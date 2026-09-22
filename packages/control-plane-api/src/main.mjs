import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { evaluateGuardrails } from '../../guardrail-policy/src/evaluate.mjs';
import { summarizeEvidence } from '../../indicators/src/summarize.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';

const workspaces = JSON.parse(
  readFileSync(new URL('../../../config/control-plane/workspaces.json', import.meta.url)),
).workspaces;
const policy = JSON.parse(
  readFileSync(new URL('../../../config/control-plane/guardrails.json', import.meta.url)),
);
const registry = createRegistry(workspaces);
const evidence = [];

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
    handle: ({ evidence }, request, response) =>
      send(response, 200, { data: summarizeEvidence(evidence) }),
  },
  {
    method: 'POST',
    path: '/v1/evidence',
    handle: async ({ policy, evidence }, request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      // The try spans both the parse and the evaluation, exactly as it did before the table
      // existed. Narrowing it to JSON.parse would change what an evaluator fault puts on the
      // wire: today a throw from evaluateGuardrails is answered with the documented 400
      // envelope, whereas narrowed it would escape the handler, reject the returned promise
      // and leave the caller with no response at all. That is a contract change, not a tidy-up.
      try {
        const record = JSON.parse(raw);
        const decision = evaluateGuardrails(record, policy);
        if (!decision.accepted) return send(response, 422, { decision });
        evidence.push(Object.freeze(record));
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

export function createApp() {
  return createServer(createRequestHandler({ registry, policy, evidence }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`control plane scaffold listening on :${port}`));
}
