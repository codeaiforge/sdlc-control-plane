// TEST FIXTURE - never the service. A child process for durable-service.integration.mjs: the real
// seam (createRequestHandler inside createSeamServer, exactly as createApp composes it) over the
// real durable store (openDurableEvidenceStore, which reads PG* and runs every startup check),
// with the key set, registry and policy injected on stdin by the test.
//
// It exists because the service's own composition cannot be pointed at test keys: main.mjs
// fetches GitHub's key set, and task 2.1 forbids any variable that would change a verification
// constant. Production code gains no flag for this; the fixture composes the same parts itself.
//
// stdin:  {"jwks": {...}, "registry": {...}, "policy": {...}}
// stdout: {"port": <n>} once listening on 127.0.0.1
// stderr: refusal lines, or one "control plane refused to start: <code>" line and exit 1

import {
  StartupRefused,
  openDurableEvidenceStore,
} from '../../evidence-store/src/database-config.mjs';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import { createRequestHandler, createSeamServer } from './main.mjs';
import { stderrLog } from './refusal-log.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const { jwks, registry, policy } = await readStdin();
  const evidenceStore = await openDurableEvidenceStore();
  const keySet = createKeySet({
    fetchKeySet: async () => ({
      body: Buffer.from(JSON.stringify(jwks)),
      cacheControl: 'max-age=3600',
    }),
  });
  const server = createSeamServer(
    createRequestHandler({
      registry: createRegistry(registry),
      policy,
      evidenceStore,
      authenticate: createAuthenticator({ keySet }),
      log: stderrLog,
    }),
  );
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
  });
} catch (error) {
  const line =
    error instanceof StartupRefused ? error.message : 'control plane refused to start: failed';
  process.stderr.write(`${line}\n`);
  process.exit(1);
}
