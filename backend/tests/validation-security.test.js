const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBirthDateInput, normalizePhoneNumber, ensureHashedPassword } = require('../src/utils/security');

test('birth date input keeps a 4-digit year and normalizes to YYYY-MM-DD', () => {
  assert.equal(normalizeBirthDateInput('20240512'), '2024-05-12');
  assert.equal(normalizeBirthDateInput('2024-05-12'), '2024-05-12');
  assert.equal(normalizeBirthDateInput('2024051'), '2024-05-01');
});

test('phone numbers are normalized to 09-prefixed 11-digit format', () => {
  assert.equal(normalizePhoneNumber('09123456789'), '09123456789');
  assert.equal(normalizePhoneNumber('9123456789'), '09123456789');
  assert.equal(normalizePhoneNumber('091234567890'), '09123456789');
});

test('plain-text passwords are upgraded to bcrypt hashes', async () => {
  const hashed = await ensureHashedPassword('centerhead123');
  assert.notEqual(hashed, 'centerhead123');
  assert.match(hashed, /^\$2[aby]\$/);
});
