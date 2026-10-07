import {
  ACCEPTED_ISSUERS,
  REGISTRY_SCHEMA_VERSION,
  validateWorkspaceRegistration,
} from '../../contracts/src/schema.mjs';

// Re-exported for control-plane-api's startup check that this set is exactly workload-identity's
// ISSUER. The seam must not import packages/contracts itself: that edge would take the project's
// fan-in from 2 to 3 and flip its `shared` flag (ADR-0003 › Registration contract), so the
// registry, which already depends on it, carries the value across.
export { ACCEPTED_ISSUERS } from '../../contracts/src/schema.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// JSON.stringify, never a delimiter join - the same encoding, for the same reason, as ADR-0002's
// idempotency key: ['a|b','c'] and ['a','b|c'] join to one string and encode to two.
export const bindingKey = (issuer, repositoryOwnerId, repositoryId) =>
  JSON.stringify([issuer, repositoryOwnerId, repositoryId]);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return value;
}

// A `workspace-registry/1` document: the version is checked before any registration is read, so
// a `/0` document - which has no workload binding - refuses to load instead of loading and then
// authorizing nothing, with no error anywhere (ADR-0003 › Version enforcement).
export function createRegistry(document) {
  if (!isObject(document) || document.registry_version !== REGISTRY_SCHEMA_VERSION)
    throw new Error(
      `unsupported registry document: registry_version must be ${REGISTRY_SCHEMA_VERSION}`,
    );
  if (!Array.isArray(document.workspaces))
    throw new Error('unsupported registry document: workspaces must be an array');
  const entries = new Map();
  // Maps, never plain objects: a key built from token claims must not resolve to an inherited
  // property of Object.prototype.
  const bindings = new Map();
  const register = (registration) => registerInto(entries, bindings, registration);
  for (const registration of document.workspaces) register(registration);
  return {
    register,
    get: (workspaceId) => entries.get(workspaceId),
    list: () => [...entries.values()].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)),
    // The verified principal's triple to a registry-assigned workspace_id, or undefined.
    bindingFor: ({ issuer, repository_owner_id, repository_id }) =>
      bindings.get(bindingKey(issuer, repository_owner_id, repository_id)),
  };
}

function registerInto(entries, bindings, registration) {
  const validation = validateWorkspaceRegistration(registration);
  if (!validation.ok)
    throw new Error(`invalid workspace registration: ${validation.errors.join('; ')}`);
  if (entries.has(registration.workspace_id))
    throw new Error(`workspace already registered: ${registration.workspace_id}`);
  const { issuer, repository_owner_id, repository_id } = registration.workload_identity;
  const key = bindingKey(issuer, repository_owner_id, repository_id);
  // Two registrations on one triple would make the workspace a token speaks for depend on load
  // order. Refused at load, as a duplicate workspace_id is.
  if (bindings.has(key))
    throw new Error(
      `workload identity already bound: ${registration.workspace_id} repeats ${bindings.get(key)}'s triple`,
    );
  // A deep-frozen copy: Object.freeze is shallow, and a registration is the authority a token is
  // matched against, so its nested workload_identity must not be editable after load either.
  const stored = deepFreeze(structuredClone(registration));
  entries.set(registration.workspace_id, stored);
  bindings.set(key, registration.workspace_id);
  return stored;
}

// Step 6's registration rules, pure, in ADR-0003's order: status, event, then the two pins. A pin
// whose claim is absent (null in the principal) is unequal and refuses. The refused-actor rule is
// the seam's, because its set is a workload-identity constant and this package does not import
// that one. Returns null when the registration admits the principal, or the refusal reason.
export function admits(registration, principal) {
  if (registration.status !== 'active') return 'not-active';
  const identity = registration.workload_identity;
  if (!identity.admitted_events.includes(principal.event_name)) return 'event-not-admitted';
  if (
    Object.hasOwn(identity, 'required_job_workflow_ref') &&
    principal.job_workflow_ref !== identity.required_job_workflow_ref
  )
    return 'pin-ref';
  if (
    Object.hasOwn(identity, 'required_job_workflow_sha') &&
    principal.job_workflow_sha !== identity.required_job_workflow_sha
  )
    return 'pin-sha';
  return null;
}
