import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestHandler } from './main.mjs';

test('exposes health without requiring a network listener', async () => {
  let body = '';
  const handler = createRequestHandler({ registry: { list: () => [] }, policy: {}, evidence: [] });
  await handler({ method: 'GET', url: '/health' }, {
    writeHead: (status) => assert.equal(status, 200),
    end: (value) => { body = value; },
  });
  assert.deepEqual(JSON.parse(body), { status: 'ok' });
});
