/**
 * Shared authorization helpers.
 * Keep role aliases and resident-scope rules in one place so controllers and
 * middleware make the same access decisions.
 */

const ROLE_ALIASES = {
  'center head': 'centerhead',
  center_head: 'centerhead',
  'center-head': 'centerhead',
  'social worker': 'socialworker',
  social_worker: 'socialworker',
  'house parent': 'houseparent',
  house_parent: 'houseparent',
};

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[value] || value;
}

function hasRole(user, ...roles) {
  const role = normalizeRole(user?.role);
  return roles.map(normalizeRole).includes(role);
}

function isManager(user) {
  return hasRole(user, 'centerhead', 'admin', 'socialworker');
}

function isHouseparent(user) {
  return hasRole(user, 'houseparent');
}

function isSupportedRole(role, roles) {
  return roles.map(normalizeRole).includes(normalizeRole(role));
}

module.exports = {
  ROLE_ALIASES,
  normalizeRole,
  hasRole,
  isManager,
  isHouseparent,
  isSupportedRole,
};
