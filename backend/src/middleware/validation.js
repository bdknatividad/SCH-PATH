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

/**
 * The Education levels that are not a school placement — the resident is not
 * enrolled (the enrolment window has closed, or they are between schools), so
 * they have no school and no enrolment date to give. Mirrors `isNotEnrolled` in
 * `frontend/src/app/components/Education.tsx`; the two change together.
 */
const NOT_ENROLLED_EDUCATION_LEVELS = ['Tutorial'];

/**
 * A learner who is enrolled at a school must have a school and an enrolment
 * date; one who is not enrolled has neither.
 *
 * This cannot live in the table: `education_records.school` and
 * `.enrollmentDate` are nullable precisely so the not-enrolled level can be
 * recorded at all. It cannot live in `validateBody` either, because it is
 * conditional on another field of the same body. And it has to exist on this
 * side at all — the form is not the only caller, and a record that says "High
 * School" while naming no school is the inconsistency the frontend check
 * prevents and a direct API call would otherwise reintroduce.
 *
 * A body that does not mention `educationLevel` is left alone: a partial update
 * that does not touch the level cannot be judged here, and the stored record's
 * consistency was settled when it was written. A body that names a school
 * placement without its school is genuinely incomplete and is refused.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function requireEducationPlacement(req, res, next) {
  const data = req.body || {};
  const level = data.educationLevel;

  if (level === undefined || level === null || String(level).trim() === '') {
    return next();
  }

  if (NOT_ENROLLED_EDUCATION_LEVELS.includes(String(level).trim())) {
    return next();
  }

  const missing = [];
  if (!String(data.school ?? '').trim()) missing.push('school');
  if (!String(data.enrollmentDate ?? '').trim()) missing.push('enrollmentDate');

  if (missing.length > 0) {
    return next(
      new ApiError(
        400,
        `A learner recorded at ${level} needs a school and an enrolment date (missing: ${missing.join(', ')}).`
      )
    );
  }

  return next();
}

module.exports = {
  validateBody,
  validateId,
  schemas,
  sanitizeBody,
  requireEducationPlacement,
};
