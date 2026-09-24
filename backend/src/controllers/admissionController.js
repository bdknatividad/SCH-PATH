const { pool } = require('../config/database');
const { ApiError } = require('../middleware/errorHandler');
const { generateId, runInTransactionWithIdRetry, normalizeAge, mapRow } = require('../utils/helpers');
const {
  PHASE_REQUIREMENTS,
  ADMISSION_STATUSES,
  DEFAULT_RETURNING_ADMISSION_STATUS,
} = require('../utils/constants');
const notifications = require('../services/notificationService');
const { canAccessResident } = require('./assignmentController');

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function requireField(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ApiError(400, `${label} is required.`);
  }
}

/** `requireField` only proves the value is non-empty; this proves it is a date. */
function requireValidDate(value, label) {
  requireField(value, label);
  if (Number.isNaN(new Date(value).getTime())) {
    throw new ApiError(400, `${label} must be a valid date.`);
  }
}

/**
 * Classify an admission.
 *
 * A first admission is `New` and nothing else can be true of it, whatever the
 * caller sends — the system knows there is no earlier admission, so it does not
 * ask. A later admission has to be told apart: a resident who left without
 * permission and a resident who returned to substance use are identical in the
 * data, so the caller's choice is taken. An omitted or unrecognised value falls
 * back to the label the interface used before the vocabulary existed, rather
 * than refusing an admission the Social Worker has already completed.
 *
 * @param {number} admissionNumber - 1 for a first admission, higher afterwards.
 * @param {unknown} requested - The caller's classification, if any.
 * @returns {string} One of `ADMISSION_STATUSES`.
 */
function resolveAdmissionStatus(admissionNumber, requested) {
  if (Number(admissionNumber) <= 1) return 'New';
  const value = String(requested ?? '').trim();
  if (value && value !== 'New' && ADMISSION_STATUSES.includes(value)) return value;
  return DEFAULT_RETURNING_ADMISSION_STATUS;
}

/**
 * The stable id of the Houseparent on duty.
 *
 * The slip has always recorded this person as a *printed name*
 * (`houseparentOnDuty`), and the caseload scope then matched that name back
 * against `users.username` / `displayName` / `fullName` to decide which
 * residents a Houseparent may open. A name is not a key: renaming a member of
 * staff silently moved their caseload, two people sharing a display name saw
 * each other's residents, and a stray double space in the dropdown label was
 * enough to detach the resident entirely.
 *
 * The admission now carries the id alongside the name. The name is still
 * written — it is what the official slip prints — but it is a label again
 * rather than the link. The name match survives only for rows admitted before
 * this column existed, and only where the column is still NULL.
 *
 * An id that names nobody is refused as a 400 rather than stored, because a
 * dangling id would look like an assignment while granting nothing.
 *
 * @param {unknown} value The selected Houseparent's `users.id`.
 * @returns {Promise<string|null>} The id, or null when nothing was selected.
 */
async function resolveHouseparentUserId(value, executor = pool) {
  const id = String(value ?? '').trim();
  if (!id) return null;

  const [rows] = await executor.query('SELECT id FROM users WHERE id = ? LIMIT 1', [id]);
  if (!rows.length) {
    throw new ApiError(400, 'The selected Houseparent on duty no longer exists.');
  }
  return rows[0].id;
}

function requireContactNumber(value, label) {
  const contact = String(value || '').replace(/\D/g, '');

  if (!contact) {
    throw new ApiError(400, `${label} is required.`);
  }

  if (!/^\d{11}$/.test(contact)) {
    throw new ApiError(
      400,
      `${label} must contain exactly 11 digits.`
    );
  }

  return contact;
}

async function findResidentByName(connection, name) {
  const normalizedName = normalizeName(name);

  if (!normalizedName) return null;

  const [rows] = await connection.query(
    `SELECT *
       FROM children
      WHERE LOWER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' '))) = ?
      ORDER BY createdAt ASC
      LIMIT 1`,
    [normalizedName]
  );

  return rows[0] || null;
}

async function getLatestForResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    const [rows] = await pool.query(
      `SELECT *
         FROM admissions
        WHERE residentId = ?
        ORDER BY admissionNumber DESC
        LIMIT 1`,
      [residentId]
    );

    res.json({
      success: true,
      data: rows[0] ? mapRow('admissions', rows[0]) : null,
    });
  } catch (error) {
    next(error);
  }
}

async function getByResident(req, res, next) {
  try {
    const { residentId } = req.params;
    if (!await canAccessResident(req.user, residentId)) {
      throw new ApiError(403, 'You are not assigned to this resident');
    }

    const [rows] = await pool.query(
      `SELECT *
         FROM admissions
        WHERE residentId = ?
        ORDER BY admissionNumber DESC`,
      [residentId]
    );

    res.json({
      success: true,
      data: rows.map(row => mapRow('admissions', row)),
      count: rows.length,
    });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const body = req.body || {};
    const resident = body.resident || {};
    const admission = body.admission || {};

    // `admissions.caseHistory` is NOT NULL, but the admission form always submits
    // it empty. An API client that omits the field entirely would otherwise hit
    // the constraint and see an opaque "Database error occurred" instead of a
    // saved admission, so normalise it the same way the form does.
    const caseHistory = String(admission.caseHistory ?? '');

    /*
     * Required resident/admission information.
     */
    requireField(resident.name, 'Full name');
    requireValidDate(resident.birthDate, 'Date of birth');
    requireField(resident.sex, 'Sex');
    requireField(resident.religion, 'Religion');
    requireField(resident.address, 'Complete address');

    // The guardian is optional. The Social Worker is often admitting a resident
    // whose guardian has not been traced yet, or who has none — making all three
    // fields mandatory forced something to be typed into each one, and a
    // placeholder is worse than a blank because it reads as a real guardian
    // afterwards. What is still enforced is the *format*: a contact number that
    // was supplied has to be a usable one.
    const guardianName = String(resident.guardianName ?? '').trim();
    const guardianContact = String(resident.guardianContact ?? '').trim();
    const guardianAddress = String(resident.guardianAddress ?? '').trim();
    if (guardianContact) {
      requireContactNumber(guardianContact, 'Guardian contact');
    }

    requireField(admission.admissionDate, 'Date of admission');
    if (admission.expectedDischargeDate != null && String(admission.expectedDischargeDate).trim() !== '') {
      requireValidDate(admission.expectedDischargeDate, 'Expected discharge date');
      if (new Date(admission.expectedDischargeDate) < new Date(admission.admissionDate)) {
        throw new ApiError(400, 'Expected discharge date cannot be before the admission date.');
      }
    }
    requireField(admission.legalCategory, 'Legal category');
    requireField(admission.specificOffense, 'Specific offense');

    requireField(
      admission.referringParty,
      'Referring party'
    );

    requireField(
      admission.referringPartyContact,
      'Referring party contact'
    );

    requireContactNumber(
      admission.referringPartyContact,
      'Referring party contact'
    );

    requireField(
      admission.houseparentOnDuty,
      'Houseparent on duty'
    );

    // Resolved here rather than inside the transaction: an unknown id is the
    // caller's mistake, and the transaction below creates a resident, a phase
    // row and the admission, so it should not be opened to discover that.
    const houseparentUserId = await resolveHouseparentUserId(admission.houseparentUserId);

    // Creating a resident, their first phase record and the admission snapshot
    // is one state transition across three tables, so it must not half-apply.
    // Four ids are derived from the current maximum (CH, two PHS, ADM), so two
    // simultaneous admissions can compute the same one and the loser's INSERT
    // fails on a duplicate primary key — the whole transaction is therefore
    // retried, and its fresh snapshot then sees the ids the winner committed.
    // A locking read cannot be used: this transaction already holds a `children`
    // row lock, so locking the whole id range would deadlock against a
    // concurrent admission (see runInTransactionWithIdRetry).
    const { residentId, admissionId, admissionNumber } = await runInTransactionWithIdRetry(pool, async (connection) => {

      let residentId = body.residentId || null;
      let existingResident = null;
      let isNewResident = false;

      /*
       * If residentId was supplied, this is a new admission
       * for an existing resident.
       */
      if (residentId) {
        const [rows] = await connection.query(
          'SELECT * FROM children WHERE id = ? FOR UPDATE',
          [residentId]
        );

        if (!rows.length) {
          throw new ApiError(404, 'Resident not found.');
        }

        existingResident = rows[0];

        /*
         * Never create another admission while the latest admission is active.
         * Returning residents are allowed when the previous admission was
         * properly closed (status = 'Closed').
         */
        const [latestAdmissionRows] = await connection.query(
          `SELECT status
             FROM admissions
            WHERE residentId = ?
            ORDER BY admissionNumber DESC
            LIMIT 1`,
          [residentId]
        );

        const latestAdmissionStatus = latestAdmissionRows[0]?.status || null;
        if (latestAdmissionStatus === 'Active') {
          throw new ApiError(
            409,
            'This resident already has an active admission. Open the existing admission instead.'
          );
        }
      } else {
        /*
         * New person: make sure the same full name does not already exist.
         */
        existingResident = await findResidentByName(connection, resident.name);

        if (existingResident) {
          const [latest] = await connection.query(
            `SELECT *
               FROM admissions
              WHERE residentId = ?
              ORDER BY admissionNumber DESC
              LIMIT 1`,
            [existingResident.id]
          );

          throw new ApiError(
            409,
            'A resident with this full name already exists. Please confirm the existing admission before creating a new admission.',
            {
              existingResident: mapRow('children', existingResident),
              latestAdmission: latest[0]
                ? mapRow('admissions', latest[0])
                : null,
            }
          );
        }

        const [allChildren] = await connection.query(
          'SELECT id FROM children'
        );

        residentId = generateId(
          'CH',
          allChildren.map(row => ({ id: row.id }))
        );

        isNewResident = true;
      }

      /*
       * Determine admission number.
       */
      const [numberRows] = await connection.query(
        `SELECT COALESCE(MAX(admissionNumber), 0) + 1 AS nextNumber
           FROM admissions
          WHERE residentId = ?`,
        [residentId]
      );

      const admissionNumber = Number(numberRows[0]?.nextNumber || 1);

      /*
       * The admission this one supersedes, if any.
       *
       * A resident reaching here is either new (admission 1) or returning, in
       * which case the previous admission was closed above and its phases are
       * the ones to retire. Read before the `admissions` insert so it names the
       * *outgoing* admission rather than the one being created.
       */
      const [previousAdmissionRows] = await connection.query(
        `SELECT id
           FROM admissions
          WHERE residentId = ?
          ORDER BY admissionNumber DESC
          LIMIT 1`,
        [residentId]
      );
      const previousAdmissionId = previousAdmissionRows[0]?.id || null;

      const admissionStatus = resolveAdmissionStatus(admissionNumber, admission.admissionStatus);

      /*
       * Create resident master record only for first admission.
       */
      if (isNewResident) {
        await connection.query(
          `INSERT INTO children (
            id,
            name,
            age,
            gender,
            admissionDate,
            legalCategory,
            caseType,
            status,
            casePhase,
            isRepeatOffender,
            previousCaseDetails,
            previousCases,
            birthDate,
            address,
            documentsComplete,
            guardianName,
            guardianContact,
            createdBy
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 'Admission Phase', ?, ?, '[]', ?, ?, FALSE, ?, ?, ?)`,
          [
            residentId,
            resident.name.trim().replace(/\s+/g, ' '),
            normalizeAge(resident.age, resident.birthDate),
            resident.sex,
            admission.admissionDate,
            admission.legalCategory,
            admission.specificOffense,
            admissionNumber > 1,
            caseHistory,
            resident.birthDate,
            resident.address,
            guardianName || null,
            guardianContact || null,
            req.user?.username || 'System',
          ]
        );

        const phaseRequirements =
          PHASE_REQUIREMENTS['Admission Phase'] || {};

        const [existingPhases] = await connection.query(
          'SELECT id FROM phaseProgress'
        );

        const phaseId = generateId(
          'PHS',
          existingPhases.map(row => ({ id: row.id }))
        );

        await connection.query(
          `INSERT INTO phaseProgress (
            id,
            residentId,
            phaseName,
            enteredAt,
            isCurrent,
            tasksRequired,
            tasksCompleted,
            enteredBy,
            createdBy
          ) VALUES (?, ?, 'Admission Phase', ?, 1, ?, '[]', ?, ?)`,
          [
            phaseId,
            residentId,
            admission.admissionDate,
            JSON.stringify(phaseRequirements.requiredTasks || []),
            req.user?.username || 'System',
            req.user?.username || 'System',
          ]
        );
      } else {
        /*
         * Existing resident:
         * keep the permanent resident ID but update ONLY
         * the current/master summary.
         *
         * The previous admission itself remains untouched in admissions.
         */
        /*
         * Every earlier admission, not just the one being closed.
         *
         * The Documents module splits a returning resident's files by admission,
         * so the whole history has to survive on the resident row: keeping only
         * the latest admission would erase admission 1 the moment a resident
         * came back a second time, and its documents would have no period to
         * belong to.
         *
         * `closedDate` is taken from the admission row itself, which the
         * discharge flow stamps. It only falls back to the intake date when an
         * admission was never formally closed, so every period has an end.
         */
        const [priorAdmissions] = await connection.query(
          `SELECT id,
                  admissionNumber,
                  admissionDate,
                  legalCategory,
                  specificOffense,
                  caseHistory,
                  closedDate
             FROM admissions
            WHERE residentId = ?
              AND admissionNumber < ?
            ORDER BY admissionNumber ASC`,
          [residentId, admissionNumber]
        );

        // `admissionId` is carried through so the Documents module can match a
        // document's own admissionId to the period it belongs to, instead of
        // guessing from upload timestamps.
        const previousCases = priorAdmissions.map((row) => ({
          admissionId: row.id,
          admissionNumber: row.admissionNumber,
          admissionDate: row.admissionDate,
          legalCategory: row.legalCategory,
          specificOffense: row.specificOffense,
          caseHistory: row.caseHistory,
          closedDate: row.closedDate || admission.admissionDate,
        }));

        await connection.query(
          `UPDATE children
              SET name = ?,
                  age = ?,
                  gender = ?,
                  admissionDate = ?,
                  legalCategory = ?,
                  caseType = ?,
                  status = 'Active',
                  casePhase = 'Admission Phase',
                  isRepeatOffender = TRUE,
                  previousCaseDetails = ?,
                  previousCases = ?,
                  birthDate = ?,
                  address = ?,
                  documentsComplete = FALSE,
                  guardianName = ?,
                  guardianContact = ?,
                  readmissionDate = ?,
                  readmissionDatetime = ?
            WHERE id = ?`,
          [
            resident.name.trim().replace(/\s+/g, ' '),
            normalizeAge(resident.age, resident.birthDate),
            resident.sex,
            admission.admissionDate,
            admission.legalCategory,
            admission.specificOffense,
            caseHistory,
            JSON.stringify(previousCases),
            resident.birthDate,
            resident.address,
            guardianName || null,
            guardianContact || null,
            admission.admissionDate,
            new Date().toISOString(),
            residentId,
          ]
        );

        /*
         * Retire the phases of the admission being closed.
         *
         * Scoped to the admission, not the resident: archiving everything the
         * resident owns would also close the phases of admissions already
         * retired, and — because `isCurrent` is the only "which phase are they
         * in" signal — would leave the returning resident with no current phase
         * at all until the insert below ran. A phase belongs to exactly one
         * admission, so an admission retires only its own.
         *
         * Rows written before the admission link existed (NULL) still fall back
         * to the per-resident sweep, so a legacy upgrade does not strand them.
         */
        await connection.query(
          `UPDATE phaseProgress
              SET isCurrent = 0,
                  completedAt = COALESCE(completedAt, ?),
                  completedBy = COALESCE(completedBy, ?)
            WHERE residentId = ?
              AND (admissionId = ? OR admissionId IS NULL)
              AND isCurrent = 1`,
          [
            admission.admissionDate,
            req.user?.username || 'System',
            residentId,
            previousAdmissionId,
          ]
        );

        const [existingPhases] = await connection.query(
          'SELECT id FROM phaseProgress'
        );

        const phaseId = generateId(
          'PHS',
          existingPhases.map(row => ({ id: row.id }))
        );

        const phaseRequirements =
          PHASE_REQUIREMENTS['Admission Phase'] || {};

        await connection.query(
          `INSERT INTO phaseProgress (
            id,
            residentId,
            phaseName,
            enteredAt,
            isCurrent,
            tasksRequired,
            tasksCompleted,
            enteredBy,
            createdBy
          ) VALUES (?, ?, 'Admission Phase', ?, 1, ?, '[]', ?, ?)`,
          [
            phaseId,
            residentId,
            admission.admissionDate,
            JSON.stringify(phaseRequirements.requiredTasks || []),
            req.user?.username || 'System',
            req.user?.username || 'System',
          ]
        );
      }

      /*
       * Create the IMMUTABLE admission snapshot.
       */
      const [allAdmissions] = await connection.query(
        'SELECT id FROM admissions'
      );

      const admissionId = generateId(
        'ADM',
        allAdmissions.map(row => ({ id: row.id }))
      );

      await connection.query(
        `INSERT INTO admissions (
          id,
          residentId,
          admissionNumber,
          admissionDate,
          name,
          age,
          sex,
          birthDate,
          religion,
          address,
          residentSignature,
          residentImage,
          guardianName,
          guardianContact,
          guardianAddress,
          guardianSignature,
          referringParty,
          referringPartyContact,
          referringPartySignature,
          houseparentOnDuty,
          houseparentUserId,
          houseparentSignature,
          legalCategory,
          specificOffense,
          caseHistory,
          admissionStatus,
          expectedDischargeDate,
          status,
          createdBy
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?
        )`,
        [
          admissionId,
          residentId,
          admissionNumber,
          admission.admissionDate,
          resident.name.trim().replace(/\s+/g, ' '),
          normalizeAge(resident.age, resident.birthDate),
          resident.sex,
          resident.birthDate,
          resident.religion,
          resident.address,
          admission.residentSignature,
          admission.residentImage || null,
          guardianName || null,
          guardianContact || null,
          guardianAddress || null,
          admission.guardianSignature,
          admission.referringParty,
          admission.referringPartyContact,
          admission.referringPartySignature,
          admission.houseparentOnDuty,
          houseparentUserId,
          admission.houseparentSignature,
          admission.legalCategory,
          admission.specificOffense,
          caseHistory,
          admissionStatus,
          admission.expectedDischargeDate || null,
          req.user?.username || 'System',
        ]
      );

      /*
       * Anchor this admission's phases to it.
       *
       * The phase row above was inserted before the admission existed, so it
       * could not carry the link at insert time. Without this the row would stay
       * NULL forever and a *later* re-admission's archival would sweep it (the
       * NULL fallback). Only rows with no link are touched, so an earlier
       * admission's retired phases are never pulled into this one.
       */
      await connection.query(
        `UPDATE phaseProgress
            SET admissionId = ?
          WHERE residentId = ?
            AND admissionId IS NULL`,
        [admissionId, residentId]
      );

      return { residentId, admissionId, admissionNumber };
    });

    const [residentRows] = await pool.query(
      'SELECT * FROM children WHERE id = ?',
      [residentId]
    );

    const [admissionRows] = await pool.query(
      'SELECT * FROM admissions WHERE id = ?',
      [admissionId]
    );

    // A new resident entering the facility is a supervisory fact the Center
    // Head has to know about, and nothing told them before. Addressed per
    // account (not per role) so the actor never gets their own action back.
    try {
      const managers = await notifications.usersWithAnyRole(['centerhead', 'admin']);
      await notifications.notifyUsers(
        managers.map((m) => m.id),
        {
          type: 'Admission',
          residentId,
          title: `New Resident Admitted - ${resident.name}`,
          message: `${req.user?.username || 'A staff member'} admitted ${resident.name} to the facility (admission ${admissionNumber}).`,
          priority: 'Medium',
          actionRequired: 'Review the intake record.',
          relatedRecordType: 'admissions',
          relatedRecordId: admissionId,
          actorUsername: req.user?.username,
          dedupeKey: `admission:${admissionId}:created`,
        }
      );
    } catch (notifyErr) {
      console.error('[AdmissionController] Admission notification failed (non-fatal):', notifyErr.message);
    }

    res.status(201).json({
      success: true,
      data: {
        resident: mapRow('children', residentRows[0]),
        admission: mapRow('admissions', admissionRows[0]),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  let connection;
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM admissions WHERE id = ?', [id]);
    if (!rows.length) throw new ApiError(404, 'Admission not found.');
    if (rows[0].status !== 'Active') throw new ApiError(403, 'Only the current active Admission Slip can be edited.');
    const b = req.body || {};
    if (b.expectedDischargeDate !== undefined && b.expectedDischargeDate !== null && String(b.expectedDischargeDate).trim() !== '') {
      requireValidDate(b.expectedDischargeDate, 'Expected discharge date');
      if (b.admissionDate && new Date(b.expectedDischargeDate) < new Date(b.admissionDate)) {
        throw new ApiError(400, 'Expected discharge date cannot be before the admission date.');
      }
    }
    const fields = ['admissionDate','expectedDischargeDate','name','age','sex','birthDate','religion','address','residentSignature','guardianName','guardianContact','guardianAddress','guardianSignature','referringParty','referringPartyContact','referringPartySignature','houseparentOnDuty','houseparentUserId','houseparentSignature','residentImage','legalCategory','specificOffense','admissionStatus'];
    const sets = []; const values = [];
    for (const field of fields) {
      if (b[field] === undefined) continue;
      // The Houseparent on duty is stored by id as well as by printed name, so
      // reassigning a resident survives a rename of the new Houseparent. An id
      // that names nobody is refused here rather than written as a dangling
      // reference that would look like an assignment and grant nothing.
      if (field === 'houseparentUserId') {
        sets.push(`${field} = ?`);
        values.push(await resolveHouseparentUserId(b[field]));
        continue;
      }
      sets.push(`${field} = ?`); values.push(b[field] === '' ? null : b[field]);
    }
    if (!sets.length) return res.json({ success: true, data: mapRow('admissions', rows[0]) });
    sets.push('modifiedBy = ?'); values.push(req.user?.username || 'System'); values.push(id);

    // The admission slip and the resident master record are two views of the
    // same person. Updating one without the other leaves Personal Info
    // disagreeing with the official slip, so both writes share a transaction.
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.query(`UPDATE admissions SET ${sets.join(', ')} WHERE id = ?`, values);
    const [updatedRows] = await connection.query('SELECT * FROM admissions WHERE id = ?', [id]);
    const updatedAdmission = updatedRows[0];
    // Keep the resident master record synchronized with the current admission.
    // Personal Info reads from children, while the official slip reads from admissions.
    //
    // The two guardian fields are assigned rather than COALESCEd. They are the
    // one pair the caller can now legitimately clear — the guardian is optional —
    // and `COALESCE(NULL, guardianName)` would keep the old name on Personal Info
    // after the slip had been blanked, so the two views would disagree about
    // whether the resident has a guardian. `updatedAdmission` is read back after
    // the write, so it is the authoritative current value either way.
    await connection.query(
      `UPDATE children
          SET name = COALESCE(?, name),
              age = COALESCE(?, age),
              gender = COALESCE(?, gender),
              birthDate = COALESCE(?, birthDate),
              admissionDate = COALESCE(?, admissionDate),
              address = COALESCE(?, address),
              guardianName = ?,
              guardianContact = ?,
              legalCategory = COALESCE(?, legalCategory),
              caseType = COALESCE(?, caseType)
        WHERE id = ?`,
      [updatedAdmission.name, updatedAdmission.age, updatedAdmission.sex,
       updatedAdmission.birthDate, updatedAdmission.admissionDate,
       updatedAdmission.address, updatedAdmission.guardianName,
       updatedAdmission.guardianContact, updatedAdmission.legalCategory,
       updatedAdmission.specificOffense, updatedAdmission.residentId]
    );

    await connection.commit();

    res.json({ success: true, data: mapRow('admissions', updatedAdmission) });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* connection already gone */ }
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
}

async function getById(req, res, next) {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      'SELECT * FROM admissions WHERE id = ?',
      [id]
    );

    if (!rows.length) {
      throw new ApiError(404, 'Admission not found.');
    }

    res.json({
      success: true,
      data: mapRow('admissions', rows[0]),
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  resolveAdmissionStatus,
  resolveHouseparentUserId,
  create,
  getByResident,
  getLatestForResident,
  getById,
  update,
};