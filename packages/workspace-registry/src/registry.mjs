import { validateWorkspaceRegistration } from '../../contracts/src/schema.mjs';

export function createRegistry(initial = []) {
  const entries = new Map();
  for (const registration of initial) register(entries, registration);
  return {
    register: (registration) => register(entries, registration),
    get: (workspaceId) => entries.get(workspaceId),
    list: () => [...entries.values()].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)),
  };
}

function register(entries, registration) {
  const validation = validateWorkspaceRegistration(registration);
  if (!validation.ok) throw new Error(`invalid workspace registration: ${validation.errors.join('; ')}`);
  if (entries.has(registration.workspace_id)) throw new Error(`workspace already registered: ${registration.workspace_id}`);
  entries.set(registration.workspace_id, Object.freeze({ ...registration }));
  return entries.get(registration.workspace_id);
}
