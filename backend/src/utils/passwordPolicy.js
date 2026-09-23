/**
 * Password policy — the single place a candidate password is judged.
 *
 * Every endpoint that accepts a password (register, the Center Head's account
 * edit, the self-service change, and the profile update) calls `assertPassword`
 * rather than inventing its own rule, so a password that is accepted in one
 * place cannot be rejected in another.
 *
 * The numbers live in `config/passwordPolicy.json`, mirrored byte-identically
 * into the frontend so both sides agree. See that file for why.
 *
 * @module utils/passwordPolicy
 */

const policy = require('../config/passwordPolicy.json');
const { ApiError } = require('../middleware/errorHandler');

/**
 * Judge a candidate password.
 *
 * @param {unknown} password - The candidate, straight from the request body.
 * @param {{username?: string}} [context] - The account the password belongs to.
 * @returns {string|null} The problem to report, or `null` when it is acceptable.
 */
function passwordProblem(password, { username } = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required.';
  }

  // A password of only spaces is technically long enough but is almost always
  // a form that lost its input, and it cannot be typed back reliably.
  if (password.trim().length === 0) {
    return 'Password cannot be only spaces.';
  }

  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters.`;
  }

  // bcrypt only reads the first 72 bytes. A longer password would silently lose
  // its tail, so two different long passwords could authenticate each other.
  if (Buffer.byteLength(password, 'utf8') > policy.maxLengthBytes) {
    return `Password must be at most ${policy.maxLengthBytes} bytes.`;
  }

  if (
    policy.mustDifferFromUsername &&
    username &&
    password.trim().toLowerCase() === String(username).trim().toLowerCase()
  ) {
    return 'Password cannot be the same as the username.';
  }

  return null;
}

/**
 * `passwordProblem`, as a guard: throws the 400 the API should return.
 *
 * @param {unknown} password
 * @param {{username?: string}} [context]
 * @returns {string} The accepted password, so call sites can hash it inline.
 */
function assertPassword(password, context) {
  const problem = passwordProblem(password, context);
  if (problem) throw new ApiError(400, problem);
  return password;
}

module.exports = { passwordProblem, assertPassword, policy };
