# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4, Express 4 + mysql2 + JWT.
MySQL-only. Repo `bdknatividad/SCH-PATH`, branch `master`. Live pair:
`sch-path-production.up.railway.app` (API) + `sch-path.vercel.app`. Detail and
history live in the daily logs; this file is rules only.

No reachable MySQL here, so verify on the live pair: the **served artifact** (a
lazy route's fix lands in a *route chunk*, not the entry chunk), the **real UI**
(Playwright on Vercel, real login, assert rendered output not HTTP 200s), the
**API** with a bearer token.

## Conventions that are easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text (no frontend
  runner), so renaming a state variable in a pinned component breaks a *backend*
  test — the pin is often a literal identifier. Relaxing such a test is sometimes
  right but check first. `\s*` where a call may wrap; flatten
  (`replace(/\s+/g,' ')`) if a pin would depend on indentation; `[^)]*` breaks on
  nested parens like `includes('x')` — use `[^;]*`. Re-run
  `cd backend && node --test "tests/**/*.test.js"` after editing any pinned component.
- **Mutation discipline.** Neuter the code, confirm the test actually *fails*, then
  restore from bytes captured at apply time — not `git checkout --`, and
  unconditionally (the mutation removed the match string). Print
  `matched N occurrence(s)`; exit non-zero on zero. Mutate **every** file the
  contract spans, or the test may fail for a disagreement rather than the regression.
- **The harness must not run the suite.** A node process cannot spawn the managed
  node binary — `execFileSync` returns `status: null` and *throws*, so a harness
  treating "threw" as failure marks every mutation caught. Run the suite from bash.
- **A bare identifier not in scope is a live 500, not a load error.**
  `violationGuideController` called `normalizeRole` without importing it, so every
  `PUT /intervention-tracker/:id` carrying `scheduledAt` threw `ReferenceError` → 500
  while `{status}` and `{}` kept working; `accessDefaults.js` is the same shape
  (`rbac.CHILD_RECORD_TABS_MODULE`). `tests/intervention-schedule.test.js` walks
  `src/**` and checks every `utils/authorization.js` export a file *calls* is imported
  or defined there.
- **A plain `Error` from a service is a 500, not a 400.** `errorHandler` maps only
  `ApiError`, `ER_*`, `ValidationError` and the JWT errors; the rest fall to
  `err.statusCode || 500`, and production masks the message. Validate in the
  **controller** with `ApiError(400, …)`; grep `throw new Error(` under `services/`.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks
  status **then shape** — an HTML body throws, because a path that never reaches the
  API is answered by the SPA rewrite with `index.html` and a 200, and pdf.js then
  reports a *render* failure. `.blob()` only inside `fetchBinary` (pinned);
  `/forms/*.pdf` are same-origin assets read via `arrayBuffer()`, not `apiUrl`.
- **Display-name keys (recurring class).** Add an id column beside the name, read the
  id first, gate the name comparison on `<idColumn> IS NULL` (migration aid only),
  backfill only where the name resolves to exactly one account, 400 on an unknown id,
  and declare the column in `ensureTable`, the boot migration **and** `schema.sql`.
  Silent failure, so it needs tests.
- **No backticks** in print-HTML template literals (`Reports.tsx`,
  `PhaseProgress.tsx`, `Tri.tsx`) — a backtick in a CSS comment terminates the string
  → `TS1005`.

## Column widths — a copy must be as wide as its source

`errorHandler` maps **every** `ER_*` to the generic "Database error occurred" and
drops `err.message` in production, so a failing column is never named in the UI —
read the Railway runtime log. `ER_DATA_TOO_LONG` is the trap that hides there: the
width must be compared against what the code *writes*, and a sample row cannot reveal
it, because the row that breaks it is the one nobody has created yet. So derive the
bound from the **declared width of the source column** — a column that copies another
must be at least as wide as the column it copies. `ensureColumnLength()` widens
idempotently at boot and logs
`Migration: <table>.<column> widened to <def> (was <n>).` only **after** the ALTER
succeeds, so that line is the proof. Pinned by
`tests/assessments-column-widths.test.js`; the widths live in `schema.sql` **and** the
`server.js` CREATE TABLEs, which must agree.

## Time on the wire

`dateStrings: true` makes a DATETIME arrive as the literal stored string with **no
zone**, and the database holds **UTC**; JS parses a zone-less date-time as **local**,
so `2026-09-25 06:32:02` showed as 06:32 in Manila instead of 14:32. Fixed at the
**response boundary** (`utils/serverTime.js` + `middleware/isoTimestamps.js`, wrapping
`res.json` before `/api`) — one boundary beats 47 `toLocale*` call sites, because a
formatter runs after `new Date()` has already committed to the wrong instant.

- **`DATE` columns stay bare** — a calendar day is not an instant, and the bare form
  feeds `<input type="date">`. The pattern requires a time.
- **Not every DATETIME is a UTC instant.** `WALL_CLOCK_DATETIME_COLUMNS`
  (`incidentDateTime`, `scheduledAt`) is filled from a `datetime-local` and labelled
  `+08:00`, not `Z`; storage untouched. The list is asserted whole — one column
  wrongly left out lands 8 h out.
- **Never derive "now"/"today" from `toISOString()`** — it is UTC, so `slice(0,10)`
  is the UTC *day* (yesterday in Manila until 08:00). Use `getCurrentPHDate()` /
  `getCurrentPHDateTime()` (`utils/dateFormatter.ts`; the latter pins `hour12: false`
  because `en-CA` otherwise renders "02:40 p.m.", which a `datetime-local` rejects).
  `toMysqlDateTime` writes the **process's** wall-clock, `NOW()` the **database's** —
  hence `ENV TZ=UTC`. Pinned by `tests/iso-timestamps.test.js`,
  `tests/wall-clock-columns.test.js`, `tests/manila-now-defaults.test.js`.

## Build and deploy invariants

- Lazy routes go through `@/app/utils/lazyComponent` in `App.tsx`. **Never add
  `pdfjs-dist` to `manualChunks`** — it emits its own async worker and CMaps chunks
  resolved at runtime by URL; pinning it breaks the worker. Entry-chunk budget near
  **142 kB gzip** (currently 110.85 / 32.76 kB).
- `vite build` does **not** run `tsc`; 9 long-standing type errors
  (`AssessmentDetail.tsx` 4, `ChildDetail.tsx` 3, `Assessments.tsx` 1,
  `ChildRecords.tsx` 1) do not block the build. It also cannot finish in this sandbox
  (the safe-delete shim refuses to empty `dist/assets`) — use
  `vite build --outDir /c/tmp/dist-verify --emptyOutDir` for a real artifact.
- Uploads are **base64 inside MySQL `LONGTEXT`** — no filesystem or S3 layer, so DB
  size is the free-tier constraint. MySQL is mandatory (`ON DUPLICATE KEY UPDATE`,
  `INFORMATION_SCHEMA`).
- The backend reads PDF templates and the logo from the **frontend tree** at runtime,
  so the Docker context is the **repository root**, not `backend/`.
  `COPY backend/src ./backend/src` is a **directory** copy, so a new
  controller/service/route needs no Dockerfile change. The frontend tree is copied
  file-by-file, so **every frontend file the backend resolves at request time needs a
  `COPY` line and the build will not tell you** (omitting `triLayout.json` made every
  TRI approval throw ENOENT silently — `tests/tri-docker-assets.test.js`).
- **A publisher with a non-fatal catch needs a retry path.** TRI `finalize` swallows
  a render failure so an approval is never rolled back, so
  `publishMissingTriDocuments()` (at boot) finishes the job; the Anecdotal Report
  publishes *before* flipping status instead. A publish fault must be **reported** —
  a silent `documentId: null` hides it.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file
  in `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs` must not be `immutable`, and its URL must carry a version
  query.** It sits at an **unhashed** URL, so `immutable` is a one-way door: served
  once with a bad Content-Type it stayed broken for a year, and fixing the header
  changed nothing — only a **new URL** cures it. Every
  `GlobalWorkerOptions.workerSrc` must be `` `/pdf.worker.mjs?v=${pdfjs.version}` ``
  (`tests/pdf-worker-cache-key.test.js`). **Unhashed paths must revalidate; hashed
  ones may be `immutable`.**
- `VITE_API_URL` is baked at build time and **must** be set on Vercel; the baseline
  hardcoded `'/api'`, breaking every request on the split deployment. `api.ts` exports
  `API_BASE_URL`/`apiUrl` for callers that cannot use `request()`. Consequence: **a
  local build's entry-chunk hash can never equal the deployed one** — compare the
  chunk's *content*, not its filename.
- **Railway redeploys on every push to `master`** — a docs-only commit restarts
  production. Batch memory/comment commits; do not push one per edit.

## Notifications

SSE via `services/alertStream.js` + `GET /api/alerts/stream` (30s poll is the
fallback); the frame carries no data, so `GET /api/alerts` stays the single visibility
implementation. Use `fetch` + `ReadableStream`, **not `EventSource`**. **`targetRole`
is one column, so a role-addressed row reaches exactly one role** — address **one row
per user** (`usersWithAnyRole` + `notifyUsers`).

## Access model

Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`,
`socialworker`, `houseparent`. Effective access = `accessibleModules` + `subModules`
+ `permissions` on the user row, via `buildAccessSnapshot()`.

- **`buildAccessSnapshot()` treats an *empty* `accessibleModules` as "fall back to
  the role's full matrix".** Code deciding redaction must read the **role definition**
  (`getRoleDefinition(role)`), never the stored grant, or an account seeded with `[]`
  gains everything. `childController.js` has the right pattern in
  `roleCanReachMedicalTab` / `roleCanReachHealth`.
- **The write path for `accessibleModules` is `accessDefaults.canonicalizeModules`**
  (`userController` 209/366/544/666, `server.js:1324`): delegate to
  `rbac.normalizeModuleKey`, then order by `MODULE_ORDER`. Being the write path, a
  dropped alias is a **silent revocation**.
- **Read `[]` carefully.** The boot migration refills `accessibleModules` only for
  `nurse`/`educator`/`houseparent`, so a `[]` on `centerhead`/`socialworker`/
  `psychologist` is the original seed, *not* evidence a repair ran.
- **`/alerts` has no module guard**, and `DELETE /api/alerts/:id` checks only
  `findVisible` — so any recipient can delete a role-addressed alert for everyone,
  contradicting the per-user read state the module is built around. Unresolved: needs
  an `alertDismissals` table or a manager-only delete. `/violations` and
  `/phaseProgress` are likewise mounted without a guard.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), and the
  seed writes `assignmentType = 'houseparent'`. Never widen a reader to accept the old
  `'household'` typo (fixed `effd62d`): the seed creates the full houseparent × child
  cross product, so accepting it would hand every Houseparent every resident.
  `/violations` and `/phaseProgress` are deliberately **facility-wide** for
  Houseparents. The fix is **forward-only**.

## Failure modes that hide

**`schema.sql` is never executed.** Only the boot migrations in `server.js` (and a
controller's own lazy `CREATE TABLE`) shape a deployed database, so a column declared
only in schema.sql exists on a fresh install and nowhere else. The contract test
checks the runtime set separately. `seedDatabase()`'s one shared try/catch made the
first failure skip every later step (fixed `5b68857`); `/store` swallows per-table
errors into `[]`; a literal route after a `/:param` sibling 404s for its whole life.
**`GET /api/health/db`** is *readiness*, `/api/health` a *liveness* check.

## Inspecting Railway

`backboard.railway.com/graphql/v2`. A **workspace** token uses
`Authorization: Bearer <t>`; a project token uses `Project-Access-Token`. **Never
probe a workspace token with `me` or `projectToken`** — one unauthorised field
invalidates the whole selection set.

Project `fabulous-radiance` `840f2fbc-7579-4294-9715-8c0cfd7d06a7`, service `SCH-PATH`
`b5fb305f-e348-4f2f-982b-49fbd38e929f`; the `MySQL` and `production` environment ids sit
beside them in `C:/tmp/railway-deploy.js` / `wait-migration.js`, which list deployments,
dump the runtime log, and grep the boot log for a migration line. **`deploymentLogs`
carries request-time errors** — a controller's `next(error)` appears with its stack and
the request path. Token `84e36095-…` was valid 2026-09-25.

## Tooling and test infrastructure

- Playwright lives in the managed node workspace (`channel: 'msedge'` = installed
  Edge). **Never re-login in a loop** — the login route rate-limits (429), and a poll
  that fetches a token per attempt then sends `Bearer undefined` → a burst of
  `401 Invalid token` at `auth.js`. Cache the token to a file, across scripts.
- **6 tests fail in this sandbox and fail identically at HEAD** (5 in
  `jwt-secret.test.js`, 1 dialog-guard): `spawnSync … node.exe EBUSY` — prove it by
  stashing and running clean first. **Sandbox read-blocks on `node_modules/*` corrupt
  a whole-suite run** — keep backups **outside** the repo.
- **Verifying a push — the remote-tracking ref lies.** The sandbox **discards writes
  to `refs/remotes/`**, so after a push the server accepted, `git log
  origin/master..HEAD` still lists those commits. Ask the server —
  `git ls-remote origin master`.
- **Behavioural controller tests without a database:** inject a pool stub into
  `require.cache` for `src/config/database` *before* requiring the controller, then
  dispatch on the SQL text in a fake `query(sql, params)`
  (`tests/intervention-schedule.test.js`). If validation precedes the first query, no
  stub is needed — drive the controller with fake `req`/`res` and assert the real
  status (`tests/notifications.test.js`). A fake store must split column and value
  lists on **top-level commas** (quote/paren-aware, only `?` advances the counter) —
  publishers interleave literals, so pairing positionally yields `undefined` ids.
