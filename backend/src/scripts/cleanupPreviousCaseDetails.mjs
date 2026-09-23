/**
 * Cleanup script to fix malformed previousCaseDetails dates
 */

import { pool } from '../config/database.js';

async function cleanupPreviousCaseDetails() {
  try {
    console.log('Starting previousCaseDetails cleanup...');

    // Get all children with previousCaseDetails
    const [children] = await pool.query(
      'SELECT id, previousCaseDetails FROM children WHERE previousCaseDetails IS NOT NULL AND previousCaseDetails != \'\''
    );
    console.log(`Found ${children.length} children with previousCaseDetails`);

    for (const child of children) {
      const details = child.previousCaseDetails;
      
      // Fix the format: replace GMT dates with YYYY-MM-DD format
      // Pattern: (Wed May 27 2026 00:00:00 GMT+0800...) -> (2026-05-27)
      const fixedDetails = details.replace(
        /\([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT[+-]\d{4}\s*\([^)]+\)\)/g,
        (match) => {
          // Extract date from the GMT string
          const dateMatch = match.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
          if (dateMatch) {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const month = monthNames.indexOf(dateMatch[1]) + 1;
            const day = dateMatch[2].padStart(2, '0');
            const year = dateMatch[3];
            return `(${year}-${month.toString().padStart(2, '0')}-${day})`;
          }
          return match;
        }
      );

      // Also clean up duplicate "Previous:" entries
      const cleanedDetails = fixedDetails
        .replace(/Previous:\s*Previous:/g, 'Previous:')  // Fix double "Previous:"
        .replace(/\|\s*Previous:\s*/g, ' | ')  // Clean up pipe separators
        .replace(/\s*\|\s*$/g, '')  // Remove trailing pipes
        .trim();

      if (cleanedDetails !== details) {
        await pool.query(
          'UPDATE children SET previousCaseDetails = ? WHERE id = ?',
          [cleanedDetails, child.id]
        );
        console.log(`Fixed ${child.id}: ${cleanedDetails}`);
      }
    }

    console.log('Cleanup complete!');
    process.exit(0);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }
}

cleanupPreviousCaseDetails();
