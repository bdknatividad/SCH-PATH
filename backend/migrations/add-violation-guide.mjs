/**
 * Migration: Add Violation & Intervention Guide Tables
 * @description Creates tables for managing violation definitions and intervention tracking
 */

const { pool } = require('../config/database');

async function up() {
  const connection = await pool.getConnection();
  
  try {
    console.log('Running migration: Add Violation & Intervention Guide Tables...');
    
    // Create violation_guide table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS violation_guide (
        id VARCHAR(40) PRIMARY KEY,
        name VARCHAR(500) NOT NULL,
        category ENUM('Minor', 'Major') NOT NULL DEFAULT 'Minor',
        description TEXT NULL,
        status ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
        createdBy VARCHAR(100) NOT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updatedBy VARCHAR(100) NULL,
        INDEX idx_status (status),
        INDEX idx_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created violation_guide table');
    
    // Create intervention_types table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS intervention_types (
        id VARCHAR(40) PRIMARY KEY,
        type VARCHAR(100) NOT NULL UNIQUE,
        description TEXT NULL,
        requiresDuration BOOLEAN NOT NULL DEFAULT TRUE,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created intervention_types table');
    
    // Create guide_interventions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS guide_interventions (
        id VARCHAR(40) PRIMARY KEY,
        guideId VARCHAR(40) NOT NULL,
        offenseLevel ENUM('1st', '2nd', '3rd') NOT NULL,
        interventionType VARCHAR(100) NOT NULL,
        duration INT NULL,
        unit VARCHAR(50) NULL,
        metadata JSON NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE CASCADE,
        INDEX idx_guideId (guideId),
        INDEX idx_offenseLevel (offenseLevel)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created guide_interventions table');
    
    // Create intervention_tracker table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS intervention_tracker (
        id VARCHAR(40) PRIMARY KEY,
        residentId VARCHAR(40) NOT NULL,
        violationId VARCHAR(40) NOT NULL,
        guideId VARCHAR(40) NOT NULL,
        offenseLevel ENUM('1st', '2nd', '3rd') NOT NULL,
        interventionType VARCHAR(100) NOT NULL,
        duration INT NULL,
        unit VARCHAR(50) NULL,
        metadata JSON NULL,
        status ENUM('Pending', 'In Progress', 'Completed') NOT NULL DEFAULT 'Pending',
        startDate DATE NULL,
        completionDate DATE NULL,
        notes TEXT NULL,
        completedBy VARCHAR(100) NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (residentId) REFERENCES children(id) ON DELETE CASCADE,
        FOREIGN KEY (violationId) REFERENCES violations(id) ON DELETE CASCADE,
        FOREIGN KEY (guideId) REFERENCES violation_guide(id) ON DELETE CASCADE,
        INDEX idx_residentId (residentId),
        INDEX idx_status (status),
        INDEX idx_violationId (violationId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created intervention_tracker table');
    
    // Insert default intervention types
    try {
      await connection.query(`
        INSERT INTO intervention_types (id, type, description, requiresDuration) VALUES
        ('IT001', 'Guide Requirement', 'Exact requirement taken from the official SCH intervention guide', FALSE),
        ('IT002', 'Psychosocial Activity', 'Psychosocial activity required by the official SCH intervention guide', FALSE),
        ('IT003', 'Privilege Restriction', 'Restriction of a specific privilege described by the guide', TRUE),
        ('IT004', 'Privilege Suspension', 'Suspension of privileges described by the guide', TRUE),
        ('IT005', 'Household Chores', 'Household chore requirement described by the guide', TRUE),
        ('IT006', 'Cleaning', 'Cleaning requirement described by the guide', TRUE),
        ('IT007', 'Confiscation', 'Confiscation or safekeeping requirement', FALSE),
        ('IT008', 'Other', 'Other exact requirement from the official guide', FALSE)
      `);
      console.log('✓ Inserted default intervention types');
    } catch (error) {
      // Types may already exist, continue
      console.log('ℹ Intervention types may already exist, continuing...');
    }
    
    console.log('✅ Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

async function down() {
  const connection = await pool.getConnection();
  
  try {
    console.log('Rolling back migration: Add Violation & Intervention Guide Tables...');
    
    await connection.query('DROP TABLE IF EXISTS intervention_tracker');
    await connection.query('DROP TABLE IF EXISTS guide_interventions');
    await connection.query('DROP TABLE IF EXISTS violation_guide');
    await connection.query('DROP TABLE IF EXISTS intervention_types');
    
    console.log('✅ Rollback completed successfully');
  } catch (error) {
    console.error('❌ Rollback failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { up, down };
