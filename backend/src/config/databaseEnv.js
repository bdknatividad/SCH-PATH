/**
 * Database connection resolution
 * @module config/databaseEnv
 * @description Turns the environment into the five fields a MySQL client needs.
 *
 * Split out of `config/database.js` so the precedence rules can be tested
 * without opening a pool, and without `dotenv` re-injecting the developer's
 * `.env` over the values a test sets.
 */

/**
 * Connection details from a single URL, when one is provided.
 *
 * Managed MySQL providers hand out a `mysql://user:pass@host:port/db` string and
 * some (Railway, Heroku, Clever Cloud) expose it as `MYSQL_URL` / `DATABASE_URL`
 * rather than as separate fields. Reading it here means a deployment that only
 * has the URL still connects, instead of silently falling back to
 * `root@localhost` and failing at boot with a confusing ECONNREFUSED.
 *
 * @param {string|undefined|null} value
 * @returns {{host:?string,port:?number,user:?string,password:?string,database:?string}|null}
 */
function parseConnectionUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!/^mysql(s)?:$/.test(parsed.protocol)) return null;
    return {
      host: parsed.hostname || null,
      port: parsed.port ? Number(parsed.port) : null,
      user: parsed.username ? decodeURIComponent(parsed.username) : null,
      password: parsed.password ? decodeURIComponent(parsed.password) : null,
      database: parsed.pathname
        ? decodeURIComponent(parsed.pathname.replace(/^\//, '')) || null
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the five connection fields from an environment.
 *
 * Order, per field: explicit `DB_*` → the provider's own variable name → a
 * parsed connection URL → the local development default.
 *
 * The provider names matter because Railway's MySQL template publishes
 * `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD` and `MYSQLDATABASE`,
 * not `DB_*`. `railway.toml` used to document those as the source of truth while
 * `database.js` only ever read `DB_*`, so the deployment was reproducible only
 * from variables that lived in the Railway dashboard and nowhere in the
 * repository. A service that references them — or that has the URL — now starts
 * with no hand-entered values at all.
 *
 * An empty string counts as "not set", because that is what an unset variable
 * referenced into a service often looks like.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{host: string, port: number, user: string, password: string, database: string}}
 */
function resolveDatabaseEnv(env = {}) {
  const fromUrl =
    parseConnectionUrl(env.MYSQL_URL) || parseConnectionUrl(env.DATABASE_URL) || {};

  const pick = (dbName, mysqlName, urlValue, fallback) => {
    const direct = env[dbName];
    if (direct !== undefined && direct !== null && direct !== '') return direct;
    const provider = env[mysqlName];
    if (provider !== undefined && provider !== null && provider !== '') return provider;
    if (urlValue !== null && urlValue !== undefined && urlValue !== '') return urlValue;
    return fallback;
  };

  const rawPort = pick('DB_PORT', 'MYSQLPORT', fromUrl.port, 3306);
  // An unparseable port must not become NaN: mysql2 rejects a non-numeric port
  // at pool creation, and the failure surfaces as an opaque connection error
  // rather than as "DB_PORT is not a number".
  const parsedPort = Number(rawPort);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3306;

  return {
    host: String(pick('DB_HOST', 'MYSQLHOST', fromUrl.host, 'localhost')),
    port,
    user: String(pick('DB_USER', 'MYSQLUSER', fromUrl.user, 'root')),
    password: String(pick('DB_PASSWORD', 'MYSQLPASSWORD', fromUrl.password, '')),
    database: String(pick('DB_NAME', 'MYSQLDATABASE', fromUrl.database, 'sch_path_db')),
  };
}

module.exports = { parseConnectionUrl, resolveDatabaseEnv };
