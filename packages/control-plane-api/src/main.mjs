import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { evaluateGuardrails } from '../../guardrail-policy/src/evaluate.mjs';
import { summarizeEvidence } from '../../indicators/src/summarize.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';

const workspaces = JSON.parse(readFileSync(new URL('../../../config/control-plane/workspaces.json', import.meta.url))).workspaces;
const policy = JSON.parse(readFileSync(new URL('../../../config/control-plane/guardrails.json', import.meta.url)));
const registry = createRegistry(workspaces);
const evidence = [];

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function createRequestHandler({ registry, policy, evidence }) {
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok' });
    if (request.method === 'GET' && request.url === '/v1/workspaces') return send(response, 200, { data: registry.list() });
    if (request.method === 'GET' && request.url === '/v1/indicators') return send(response, 200, { data: summarizeEvidence(evidence) });
    if (request.method === 'POST' && request.url === '/v1/evidence') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      try {
        const record = JSON.parse(raw);
        const decision = evaluateGuardrails(record, policy);
        if (!decision.accepted) return send(response, 422, { decision });
        evidence.push(Object.freeze(record));
        return send(response, 202, { decision });
      } catch {
        return send(response, 400, { error: 'request body must be valid JSON' });
      }
    }
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
