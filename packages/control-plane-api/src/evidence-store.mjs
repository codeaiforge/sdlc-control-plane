// The append-only evidence port. Task 1.2 ships the in-memory adapter below; task 2.2 writes the
// PostgreSQL adapter against the same conformance suite in store-conformance.mjs. ADR-0002
// records the store, the key, the retention window and the audit-event boundary this shape
// assumes, and why the envelope wraps the record instead of extending `evidence/0`.

import { createHash } from 'node:crypto';

export const ENVELOPE_VERSION = 'evidence-envelope/0';

// The collision rule compares this, never the payload. Retention redacts the body and keeps the
// identity, so a rule that compared bodies would stop being decidable the moment a row expired -
// a replay of an expired submission would match nothing and fall to `conflict`, which ADR-0002
// reserves for a producer fault or tampering. A digest computed at insert outlives the body it
// was taken from, so the same replay is still answered `duplicate`. node:crypto is a builtin; the
// zero-dependency rule is intact.
const payloadDigest = (text) => createHash('sha256').update(text).digest('hex');

// JSON.stringify, never a delimiter join. ['a|b','c'].join('|') and ['a','b|c'].join('|') are the
// same string, so a joined key would alias two distinct (workspace, change) pairs: the second
// workspace's record would be answered as a replay of the first and never stored.
// JSON.stringify(['a|b','c']) !== JSON.stringify(['a','b|c']), so the pair survives the encoding.
export const idempotencyKey = (workspaceId, changeId) => JSON.stringify([workspaceId, changeId]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasString = (value, key) => typeof value?.[key] === 'string' && value[key].length > 0;

// Object.freeze is shallow. Under a shallow freeze `envelope.evidence.result.pass = false`
// succeeds, which flips passing_records from 1 to 0 in an indicator the control plane has
// already published — a log that can be edited in place is not an append-only log. Reflect
// .ownKeys also walks symbol keys, which Object.keys steps past. The Object.isFrozen guard skips
// work already done and terminates the walk if a value ever reaches here with a cycle in it.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return value;
}

// What is stored is the JSON projection of the record, never the caller's object. Two hazards in
// one step: the caller keeps a live reference it could mutate after the append, and a `jsonb`
// column reshapes values on the way in — a Date becomes its ISO string, an undefined-valued
// property disappears. An in-memory adapter that kept the original would accept values 2.2's
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
  return { text, value: JSON.parse(text) };
}

export function createInMemoryEvidenceStore({ now = () => new Date().toISOString() } = {}) {
  const envelopes = [];
  // A Map, never a plain object. A plain-object index resolves 'constructor', 'toString' and
  // '__proto__' to inherited values, and change_id is caller-controlled: a submission carrying
  // one of those would read as an already-present key and be answered `duplicate` against a
  // record that was never appended. A Map has no such inherited entries.
  const byKey = new Map();

  // The port does not re-validate `evidence/0` — that is the contracts package's job and the
  // seam does it before calling here. These three preconditions are the store's own: it cannot
  // key a record it cannot read, and it must not half-store one it then refuses.
  function append(record, { workspace_id = null, received_at, policy_id = null } = {}) {
    if (!isObject(record)) throw new TypeError('evidence record must be an object');
    const { text, value } = project(record);
    if (!hasString(value, 'change_id'))
      throw new TypeError('evidence record must carry a non-empty string change_id');

    // A null workspace_id claims no uniqueness at all: there is no identity to be unique
    // against until 2.1 authenticates one, and a key of [null, change_id] would make two
    // unrelated workspaces collide on a shared change_id. ADR-0002 requires 2.2 to refuse a
    // null workspace_id in production configuration rather than let this branch reach it.
    const key = workspace_id === null ? null : idempotencyKey(workspace_id, value.change_id);
    const payload_sha256 = payloadDigest(text);
    const existing = key === null ? undefined : byKey.get(key);
    if (existing) {
      // `conflict` is not `duplicate`: two different bodies claiming the same (workspace,
      // change) is a producer fault or tampering, and answering it as a replay would leave
      // stored evidence disagreeing with what the workspace believes it submitted. Either way
      // the first record stands and nothing is appended — replacing it would let a later caller
      // rewrite accepted evidence — but the caller is told which of the two happened.
      //
      // Equality is on a digest of the projection string, the strictest reading of "identical
      // payload": two bodies differing only in key order read as a conflict here, where 2.2's
      // `jsonb` comparison would read them as a duplicate. The suite does not pin that case;
      // 2.2 must.
      return {
        outcome: existing.payload_sha256 === payload_sha256 ? 'duplicate' : 'conflict',
        key,
        envelope: existing.envelope,
      };
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
      // Carried on the envelope, not just in the index, because it is a column of the row and
      // 2.2's adapter maps the two one to one. It is also what survives redaction.
      payload_sha256,
      evidence: value,
    });
    envelopes.push(envelope);
    // The digest, not `text`: a second full copy of every payload, retained for the process's
    // lifetime with no eviction, doubles per-record memory the moment 2.1 starts sending a
    // workspace_id. The digest is what the comparison reads, so the copy bought nothing.
    if (key !== null) byKey.set(key, { envelope, payload_sha256 });
    return { outcome: 'appended', key, envelope };
  }

  return {
    append,
    // A fresh array per call. Handing back the log itself would let a caller that sorts,
    // splices or truncates the result reorder or empty the store through a read method.
    list: () => [...envelopes],
    // Payloads of envelopes that still have one. 1.2 implements no expiry, so this filter
    // removes nothing today; it states the shape 2.2's retention job has to preserve, where a
    // redacted envelope keeps its identity columns and loses its payload.
    listRecords: () =>
      envelopes
        .filter((envelope) => envelope.evidence !== null)
        .map((envelope) => envelope.evidence),
  };
}
