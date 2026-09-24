# SCH-PATH — Project Notes

Long-term notes for `C:\sept23`. Stack: React 18 + Vite 6 + TS + Tailwind 4
(frontend), Express 4 + mysql2 + JWT (backend). MySQL-only.

## Conventions that are easy to break

### Backend tests read frontend source as text
`backend/tests/*.test.js` has no frontend test runner, so it pins frontend
behaviour by regex against `.tsx` source. Consequences:
- Renaming a state variable or parameter in a pinned component breaks a
  **backend** test. The pin is often a literal identifier, not a pattern.
- Relaxing such a test is sometimes correct (it was asserting a calling
  convention rather than behaviour) — but check that first.
- Run `cd backend && node --test "tests/**/*.test.js"` after any frontend edit to
  `App.tsx`, `Layout.tsx`, `PhaseProgress.tsx`, `SignaturePad.tsx`,
  `ChildRecords.tsx`, `Tri.tsx`, `Health.tsx`.

### Verbatim no-backticks rule
Several components build print HTML inside JS **template literals**
(`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`). A backtick inside a CSS comment
in those blocks terminates the string and produces a confusing `TS1005`. Write
comments there without backticks.

### RBAC definition is duplicated byte-for-byte
`backend/src/config/rbac.definition.json` and
`frontend/src/app/config/rbac.definition.json` are asserted equal by a test.
Edit one, then copy it over the other.

### `accessDefaults.js` needs the `rbac.` prefix
`rbac.CHILD_RECORD_TABS_MODULE`, not the bare name — the bare identifier is not
in scope in that file and throws at require time, breaking unrelated tests with
HTTP 500s.

### A plain `Error` from a service is a 500, not a 400
`middleware/errorHandler.js` maps only `ApiError`, `ER_*`, `ValidationError` and
the JWT errors to a specific status; anything else falls through to
`err.statusCode || 500`, and in production the message is masked to "Internal
server error". So a service that validates by throwing a bare `Error` reports the
caller's mistake as a server fault with nothing to act on. Validate in the
**controller** and throw `ApiError(400, …)`; leave the service's throw as a
programmer-error guard for callers that bypass the controller. Measured before
the fix: `POST /alerts {}` → 500 (now 400). When auditing an endpoint's error
contract, grep `throw new Error(` under `services/`.

### Verifying a guard: mutate, then restore from your own copy
The dominant test style here is source-text scanning, so a guard can pass
vacuously. Neuter the code and confirm the test actually *fails* before trusting
it. Restore from a copy you made — **not `git checkout --`** — because the fix is
normally still uncommitted, so HEAD does not contain it and the checkout reverts
the fix along with the mutation.

**Check the mutator actually applied.** A mutation script that silently fails to
match makes the whole battery vacuous — a green run then proves nothing. Have the
mutator print `replaced N occurrence(s)` and fail loudly on zero.

### Windows traps when scripting a mutation or a source-scanning test
- **Python text-mode writes convert LF → CRLF.** `io.open(p, 'w')` writes `\r\n`.
  A test that locates a block by a multi-line marker containing `\n` then stops
  matching: `indexOf` gives `-1` and `slice(-1)` yields a *one-character* block —
  which fails, or with a loose pattern passes for the wrong reason. Normalize on
  read (`.replace(/\r\n/g, '\n')`) and assert the markers were found plus a
  plausible block length. Write LF deliberately with `newline=''`.
- **Python resolves `/tmp` as `C:\tmp`.** A helper heredoc'd to `/tmp/x.py` is not
  readable by `python /tmp/x.py` under Git Bash. Use `"$(cygpath -w /tmp)/x.py"`.

### Behavioural controller tests without a database
Inject a pool stub into `require.cache` for `src/config/database` *before*
requiring the controller, then dispatch on the SQL text inside a fake
`query(sql, params)`. Lets the real rule be exercised — not source text. Patterns:
`tests/violation-verification-access.test.js`,
`tests/access-request-history-identity.test.js`.

### Keying a relationship on a display name (the recurring defect class)
Where a link is stored as a printed name, the fix shape is: add an id column
*beside* the name; read the id first; gate the old name comparison on
`<idColumn> IS NULL` so it is only a migration aid; backfill only where the name
resolves to exactly one account; refuse an unknown id with a 400; and declare the
column in **all** places the table is created (`ensureTable`, `server.js` boot
migration, `schema.sql`). Applied to `admissions.houseparentUserId` (item 51) and
`accessRequests.reviewedById` (item 50). The failure mode is always silent — the
wrong list is returned — so it needs tests, not a smoke test.

### A controller test needs no database when validation precedes I/O
If the code under test rejects bad input before its first query, drive the
controller with fake `req`/`res` and a `next` that captures the error, and assert
the **real status code**. Stronger than a text assertion, and it needs no pool
stub: `config/database` builds a pool at import, but `createPool` does not
connect. Pattern in `tests/notifications.test.js`.

## Frontend build / bundling

- Route-level lazy loading lives in `App.tsx` via
  `@/app/utils/lazyComponent` — it handles the codebase's mix of named and
  default exports. Add new routes that way, not with static imports.
- **Never add `pdfjs-dist` to `manualChunks`.** It emits its own async worker and
  CMaps chunks resolved at runtime by URL; pinning it breaks the worker. See the
  comment in `vite.config.ts`.
- Entry-chunk budget: keep it near **142 kB gzip**. If it grows much beyond that,
  a heavy import has leaked into the shell or `LoginPage`.
- `vite build` does **not** run `tsc`. There are 9 long-standing type errors in
  `AssessmentDetail.tsx`, `Assessments.tsx`, `ChildDetail.tsx`,
  `ChildRecords.tsx`; they do not block the build. Do not "fix" them casually —
  check the change does not alter the pinned text those components' tests read.

## Deployment invariants

- All uploaded files are **base64 inside MySQL `LONGTEXT` columns**. There is no
  filesystem or S3 layer. Database size is therefore the primary free-tier
  constraint, and MySQL is mandatory (the code uses `ON DUPLICATE KEY UPDATE`,
  `INFORMATION_SCHEMA`, `max_allowed_packet`).
- The backend reads PDF templates and the logo from the **frontend tree** at
  runtime (`../../../frontend/public/forms`, `frontend/src/assets/sch-logo.png`).
  The Docker build context must be the **repository root** and the image must
  carry those files. Do not "fix" the context to `backend/`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths. Any
  new file added to `frontend/public/` **must** be added to that exclusion, or it
  is served as `index.html` in production. `pdf.worker.mjs` is the one that
  breaks everything visibly if missed.
- PDF form templates live in `frontend/public/forms/` (18 referenced, 20 on
  disk). If a generated PDF is blank in production, check the Docker context
  before anything else.

## Access model summary

Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`,
`socialworker`, `houseparent`. Effective access = `accessibleModules` +
`subModules` + `permissions` on the user row, resolved through
`buildAccessSnapshot()`.

**Known trap:** `buildAccessSnapshot()` treats an *empty* `accessibleModules`
array as "fall back to the role's full matrix". Code that decides redaction must
read the **role definition** (`getRoleDefinition(role)`), never the stored grant,
or an account seeded with `[]` gains everything. `childController.js` has the
correct pattern in `roleCanReachMedicalTab` / `roleCanReachHealth`.

**`/alerts` has no module guard.** It is mounted as
`router.use('/alerts', authenticate, alertRoutes)` — no `requireModule` — so every
authenticated account reaches the whole alert surface. That makes
`DELETE /api/alerts/:id` cross-user destructive: `notificationService.remove()`
deletes the row itself plus its `alertReads`, and the only check is `findVisible`
("can I see it"), so any one recipient can delete a role-addressed alert for
everyone sharing it. This contradicts the per-user read state the module was
built around. `DataContext.tsx` → `deleteResource('alerts', id)` reaches it from
the UI for every role. Unresolved: fixing it needs an `alertDismissals` table
(per-user, consistent with `alertReads`) or a manager-only delete, and both
change UX. `/violations` and `/phaseProgress` are likewise mounted without a
module guard.

**Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), and
the seed now writes `assignmentType = 'houseparent'` — the one value every reader
grants scope on. The old `'household'` seed value was a **typo, fixed 2026-09-24
(commit `effd62d`)**. Never widen a reader to accept `'household'`: the seed
creates the full houseparent × child cross product, so accepting it would hand
every Houseparent every resident. `/violations` and `/phaseProgress` are
deliberately **facility-wide** for Houseparents, so `tests/caseload-scope.test.js`
no longer asserts those two controllers consult the scope.

**That seed fix is forward-only.** `seedResidentAssignments` keys its
idempotency check on `(userId, residentId)` and ignores `assignmentType`, so on
an already-seeded database every pair is present (with the old value) and no
corrected row is inserted — the change only lands on a fresh seed. The live demo
still shows seeded Houseparents an empty caseload until those rows are rewritten,
which is a deliberate access change awaiting a decision. Note also that the seed
never writes `admissions.houseparentOnDuty`, so the legacy fallback in
`residentScope.js` does not cover seeded Houseparents.

## Two traps that make a failure look like a non-failure

**`/store` swallows per-table errors.** Each table in the bulk load is wrapped in
try/catch and assigned `[]` on error, logged only server-side. So a *broken*
table and a genuinely *empty* one are indistinguishable from outside — both
render as "no records". To tell them apart, compare `/store` against the
individual endpoint for the same table. All 19 resources currently agree.

**A literal route declared after a `/:param` sibling is unreachable.** Express
matches in declaration order, so `router.get('/:id')` above
`router.get('/daily-data')` meant the literal path could never be called — it
404'd as "report not found" for its whole life, while the route file advertised
it. Fixed in `reportRoutes.js`; guarded generally by
`tests/route-shadowing.test.js`. Keep literal paths above catch-alls.

**The live deployment's database is confirmed working** (measured 2026-09-24, not
assumed): ~147 read probes across the whole API, zero 5xx. Railway holds both the
backend and the MySQL; Vercel serves the SPA. The seeded `centerhead` login in
`scripts/seedDatabase.js` works against it, which is enough to reach every module.
**`/api/health` still does not query MySQL**, so Railway's healthcheck would
report the service healthy with a dead database — an unfixed blind spot.
