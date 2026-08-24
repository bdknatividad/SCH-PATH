/**
 * Validation Middleware
 * @module middleware/validation
 * @description Input validation middleware for API requests
 */

const { ApiError } = require('./errorHandler');

/**
 * Validate request body against schema
 * @param {Object} schema - Validation schema
 * @returns {Function} Express middleware
 * @example
 * const schema = {
 *   name: { required: true, type: 'string', min: 2, max: 100 },
 *   age: { required: true, type: 'number', min: 0, max: 120 }
 * };
 * router.post('/', validateBody(schema), controller);
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];
    const data = req.body || {};

    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];

      // Check required
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push({ field, message: `${field} is required` });
        continue;
      }

      // Skip further validation if not required and empty
      if (!value && !rules.required) {
        continue;
      }

      // Type validation
      if (rules.type) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== rules.type) {
          errors.push({ field, message: `${field} must be of type ${rules.type}` });
        }
      }

      // String length validation
      if (rules.type === 'string' && typeof value === 'string') {
        if (rules.min && value.length < rules.min) {
          errors.push({ field, message: `${field} must be at least ${rules.min} characters` });
        }
        if (rules.max && value.length > rules.max) {
          errors.push({ field, message: `${field} must be at most ${rules.max} characters` });
        }
      }

      // Number range validation
      if (rules.type === 'number' && typeof value === 'number') {
        if (rules.min !== undefined && value < rules.min) {
          errors.push({ field, message: `${field} must be at least ${rules.min}` });
        }
        if (rules.max !== undefined && value > rules.max) {
          errors.push({ field, message: `${field} must be at most ${rules.max}` });
        }
      }

      // Pattern validation (regex)
      if (rules.pattern && typeof value === 'string') {
        if (!rules.pattern.test(value)) {
          errors.push({ field, message: rules.message || `${field} format is invalid` });
        }
      }

      // Enum validation
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push({ field, message: `${field} must be one of: ${rules.enum.join(', ')}` });
      }
    }

    if (errors.length > 0) {
      throw new ApiError(400, 'Validation failed', { errors });
    }

    next();
  };
}

/**
 * Validate resource ID parameter
 * @param {string} paramName - URL parameter name
 * @returns {Function} Express middleware
 */
function validateId(paramName = 'id') {
  return (req, res, next) => {
    const id = req.params[paramName];
    
    if (!id || typeof id !== 'string' || id.trim() === '') {
      throw new ApiError(400, `Invalid ${paramName} provided`);
    }

    // Sanitize ID (remove any potentially dangerous characters)
    req.params[paramName] = id.trim().replace(/[<>\"']/g, '');
    
    next();
  };
}

/**
 * Common validation schemas
 * @constant {Object}
 */
const schemas = {
  child: {
    name: { required: true, type: 'string', min: 2, max: 150 },
    age: { required: true, type: 'number', min: 0, max: 120 },
    gender: { required: true, type: 'string', enum: ['Male', 'Female', 'Other'] },
    admissionDate: { required: true, type: 'string' },
    legalCategory: { required: true, type: 'string' },
  },
  
  violation: {
    residentId: { required: true, type: 'string' },
    date: { required: true, type: 'string' },
    type: { required: true, type: 'string', min: 2 },
    severity: { required: true, type: 'string', enum: ['Minor', 'Major', 'Critical'] },
    points: { required: true, type: 'number', min: 0 },
  },
  
  healthRecord: {
    residentId: { required: true, type: 'string' },
    residentName: { required: true, type: 'string', min: 2 },
    recordType: { required: true, type: 'string' },
    date: { required: true, type: 'string' },
  },
  
  document: {
    title: { required: true, type: 'string', min: 2, max: 150 },
    type: { required: true, type: 'string' },
    category: { required: true, type: 'string' },
  },
  
  assessment: {
    title: { required: true, type: 'string', min: 2, max: 150 },
    date: { required: true, type: 'string' },
    type: { required: true, type: 'string' },
    assessor: { required: true, type: 'string' },
  },
  
  user: {
    username: { required: true, type: 'string', min: 3, max: 100 },
    password: { required: true, type: 'string', min: 6 },
    role: { required: true, type: 'string', enum: ['centerhead', 'socialworker', 'psychologist', 'nurse', 'educator'] },
  },
};

/**
 * Sanitize request body
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        // Remove HTML tags and trim
        req.body[key] = req.body[key]
          .replace(/<[^>]*>/g, '')
          .trim();
      }
    }
  }
  next();
}

module.exports = {
  validateBody,
  validateId,
  schemas,
  sanitizeBody,
};
