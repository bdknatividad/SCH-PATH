/**
 * Execute SQL fix for phaseProgress columns
 */

import { pool } from '../config/database.js';

async function executeFix() {
  try {
    console.log('Adding columns to phaseProgress...');
    
    // Add columns one by one
    try {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN violationCount INT NOT NULL DEFAULT 0');
      console.log('✓ Added violationCount');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log('✓ violationCount already exists');
      else throw e;
    }
    
    try {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN advancementBlocked BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('✓ Added advancementBlocked');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log('✓ advancementBlocked already exists');
      else throw e;
    }
    
    try {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN demotionRecommended BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('✓ Added demotionRecommended');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log('✓ demotionRecommended already exists');
      else throw e;
    }
    
    try {
      await pool.query('ALTER TABLE phaseProgress ADD COLUMN demotionCount INT NOT NULL DEFAULT 0');
      console.log('✓ Added demotionCount');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log('✓ demotionCount already exists');
      else throw e;
    }

    // Reset blocks
    console.log('\nSyncing violation blocks...');
    
    // Get violation counts per resident
    const [violations] = await pool.query(`
      SELECT residentId, COUNT(*) as count 
      FROM violations 
      WHERE status IN ('Pending', 'Under Review')
      GROUP BY residentId
    `);
    
    const violationMap = {};
    for (const v of violations) {
      violationMap[v.residentId] = v.count;
    }
    
    // Get all current phases
    const [phases] = await pool.query('SELECT id, residentId FROM phaseProgress WHERE isCurrent = 1');
    
    for (const phase of phases) {
      const violationCount = violationMap[phase.residentId] || 0;
      const blocked = violationCount > 0;
      const demotionRecommended = violationCount >= 2;
      
      await pool.query(
        'UPDATE phaseProgress SET violationCount = ?, advancementBlocked = ?, demotionRecommended = ? WHERE id = ?',
        [violationCount, blocked, demotionRecommended, phase.id]
      );
      
      console.log(`${phase.residentId}: ${violationCount} violations, blocked=${blocked}`);
    }
    
    console.log('\n✅ Fix complete!');
    process.exit(0);
  } catch (error) {
    console.error('Fix failed:', error.message);
    process.exit(1);
  }
}

executeFix();
