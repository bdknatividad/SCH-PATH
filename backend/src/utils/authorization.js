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

/**
 * The system-wide roles: the Center Head and the Administrator.
 *
 * Used where a submission by the account needs no second pair of eyes. The Center
 * Head holds system-wide access and the Administrator holds every module, so a
 * document, report or record either of them files is final when they submit it:
 * routing it into a review queue leaves the Center Head's own work waiting on a
 * reviewer who can only be the Center Head.
 *
 * Deliberately narrower than `isManager`, which includes the Social Worker — a
 * Social Worker's submission does still go to review.
 *
 * There is no capability that expresses this. `manageUsers` happens to be held by
 * exactly these two roles, but it means "may manage accounts", and keying a review
 * rule on it would silently follow any future change to that permission.
 */
function isSystemWide(user) {
  return hasRole(user, 'centerhead', 'admin');
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
  isSystemWide,
  isSupportedRole,
};
