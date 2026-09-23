-- Migration: link every document to the admission it belongs to
-- Run this once in phpMyAdmin's SQL tab against sch_path_db (or via the mysql
-- client). Safe to re-run: the column is added with IF NOT EXISTS and the two
-- backfill passes only ever touch rows whose admissionId is still NULL.
--
-- Why: a returning resident's documents were being separated only by upload
-- timestamp, which cannot tell two admissions apart when they fall on the same
-- day and cannot place a document that has no uploadedAt at all. The folder view
-- is Resident -> Admission -> Category -> File, so the admission has to be
-- stored on the row rather than inferred.
--
-- Placement rule for existing rows: the latest admission that already existed
-- when the document was written — i.e. the highest admissionNumber whose
-- `createdAt` is at or before the document's `createdAt`.
--
-- `createdAt` is the right column here, not `uploadedAt`. `uploadedAt` is not
-- consistent across writers: the Documents module sends `new Date().toISOString()`
-- (UTC), while the TRI / Anecdotal / QPR / Health publishers let MySQL stamp it
-- (local time). In GMT+8 those two differ by eight hours, so ordering documents
-- by `uploadedAt` interleaves them wrongly. `createdAt` is stamped by the server
-- on every path and lines up exactly with `admissions.createdAt` — an admission
-- slip and the admission row it belongs to are written in the same second.
--
-- Documents that predate every admission on record (or carry no timestamp) fall
-- back to the resident's earliest admission, so that no row is left without a
-- folder to appear in.

USE sch_path_db;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS admissionId VARCHAR(40) NULL AFTER residentId;

-- The folder view reads every document for a resident and groups by admission,
-- so this index carries the lookup the Documents module actually performs.
CREATE INDEX IF NOT EXISTS idx_documents_admissionId ON documents (admissionId);

-- Pass 1: the admission that already existed when the document was written.
UPDATE documents d
  JOIN (
    SELECT d2.id AS docId,
           (SELECT a.id
              FROM admissions a
             WHERE a.residentId = d2.residentId
               AND a.createdAt <= COALESCE(d2.createdAt, d2.uploadedAt, d2.submittedAt)
             ORDER BY a.admissionNumber DESC
             LIMIT 1) AS resolvedAdmissionId
      FROM documents d2
     WHERE d2.admissionId IS NULL
  ) resolved ON resolved.docId = d.id
   SET d.admissionId = resolved.resolvedAdmissionId
 WHERE resolved.resolvedAdmissionId IS NOT NULL;

-- Pass 2: anything still unplaced (dated before the first admission, or with no
-- timestamp at all) belongs to the resident's earliest admission — never left
-- NULL, because a document with no admission has no folder to appear in.
UPDATE documents d
  JOIN (
    SELECT d2.id AS docId,
           (SELECT a.id
              FROM admissions a
             WHERE a.residentId = d2.residentId
             ORDER BY a.admissionNumber ASC
             LIMIT 1) AS firstAdmissionId
      FROM documents d2
     WHERE d2.admissionId IS NULL
  ) resolved ON resolved.docId = d.id
   SET d.admissionId = resolved.firstAdmissionId
 WHERE resolved.firstAdmissionId IS NOT NULL;
