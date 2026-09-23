/**
 * Migration script to add violation tracking columns to phaseProgress table
 */

import { pool } from '../config/database.js';

async function addViolationColumns() {
  try {
    console.log('Adding violation tracking columns to phaseProgress...');

    // Check if columns exist
    const [columns] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_NAME = 'phaseProgress' AND TABLE_SCHEMA = DATABASE()`
    );
    
    const existingColumns = columns.map(c => c.COLUMN_NAME);
    
    // Add violationCount if not exists
    if (!existingColumns.includes('violationCount')) {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN violationCount INT NOT NULL DEFAULT 0');
      console.log('✓ Added violationCount column');
    } else {
      console.log('✓ violationCount already exists');
    }
    
    // Add advancementBlocked if not exists
    if (!existingColumns.includes('advancementBlocked')) {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN advancementBlocked BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('✓ Added advancementBlocked column');
    } else {
      console.log('✓ advancementBlocked already exists');
    }
    
    // Add demotionRecommended if not exists
    if (!existingColumns.includes('demotionRecommended')) {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN demotionRecommended BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('✓ Added demotionRecommended column');
    } else {
      console.log('✓ demotionRecommended already exists');
    }
    
    // Add demotionCount if not exists
    if (!existingColumns.includes('demotionCount')) {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN demotionCount INT NOT NULL DEFAULT 0');
      console.log('✓ Added demotionCount column');
    } else {
      console.log('✓ demotionCount already exists');
    }

    console.log('Migration complete!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

addViolationColumns();
