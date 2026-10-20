// The append-only evidence port. Two adapters implement it against the one conformance suite in
// store-conformance.mjs: the in-memory adapter below, which tests inject, and the PostgreSQL
// adapter in postgres-store.mjs, which the service runs on (task 2.2). ADR-0002 records the
// store, the key, the retention window and the audit-event boundary this shape assumes, and why
// the envelope wraps the record instead of extending `evidence/0`.

export const ENVELOPE_VERSION = 'evidence-envelope/0';

// JSON.stringify, never a delimiter join. ['a|b','c'].join('|') and ['a','b|c'].join('|') are the
// same string, so a joined key would alias two distinct (workspace, change) pairs: the second
// workspace's record would be answered as a replay of the first and never stored.
// JSON.stringify(['a|b','c']) !== JSON.stringify(['a','b|c']), so the pair survives the encoding.
export const idempotencyKey = (workspaceId, changeId) => JSON.stringify([workspaceId, changeId]);

// The control plane's own fault, never the caller's: a store that cannot be reached or did not
// answer in time, or an envelope option the seam built wrongly. The seam answers it 503, where a
// TypeError - a record fault - is answered 400. The cause is kept for a debugger and never logged.
export class EvidenceStoreFault extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'EvidenceStoreFault';
  }
}

// What PostgreSQL can hold. Measured on 16.15: U+0000 is refused in text and in jsonb, a lone
// surrogate is refused in jsonb and silently stored as U+FFFD in a text column. JSON.parse accepts
// both, so a record carrying either is valid JSON that no durable store keeps unchanged.
export const isStorableString = (value) =>
  typeof value === 'string' && !value.includes('\u0000') && value.isWellFormed();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasString = (value, key) => typeof value?.[key] === 'string' && value[key].length > 0;

// Object.freeze is shallow. Under a shallow freeze `envelope.evidence.result.pass = false`
// succeeds, which flips passing_records from 1 to 0 in an indicator the control plane has
// already published — a log that can be edited in place is not an append-only log. Reflect
// .ownKeys also walks symbol keys, which Object.keys steps past. The Object.isFrozen guard skips
// work already done and terminates the walk if a value ever reaches here with a cycle in it.
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return value;
}

// Every string and every key in a parsed JSON value, walked with an explicit stack: a recursive
// walk would overflow at a depth JSON.stringify had just accepted, and that RangeError would
// reach the seam as something other than a record fault.
function firstUnstorable(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (!isStorableString(current)) return true;
    } else if (current !== null && typeof current === 'object') {
      for (const key of Object.keys(current)) {
        if (!Array.isArray(current) && !isStorableString(key)) return true;
        pending.push(current[key]);
      }
    }
  }
  return false;
}

// What is stored is the JSON projection of the record, never the caller's object. Two hazards in
// one step: the caller keeps a live reference it could mutate after the append, and a `jsonb`
// column reshapes values on the way in — a Date becomes its ISO string, an undefined-valued
// property disappears. An in-memory adapter that kept the original would accept values the
// PostgreSQL adapter cannot store unchanged, and the conformance suite would not notice.
export function project(record) {
  let text;
  try {
    text = JSON.stringify(record);
  } catch (cause) {
    // A cycle or a BigInt throws here, before anything is indexed, so nothing is stored. So does
    // a record nested deeper than JSON.stringify's recursion limit - which JSON.parse does NOT
    // share, so the seam can parse a body this cannot project. The seam therefore projects
    // immediately after parsing, before policy runs, so the control plane never grants an
    // acceptance to a record it is about to fail to store.
    throw new TypeError('evidence record must be JSON-serialisable', { cause });
  }
  if (typeof text !== 'string') throw new TypeError('evidence record must be JSON-serialisable');
  const value = JSON.parse(text);
  // Refused here, in the one function both adapters and the seam share, so every adapter refuses
  // identically and the seam refuses before policy is evaluated: a record PostgreSQL cannot hold
  // is the caller's fault, and answering it as a store failure would blame the control plane.
  if (firstUnstorable(value))
    throw new TypeError('evidence record must not contain U+0000 or an unpaired surrogate');
  return { text, value };
}

// A text that is equal for two projections exactly when their values are equal, whatever order
// their keys were written in: jsonb compares values, not text (measured), and the in-memory
// adapter has to reach the same answer. Key order carries no meaning in JSON, and a conflict on it
// would answer a correct retry from a re-serialising client as a fault. JSON.stringify does the
// recursion, so the depth band is the projection's own.
export function canonicalText(value) {
  try {
    return JSON.stringify(value, (_key, nested) =>
      isObject(nested)
        ? Object.fromEntries(
            Object.keys(nested)
              .sort()
              .map((key) => [key, nested[key]]),
          )
        : nested,
    );
  } catch (cause) {
    throw new TypeError('evidence record must be JSON-serialisable', { cause });
  }
}

// The envelope options are the control plane's, never the caller's: the seam builds every one of
// them from the verified principal and the decision. A wrong one is therefore a control-plane
// fault, answered 503, and it is refused before anything is stored.
export function assertEnvelopeOptions({ workspace_id, policy_id, submitted_by }) {
  for (const [name, value] of [
    ['workspace_id', workspace_id],
    ['policy_id', policy_id],
  ]) {
    if (value !== null && !(isStorableString(value) && value.length > 0))
      throw new EvidenceStoreFault(`${name} must be null or a non-empty storable string`);
  }
  if (submitted_by !== null && !isObject(submitted_by))
    throw new EvidenceStoreFault('submitted_by must be an object or null');
  if (submitted_by !== null) {
    let text;
    try {
      text = JSON.stringify(submitted_by);
    } catch (cause) {
      throw new EvidenceStoreFault('submitted_by must be JSON-serialisable', { cause });
    }
    if (firstUnstorable(JSON.parse(text)))
      throw new EvidenceStoreFault('submitted_by must hold only storable strings');
  }
}

// The four submitted_by fields ADR-0004 nulls when a payload is redacted: each is a name a person
// chose, and outliving the payload would keep personal data the retention window exists to drop.
// The other seven are identifiers and stay with the tombstone.
export const REDACTED_SUBMITTER_FIELDS = Object.freeze([
  'ref',
  'event_name',
  'workflow_ref',
  'job_workflow_ref',
]);

export function createInMemoryEvidenceLog({ now = () => new Date().toISOString() } = {}) {
  const envelopes = [];
  // A Map, never a plain object. A plain-object index resolves 'constructor', 'toString' and
  // '__proto__' to inherited values, and change_id is caller-controlled: a submission carrying
  // one of those would read as an already-present key and be answered `duplicate` against a
  // record that was never appended. A Map has no such inherited entries.
  const byKey = new Map();

  // The port does not re-validate `evidence/0` — that is the contracts package's job and the
  // seam does it before calling here. These preconditions are the store's own: it cannot key a
  // record it cannot read, and it must not half-store one it then refuses.
  function append(
    record,
    { workspace_id = null, received_at, policy_id = null, submitted_by = null } = {},
  ) {
    if (!isObject(record)) throw new TypeError('evidence record must be an object');
    const { value } = project(record);
    if (!hasString(value, 'change_id'))
      throw new TypeError('evidence record must carry a non-empty string change_id');
    assertEnvelopeOptions({ workspace_id, policy_id, submitted_by });
    const canonical = canonicalText(value);

    // A null workspace_id claims no uniqueness at all: there is no identity to be unique
    // against, and a key of [null, change_id] would make two unrelated workspaces collide on a
    // shared change_id. The seam always passes the authenticated principal's workspace, so only
    // a direct caller of the port reaches this branch, and the service's durable adapter is
    // constructed to refuse it (requireWorkspace, ADR-0002).
    const key = workspace_id === null ? null : idempotencyKey(workspace_id, value.change_id);
    const existing = key === null ? undefined : byKey.get(key);
    if (existing) {
      // `conflict` is not `duplicate`: two different bodies claiming the same (workspace,
      // change) is a producer fault or tampering, and answering it as a replay would leave
      // stored evidence disagreeing with what the workspace believes it submitted. Either way
      // the first record stands and nothing is appended — replacing it would let a later caller
      // rewrite accepted evidence — but the caller is told which of the two happened.
      //
      // Equality is on the canonical text, so two bodies differing only in key order are a
      // duplicate here exactly as they are under jsonb's comparison (AC-15).
      //
      // A redacted envelope has no body, so there is nothing to compare and nothing to disagree
      // with: a replay of a redacted submission resolves to `duplicate` on the key alone. That is
      // why no digest of the payload is retained - one would outlive the body it was taken from
      // and become an offline oracle for it.
      const envelope = envelopes[existing.index];
      const same = envelope.evidence === null || existing.canonical === canonical;
      return { outcome: same ? 'duplicate' : 'conflict', key, envelope };
    }

    const envelope = deepFreeze({
      envelope_version: ENVELOPE_VERSION,
      workspace_id,
      // The control plane's clock, never a received_at field in the submitted record. A
      // submitter that sets its own receipt time sets its own retention clock with it, and can
      // backdate itself out of the window or park a record outside it indefinitely.
      received_at: received_at ?? now(),
      idempotency_key: key,
      // The approved policy that granted the acceptance. NFR-6.1's first clause is "retain the
      // approving decision reference", and openapi.json already requires policy_id on an accepted
      // decision because an acceptance naming no approved policy is not traceable. Without this
      // slot the durable record could only answer *when* it was accepted, leaving *under which
      // policy* to be inferred from the git history of config/control-plane/guardrails.json.
      policy_id,
      // The verified run identity that submitted the record (ADR-0004), built by the seam from
      // token claims and never from the body, or null when no principal is passed. A projected
      // copy, deep-frozen with the rest of the envelope, so the caller's object cannot reach the
      // log afterwards. On a duplicate or a conflict the branch above has already returned the
      // first envelope, so the first submitter stands: a replay is not a second submitter.
      submitted_by: submitted_by === null ? null : JSON.parse(JSON.stringify(submitted_by)),
      evidence: value,
      // null until the payload is redacted, then the time it was. Added by task 2.2 without a
      // version bump, on ADR-0004's argument for submitted_by: no envelope was durable before it.
      redacted_at: null,
    });
    envelopes.push(envelope);
    if (key !== null) byKey.set(key, { index: envelopes.length - 1, canonical });
    return { outcome: 'appended', key, envelope };
  }

  // Not a port method. Redaction is the one deliberate exception to append-only, and in the
  // durable store it is a different database role on a different connection, constrained by a
  // trigger the application role cannot reach; nothing the seam holds can call it. This is the
  // in-memory equivalent, handed to tests beside the store so the conformance suite can pin what a
  // redacted envelope looks like and that a replay of one is a duplicate (ADR-0002, AC-8).
  function redact({ workspace_id, change_id }) {
    const entry = byKey.get(idempotencyKey(workspace_id, change_id));
    if (entry === undefined || envelopes[entry.index].evidence === null) return false;
    const stored = envelopes[entry.index];
    const submitter =
      stored.submitted_by === null
        ? null
        : {
            ...stored.submitted_by,
            ...Object.fromEntries(REDACTED_SUBMITTER_FIELDS.map((field) => [field, null])),
          };
    envelopes[entry.index] = deepFreeze({
      ...stored,
      submitted_by: submitter,
      evidence: null,
      redacted_at: now(),
    });
    entry.canonical = null;
    return true;
  }

  const store = {
    append,
    // A fresh array per call. Handing back the log itself would let a caller that sorts,
    // splices or truncates the result reorder or empty the store through a read method. An
    // optional workspace filter keeps a per-workspace read from reading every workspace (RR-10).
    list: ({ workspace_id } = {}) => {
      if (workspace_id === undefined) return [...envelopes];
      if (typeof workspace_id !== 'string')
        throw new TypeError('list workspace_id filter must be a string');
      return envelopes.filter((envelope) => envelope.workspace_id === workspace_id);
    },
    // Payloads of envelopes that still have one: a redacted envelope keeps its identity and
    // loses its payload, so it is not a record any more.
    listRecords: () =>
      envelopes
        .filter((envelope) => envelope.evidence !== null)
        .map((envelope) => envelope.evidence),
  };
  return { store, redact };
}

export function createInMemoryEvidenceStore(options) {
  return createInMemoryEvidenceLog(options).store;
}
