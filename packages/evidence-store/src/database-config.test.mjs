import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import postgres from 'postgres';
import {
  DATABASE_ENV,
  StartupRefused,
  isLoopback,
  openDurableEvidenceStore,
  readDatabaseConfig,
} from './database-config.mjs';
import { loadMigrations } from './migrate.mjs';

// Unit tests, no database. That the service really refuses a role, a schema or an unverified
// connection on a live server is database-roles.integration.mjs's and
// durable-service.integration.mjs's; this file pins the configuration those rest on.

const SOURCE = readFileSync(new URL('./database-config.mjs', import.meta.url), 'utf8');
const CODE = SOURCE.split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');
const SENTINEL = 'CANARY-PGPASSWORD-not-for-logs';

const remote = (overrides = {}) => ({
  PGHOST: 'db.example.com',
  PGPORT: '5432',
  PGDATABASE: 'sdlc',
  PGUSER: 'evidence_app',
  PGPASSWORD: SENTINEL,
  ...overrides,
});
const local = (overrides = {}) => remote({ PGHOST: '127.0.0.1', ...overrides });
const refused = (code) => (error) => error instanceof StartupRefused && error.code === code;

test('the configuration reads exactly the six PG* variables, and nothing else', () => {
  assert.deepEqual(DATABASE_ENV, [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLROOTCERT',
  ]);
  const read = new Set();
  const env = new Proxy(remote(), {
    get(target, key) {
      read.add(key);
      return target[key];
    },
  });
  readDatabaseConfig(env);
  assert.deepEqual([...read].sort(), [...DATABASE_ENV].sort());
  // The two env defaults are the only process.env reads in the module, and no SSL mode is read.
  assert.deepEqual(
    [...CODE.matchAll(/process\.env\b[^\n]*/g)].map((match) => match[0].trim()),
    ['process.env) {', 'process.env, client = postgres } = {}) {'],
  );
  assert.doesNotMatch(CODE, /PGSSLMODE|sslmode/i);
});

// The driver's own defaults table, read from its source, so an upgrade that adds an option the
// environment can set fails here rather than becoming a variable nobody reviewed.
function driverDefaults() {
  const source = readFileSync(fileURLToPath(import.meta.resolve('postgres')), 'utf8');
  const block = /const defaults = \{([\s\S]*?)\n\s*\}/.exec(source)[1];
  return [...block.matchAll(/^\s*(\w+)\s*:/gm)].map((match) => match[1]);
}

test('every option the driver would take from the environment is passed explicitly', () => {
  const defaults = driverDefaults();
  assert.ok(defaults.includes('ssl') && defaults.includes('debug'), 'parsed the defaults table');
  const { options } = readDatabaseConfig(remote());
  for (const key of [...defaults, 'host', 'port', 'database', 'user', 'password'])
    assert.ok(Object.hasOwn(options, key), `${key} is left to the driver's environment fallback`);
  assert.equal(typeof options.password, 'function', 'an empty password is not an env fallback');
  assert.ok(
    options.target_session_attrs,
    'a falsy value would let the driver read the environment',
  );
  assert.equal(options.connection.application_name, 'sdlc-control-plane');
  assert.equal(options.debug, false);
  assert.equal(options.prepare, true);
  assert.equal(options.max, 10);
  assert.equal(options.connect_timeout, 5);
});

test('a poisoned environment changes nothing the driver is given', (t) => {
  const poison = {
    PGSSL: 'disable',
    PGSSLMODE: 'disable',
    PGDEBUG: 'true',
    PGMAX: '500',
    PGPREPARE: 'false',
    PGIDLE_TIMEOUT: '0',
    PGCONNECT_TIMEOUT: '3600',
    PGAPPNAME: 'spoofed',
    PGTARGETSESSIONATTRS: 'standby',
    PGPASSWORD: 'from-process-env',
    PGHOST: 'evil.example.com',
  };
  const saved = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  Object.assign(process.env, poison);
  const sql = postgres(readDatabaseConfig(remote({ PGPASSWORD: undefined })).options);
  t.after(() => sql.end({ timeout: 0 }));
  const seen = sql.options;
  assert.deepEqual(seen.host, ['db.example.com']);
  assert.equal(seen.ssl.rejectUnauthorized, true);
  assert.equal(seen.debug, false);
  assert.equal(seen.max, 10);
  assert.equal(seen.prepare, true);
  assert.equal(seen.idle_timeout, 30);
  assert.equal(seen.connect_timeout, 5);
  assert.equal(seen.connection.application_name, 'sdlc-control-plane');
  assert.equal(seen.target_session_attrs, 'read-write');
  assert.equal(typeof seen.pass, 'function');
  assert.equal(seen.pass(), '', 'PGPASSWORD from process.env never reaches the driver');
});

test('loopback is a literal 127.0.0.0/8 address, ::1 or a socket directory - never a name', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', '/var/run/postgresql'])
    assert.equal(isLoopback(host), true, host);
  for (const host of [
    'localhost',
    'db.example.com',
    '127.example.com',
    '10.0.0.1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
    '128.0.0.1',
  ])
    assert.equal(isLoopback(host), false, host);
});

test('a loopback host may connect without TLS; a socket directory becomes a socket path', () => {
  assert.equal(readDatabaseConfig(local()).options.ssl, false);
  assert.equal(readDatabaseConfig(local()).loopback, true);
  const socket = readDatabaseConfig(local({ PGHOST: '/var/run/postgresql', PGPORT: '5433' }));
  assert.equal(socket.options.path, '/var/run/postgresql/.s.PGSQL.5433');
  assert.equal(socket.options.ssl, false);
});

test('every non-loopback host verifies the chain and the hostname, whatever else is set', () => {
  const extras = [
    {},
    { PGSSLMODE: 'disable' },
    { PGSSL: 'false' },
    { PGSSLMODE: 'require', PGSSL: 'disable' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ];
  for (const host of ['db.example.com', 'localhost', '10.0.0.5', '2001:db8::1'])
    for (const extra of extras) {
      const { options, loopback } = readDatabaseConfig(remote({ PGHOST: host, ...extra }));
      assert.equal(loopback, false);
      assert.equal(typeof options.ssl, 'object', `${host} ${JSON.stringify(extra)}`);
      assert.equal(options.ssl.rejectUnauthorized, true);
      assert.equal(options.ssl.minVersion, 'TLSv1.2');
      assert.equal(typeof options.ssl.checkServerIdentity, 'function');
    }
});

test('the hostname check is pinned to the configured host, IP hosts included', () => {
  const cert = (name) => ({ subject: { CN: name }, subjectaltname: `DNS:${name}` });
  const named = readDatabaseConfig(remote()).options.ssl;
  assert.equal(named.servername, 'db.example.com');
  assert.equal(named.checkServerIdentity('ignored', cert('db.example.com')), undefined);
  assert.ok(
    named.checkServerIdentity('db.example.com', cert('other.example.com')) instanceof Error,
  );
  const ip = readDatabaseConfig(remote({ PGHOST: '10.0.0.5' })).options.ssl;
  assert.equal(Object.hasOwn(ip, 'servername'), false, 'no SNI for an IP');
  // Node would otherwise check an IP host's certificate against 'localhost'.
  assert.ok(ip.checkServerIdentity('localhost', cert('localhost')) instanceof Error);
  assert.equal(
    ip.checkServerIdentity('localhost', { subject: {}, subjectaltname: 'IP Address:10.0.0.5' }),
    undefined,
  );
});

test('PGSSLROOTCERT names the CA bundle; an unreadable one refuses to start', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-ca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ca.pem');
  writeFileSync(file, '-----BEGIN CERTIFICATE-----\nnot really\n-----END CERTIFICATE-----\n');
  assert.equal(
    readDatabaseConfig(remote({ PGSSLROOTCERT: file })).options.ssl.ca.toString(),
    readFileSync(file, 'utf8'),
  );
  for (const value of [join(dir, 'absent.pem'), ''])
    assert.throws(
      () => readDatabaseConfig(remote({ PGSSLROOTCERT: value })),
      refused('config-invalid'),
    );
});

test('an unusable configuration is refused with a fixed message that carries no value', () => {
  for (const env of [
    remote({ PGHOST: undefined }),
    remote({ PGHOST: '' }),
    remote({ PGDATABASE: undefined }),
    remote({ PGUSER: undefined }),
    remote({ PGPORT: 'abc' }),
    remote({ PGPORT: '0' }),
    remote({ PGPORT: '70000' }),
    remote({ PGPORT: '5432.5' }),
    remote({ PGHOST: 'a.example.com,b.example.com' }),
    remote({ PGHOST: 'db.example.com:6432' }),
    {},
  ]) {
    const error = (() => {
      try {
        readDatabaseConfig(env);
      } catch (thrown) {
        return thrown;
      }
      return assert.fail(`accepted ${JSON.stringify({ ...env, PGPASSWORD: undefined })}`);
    })();
    assert.ok(refused('config-invalid')(error));
    assert.equal(error.message, 'control plane refused to start: config-invalid');
    for (const value of Object.values(env).filter(Boolean))
      assert.equal(error.message.includes(value), false);
  }
});

// A fake client for openDurableEvidenceStore: answers the startup checks from a catalog and
// records every statement, so the store it returns can be held to requireWorkspace.
function fakeClient({ role = {}, privileges = {}, fail } = {}) {
  const calls = [];
  let ended = false;
  const bundled = loadMigrations().map(({ version, checksum }) => ({ version, checksum }));
  const sql = (strings) => {
    const text = strings.join('?');
    calls.push(text);
    if (fail) return Promise.reject(fail);
    if (text.includes('pg_stat_ssl'))
      return Promise.resolve([
        { superuser: false, schema_present: true, owns: false, ssl: false, ...role },
      ]);
    if (text.includes('has_any_column_privilege'))
      return Promise.resolve([{ rewrites: false, appends: true, ...privileges }]);
    if (text.includes('to_regclass')) return Promise.resolve([{ present: true }]);
    if (text.includes('schema_migrations')) return Promise.resolve(bundled);
    return Promise.resolve([]);
  };
  sql.end = async () => {
    ended = true;
  };
  const client = (options) => {
    client.options = options;
    return sql;
  };
  return { client, calls, ended: () => ended };
}

test('the durable store the service opens always refuses a null workspace_id (AC-14)', async () => {
  const fake = fakeClient();
  const store = await openDurableEvidenceStore({ env: local(), client: fake.client });
  const before = fake.calls.length;
  assert.throws(
    () => store.append({ change_id: 'PR-1' }),
    (error) =>
      error.name === 'EvidenceStoreFault' && /workspace_id is required/.test(error.message),
  );
  assert.equal(fake.calls.length, before, 'refused before any statement');
  assert.deepEqual(Object.keys(store).sort(), ['append', 'list', 'listRecords']);
});

test('TLS is required on the live connection exactly when the host is not loopback', async () => {
  // The fake reports ssl = false: fine on loopback, refused anywhere else.
  await openDurableEvidenceStore({ env: local(), client: fakeClient().client });
  const remoteFake = fakeClient();
  await assert.rejects(
    openDurableEvidenceStore({ env: remote(), client: remoteFake.client }),
    refused('tls-not-negotiated'),
  );
  assert.equal(remoteFake.ended(), true, 'the refused client is closed');
  await openDurableEvidenceStore({
    env: remote(),
    client: fakeClient({ role: { ssl: true } }).client,
  });
});

test('an unreachable server, an unsafe role or a stale schema refuses to start without a driver message', async () => {
  const driverError = Object.assign(new Error(`connect ECONNREFUSED ${SENTINEL}`), {
    code: 'ECONNREFUSED',
  });
  const unreachable = fakeClient({ fail: driverError });
  const error = await openDurableEvidenceStore({ env: local(), client: unreachable.client }).then(
    () => assert.fail('started'),
    (rejection) => rejection,
  );
  assert.ok(refused('database-unreachable')(error));
  assert.equal(error.message, 'control plane refused to start: database-unreachable');
  assert.equal(unreachable.ended(), true);
  await assert.rejects(
    openDurableEvidenceStore({ env: local(), client: fakeClient({ role: { owns: true } }).client }),
    refused('role-unsafe'),
  );
  await assert.rejects(
    openDurableEvidenceStore({
      env: local(),
      client: fakeClient({ privileges: { rewrites: true } }).client,
    }),
    refused('role-unsafe'),
  );
  await assert.rejects(
    openDurableEvidenceStore({ env: local({ PGUSER: undefined }), client: fakeClient().client }),
    refused('config-invalid'),
  );
});

test('the migration CLI refuses an unusable configuration with its code, before connecting', () => {
  const script = new URL('./migrate.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, 'migrate'], {
    env: { PATH: process.env.PATH, PGPASSWORD: SENTINEL },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'migrate refused: config-invalid\n');
  assert.equal(result.stdout, '');
});
