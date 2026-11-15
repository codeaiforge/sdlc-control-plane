// TEST FIXTURE - never the service. A child process for durable-service.integration.mjs: the real
// seam (createRequestHandler inside createSeamServer, exactly as createApp composes it) over the
// real durable side (openDurableService, which reads PG* and runs every startup check, and returns
// the store, the readiness check and the schema version), with the key set, registry and policy
// injected on stdin by the test. Telemetry is wired as main.mjs's entry block wires it: the
// startup line before listening, the interval snapshot, and the shutdown snapshot on SIGTERM or
// SIGINT, which re-raises the signal.
//
// It exists because the service's own composition cannot be pointed at test keys: main.mjs
// fetches GitHub's key set, and task 2.1 forbids any variable that would change a verification
// constant. Production code gains no flag for this; the fixture composes the same parts itself.
//
// stdin:  {"jwks": {...}, "registry": {...}, "policy": {...}}
// stdout: {"port": <n>} once listening on 127.0.0.1 - unchanged by task 2.3; the evidence adapter's
//         end-to-end test reads it too
// stderr: JSON event lines (startup, refusal, accepted, served, readiness, telemetry), or one
//         "control plane refused to start: <code>" line and exit 1

import { StartupRefused, openDurableService } from '../../evidence-store/src/database-config.mjs';
import { createAuthenticator } from '../../workload-identity/src/authenticate.mjs';
import { createKeySet } from '../../workload-identity/src/key-set.mjs';
import { createRegistry } from '../../workspace-registry/src/registry.mjs';
import {
  announceStartup,
  createRequestHandler,
  createSeamServer,
  installShutdownSnapshot,
} from './main.mjs';
import { createReadiness } from './readiness.mjs';
import { stderrLog } from './refusal-log.mjs';
import { createTelemetry } from './telemetry.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const { jwks, registry, policy } = await readStdin();
  const { evidenceStore, checkReadiness, schemaVersion } = await openDurableService();
  const keySet = createKeySet({
    fetchKeySet: async () => ({
      body: Buffer.from(JSON.stringify(jwks)),
      cacheControl: 'max-age=3600',
    }),
  });
  const registrations = createRegistry(registry);
  const telemetry = createTelemetry({ log: stderrLog });
  const handler = createRequestHandler({
    registry: registrations,
    policy,
    evidenceStore,
    authenticate: createAuthenticator({ keySet }),
    readiness: createReadiness({
      check: checkReadiness,
      onChange: (answer) => telemetry.readinessChanged(answer),
    }),
    telemetry,
    log: stderrLog,
  });
  // After the handler, which refuses a policy the validator does not accept.
  announceStartup({ telemetry, policy, registry: registrations, schemaVersion });
  telemetry.startInterval();
  installShutdownSnapshot({ telemetry });
  const server = createSeamServer(handler, { telemetry });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
  });
} catch (error) {
  const line =
    error instanceof StartupRefused ? error.message : 'control plane refused to start: failed';
  process.stderr.write(`${line}\n`);
  process.exit(1);
}
