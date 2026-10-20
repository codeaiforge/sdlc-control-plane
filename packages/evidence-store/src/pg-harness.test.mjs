import assert from 'node:assert/strict';
import test from 'node:test';
import { MISSING_SERVER, ROLES, requireAdminEnv, roleEnv, rolePassword } from './pg-harness.mjs';

// AC-20: the integration harness fails, and never skips, when no server is configured. Importing
// it connects to nothing, which is why this unit test can load it with no database at all.

test('the harness refuses to run without a cluster administrator in PG*', () => {
  assert.equal(
    MISSING_SERVER,
    'integration tests need PostgreSQL: set PGHOST/PGUSER/PGPASSWORD to a cluster administrator',
  );
  for (const env of [
    {},
    { PGHOST: '127.0.0.1' },
    { PGHOST: '127.0.0.1', PGUSER: 'postgres' },
    { PGHOST: '', PGUSER: 'postgres', PGPASSWORD: 'x' },
    { PGUSER: 'postgres', PGPASSWORD: 'x' },
  ])
    assert.throws(() => requireAdminEnv(env), { message: MISSING_SERVER }, JSON.stringify(env));
  assert.deepEqual(requireAdminEnv({ PGHOST: '127.0.0.1', PGUSER: 'postgres', PGPASSWORD: 'x' }), {
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGPASSWORD: 'x',
    PGDATABASE: 'postgres',
  });
});

test('role passwords are derived, so concurrent test processes agree without sharing a secret', () => {
  assert.deepEqual(ROLES, [
    'evidence_owner',
    'evidence_app',
    'evidence_retention',
    'evidence_audit',
  ]);
  const derived = ROLES.map((role) => rolePassword('admin-secret', role));
  assert.equal(new Set(derived).size, 4, 'one per role');
  for (const password of derived) assert.match(password, /^[0-9a-f]{64}$/);
  assert.equal(rolePassword('admin-secret', 'evidence_app'), derived[1], 'deterministic');
  assert.notEqual(rolePassword('other-secret', 'evidence_app'), derived[1]);
  const env = roleEnv('evidence_app', 'db1', {
    PGHOST: '127.0.0.1',
    PGPORT: '5433',
    PGUSER: 'postgres',
    PGPASSWORD: 'admin-secret',
  });
  assert.deepEqual(env, {
    PGHOST: '127.0.0.1',
    PGPORT: '5433',
    PGDATABASE: 'db1',
    PGUSER: 'evidence_app',
    PGPASSWORD: derived[1],
  });
});
