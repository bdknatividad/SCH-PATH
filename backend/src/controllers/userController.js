const bcrypt = require('bcrypt');
/**
 * User Controller
 * @module controllers/userController
 * @description User authentication and management operations
 */

const { pool } = require('../config/database');
const { generateToken } = require('../middleware/auth');
const { mapRow, insertWithGeneratedId } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const { normalizeRole, isSupportedRole } = require('../utils/authorization');
const { assertPassword } = require('../utils/passwordPolicy');
const {
  defaultsForRole,
  canonicalizeModules,
  canonicalizeTabs,
  canonicalizeSubModules,
} = require('../utils/accessDefaults');
const { USER_ROLES } = require('../utils/constants');
const {
  buildAccessSnapshot,
  listAccessibleMenus,
  isFullAccessRole,
  normalizeModuleKey,
  MODULE_KEYS,
} = require('../config/rbac');

/**
 * The complete set of module grants, used for full-access roles so a new
 * module is never missing from an existing Center Head account.
 */
const ALL_MODULE_GRANTS = [...MODULE_KEYS, 'Intervention Tracker'];

/**
 * The only values `users.status` accepts.
 *
 * The column is an ENUM, so an unrecognised value would reach MySQL and come
 * back as a database error — a 500 for what is really a bad request. Validating
 * here turns it into the 400 the client can act on.
 */
const USER_STATUSES = ['Active', 'Inactive'];

/**
 * Resolve the per-module submenu grants to persist for an account.
 *
 * Every granted module gets the role's declared submenus by default, so
 * granting a module never leaves a user staring at a menu with nothing under
 * it. An explicit request (or a legacy `childRecordTabs` list) narrows it.
 *
 * @param {{role:string, modules:string[], requested?:unknown, childRecordTabs?:unknown}} input
 * @returns {Record<string, string[]>}
 */
function resolveSubModuleGrants({ role, modules, requested, childRecordTabs }) {
  const defaults = defaultsForRole(role);
  const grants = {};
  for (const moduleName of modules) {
    const key = normalizeModuleKey(moduleName);
    if (!key) continue;
    grants[key] = [...(defaults.subModules[key] || [])];
  }

  if (requested && typeof requested === 'object' && !Array.isArray(requested)) {
    for (const [moduleName, value] of Object.entries(requested)) {
      const key = normalizeModuleKey(moduleName);
      if (!key) continue;
      grants[key] = canonicalizeSubModules(key, value, grants[key] || []);
    }
  }

  // `childRecordTabs` is the legacy, single-module form of the same grant.
  if (childRecordTabs !== undefined) {
    grants['Child Records'] = canonicalizeSubModules(
      'Child Records',
      childRecordTabs,
      defaults.childRecordTabs,
    );
  }

  return grants;
}

/**
 * Read user rows including the RBAC grant columns.
 *
 * A database provisioned before `subModules` existed would reject the column,
 * so the read retries without it. Losing that column only costs the per-tab
 * overrides — the role's declared matrix still answers every access check.
 *
 * @param {string} whereClause - e.g. `WHERE id = ?` (omit to read every row)
 * @param {unknown[]} [params]
 * @param {{orderBy?:string}} [options]
 */
async function selectUsers(whereClause = '', params = [], options = {}) {
  const order = options.orderBy ? ` ORDER BY ${options.orderBy}` : '';
  const withSubModules = `SELECT id, username, displayName, role, accessibleModules, childRecordTabs, subModules, status, createdDate FROM users ${whereClause}${order}`;
  const withoutSubModules = `SELECT id, username, displayName, role, accessibleModules, childRecordTabs, status, createdDate FROM users ${whereClause}${order}`;
  try {
    const [rows] = await pool.query(withSubModules, params);
    return rows;
  } catch {
    const [rows] = await pool.query(withoutSubModules, params);
    return rows;
  }
}

/**
 * User login with username and password
 * @async
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      throw new ApiError(400, 'Username and password are required');
    }

    // Fetch by username only, verify password separately
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    if (rows.length === 0) {
      throw new ApiError(401, 'Invalid username or password');
    }

    const dbUser = rows[0];
    const storedPw = dbUser.password || '';

    // Support both hashed and legacy plain text passwords
    let passwordMatch = false;
    if (storedPw.startsWith('$2b$') || storedPw.startsWith('$2a$')) {
      passwordMatch = await bcrypt.compare(password, storedPw);
    } else {
      passwordMatch = (password === storedPw);
      if (passwordMatch) {
        // Silently upgrade to hashed on first login
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, dbUser.id]);
        dbUser.password = hashed;
      }
    }

    if (!passwordMatch) {
      throw new ApiError(401, 'Invalid username or password');
    }

    const user = mapRow('users', dbUser);

    if (user.status !== 'Active') {
      throw new ApiError(401, 'Account is inactive. Please contact administrator.');
    }

    // Generate JWT token
    const token = generateToken(user);

    // Ship the resolved access snapshot with the session. The client renders
    // exactly these capabilities instead of re-deriving them, so the sidebar,
    // the route guards and the API's own 403s cannot drift apart.
    const access = buildAccessSnapshot({
      role: user.role,
      accessibleModules: user.accessibleModules,
      childRecordTabs: user.childRecordTabs,
      subModules: user.subModules,
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          fullName: user.displayName || null,
          username: user.username,
          role: normalizeRole(user.role),
          accessibleModules: user.accessibleModules,
          childRecordTabs: user.childRecordTabs || [],
          subModules: user.subModules || {},
          fullAccess: access.fullAccess,
          permissions: access.permissions,
          menus: listAccessibleMenus(access),
        },
        access,
        token,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Register new user
 * @async
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
async function register(req, res, next) {
  try {
    const { password: rawPassword, role, accessibleModules } = req.body || {};
    const username = String(req.body?.username ?? '').trim();
    const displayName = (req.body?.displayName ?? req.body?.fullName ?? '').toString().trim();
    const normalizedUserRole = normalizeRole(role);
    const requestedModules = canonicalizeModules(Array.isArray(accessibleModules) ? accessibleModules : []);
    const roleDefaults = defaultsForRole(normalizedUserRole);
    // Canonicalized, so an unknown module key cannot be stored: a grant the rest
    // of the system cannot read is a broken permission configuration. A request
    // that canonicalizes away to nothing falls back to the role's own grants.
    const normalizedModules = isFullAccessRole(normalizedUserRole)
      ? ALL_MODULE_GRANTS
      : (requestedModules.length > 0 ? requestedModules : roleDefaults.modules);
    if (!isSupportedRole(normalizedUserRole, USER_ROLES)) {
      throw new ApiError(400, `Unsupported user role. Allowed roles: ${USER_ROLES.join(', ')}`);
    }
    // Trimmed first, so "  " is a missing username rather than a stored blank
    // one that no later uniqueness check can match.
    if (!username) {
      throw new ApiError(400, 'Username is required');
    }
    // Only judged when a password is actually supplied: the account may be
    // created first and given a password later, which is how the seed data and
    // the tests provision users.
    if (rawPassword) assertPassword(rawPassword, { username });
    const password = rawPassword ? await bcrypt.hash(rawPassword, 10) : null;

    // Check if username exists
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      throw new ApiError(409, 'Username already exists');
    }

    const { childRecordTabs: newUserTabs, subModules: newUserSubModules } = req.body || {};
    const normalizedSubModules = resolveSubModuleGrants({
      role: normalizedUserRole,
      modules: normalizedModules,
      requested: newUserSubModules,
      childRecordTabs: newUserTabs,
    });

    // The id is allocated inside insertWithGeneratedId(), which re-reads the id
    // list and recomputes on a duplicate-key collision instead of 500-ing. Two
    // concurrent registrations used to derive the same id from the same read.
    //
    // The column fallbacks stay inside the insert callback rather than being a
    // second retry: a database provisioned before childRecordTabs/subModules
    // existed rejects the column, and that must not be mistaken for an id
    // collision and answered with a different id.
    const userId = await insertWithGeneratedId(pool, {
      table: 'users',
      prefix: 'U',
      insert: async (generatedId) => {
        const createdBy = req.user?.username || 'System';
        const tabs = JSON.stringify(normalizedSubModules['Child Records'] || []);
        try {
          await pool.query(
            `INSERT INTO users (id, username, displayName, password, role, accessibleModules, childRecordTabs, subModules, status, createdDate, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Active', NOW(), ?)`,
            [generatedId, username, displayName || null, password, normalizedUserRole, JSON.stringify(normalizedModules), tabs, JSON.stringify(normalizedSubModules), createdBy]
          );
        } catch (sqlErr) {
          if (sqlErr.code !== 'ER_BAD_FIELD_ERROR') throw sqlErr;
          if (sqlErr.message.includes('subModules')) {
            await pool.query(
              `INSERT INTO users (id, username, displayName, password, role, accessibleModules, childRecordTabs, status, createdDate, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', NOW(), ?)`,
              [generatedId, username, displayName || null, password, normalizedUserRole, JSON.stringify(normalizedModules), tabs, createdBy]
            );
            return;
          }
          if (sqlErr.message.includes('childRecordTabs')) {
            await pool.query(
              `INSERT INTO users (id, username, password, role, accessibleModules, status, createdDate, createdBy) VALUES (?, ?, ?, ?, ?, 'Active', NOW(), ?)`,
              [generatedId, username, password, normalizedUserRole, JSON.stringify(normalizedModules), createdBy]
            );
            return;
          }
          throw sqlErr;
        }
      },
    });

    // Fetch the created user
    const rows = await selectUsers('WHERE id = ?', [userId]);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: mapRow('users', rows[0]),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get current user profile
 * @async
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
async function getProfile(req, res, next) {
  try {
    const rows = await selectUsers('WHERE id = ?', [req.user.id]);

    if (rows.length === 0) {
      throw new ApiError(404, 'User not found');
    }

    res.json({
      success: true,
      data: mapRow('users', rows[0]),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update user profile
 * @async
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
async function updateProfile(req, res, next) {
  try {
    const { password, currentPassword, accessibleModules } = req.body || {};
    const updates = [];
    const values = [];

    if (password) {
      // A password change is only accepted alongside the current password.
      //
      // This endpoint is `authenticate`-only, so without the check it was a
      // password-change bypass: a stolen or leaked token was enough to set a new
      // password and lock the real owner out, and POST /change-password — which
      // does verify — could simply be skipped.
      const [pwRows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
      if (!pwRows || pwRows.length === 0) throw new ApiError(404, 'User not found');
      const storedPw = pwRows[0].password || '';
      const matches = storedPw.startsWith('$2')
        ? await bcrypt.compare(String(currentPassword ?? ''), storedPw)
        : String(currentPassword ?? '') === storedPw;
      if (!matches) {
        throw new ApiError(401, 'Current password is incorrect');
      }

      assertPassword(password, { username: req.user?.username });
      updates.push('password = ?');
      values.push(await bcrypt.hash(password, 10));
    }

    if (accessibleModules) {
      const role = normalizeRole(req.user?.role);
      const fixedRoleModules = ['nurse', 'educator', 'houseparent'];
      // Canonicalized, so a client cannot write a module key the rest of the
      // system cannot read. An empty result falls back to the role's grants.
      const requested = canonicalizeModules(accessibleModules);
      const modules = fixedRoleModules.includes(role)
        ? defaultsForRole(role).modules
        : (requested.length > 0 ? requested : defaultsForRole(role).modules);
      updates.push('accessibleModules = ?');
      values.push(JSON.stringify(modules));
    }

    if (updates.length === 0) {
      throw new ApiError(400, 'No fields to update');
    }

    updates.push('modifiedBy = ?');
    values.push(req.user.username);
    values.push(req.user.id);

    await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Change user password
 * @async
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};

    // Verify current password (bcrypt-aware)
    const [pwRows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!pwRows || pwRows.length === 0) throw new ApiError(404, 'User not found');
    const storedPw = pwRows[0].password || '';
    let pwMatch = false;
    // Every bcrypt variant, not just $2a$/$2b$ — a hash written by another
    // bcrypt build (php's $2y$) would otherwise be compared as plaintext.
    if (storedPw.startsWith('$2')) {
      pwMatch = await bcrypt.compare(String(currentPassword ?? ''), storedPw);
    } else {
      pwMatch = (currentPassword === storedPw);
    }
    if (!pwMatch) {
      throw new ApiError(401, 'Current password is incorrect');
    }

    assertPassword(newPassword, { username: req.user?.username });
    const newHashed = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password = ?, modifiedBy = ? WHERE id = ?',
      [newHashed, req.user.username, req.user.id]
    );

    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get user by ID
 * @async
 */
async function getById(req, res, next) {
  try {
    const { id } = req.params;
    const rows = await selectUsers('WHERE id = ?', [id]);
    if (rows.length === 0) throw new ApiError(404, 'User not found');
    res.json({ success: true, data: mapRow('users', rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * Update user by ID (username, password, role, accessibleModules, status)
 * @async
 */
async function updateById(req, res, next) {
  try {
    const { id } = req.params;
    const { password, role, accessibleModules, childRecordTabs, subModules, status } = req.body || {};
    // Trimmed here rather than at each use, so the uniqueness probe, the UPDATE
    // and the fallback path all compare the same string. A whitespace-only
    // username is a blank account nobody can log into, so it is refused.
    const username = req.body?.username === undefined ? undefined : String(req.body.username ?? '').trim();
    const displayName = req.body?.displayName !== undefined
      ? String(req.body.displayName || '').trim()
      : (req.body?.fullName !== undefined ? String(req.body.fullName || '').trim() : undefined);

    if (username !== undefined && username.length === 0) {
      throw new ApiError(400, 'Username is required');
    }

    // Check target exists. The current schema uses displayName; older databases
    // may not have that column yet, so determine the actual column before
    // building the UPDATE. Never reference users.fullName here.
    const [userColumns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    const userColumnNames = new Set(userColumns.map(column => String(column.COLUMN_NAME)));
    const hasDisplayName = userColumnNames.has('displayName');

    const [existing] = await pool.query('SELECT id, role, username FROM users WHERE id = ?', [id]);
    if (existing.length === 0) throw new ApiError(404, 'User not found');

    // Username uniqueness check
    if (username) {
      const [conflict] = await pool.query(
        'SELECT id FROM users WHERE username = ? AND id != ?',
        [username, id]
      );
      if (conflict.length > 0) throw new ApiError(409, 'Username already taken by another account');
    }

    // Validate every field before any of them is written, so a request that
    // carries one bad value cannot leave half an edit behind.
    const normalizedStatus = status === undefined ? undefined : String(status).trim();
    if (normalizedStatus !== undefined && !USER_STATUSES.includes(normalizedStatus)) {
      throw new ApiError(400, `Unsupported account status. Allowed statuses: ${USER_STATUSES.join(', ')}`);
    }
    if (role) {
      const normalizedRole = normalizeRole(role);
      if (!isSupportedRole(normalizedRole, USER_ROLES)) {
        throw new ApiError(400, `Unsupported user role. Allowed roles: ${USER_ROLES.join(', ')}`);
      }
    }
    if (password) {
      assertPassword(password, { username: username || existing[0].username });
    }

    const updates = [];
    const values = [];

    if (username) { updates.push('username = ?'); values.push(username); }
    if (displayName !== undefined && hasDisplayName) {
      const normalizedDisplayName = displayName || null;
      updates.push('displayName = ?');
      values.push(normalizedDisplayName);
      if (userColumnNames.has('fullName')) {
        updates.push('fullName = ?');
        values.push(normalizedDisplayName);
      }
    }
    if (password) { updates.push('password = ?'); values.push(await bcrypt.hash(password, 10)); }
    const finalRole = role ? normalizeRole(role) : normalizeRole(existing[0].role);

    if (role) {
      updates.push('role = ?'); values.push(finalRole);
    }
    // Resolve the grants once, then write them. Deriving them together is what
    // keeps accessibleModules, childRecordTabs and subModules consistent with
    // each other instead of each block guessing at the other's intent.
    const touchesGrants =
      accessibleModules !== undefined ||
      childRecordTabs !== undefined ||
      subModules !== undefined ||
      Boolean(role);

    let resolvedModules = null;
    let resolvedTabs = null;
    if (touchesGrants) {
      const roleDefaults = defaultsForRole(finalRole);
      const requestedModules = canonicalizeModules(accessibleModules);
      // A full-access role keeps every module. Unioning with the role's declared
      // grants (rather than trusting the request alone) is what stops a
      // malformed or truncated module list from quietly stripping a Center Head
      // of the system.
      resolvedModules = isFullAccessRole(finalRole)
        ? Array.from(new Set([...requestedModules, ...roleDefaults.modules, 'Account Management']))
        : (requestedModules.length > 0 ? requestedModules : roleDefaults.modules);

      // Roles whose tab set is fixed by policy keep their declared tabs.
      const fixedRoleTabs = ['nurse', 'educator', 'houseparent'];
      const requestedTabs = canonicalizeTabs(childRecordTabs);
      resolvedTabs = fixedRoleTabs.includes(finalRole)
        ? roleDefaults.childRecordTabs
        : (requestedTabs.length > 0 ? requestedTabs : roleDefaults.childRecordTabs);

      updates.push('accessibleModules = ?');
      values.push(JSON.stringify(resolvedModules));

      updates.push('childRecordTabs = ?');
      values.push(JSON.stringify(resolvedTabs));

      updates.push('subModules = ?');
      values.push(
        JSON.stringify(
          resolveSubModuleGrants({
            role: finalRole,
            modules: resolvedModules,
            requested: subModules,
            childRecordTabs: resolvedTabs,
          }),
        ),
      );
    }
    if (normalizedStatus !== undefined) { updates.push('status = ?'); values.push(normalizedStatus); }

    if (updates.length === 0) throw new ApiError(400, 'No fields to update');

    updates.push('modifiedBy = ?');
    values.push(req.user?.username || 'System');
    values.push(id);

    try {
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    } catch (sqlErr) {
      // A column this build writes may not exist yet (childRecordTabs and
      // subModules both arrived by migration). Retry with only the columns the
      // table actually has, so a grant edit still lands instead of 500-ing.
      const missingGrantColumn =
        sqlErr.code === 'ER_BAD_FIELD_ERROR' &&
        (sqlErr.message.includes('childRecordTabs') || sqlErr.message.includes('subModules'));
      if (missingGrantColumn) {
        const safeUpdates = [];
        const safeValues = [];
        if (username) { safeUpdates.push('username = ?'); safeValues.push(username); }
        if (displayName !== undefined && hasDisplayName) {
          safeUpdates.push('displayName = ?');
          safeValues.push(displayName || null);
        }
        if (password) { safeUpdates.push('password = ?'); safeValues.push(await bcrypt.hash(password, 10)); }
        if (role) { safeUpdates.push('role = ?'); safeValues.push(finalRole); }
        if (accessibleModules !== undefined) {
          safeUpdates.push('accessibleModules = ?');
          safeValues.push(JSON.stringify(resolvedModules || defaultsForRole(finalRole).modules));
        }
        if (userColumnNames.has('childRecordTabs') && resolvedTabs) {
          safeUpdates.push('childRecordTabs = ?');
          safeValues.push(JSON.stringify(resolvedTabs));
        }
        if (userColumnNames.has('subModules') && resolvedTabs) {
          safeUpdates.push('subModules = ?');
          safeValues.push(
            JSON.stringify(
              resolveSubModuleGrants({
                role: finalRole,
                modules: resolvedModules || [],
                requested: subModules,
                childRecordTabs: resolvedTabs,
              }),
            ),
          );
        }
        if (normalizedStatus !== undefined) { safeUpdates.push('status = ?'); safeValues.push(normalizedStatus); }
        if (safeUpdates.length === 0) throw new ApiError(400, 'No fields to update');
        safeUpdates.push('modifiedBy = ?');
        safeValues.push(req.user?.username || 'System');
        safeValues.push(id);
        await pool.query(`UPDATE users SET ${safeUpdates.join(', ')} WHERE id = ?`, safeValues);
      } else {
        throw sqlErr;
      }
    }

    const rows = await selectUsers('WHERE id = ?', [id]);

    res.json({ success: true, message: 'User updated successfully', data: mapRow('users', rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * Update only module/tab access for a user.
 * This deliberately uses a narrow UPDATE so Account Management permission
 * changes do not depend on legacy user-name fields from older schemas.
 */
async function updateAccess(req, res, next) {
  try {
    const { id } = req.params;
    const { accessibleModules, childRecordTabs, subModules, displayName } = req.body || {};

    const [existing] = await pool.query(
      'SELECT id, role FROM users WHERE id = ?',
      [id]
    );
    if (!existing.length) throw new ApiError(404, 'User not found');

    const role = normalizeRole(existing[0].role);
    const roleDefaults = defaultsForRole(role);
    const requestedModules = Array.isArray(accessibleModules)
      ? accessibleModules
      : roleDefaults.modules;
    const canonicalModules = canonicalizeModules(requestedModules);
    // A full-access role keeps every module. Unioning with the role's declared
    // grants (rather than trusting the request alone) is what stops a malformed
    // or truncated module list from quietly stripping a Center Head of the
    // system — the same guarantee updateById() gives.
    const modules = isFullAccessRole(role)
      ? Array.from(new Set([...canonicalModules, ...roleDefaults.modules, 'Account Management']))
      : (canonicalModules.length ? canonicalModules : roleDefaults.modules);

    const requestedTabs = Array.isArray(childRecordTabs)
      ? childRecordTabs
      : roleDefaults.childRecordTabs;
    const fixedTabRoles = ['nurse', 'educator', 'houseparent'];
    const tabs = fixedTabRoles.includes(role)
      ? roleDefaults.childRecordTabs
      : (canonicalizeTabs(requestedTabs).length ? canonicalizeTabs(requestedTabs) : roleDefaults.childRecordTabs);

    // The hierarchy-aware grant. Derived from the same inputs as `modules` and
    // `tabs` so the three can never describe different access.
    const resolvedSubModules = resolveSubModuleGrants({
      role,
      modules,
      requested: subModules,
      childRecordTabs: tabs,
    });

    // Detect/repair the user-name compatibility columns before the permission
    // update. Some existing databases were created by an older build whose
    // users table (or database-side objects) still expects fullName. Adding the
    // nullable compatibility column here makes a module-only permission edit
    // safe even when the server is started against that older database.
    const [columnsBeforeRepair] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'users'`
    );
    const beforeNames = new Set(columnsBeforeRepair.map(c => String(c.COLUMN_NAME).toLowerCase()));
    if (!beforeNames.has('displayname')) {
      await pool.query('ALTER TABLE users ADD COLUMN displayName VARCHAR(150) NULL AFTER username');
    }
    if (!beforeNames.has('fullname')) {
      await pool.query('ALTER TABLE users ADD COLUMN fullName VARCHAR(150) NULL AFTER displayName');
    }
    // Grant columns. Self-healing here means a permission edit works against a
    // database provisioned by an older build, instead of silently dropping the
    // submenu part of the change.
    if (!beforeNames.has('childrecordtabs')) {
      await pool.query('ALTER TABLE users ADD COLUMN childRecordTabs JSON NULL AFTER accessibleModules');
    }
    if (!beforeNames.has('submodules')) {
      await pool.query('ALTER TABLE users ADD COLUMN subModules JSON NULL AFTER childRecordTabs');
    }
    const [columns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'users'`
    );
    const names = new Set(columns.map(c => String(c.COLUMN_NAME).toLowerCase()));

    const updates = ['accessibleModules = ?'];
    const values = [JSON.stringify(modules)];

    if (names.has('childrecordtabs')) {
      updates.push('childRecordTabs = ?');
      values.push(JSON.stringify(tabs));
    }
    if (names.has('submodules')) {
      updates.push('subModules = ?');
      values.push(JSON.stringify(resolvedSubModules));
    }
    if (names.has('displayname') && displayName !== undefined) {
      const normalizedDisplayName = displayName ? String(displayName).trim() : null;
      updates.push('displayName = ?');
      values.push(normalizedDisplayName);
      if (names.has('fullname')) {
        updates.push('fullName = ?');
        values.push(normalizedDisplayName);
      }
    }
    if (names.has('modifiedby')) {
      updates.push('modifiedBy = ?');
      values.push(req.user?.username || 'System');
    }

    values.push(id);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

    const selected = ['id', 'username'];
    if (names.has('displayname')) selected.push('displayName');
    selected.push('role', 'accessibleModules');
    if (names.has('childrecordtabs')) selected.push('childRecordTabs');
    if (names.has('submodules')) selected.push('subModules');
    selected.push('status', 'createdDate');

    const [rows] = await pool.query(
      `SELECT ${selected.join(', ')} FROM users WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      message: 'Module access updated successfully',
      data: mapRow('users', rows[0]),
    });
  } catch (error) {
    next(error);
  }
}

async function deleteById(req, res, next) {
  try {
    const { id } = req.params;
    const [existing] = await pool.query('SELECT id, role FROM users WHERE id = ?', [id]);
    if (existing.length === 0) throw new ApiError(404, 'User not found');
    if (existing[0].role === 'centerhead') throw new ApiError(403, 'Cannot delete the Center Head account');

    await pool.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
}

/**
 * Get all users
 * @async
 */
async function getAll(req, res, next) {
  try {
    const rows = await selectUsers('', [], { orderBy: 'createdDate DESC' });
    res.json({
      success: true,
      data: rows.map(row => mapRow('users', row)),
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  login,
  register,
  getProfile,
  updateProfile,
  changePassword,
  getAll,
  getById,
  updateById,
  updateAccess,
  deleteById,
};
