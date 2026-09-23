/**
 * Password policy — the frontend half.
 *
 * The numbers come from `app/config/passwordPolicy.json`, which is kept
 * byte-identical to `backend/src/config/passwordPolicy.json`. This file mirrors
 * `backend/src/utils/passwordPolicy.js` so the message shown before saving is
 * the message the API would return, rather than a round trip that ends in a 400.
 *
 * The backend remains the enforcement point; this is only the early warning.
 */

import policy from '@/app/config/passwordPolicy.json';

export { policy };

/**
 * Judge a candidate password.
 *
 * @param password The candidate, straight from the form field.
 * @param username The account the password belongs to, when known.
 * @returns The problem to show, or `null` when it is acceptable.
 */
export function passwordProblem(password: string, username?: string): string | null {
  if (!password || password.length === 0) {
    return 'Password is required.';
  }

  if (password.trim().length === 0) {
    return 'Password cannot be only spaces.';
  }

  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters.`;
  }

  // bcrypt only reads the first 72 bytes, so a longer password would silently
  // lose its tail. Measured in bytes, not characters, to match the backend.
  if (new TextEncoder().encode(password).length > policy.maxLengthBytes) {
    return `Password must be at most ${policy.maxLengthBytes} bytes.`;
  }

  if (
    policy.mustDifferFromUsername &&
    username &&
    password.trim().toLowerCase() === username.trim().toLowerCase()
  ) {
    return 'Password cannot be the same as the username.';
  }

  return null;
}
