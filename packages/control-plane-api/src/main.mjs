import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { evaluateGuardrails } from '../../guardrail-policy/src/evaluate.mjs';
import { summarizeEvidence } from '../../indicators/src/summarize.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import { createInMemoryEvidenceStore, project } from './evidence-store.mjs';

const workspaces = JSON.parse(
  readFileSync(new URL('../../../config/control-plane/workspaces.json', import.meta.url)),
).workspaces;
// createRegistry validates every registration at load and throws; the policy was the one
// configuration loaded unchecked. openapi.json requires policy_id on an accepted decision
// because an acceptance that names no approved policy is not traceable (FR-3.1, NFR-6.1), and
// evaluateGuardrails passes policy.policy_id straight through - so an unvalidated policy file
// makes the seam emit a 202 its own published schema rejects. Fail at startup instead.
export function assertUsablePolicy(candidate) {
  const errors = [];
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    return ['policy must be an object'];
  if (candidate.policy_version !== 'guardrails/0')
    errors.push('policy_version must be guardrails/0');
  if (typeof candidate.policy_id !== 'string' || candidate.policy_id.length === 0)
    errors.push('policy_id must be a non-empty string');
  return errors;
}

const policy = JSON.parse(
  readFileSync(new URL('../../../config/control-plane/guardrails.json', import.meta.url)),
);
const policyErrors = assertUsablePolicy(policy);
if (policyErrors.length > 0)
  throw new Error(`unusable guardrail policy: ${policyErrors.join('; ')}`);

const registry = createRegistry(workspaces);
// One store per process, created at module scope exactly as the array it replaces was, so the
// running service keeps the singleton it has today. createApp() takes an injection seam instead
// of reaching for this binding, so a test can hold its own store without sharing this one.
const defaultEvidenceStore = createInMemoryEvidenceStore();

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

// The routes are data so that something other than a reader can enumerate them. openapi.json
// claims a set of routes and statuses, and openapi.contract.test.mjs compares that claim against
// this table rather than against a description of it.
export const routes = [
  {
    method: 'GET',
    path: '/health',
    handle: (context, request, response) => send(response, 200, { status: 'ok' }),
  },
  {
    method: 'GET',
    path: '/v1/workspaces',
    handle: ({ registry }, request, response) => send(response, 200, { data: registry.list() }),
  },
  {
    method: 'GET',
    path: '/v1/indicators',
    handle: ({ evidenceStore }, request, response) =>
      send(response, 200, { data: summarizeEvidence(evidenceStore.listRecords()) }),
  },
  {
    method: 'POST',
    path: '/v1/evidence',
    handle: async ({ policy, evidenceStore }, request, response) => {
      // The try spans the body read, the parse and the evaluation. Narrowing it would change
      // what a fault puts on the wire: a throw inside this span is answered with the
      // documented 400 envelope, whereas outside it the throw escapes the handler, rejects
      // the returned promise and leaves the caller with no response at all. The body read is
      // inside for that reason and not only for tidiness — a client that opens a POST and
      // drops the socket makes `for await` throw, and an unhandled rejection there terminates
      // the process under Node's default behaviour, which `nx serve` runs with.
      try {
        // Concat then decode once: `raw += chunk` stringifies each Buffer independently, so a
        // multi-byte character straddling a chunk boundary becomes U+FFFD. The record still
        // parses and still satisfies every published schema, so no contract check can catch it
        // - it is silent corruption of the change_id that ties evidence to a change.
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Projected before the policy is evaluated, not after. JSON.stringify is recursive where
        // JSON.parse is not, so a body the seam parses can still be unprojectable; running policy
        // first would let the control plane compute "accepted" for a record it then loses, and
        // answer the caller with a body-fault 400 for JSON that was valid. Refuse it first.
        project(record);
        const decision = evaluateGuardrails(record, policy);
        if (!decision.accepted) return send(response, 422, { decision });
        evidenceStore.append(record);
        return send(response, 202, { decision });
      } catch {
        return send(response, 400, { error: 'request body must be valid JSON' });
      }
    },
  },
];

export function createRequestHandler(context) {
  return async (request, response) => {
    // .find() over the table performs the same two === comparisons, in the same order, as the
    // if-chain it replaces. A Map keyed on a joined string would be a different comparison on a
    // different value, and the claim that routing behaviour is unchanged would stop being true.
    const route = routes.find(
      (candidate) => candidate.method === request.method && candidate.path === request.url,
    );
    if (route) return route.handle(context, request, response);
    return send(response, 404, { error: 'not found' });
  };
}

export function createApp({ evidenceStore = defaultEvidenceStore } = {}) {
  return createServer(createRequestHandler({ registry, policy, evidenceStore }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`control plane scaffold listening on :${port}`));
}
