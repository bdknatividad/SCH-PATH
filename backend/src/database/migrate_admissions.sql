CREATE TABLE admissions (
  id VARCHAR(40) PRIMARY KEY,
  residentId VARCHAR(40) NOT NULL,

  admissionNumber INT NOT NULL,

  admissionDate DATE NOT NULL,

  name VARCHAR(150) NOT NULL,
  age INT NOT NULL,
  sex ENUM('Male', 'Female') NOT NULL,
  birthDate DATE NOT NULL,
  religion VARCHAR(100) NOT NULL,
  address TEXT NOT NULL,

  residentSignature LONGTEXT NULL,
  residentImage LONGTEXT NULL,

  guardianName VARCHAR(150) NOT NULL,
  guardianContact VARCHAR(100) NOT NULL,
  guardianAddress TEXT NOT NULL,
  guardianSignature LONGTEXT NULL,

  referringParty VARCHAR(150) NOT NULL,
  referringPartyContact VARCHAR(100) NOT NULL,
  referringPartySignature LONGTEXT NULL,

  houseparentOnDuty VARCHAR(150) NOT NULL,
  houseparentSignature LONGTEXT NULL,

  legalCategory VARCHAR(150) NOT NULL,
  specificOffense TEXT NOT NULL,
  caseHistory TEXT NOT NULL,

  expectedDischargeDate DATE NULL,
  status ENUM('Active', 'Closed') NOT NULL DEFAULT 'Active',
  closedDate DATE NULL,

  createdBy VARCHAR(100) NULL,
  modifiedBy VARCHAR(100) NULL,

  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (residentId) REFERENCES children(id)
    ON DELETE CASCADE,

  UNIQUE KEY uq_resident_admission_number (residentId, admissionNumber),
  INDEX idx_admissions_residentId (residentId),
  INDEX idx_admissions_status (status),
  INDEX idx_admissions_admissionDate (admissionDate)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
