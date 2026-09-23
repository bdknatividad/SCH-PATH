/**
 * Database connection resolution.
 *
 * The deployment target publishes the database as `MYSQLHOST`, `MYSQLUSER`,
 * `MYSQLPASSWORD`, `MYSQLDATABASE` and `MYSQL_URL`, while this application reads
 * `DB_*`. Until these rules existed, `railway.toml` documented the provider's
 * variables as the source of truth and the code ignored them — so a fresh
 * deployment booted against `root@localhost` with a database name that did not
 * exist, and the only way to find the real values was the hosting dashboard.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseConnectionUrl, resolveDatabaseEnv } = require('../src/config/databaseEnv');

test('explicit DB_* variables win over everything else', () => {
  const resolved = resolveDatabaseEnv({
    DB_HOST: 'db.internal',
    DB_PORT: '3307',
    DB_USER: 'app',
    DB_PASSWORD: 'secret',
    DB_NAME: 'sch_path',
    MYSQLHOST: 'ignored.internal',
    MYSQLUSER: 'ignored',
    MYSQLPASSWORD: 'ignored',
    MYSQLDATABASE: 'ignored',
    MYSQL_URL: 'mysql://ignored:ignored@ignored.internal:3306/ignored',
  });

  assert.deepEqual(resolved, {
    host: 'db.internal',
    port: 3307,
    user: 'app',
    password: 'secret',
    database: 'sch_path',
  });
});

test("the provider's own variable names are used when DB_* is absent", () => {
  const resolved = resolveDatabaseEnv({
    MYSQLHOST: 'mysql.railway.internal',
    MYSQLPORT: '3306',
    MYSQLUSER: 'root',
    MYSQLPASSWORD: 'railway-password',
    MYSQLDATABASE: 'railway',
  });

  assert.deepEqual(resolved, {
    host: 'mysql.railway.internal',
    port: 3306,
    user: 'root',
    password: 'railway-password',
    database: 'railway',
  });
});

test('a connection URL is parsed when no separate fields are set', () => {
  const resolved = resolveDatabaseEnv({
    MYSQL_URL: 'mysql://root:s3cr3t@shuttle.proxy.rlwy.net:22738/railway',
  });

  assert.deepEqual(resolved, {
    host: 'shuttle.proxy.rlwy.net',
    port: 22738,
    user: 'root',
    password: 's3cr3t',
    database: 'railway',
  });
});

test('URL-encoded credentials survive the round trip', () => {
  const resolved = resolveDatabaseEnv({
    DATABASE_URL: 'mysql://app:p%40ss%2Fword@host.internal:3306/db',
  });

  assert.equal(resolved.user, 'app');
  assert.equal(resolved.password, 'p@ss/word');
});

test('separate fields win over a URL that is also present', () => {
  const resolved = resolveDatabaseEnv({
    MYSQL_URL: 'mysql://url-user:url-pass@url-host:3306/url-db',
    MYSQLUSER: 'field-user',
    MYSQLHOST: 'field-host',
  });

  assert.equal(resolved.user, 'field-user');
  assert.equal(resolved.host, 'field-host');
  // Fields not provided separately still come from the URL.
  assert.equal(resolved.password, 'url-pass');
  assert.equal(resolved.database, 'url-db');
});

test('an empty string counts as unset, not as a value', () => {
  // Referencing a variable that does not exist yields an empty string on several
  // hosts, and an empty host would produce an unactionable connection error.
  const resolved = resolveDatabaseEnv({
    DB_HOST: '',
    DB_USER: '',
    MYSQLHOST: 'fallback.internal',
    MYSQLUSER: 'fallback-user',
  });

  assert.equal(resolved.host, 'fallback.internal');
  assert.equal(resolved.user, 'fallback-user');
});

test('nothing set falls back to the local development defaults', () => {
  assert.deepEqual(resolveDatabaseEnv({}), {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    database: 'sch_path_db',
  });
});

test('a non-MySQL URL is ignored rather than half-parsed', () => {
  assert.equal(parseConnectionUrl('postgres://user:pass@host:5432/db'), null);
  assert.equal(parseConnectionUrl('not a url'), null);
  assert.equal(parseConnectionUrl(''), null);
  assert.equal(parseConnectionUrl(undefined), null);

  const resolved = resolveDatabaseEnv({ DATABASE_URL: 'postgres://user:pass@host:5432/db' });
  assert.equal(resolved.host, 'localhost', 'a PostgreSQL URL must not be treated as the MySQL target');
});

test('an unusable port falls back to the MySQL default', () => {
  // `Number('abc')` is NaN, and a NaN port makes mysql2 throw at pool creation.
  const resolved = resolveDatabaseEnv({ DB_HOST: 'h', DB_PORT: 'abc' });
  assert.ok(Number.isFinite(resolved.port), 'port must be a finite number');
});
