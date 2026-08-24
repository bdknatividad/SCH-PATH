const bcrypt = require('bcrypt');
/**
 * User Controller
 * @module controllers/userController
 * @description User authentication and management operations
 */

const { pool } = require('../config/database');
const { generateToken } = require('../middleware/auth');
const { mapRow, generateId } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');

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

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          accessibleModules: user.accessibleModules,
          childRecordTabs: user.childRecordTabs || [],
        },
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
    const { username, password: rawPassword, role, accessibleModules } = req.body || {};
    const password = rawPassword ? await bcrypt.hash(rawPassword, 10) : null;

    // Check if username exists
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      throw new ApiError(409, 'Username already exists');
    }

    const [existingUsers] = await pool.query('SELECT id FROM users');
    const userId = generateId('U', existingUsers.map(r => ({ id: r.id })));

    const { childRecordTabs: newUserTabs } = req.body || {};
    try {
      await pool.query(
        `INSERT INTO users (id, username, password, role, accessibleModules, childRecordTabs, status, createdDate, createdBy) VALUES (?, ?, ?, ?, ?, ?, 'Active', NOW(), ?)`,
        [userId, username, password, role, JSON.stringify(accessibleModules || []), JSON.stringify(newUserTabs || []), req.user?.username || 'System']
      );
    } catch (sqlErr) {
      if (sqlErr.code === 'ER_BAD_FIELD_ERROR' && sqlErr.message.includes('childRecordTabs')) {
        await pool.query(
          `INSERT INTO users (id, username, password, role, accessibleModules, status, createdDate, createdBy) VALUES (?, ?, ?, ?, ?, 'Active', NOW(), ?)`,
          [userId, username, password, role, JSON.stringify(accessibleModules || []), req.user?.username || 'System']
        );
      } else { throw sqlErr; }
    }

    // Fetch the created user
    let rows;
    try {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, childRecordTabs, status, createdDate FROM users WHERE id = ?',
        [userId]
      );
    } catch {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, status, createdDate FROM users WHERE id = ?',
        [userId]
      );
    }

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
    const [rows] = await pool.query(
      'SELECT id, username, role, accessibleModules, status FROM users WHERE id = ?',
      [req.user.id]
    );

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
    const { password, accessibleModules } = req.body || {};
    const updates = [];
    const values = [];

    if (password) {
      const hashedPw = await bcrypt.hash(password, 10);
      updates.push('password = ?');
      values.push(hashedPw);
    }

    if (accessibleModules) {
      updates.push('accessibleModules = ?');
      values.push(JSON.stringify(accessibleModules));
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

    // Verify current password
    // Verify current password (bcrypt-aware)
    const [pwRows] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!pwRows || pwRows.length === 0) throw new ApiError(404, 'User not found');
    const storedPw = pwRows[0].password || '';
    let pwMatch = false;
    if (storedPw.startsWith('$2b$') || storedPw.startsWith('$2a$')) {
      pwMatch = await bcrypt.compare(currentPassword, storedPw);
    } else {
      pwMatch = (currentPassword === storedPw);
    }
    if (!pwMatch) {
      throw new ApiError(401, 'Current password is incorrect');
    }

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
    let rows;
    try {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, childRecordTabs, status, createdDate FROM users WHERE id = ?',
        [id]
      );
    } catch {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, status, createdDate FROM users WHERE id = ?',
        [id]
      );
    }
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
    const { username, password, role, accessibleModules, childRecordTabs, status } = req.body || {};

    // Check target exists
    const [existing] = await pool.query('SELECT id, role FROM users WHERE id = ?', [id]);
    if (existing.length === 0) throw new ApiError(404, 'User not found');

    // Username uniqueness check
    if (username) {
      const [conflict] = await pool.query(
        'SELECT id FROM users WHERE username = ? AND id != ?',
        [username, id]
      );
      if (conflict.length > 0) throw new ApiError(409, 'Username already taken by another account');
    }

    const updates = [];
    const values = [];

    if (username) { updates.push('username = ?'); values.push(username); }
    if (password) { updates.push('password = ?'); values.push(await bcrypt.hash(password, 10)); }
    if (role)     { updates.push('role = ?');     values.push(role); }
    if (accessibleModules !== undefined) {
      updates.push('accessibleModules = ?');
      values.push(JSON.stringify(accessibleModules));
    }
    if (childRecordTabs !== undefined) {
      updates.push('childRecordTabs = ?');
      values.push(JSON.stringify(childRecordTabs));
    }
    if (status)   { updates.push('status = ?');   values.push(status); }

    if (updates.length === 0) throw new ApiError(400, 'No fields to update');

    updates.push('modifiedBy = ?');
    values.push(req.user?.username || 'System');
    values.push(id);

    try {
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    } catch (sqlErr) {
      // Column may not exist yet — retry without childRecordTabs
      if (sqlErr.code === 'ER_BAD_FIELD_ERROR' && sqlErr.message.includes('childRecordTabs')) {
        const safeUpdates = [];
        const safeValues = [];
        if (username) { safeUpdates.push('username = ?'); safeValues.push(username); }
        if (password) { safeUpdates.push('password = ?'); safeValues.push(password); }
        if (role)     { safeUpdates.push('role = ?');     safeValues.push(role); }
        if (accessibleModules !== undefined) { safeUpdates.push('accessibleModules = ?'); safeValues.push(JSON.stringify(accessibleModules)); }
        if (status)   { safeUpdates.push('status = ?');   safeValues.push(status); }
        if (safeUpdates.length === 0) throw new ApiError(400, 'No fields to update');
        safeUpdates.push('modifiedBy = ?');
        safeValues.push(req.user?.username || 'System');
        safeValues.push(id);
        await pool.query(`UPDATE users SET ${safeUpdates.join(', ')} WHERE id = ?`, safeValues);
      } else {
        throw sqlErr;
      }
    }

    let rows;
    try {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, childRecordTabs, status, createdDate FROM users WHERE id = ?',
        [id]
      );
    } catch {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, status, createdDate FROM users WHERE id = ?',
        [id]
      );
    }

    res.json({ success: true, message: 'User updated successfully', data: mapRow('users', rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete user by ID
 * @async
 */
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
    let rows;
    try {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, childRecordTabs, status, createdDate FROM users ORDER BY createdDate DESC'
      );
    } catch {
      [rows] = await pool.query(
        'SELECT id, username, role, accessibleModules, status, createdDate FROM users ORDER BY createdDate DESC'
      );
    }
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
  deleteById,
};
