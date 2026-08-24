/**
 * Helper Functions
 * @module utils/helpers
 * @description Utility functions for SCH-PATH system
 */

const { RESOURCES } = require('./constants');

/**
 * Generate unique ID for resources
 * @param {string} prefix - ID prefix (e.g., 'CH', 'VIO')
 * @param {Array} existing - Array of existing items to check for duplicates
 * @returns {string} Generated unique ID
 * @example
 * generateId('CH', children) // Returns: 'CH-2024-01-15-001'
 */
function generateId(prefix, existing = []) {
  // Extract the highest existing sequential number for this prefix
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const item of existing) {
    const match = (item.id || '').match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  const next = (max + 1).toString().padStart(3, '0');
  return `${prefix}${next}`;
}

/**
 * Map database row to resource object
 * @param {string} resource - Resource name
 * @param {Object} row - Database row
 * @returns {Object} Mapped resource object
 */
function mapRow(resource, row) {
  if (!row) return null;
  
  const config = RESOURCES[resource];
  if (!config) return row;
  
  const mapped = {};
  
  for (const col of config.columns) {
    if (col in row) {
      mapped[col] = row[col];
    }
  }
  
  // Parse JSON fields
  for (const field of config.jsonFields) {
    if (mapped[field] && typeof mapped[field] === 'string') {
      try {
        mapped[field] = JSON.parse(mapped[field]);
      } catch {
        mapped[field] = [];
      }
    }
  }
  
  // Convert boolean fields
  const boolFields = ['isRepeatOffender', 'documentsComplete', 'isRead', 'isCurrent', 'requiresAssessment', 'assessmentTriggered'];
  for (const field of boolFields) {
    if (field in mapped) {
      mapped[field] = Boolean(mapped[field]);
    }
  }
  
  // Convert timestamp fields to ISO string
  const timestampFields = ['createdAt', 'updatedAt', 'submittedAt', 'uploadedAt', 'reviewedAt', 'approvedAt', 'readAt'];
  for (const field of timestampFields) {
    if (mapped[field] && mapped[field] instanceof Date) {
      mapped[field] = mapped[field].toISOString();
    }
  }

  // Normalize date-only fields to YYYY-MM-DD (strip time/timezone)
  const dateOnlyFields = ['birthDate', 'admissionDate', 'date', 'hearingDate', 'nextHearing', 'createdDate', 'enteredAt', 'completedAt'];
  for (const field of dateOnlyFields) {
    if (mapped[field]) {
      const val = mapped[field];
      if (val instanceof Date) {
        mapped[field] = val.toISOString().split('T')[0];
      } else if (typeof val === 'string' && val.includes('T')) {
        mapped[field] = val.split('T')[0];
      }
    }
  }
  
  return mapped;
}

/**
 * Build SQL WHERE clause from filters
 * @param {Object} filters - Filter criteria
 * @returns {Object} { clause: string, values: Array }
 */
function buildWhereClause(filters = {}) {
  const conditions = [];
  const values = [];
  
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      conditions.push(`${key} = ?`);
      values.push(value);
    }
  }
  
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

/**
 * Get current timestamp in ISO format
 * @returns {string} ISO timestamp
 */
function getCurrentTimestamp() {
  return new Date().toISOString();
}

/**
 * Format date for display
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Calculate resident age from birth date
 * @param {string|Date} birthDate - Birth date
 * @returns {number} Age in years
 */
function calculateAge(birthDate) {
  if (!birthDate) return 0;
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}

/**
 * Sanitize string input
 * @param {string} input - Input string
 * @returns {string} Sanitized string
 */
function sanitizeString(input) {
  if (!input || typeof input !== 'string') return '';
  return input.trim().replace(/[<>]/g, '');
}

/**
 * Validate required fields
 * @param {Object} data - Data object to validate
 * @param {Array<string>} required - Required field names
 * @returns {Array<string>} Array of missing fields
 */
function validateRequired(data, required) {
  const missing = [];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      missing.push(field);
    }
  }
  return missing;
}

module.exports = {
  generateId,
  mapRow,
  buildWhereClause,
  getCurrentTimestamp,
  formatDate,
  calculateAge,
  sanitizeString,
  validateRequired,
};
