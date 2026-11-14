import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// The evidence adapter (task 3.1, ADR-0003): the one file a workspace's pinned submit job runs.
// It mints a GitHub Actions OIDC token for the control plane's audience and POSTs the gate's
// evidence/0 record to POST /v1/evidence, byte for byte. .github/workflows/submit-evidence.yml
// checks out this file alone and runs it with no install, so it imports nothing but node:
// built-ins and nothing from the workspace; tools/sdlc-controls/evidence-adapter-conformance.test.mjs
// holds it to that.
//
// The record is the gate's output and the gate ran pull-request code, so it is data: it is sent
// unchanged, parsed only to show its change_id, and never executed, sourced or interpolated. The
// adapter does not judge it - validation is the control plane's (FR-2.1).
//
// The credentials - the runner's request token and each minted token - live in one local
// variable for the length of one request. Neither is ever printed, written, put in an Error or
// returned; no caught error's message is printed, because an error raised while reading a
// response can quote what it was reading; and every server-supplied string handed back has both
// values replaced by [redacted] first, because a faulty or hostile server can echo what it was
// sent. Every failure is a fixed reason code.

// The reviewed constants. Every one is a literal changed by a reviewed commit, never an
// environment variable or an input: a tunable endpoint, audience or limit is a second policy
// surface with no review path (the rule of packages/workload-identity/src/constants.mjs). AUDIENCE
// and the two byte caps are held equal to their control-plane copies by the conformance test.
export const AUDIENCE = 'urn:codeaiforge:sdlc-control-plane:production';
// The one deployment AUDIENCE names. null until a deploy target is selected (stack.md › Deploy);
// the CLI refuses to run while it is null. Never an input or a variable: a caller-chosen endpoint
// would receive a token minted inside the pinned job, carrying the pinned workflow's claims, and
// could replay it at the real control plane with any body (threat model ABU-16). The release that
// names the deployment sets it here, in a reviewed commit.
export const CONTROL_PLANE_ENDPOINT = null;
// = admission.mjs MAX_BODY_BYTES: a larger record is refused here, before a token is minted.
export const MAX_EVIDENCE_BYTES = 1048576;
// = workload-identity MAX_TOKEN_BYTES: a longer minted value is refused, not sent.
export const MAX_TOKEN_BYTES = 8192;
// Token and submission answers alike, counted on the bytes received.
export const MAX_RESPONSE_BYTES = 65536;
export const MAX_ATTEMPTS = 4;
// The wait before attempt n (n >= 2) is d * (0.5 + 0.5 * random), d = BACKOFF_BASE_MS * 2^(n-2):
// 1-2 s, 2-4 s, 4-8 s.
export const BACKOFF_BASE_MS = 2000;
// The seam's quota window (admission.mjs SUBMISSION_QUOTA_WINDOW_MS, 60 s). A longer retry-after
// stops the loop rather than outlast it.
export const MAX_RETRY_AFTER_S = 60;
export const MINT_TIMEOUT_MS = 10000;
// Longer than the seam's REQUEST_TIMEOUT_MS (30 s), so the seam's own deadline answers first.
export const SUBMIT_TIMEOUT_MS = 40000;
// An attempt starts only if its mint and its submission both fit before this, so the loop ends
// by 150 s and the job's timeout-minutes: 5 is never what stops it.
export const TOTAL_BUDGET_MS = 150000;
const ATTEMPT_MAX_MS = MINT_TIMEOUT_MS + SUBMIT_TIMEOUT_MS;

export const EXIT = Object.freeze({
  // 202: appended or duplicate - indistinguishable on the wire.
  ACCEPTED: 0,
  // 422: answered with a disposition other than accepted; nothing stored.
  NOT_ACCEPTED: 1,
  // Refused before any request: no endpoint configured, the ID-token variables missing, the
  // record not a regular file, over 1 MiB or unreadable, an endpoint that is not https (loopback
  // excepted), or the runner refused to mint.
  LOCAL: 2,
  // No evidence.json: the gate did not reach a decision; nothing submitted.
  NO_RECORD: 3,
  // 400, 401, 403, 409, 413, any 3xx (never followed), any other status.
  REFUSED: 4,
  // 429, 502, 503, 504, a network error or timeout, or the mint unavailable, until the attempts
  // or the budget ran out.
  UNAVAILABLE: 5,
});

const USER_AGENT = 'sdlc-control-plane-evidence-adapter';
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const RETRYABLE = new Set([502, 503, 504]);

// ------------------------------------------------------------------------------------ transport

// https: anywhere, or http: to the literal loopback addresses only - for tests. `localhost` is a
// name, not loopback, and is refused (README › Tests). A URL carrying credentials is refused too.
export function allowedTarget(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]'))
    return url;
  return null;
}

// One request, one answer, never a throw. The same rules as
// packages/workload-identity/src/https-transport.mjs, written again because this file imports
// nothing:
//
// - The target is checked again here, so no caller can reach a non-https host through it.
// - `rejectUnauthorized: true` is passed explicitly, so NODE_TLS_REJECT_UNAUTHORIZED=0 in the
//   job's environment cannot switch certificate verification off on the hop carrying the token.
// - No redirect is followed: https.request never follows one, and the only response header read
//   is retry-after, so a Location is never read.
// - 64 KiB: an honest content-length over the cap fails before a byte is read, and the received
//   bytes are counted regardless.
// - One deadline per request, which destroys it.
//
// The answer is { status, retryAfter, body } or { error } with a fixed code; nothing the network
// sent reaches an error. `httpsRequest`/`httpRequest` are injectable so the tests can see the
// options without a TLS server.
export function createTransport({ httpsRequest = https.request, httpRequest = http.request } = {}) {
  return (target, { method, headers, body, timeoutMs }) =>
    new Promise((resolve) => {
      const url = allowedTarget(target);
      if (url === null) {
        resolve({ error: 'endpoint-not-https' });
        return;
      }
      let settled = false;
      let outgoing;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        outgoing?.destroy();
        resolve(answer);
      };
      const deadline = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
      const onResponse = (response) => {
        const status = response.statusCode;
        const declared = response.headers['content-length'];
        if (declared !== undefined && Number(declared) > MAX_RESPONSE_BYTES)
          return finish({ status, error: 'response-too-large' });
        const retryAfter = response.headers['retry-after'];
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) return finish({ status, error: 'response-too-large' });
          chunks.push(chunk);
        });
        response.on('error', () => finish({ error: 'network' }));
        response.on('aborted', () => finish({ error: 'network' }));
        response.on('end', () => finish({ status, retryAfter, body: Buffer.concat(chunks) }));
      };
      try {
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
        outgoing = request(
          url,
          { method, headers, rejectUnauthorized: true, agent: false },
          onResponse,
        );
      } catch {
        finish({ error: 'network' });
        return;
      }
      outgoing.on('error', () => finish({ error: 'network' }));
      outgoing.end(body);
    });
}

const defaultTransport = createTransport();

// ---------------------------------------------------------------------------------------- mint

// One token from the runner's ID-token endpoint (the protocol oidc-measure.yml proved on a real
// run). Never throws; a failure carries a fixed reason and never the token or anything the
// network sent. The value is checked for shape and size only; the control plane verifies it.
export async function mintToken({
  requestUrl,
  requestToken,
  audience = AUDIENCE,
  transport = defaultTransport,
}) {
  const url = allowedTarget(requestUrl);
  if (url === null) return { ok: false, retryable: false, reason: 'mint-endpoint-not-https' };
  // set, not append or concatenation: an audience already in the URL cannot survive beside ours.
  url.searchParams.set('audience', audience);
  const answer = await transport(url, {
    method: 'GET',
    headers: { authorization: `bearer ${requestToken}`, accept: 'application/json' },
    timeoutMs: MINT_TIMEOUT_MS,
  });
  if (answer.error === 'endpoint-not-https')
    return { ok: false, retryable: false, reason: 'mint-endpoint-not-https' };
  if (answer.error !== undefined || answer.status >= 500)
    return { ok: false, retryable: true, reason: 'mint-unavailable' };
  if (answer.status !== 200) return { ok: false, retryable: false, reason: 'mint-refused' };
  let value;
  try {
    value = JSON.parse(answer.body.toString('utf8'))?.value;
  } catch {
    return { ok: false, retryable: false, reason: 'mint-malformed' };
  }
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES ||
    !COMPACT_JWS.test(value)
  )
    return { ok: false, retryable: false, reason: 'mint-malformed' };
  return { ok: true, token: value };
}

// -------------------------------------------------------------------------------------- submit

// Every string in a parsed answer, with each secret replaced. Run while the attempt still holds
// both secrets, so nothing that echoes them leaves this module.
function redact(value, secrets) {
  if (typeof value === 'string')
    return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    );
  return value;
}

const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
};

const backoffMs = (attempt, random) =>
  BACKOFF_BASE_MS * 2 ** (attempt - 2) * (0.5 + 0.5 * random());

// One mint and one POST. Returns { final } when the loop must stop with that outcome, or
// { last, retryAfterMs?, stop? } when the answer was retry-safe.
async function attemptOnce({ body, endpoint, env, transport }) {
  const minted = await mintToken({
    requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    transport,
  });
  if (!minted.ok) {
    if (minted.retryable) return { last: minted.reason };
    return { final: { kind: 'local', reason: minted.reason } };
  }
  let token = minted.token;
  const answer = await transport(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': String(body.length),
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    body,
    timeoutMs: SUBMIT_TIMEOUT_MS,
  });
  const secrets = [token, env.ACTIONS_ID_TOKEN_REQUEST_TOKEN];
  token = undefined;

  if (answer.error === 'timeout' || answer.error === 'network') return { last: answer.error };
  if (answer.error !== undefined)
    return { final: { kind: 'refused', status: answer.status ?? null, reason: answer.error } };
  const { status } = answer;
  if (status === 202 || status === 422) {
    const decision = redact(parseJson(answer.body)?.decision ?? null, secrets);
    return { final: { kind: status === 202 ? 'accepted' : 'not-accepted', status, decision } };
  }
  if (status === 429) {
    const seconds = /^\d+$/.test(answer.retryAfter ?? '') ? Number(answer.retryAfter) : null;
    if (seconds !== null && seconds > MAX_RETRY_AFTER_S) return { last: '429', stop: true };
    if (seconds !== null && seconds >= 1) return { last: '429', retryAfterMs: seconds * 1000 };
    return { last: '429' };
  }
  if (RETRYABLE.has(status)) return { last: String(status) };
  const refused = { kind: 'refused', status };
  if (status === 409) {
    const key = parseJson(answer.body)?.idempotency_key;
    refused.idempotencyKey = redact(key ?? null, secrets);
  }
  return { final: refused };
}

// The retry loop. A fresh token is minted for every attempt and dropped after its request: a
// token lives 300 s and must not expire mid-backoff, and a retry is the same submission only if
// its bytes are identical - they are, because `body` is sent as given every time. Only
// retry-safe answers are retried (429, 502-504, a lost answer: intake is idempotent, so a lost
// 202 replays as a duplicate); a 409 is never retried.
export async function submitEvidence({
  body,
  endpoint,
  env,
  transport = defaultTransport,
  sleep = delay,
  now = Date.now,
  random = Math.random,
  onAttempt,
}) {
  if (allowedTarget(endpoint) === null) return { kind: 'local', reason: 'endpoint-not-https' };
  if (!Buffer.isBuffer(body) || body.length > MAX_EVIDENCE_BYTES)
    return { kind: 'local', reason: 'record-too-large' };
  // Read by name, never by a computed key, so the conformance test can list every variable read.
  const present = (value) => typeof value === 'string' && value.length > 0;
  if (!present(env?.ACTIONS_ID_TOKEN_REQUEST_URL) || !present(env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN))
    return { kind: 'local', reason: 'no-id-token-variables' };

  const start = now();
  let attempts = 0;
  let last;
  let wait = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      if (now() + wait + ATTEMPT_MAX_MS > start + TOTAL_BUDGET_MS) break;
      onAttempt?.({ attempt: attempts, outcome: last, waitMs: wait });
      await sleep(wait);
    }
    attempts = attempt;
    const result = await attemptOnce({ body, endpoint, env, transport });
    if (result.final) return { ...result.final, attempts };
    last = result.last;
    if (result.stop) break;
    wait = result.retryAfterMs ?? backoffMs(attempt + 1, random);
  }
  return { kind: 'unavailable', last, attempts, elapsedMs: now() - start };
}

// -------------------------------------------------------------------------------------- output

// What every echoed field passes through. The record and the answers are untrusted, and the step
// log parses a ::workflow-command:: at the start of a line, so no field may start one: C0/C1
// controls, DEL and U+2028/2029 - every line break among them - are escaped as \uXXXX, and the
// value is cut to 120 code points. A value that is not a string is shown as its type.
export function display(value) {
  if (typeof value !== 'string') return `(${value === null ? 'null' : typeof value})`;
  const points = [...value];
  const cut = points.length > 120 ? `${points.slice(0, 120).join('')}…` : value;
  return cut.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const SUMMARY_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '|': '&#124;',
  '`': '&#96;',
};
// The job summary is Markdown rendered as HTML, so a line is entity-escaped as well.
export const summaryLine = (line) => `- ${line.replace(/[&<>"'|`]/g, (c) => SUMMARY_ENTITIES[c])}`;

const LOCAL_REASONS = {
  'no-endpoint': 'no control plane endpoint is configured in this adapter release',
  'no-record-path': 'no evidence record path was given',
  'record-not-regular': 'the evidence record is not a regular file',
  'record-too-large': `the evidence record is larger than ${MAX_EVIDENCE_BYTES} bytes`,
  'record-unreadable': 'the evidence record could not be read',
  'endpoint-not-https': 'the control plane endpoint is not https',
  'no-id-token-variables':
    'the ID-token request variables are not set; does the calling job grant id-token: write?',
  'mint-endpoint-not-https': 'the ID-token request URL is not https',
  'mint-refused': 'the runner did not issue a token; does the calling job grant id-token: write?',
  'mint-malformed': 'the runner did not issue a token; does the calling job grant id-token: write?',
  failed: 'the adapter failed',
};

const REFUSED = {
  400: 'the control plane could not read the record as JSON',
  401: 'the control plane refused the token',
  403: 'no registration admits this run: check its binding, admitted event, workflow pin and actor',
  409: "this change_id is already held with different bytes; the gate's --change-id is not unique per run",
  413: 'the record is over the control plane body limit',
};

function outcomeLine(result) {
  const decision = result.decision ?? {};
  switch (result.kind) {
    case 'accepted':
      return (
        `${result.status}, disposition "${display(decision.disposition)}" under policy ` +
        `"${display(decision.policy_id)}". Recorded as the workspace's own claim ` +
        '(self-attested); the control plane did not check it is true.'
      );
    case 'not-accepted': {
      const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
      const shown = reasons.slice(0, 10).map(display).join('; ');
      const more = reasons.length > 10 ? `; and ${reasons.length - 10} more` : '';
      return (
        `${result.status}, disposition "${display(decision.disposition)}" under policy ` +
        `"${display(decision.policy_id)}"; not stored. Reasons: ${shown || '(none)'}${more}`
      );
    }
    case 'refused': {
      if (result.status === 409)
        return (
          `refused 409 (${REFUSED[409]}; idempotency key "${display(result.idempotencyKey)}"); ` +
          'nothing was stored.'
        );
      if (Object.hasOwn(REFUSED, result.status))
        return `refused ${result.status} (${REFUSED[result.status]}); nothing was stored.`;
      if (result.status >= 300 && result.status < 400)
        return `refused ${result.status} (a redirect, never followed); nothing was stored.`;
      return (
        `refused ${result.status ?? '(no status)'} (an answer this adapter does not handle); ` +
        'it cannot tell whether anything was stored.'
      );
    }
    case 'unavailable':
      return (
        `no answer after ${result.attempts} attempt(s) in ${Math.round(result.elapsedMs / 1000)} s ` +
        `(${result.last}); the record may or may not be stored — re-running this job re-sends ` +
        'the same bytes and is answered as a duplicate if it was.'
      );
    default:
      return `not submitted: ${LOCAL_REASONS[result.reason] ?? LOCAL_REASONS.failed}.`;
  }
}

const EXIT_BY_KIND = {
  accepted: EXIT.ACCEPTED,
  'not-accepted': EXIT.NOT_ACCEPTED,
  local: EXIT.LOCAL,
  refused: EXIT.REFUSED,
  unavailable: EXIT.UNAVAILABLE,
};

// ------------------------------------------------------------------------------------------ CLI

// argv = [recordPath]. Returns an EXIT code and never rejects. Every refusal below happens before
// the first request; the order is the design's: endpoint, record presence, record kind, size,
// read, endpoint scheme, ID-token variables.
export async function main({ argv, env, endpoint = CONTROL_PLANE_ENDPOINT, stdout, ...deps }) {
  const lines = [];
  const print = (text) => {
    const line = `submit-evidence: ${text}`;
    lines.push(line);
    stdout.write(`${line}\n`);
  };
  const finish = (code) => {
    const summary = env?.GITHUB_STEP_SUMMARY;
    if (typeof summary === 'string' && summary.length > 0) {
      try {
        appendFileSync(
          summary,
          `### Evidence submission\n\n${lines.map(summaryLine).join('\n')}\n`,
        );
      } catch {
        // The summary is best-effort; the log above already carries every line.
      }
    }
    return code;
  };
  const local = (reason) => {
    print(outcomeLine({ kind: 'local', reason }));
    return finish(EXIT.LOCAL);
  };
  try {
    if (endpoint === null) return local('no-endpoint');
    const path = argv?.[0];
    if (typeof path !== 'string' || path.length === 0) return local('no-record-path');
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') return local('record-unreadable');
      print(
        `no evidence record at ${display(path)}: the gate did not reach a decision; nothing ` +
          'was submitted.',
      );
      return finish(EXIT.NO_RECORD);
    }
    // lstat, so a symlink is not a regular file: the record is never read through a link.
    if (!stats.isFile()) return local('record-not-regular');
    if (stats.size > MAX_EVIDENCE_BYTES) return local('record-too-large');
    let body;
    try {
      body = readFileSync(path);
    } catch {
      return local('record-unreadable');
    }
    if (body.length > MAX_EVIDENCE_BYTES) return local('record-too-large');
    const record = parseJson(body);
    const changeId =
      record !== null && typeof record === 'object' ? display(record.change_id) : '(unreadable)';
    print(
      `record sha256:${createHash('sha256').update(body).digest('hex')} (${body.length} bytes), ` +
        `change_id "${changeId}"`,
    );
    if (allowedTarget(endpoint) === null) return local('endpoint-not-https');

    const result = await submitEvidence({
      body,
      endpoint,
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: env?.ACTIONS_ID_TOKEN_REQUEST_URL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      },
      ...deps,
      onAttempt: ({ attempt, outcome, waitMs }) =>
        print(
          `attempt ${attempt} of ${MAX_ATTEMPTS}: ${outcome}; next attempt in ` +
            `${(waitMs / 1000).toFixed(1)} s with a new token`,
        ),
    });
    print(outcomeLine(result));
    return finish(EXIT_BY_KIND[result.kind]);
  } catch {
    return local('failed');
  }
}

// True only when this file is the script node was started with, compared through the real path
// so a symlinked checkout still runs. Importing the module therefore runs nothing.
export function isEntrypoint(scriptPath, moduleUrl) {
  try {
    return typeof scriptPath === 'string' && realpathSync(scriptPath) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  main({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT.LOCAL;
    },
  );
}
