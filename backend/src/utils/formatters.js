/**
 * Data Formatters
 * @module utils/formatters
 * @description Formatting functions for consistent data presentation
 */

/**
 * Format resident name with case number
 * @param {Object} resident - Resident object
 * @returns {string} Formatted name
 */
function formatResidentName(resident) {
  if (!resident) return 'Unknown';
  return `${resident.name} (${resident.id || 'No ID'})`;
}

/**
 * Format violation for display
 * @param {Object} violation - Violation object
 * @returns {string} Formatted violation description
 */
function formatViolation(violation) {
  if (!violation) return '';
  return `${violation.type} - ${violation.severity} (${violation.points} points)`;
}

/**
 * Format date for reports
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date: "January 15, 2024"
 */
function formatReportDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return d.toLocaleDateString('en-US', options);
}

/**
 * Format time for display
 * @param {string} time - Time string (HH:MM)
 * @returns {string} Formatted time: "2:30 PM"
 */
function formatTime(time) {
  if (!time) return '';
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${minutes} ${ampm}`;
}

/**
 * Format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size: "2.5 MB"
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format phone number
 * @param {string} phone - Phone number
 * @returns {string} Formatted: "+63 912 345 6789"
 */
function formatPhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('09')) {
    return `+63 ${cleaned.slice(1, 4)} ${cleaned.slice(4, 7)} ${cleaned.slice(7)}`;
  }
  return phone;
}

/**
 * Format currency
 * @param {number} amount - Amount
 * @returns {string} Formatted: "₱1,234.56"
 */
function formatCurrency(amount) {
  if (amount === undefined || amount === null) return '₱0.00';
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
  }).format(amount);
}

/**
 * Truncate text with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} length - Max length
 * @returns {string} Truncated text
 */
function truncateText(text, length = 50) {
  if (!text || text.length <= length) return text;
  return text.substring(0, length).trim() + '...';
}

/**
 * Format status badge color
 * @param {string} status - Status value
 * @returns {string} Color class
 */
function getStatusColor(status) {
  const colors = {
    Active: 'green',
    Inactive: 'gray',
    Pending: 'yellow',
    Completed: 'blue',
    Approved: 'green',
    Rejected: 'red',
    Urgent: 'red',
    High: 'orange',
    Medium: 'yellow',
    Low: 'blue',
  };
  return colors[status] || 'gray';
}

module.exports = {
  formatResidentName,
  formatViolation,
  formatReportDate,
  formatTime,
  formatFileSize,
  formatPhone,
  formatCurrency,
  truncateText,
  getStatusColor,
};
