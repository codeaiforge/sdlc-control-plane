// The one place the service's database connection is configured and opened (D-15, D-16, D-17).
//
// Configuration comes from the standard libpq variables in DATABASE_ENV and from nowhere else:
// these are deployment secrets and addresses, a different class from the verification constants
// task 2.1 keeps out of the environment. Everything that is policy - TLS, pool size, timeouts,
// statement preparation, debug output - is a literal here, and every driver option is passed
// explicitly, because postgres.js falls back to `process.env['PG' + OPTION]` for any option it is
// not given (PGSSL, PGDEBUG, PGMAX, ... - measured), which would let an unreviewed variable switch
// TLS off or turn on query logging. There is no connection string, so the password is never part
// of a value someone might log, and PGSSLMODE is not read: no variable can disable verification.
//
// TLS: verified (chain and hostname) for every host but a loopback one. Loopback is a literal
// address in 127.0.0.0/8, ::1, or a Unix-socket directory - not `localhost`, which is a name the
// resolver decides.

import { readFileSync } from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import postgres from 'postgres';
import {
  StartupRefused,
  assertSchemaCurrent,
  assertServiceRole,
  createPostgresEvidenceStore,
} from './postgres-store.mjs';

export { StartupRefused };

export const DATABASE_ENV = Object.freeze([
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLROOTCERT',
]);

// Literals, reviewed. connect_timeout and idle_timeout are seconds (the driver's unit).
const POOL_MAX = 10;
const IDLE_TIMEOUT_S = 30;
const CONNECT_TIMEOUT_S = 5;
const MAX_LIFETIME_S = 1800;
const APPLICATION_NAME = 'sdlc-control-plane';

export function isLoopback(host) {
  if (host.startsWith('/')) return true;
  if (host === '::1') return true;
  return isIPv4(host) && host.split('.')[0] === '127';
}

const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

// Pure but for reading the CA file a deployment names. Throws StartupRefused('config-invalid')
// with no value in the message: a host or a user name is not a secret, but nothing here
// distinguishes the variables it echoes from the one that is.
export function readDatabaseConfig(env = {}) {
  const read = Object.fromEntries(DATABASE_ENV.map((name) => [name, env[name]]));
  const { PGHOST: host, PGDATABASE: database, PGUSER: user, PGPASSWORD: password } = read;
  if (!nonEmpty(host) || !nonEmpty(database) || !nonEmpty(user))
    throw new StartupRefused('config-invalid');
  // One host. A comma would make the driver try several, and a colon would be read as a port.
  if (host.includes(',') || (host.includes(':') && isIP(host) !== 6))
    throw new StartupRefused('config-invalid');
  const port = read.PGPORT === undefined ? 5432 : Number(read.PGPORT);
  if (!/^\d+$/.test(read.PGPORT ?? '5432') || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new StartupRefused('config-invalid');
  if (password !== undefined && typeof password !== 'string')
    throw new StartupRefused('config-invalid');

  const loopback = isLoopback(host);
  let ssl = false;
  if (!loopback) {
    let ca;
    if (read.PGSSLROOTCERT !== undefined) {
      if (!nonEmpty(read.PGSSLROOTCERT)) throw new StartupRefused('config-invalid');
      try {
        ca = readFileSync(read.PGSSLROOTCERT);
      } catch {
        throw new StartupRefused('config-invalid');
      }
    }
    ssl = {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      // The driver sends no SNI for an IP and Node then checks the certificate against
      // 'localhost'; the identity check is pinned to the configured host instead.
      ...(isIP(host) ? {} : { servername: host }),
      checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
      ...(ca === undefined ? {} : { ca }),
    };
  }

  const options = {
    host: [host],
    port: [port],
    path: host.startsWith('/') ? `${host}/.s.PGSQL.${port}` : undefined,
    database,
    user,
    // A function, so an absent PGPASSWORD is an empty password rather than the driver reading
    // process.env.PGPASSWORD behind this module's back.
    password: () => password ?? '',
    ssl,
    sslnegotiation: null,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_S,
    connect_timeout: CONNECT_TIMEOUT_S,
    max_lifetime: MAX_LIFETIME_S,
    max_pipeline: 100,
    backoff: (retries) => (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20),
    keep_alive: 60,
    // Prepared statements are per connection; a transaction-pooling proxy in front of the server
    // breaks them, which stack.md states as a deploy-target constraint.
    prepare: true,
    // Off, and never from the environment: debug output carries every bound parameter.
    debug: false,
    fetch_types: false,
    publications: 'alltables',
    // A truthy value, so the driver does not read PGTARGETSESSIONATTRS; read-write is also what
    // an append needs: a read-only standby is refused at connect.
    target_session_attrs: 'read-write',
    types: {},
    connection: { application_name: APPLICATION_NAME },
    onnotice: () => {},
    onparameter: () => {},
  };
  return { options, loopback };
}

// A client for a role, with the service's rules. The migration CLI uses it too.
export function connect(env = process.env) {
  return postgres(readDatabaseConfig(env).options);
}

// The service's only constructor for its store. Refuses - exit 1, one fixed line from the caller -
// on a configuration it cannot use safely, an unreachable server, a connection that did not
// negotiate TLS where TLS is required, a role assertServiceRole refuses (an elevated attribute, a
// membership of any other role, an ownership, or a grant that could change or remove a stored row
// or set its received_at or redacted_at - its comment lists each), or a schema that is not exactly
// the one bundled. Then constructs the adapter with requireWorkspace, always.
export async function openDurableEvidenceStore({ env = process.env, client = postgres } = {}) {
  const { options, loopback } = readDatabaseConfig(env);
  const sql = client(options);
  try {
    await assertServiceRole(sql, { requireTls: !loopback });
    await assertSchemaCurrent(sql);
  } catch (error) {
    await Promise.resolve()
      .then(() => sql.end({ timeout: 1 }))
      .catch(() => {});
    if (error instanceof StartupRefused) throw error;
    throw new StartupRefused('database-unreachable', { cause: error });
  }
  return createPostgresEvidenceStore({ sql, requireWorkspace: true });
}
