# SCH-PATH — the user's 51-item revision list

Recovered from the session transcript `cbf18b3a-475e-4484-9adc-ec24c849ccd5.jsonl` after the list
was lost from context once. **This file is the list.** The user sends the items one at a time; for
each one, check it against the deployed pair, implement what is missing, and add a guard test for
anything already done.

Status so far: **4, 5, 6, 7, 8 done** (and the force-discharge → re-intake bug found while testing 4).
Item 8 was answered, then **corrected by the user** and rebuilt — the block is five lines and the
template's own second-row names are the right people, so the cover band is gone. **Item 9 is a
do-not-touch item** (leave open for the user). Next: 10+.

## GENERAL / SCH

1. **Admission Slip – Houseparent on Duty.** Houseparent on Duty on the Admission Slip should refer
   only to the HP on duty upon admission; it must not change when the resident is later reassigned.
2. **Houseparent Case Load Manager.** Before a resident reaches 1 month after admission they should
   already have an assigned Houseparent / Case Load Manager, reflected in the system.
3. **E-Signatures.** For forms requiring signatures: draw with the cursor **or** upload a signature
   image, and make sure it is saved and appears in the generated document.
4. **Documents Search – Per Resident / Per Admission.** ✅ Searchable per resident and per admission,
   not the whole stay. Option/filter: Current Admission / Specific Admission / Entire Stay. A selected
   admission shows only its own documents; the default is the current admission.
5. **Incident Report – Reassessment.** ✅ Reassessing a reviewed Incident Report must return it to the
   Intervention Tracker, with the intervention staying pending until it is approved again.
6. **Scheduled Today.** ✅ Fix the Scheduled Today statistics; activities and assessments must show in
   the count/list and the count must match the data. (Widened by the user to *every* role's dashboard.)
7. **Court Records – Hearing Type.** ✅ Already implemented — "Sentencing" appears nowhere and the
   dropdown offers "Promulgation of Judgement"; `hearingType` is free-text `VARCHAR(100)` and live
   `courtRecords` is empty, so nothing to migrate. **Guard added:** `backend/tests/court-hearing-type.test.js`.
8. **TRI – Signatures.** ✅ Built and corrected. The user's first answer was **wrong** and they
   retracted it: `Ma'am HCKSBD` is not a person, Francis C. Patricio is SWO I (**not** SWO II), and
   the two names the template prints on the block's second row are the **correct** people — so the
   white cover band was hiding the right names. The real block is five lines:

   | row | line | printed name | who prints it |
   |---|---|---|---|
   | 1 | Houseparent | whoever prepared/signed | the app |
   | 1 | Administrative Officer | `PERCILA S. VILLA` | the app (template is blank) |
   | 1 | SWO I / Case Manager | `FRANCIS C. PATRICIO, RSW` | the app (template is blank) |
   | 2 | SWO II / Center Head | `MARICOR C. NAVARRO, MSSW, RSW` | **the template itself** |
   | 2 | SWO III / Section Chief | `NICOLAS Q. REGALARIO, MSSW, RSW` | **the template itself** |

   All four official lines are signable, each on its own column triple. The keys name the **line**,
   not the office-holder; `swo2`/`swo3` keep the columns they shipped with
   (`centerhead*`/`sectionchief*`) so the signatures already on live records are not moved — only the
   six new `adminOfficer*`/`swo1*` columns are added. **No cover band anywhere.** Row 2 draws no name
   at all, only a signature. Two alignment fixes the user asked for in the same message: the printed
   name goes **below** the signature on the TRI's Houseparent line, and every signature is **centred
   over the printed name** rather than over its box (both forms). Shipped in `d4e5a01`.
   **Guards:** `tri-designated-signatures.test.js` rewritten for four lines,
   `tri-houseparent-signature.test.js` and `anecdotal-report-pdf.test.js` updated; 9 mutations, all
   caught. Verified live: the four new keys answer 409 on a Finalized record, the old keys 400, all
   15 signature columns exist, TRI006's stored drawings survived, and page 8 renders correctly.
   See the daily log for the coordinate table.
9. **Anecdotal Report.** Leave open for further details the user will supply. Do not assume or modify
   beyond the explicitly requested changes.
10. **Admission – Piercing/Tattoo Form.** Add a form/section at admission for documenting piercings and
    tattoos (Left Chest, Right Ear, etc.) using a **dropdown** for the location, not free text.
11. **Academic Support / Tutorial.** Residents not enrolled in school (e.g. the enrolment period has
    ended) should have Academic Support Sessions / Tutorial as the appropriate educational activity.
12. **Education – Quarterly Reports by Role.** Each applicable role gets its own Quarterly Report, with
    role-specific sections. Example: the Educator's report should drop the sections from the
    Observation Phase down if they do not apply. Do not force identical content on every role.
13. **Houseparent Count.** The system has 10 Houseparents, not 11. Use HP 1–HP 10.
14. **Case Worker Ratio.** Case Worker to resident ratio is 1:15 — a maximum caseload of 15 residents.

## NURSE

15. **Medical Form – Multiple Dates / Editable Records.** The medical form from the top-left section
    stays editable; different entries may have different dates and staff keep adding entries rather
    than being limited to one record. Add Doctor's Name and Doctor's Specialization (Cardiologist,
    Pediatrician, …). Remove the signature.
16. **Documents – Resident Status Filter.** Add All / Active / Discharged, defaulting to **Active**,
    and the user can change it.
17. **Laboratory Results / Medical Certificate.** Put Laboratory Results beside the Laboratory
    Procedure section; allow uploading the lab results, and a Medical Certificate.
18. **Height and Weight – BMI.** Auto-calculate BMI, support monthly records, retain each month's
    height/weight/BMI, and show the healthy weight range/percentage the facility uses — following the
    same calculation method as the facility's own reference.
19. **Dental Form.** Remove the signature; replace with Dentist Name and Dental Clinic Name.

## SOCIAL WORKER

20. **Admission – Guardian.** Make the Guardian field optional in the Admission Phase; admission must
    proceed without a guardian.
21. **Social Worker – Force Advance.** Add/restore Force Advance in the Social Worker's Phase Timeline.
22. **Incident Report – Dual Verification.** Incidents must be verified by **both** the Psychologist
    and the Social Worker before proceeding; one alone is not enough.
23. **Incident Report Names.** Ma'am Joyce at the top, Sir Francis at the bottom, as printed names
    rather than role labels.
24. **Assessment Module – Social Worker.** View-only. The Social Worker must not complete, modify or
    add assessments; remove/disable those actions.
25. **Court Records Statistics.** Check and fix every count in the Court Records Module against the
    actual records.
26. **Abscon / Returning Resident / Relapse / New.** Offer the right Admission Status for a resident
    with previous records: *Returning Resident (Abscon / Tumakas)* — absconded and later apprehended,
    including repeats; *Relapse* — previously discharged, returns with a new case; *New* — no previous
    admission. Previous admissions must be preserved, never overwritten.
27. **Quarterly Progress Report – Status.** The dropdown should contain Normal, Moderate, Severe.
28. **Quarterly Progress Report – Narrative.** Add a Narrative section at the very bottom, included in
    the saved/generated report.
29. **Quarterly Progress Report – Signature.** Fix the signature section wording and layout — correct
    Signature over Printed Name formatting and alignment.

## EDUCATOR

30. **Dashboard – Remove Requiring Completion.** Remove it. Once a resident is endorsed to the school
    the Educator should no longer track them as requiring completion.
31. **School Visit Schedule.** Add an Add Schedule function for School Visits.
32. **Add Student – Tutorial / ALS.** Make the education/program options specific: include Tutorial;
    for ALS do not use a generic "High School" — separate ALS Elementary, ALS Junior High School, ALS
    Senior High School.
33. **Add Student – Grade / Section.** Make both optional; a student can be added without them.
34. **Add Student – Status.** Remove "Dropped" from the status options.
35. **Add Student – Automatic Information.** Selecting an existing resident auto-populates Address,
    Guardian Name and Guardian Contact Number from the resident's record.

## HOUSEPARENT

36. **Houseparent Module UI.** Fix layout/readability — tabs, labels, buttons, tables and resident
    information must be clearly visible.
37. **Houseparent – Log Incident.** Make Log Incident work for the appropriate roles; find out why the
    Houseparent interface cannot properly see/use the expected incident functionality.
38. **Houseparent – Verification Access.** Houseparents must not see Incident Report Verification:
    hide/remove the section and its statistics, and block the underlying records if they click a
    statistic/tab. Enforce at **both** frontend and backend/API. Apply the same principle to every
    other unauthorised role — hiding a button is not enough.
39. **Houseparent – Medical Notes Notification.** When the medical notes of an assigned resident are
    updated, notify the assigned HP, naming the resident and saying their medical information changed.

## PSYCHOLOGIST

40. **Rename Role.** "Psychologist" → **"Psychological Staff"**, consistently everywhere: Account
    Management, dashboards, dropdowns, permissions, documents, reports, notifications, generated
    documents. No stray "Psychologist" labels.
41. **Psychological Staff – Add Child.** Remove/disable Add Child; they must not create residents.
42. **Psychological Staff – Log Incident.** Remove/disable Log Incident from Child Records.
43. **Psychological Staff – Orientation Phase.** They must not check or modify the Orientation Phase
    checklist — that belongs to authorised Houseparents only. Enforce through the UI **and** the API.

## GENERAL SYSTEM CHECKS

44. **Documents – Admission Folder Order.** Always show the Current Admission folder first, past
    admissions below it, and never mix current with past documents.
45. **Social Worker – Activities and Assessments.** Remove the ability to add Activities and
    Assessments if not part of the authorised role; the Social Worker must not add an assessment.
46. **Dashboard – Duplicate Case Sections.** Check the bottom sections where Case Closed, Active Cases
    and similar appear duplicated; remove the duplicate and keep the correct statistics.
47. **Dashboard – Pending Documents / For Review.** The counts do not reflect properly; connect them to
    the actual pending-review documents.
48. **Behavioral Tab – Arrow.** Work out what the arrow beside the Behavioral tab is for; fix or remove
    it. No unexplained or non-functional controls.
49. **Violation – "Kailangan ng Schedule" Issue.** A violation such as "Kulang sa respeto" wrongly
    requires a schedule, blocking verification because there are no schedule actions. Fix the
    violation/intervention configuration so violations without a scheduling workflow verify normally.
50. **Access Request History.** Previously approved/rejected requests do not appear. Make sure they are
    saved and displayed; check both the database records and the UI filtering/status logic.
51. **Houseparent Account Name Changes.** Assignment detection must survive an HP rename. Base the
    assignment on a stable user/account **ID**, never the displayed name. Check the same for other
    roles: a display-name change must not break assignments, permissions or relationships.
