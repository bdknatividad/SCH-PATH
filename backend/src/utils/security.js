const bcrypt = require('bcrypt');

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

async function ensureHashedPassword(password) {
  if (!password || typeof password !== 'string') {
    return password;
  }

  if (isBcryptHash(password)) {
    return password;
  }

  return bcrypt.hash(password, 10);
}

function normalizeBirthDateInput(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  const compact = value.replace(/[^\d]/g, '');
  if (!compact) {
    return '';
  }

  const year = compact.slice(0, 4) || '0000';
  const month = compact.slice(4, 6) || '01';
  const day = compact.slice(6, 8) || '01';

  const normalizedYear = Number(year) > 0 ? year : '0000';
  const normalizedMonth = Math.min(12, Math.max(1, Number(month) || 1)).toString().padStart(2, '0');
  const normalizedDay = Math.min(31, Math.max(1, Number(day) || 1)).toString().padStart(2, '0');

  return `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
}

function normalizePhoneNumber(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  const digits = value.replace(/\D/g, '');
  if (!digits) {
    return '';
  }

  let normalized = digits;
  if (normalized.startsWith('63')) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith('0')) {
    normalized = normalized.slice(1);
  }
  if (!normalized.startsWith('9')) {
    normalized = `9${normalized}`;
  }
  normalized = `0${normalized}`.slice(0, 11);

  if (normalized.length !== 11 || !normalized.startsWith('09')) {
    const cleaned = normalized.replace(/^0+/, '');
    normalized = `09${cleaned}`.slice(0, 11);
  }

  return normalized;
}

module.exports = {
  isBcryptHash,
  ensureHashedPassword,
  normalizeBirthDateInput,
  normalizePhoneNumber,
};
