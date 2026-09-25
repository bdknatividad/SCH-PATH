# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, `master`. Live pair: `sch-path-production.up.railway.app` (API) +
`sch-path.vercel.app`. **History lives in the daily logs; this file is rules only.** No MySQL here —
verify on the live pair (served artifact, real UI via Playwright, API with a token).

## Easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text: renaming a state variable in a
  pinned component breaks a *backend* test. `\s*` where a call may wrap; flatten
  (`replace(/\s+/g,' ')`) when a pin would depend on indentation; `[^)]*` breaks on nested parens
  (`includes('x')`) — use `[^;]*`. Re-run `cd backend && node --test "tests/**/*.test.js"` after
  editing any pinned component.
- **Pin both ends — and the middle.** `documents.admissionId` was written by every writer and read by
  the resolver, but `/store` (the SPA's only bulk read, and the only query naming columns instead of
  `SELECT *`) omitted it, so it never reached the browser. Field looks absent → check the **read path**.
- **Mutation discipline.** Neuter, confirm the test *fails*, restore from bytes captured at apply time
  (not `git checkout --`, unconditionally). Print `matched N occurrence(s)`; exit non-zero on zero.
  Mutate **every** file the contract spans. **Never run the suite from the harness** — a node process
  cannot spawn the managed node binary (`execFileSync` → `status: null`).
- **`errorHandler` masks every MySQL error** — all `ER_*` → "Database error occurred". A **bare
  identifier out of scope is a live 500, not a load error** (`accessDefaults.js` → hence the `rbac.`
  prefix). `toISOString()` bound to a DATETIME hides here too — bind `toMysqlDateTime()`;
  `normalizeDatetimes` walks `req.body` only.
- **A plain `Error` from a service is a 500, not a 400** (only `ApiError`/`ER_*`/`ValidationError`/JWT
  errors map). Validate in the **controller** with `ApiError(400, …)`; grep `throw new Error(` under
  `services/`.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status **then shape**;
  an HTML body throws — a path that misses the API gets the SPA rewrite's `index.html` at 200.
  `.blob()` only inside `fetchBinary` (pinned); `/forms/*.pdf` are same-origin, `arrayBuffer()`, not
  `apiUrl`.
- **Display-name keys (recurring class).** Add an id column beside the name, read the id first, gate the
  name comparison on `<idColumn> IS NULL` (migration aid only), backfill only where the name resolves to
  exactly one account, 400 on an unknown id, declare the column in `ensureTable`, the boot migration
  **and** `schema.sql`.
- **`ER_DATA_TOO_LONG`** hides behind that masking: compare against what the code *writes*, never a
  sample row; bound = the **declared width of the source column**.
- **`rbac.definition.json` is duplicated byte-for-byte** (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy it over the other.
- **No backticks** in print-HTML template literals (`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`) — a
  backtick in a CSS comment ends the string → `TS1005`.

## Time on the wire

DB holds **UTC**; `dateStrings: true` gives a zone-less literal JS parses as **local**. Fixed at the
**response boundary** (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` columns stay
**bare**; `WALL_CLOCK_DATETIME_COLUMNS` (from a `datetime-local`) is `+08:00`, not `Z`. **Never derive
"now" from `toISOString()`** — use `getCurrentPHDate()`/`getCurrentPHDateTime()`
(`utils/dateFormatter.ts`). Converting one side of a comparison only = **8-hour skew**
(`comparableStamp` vs `comparableBoundary`, `utils/admissionPeriods.ts`).

## Build and deploy

- Lazy routes via `@/app/utils/lazyComponent` in `App.tsx`. **Never add `pdfjs-dist` to
  `manualChunks`** (own async worker/CMaps resolved by URL). Entry chunk ≈ **142 kB gzip** budget.
- `vite build` does **not** run `tsc`; 9 known type errors in 4 components don't block it. It cannot
  finish in this sandbox (safe-delete shim refuses to empty `dist/assets`) — use
  `vite build --outDir /c/tmp/dist-verify --emptyOutDir`.
- Uploads are **base64 in MySQL `LONGTEXT`** — no filesystem/S3; DB size is the free-tier constraint.
- Docker context is the **repository root**, not `backend/`: the backend reads PDF templates and the
  logo from the **frontend tree** at runtime, copied file-by-file — **every such file needs a `COPY`
  line and the build won't tell you**.
- **A publisher with a non-fatal catch needs a retry path** (TRI `finalize` →
  `publishMissingTriDocuments()` at boot). A publish fault must be **reported**, not a silent
  `documentId: null`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs` must not be `immutable`, and its URL must carry a version query** —
  `` `/pdf.worker.mjs?v=${pdfjs.version}` ``. **Unhashed paths revalidate; hashed may be `immutable`.**
- `VITE_API_URL` is baked at build time and **must** be set on Vercel — so a local entry-chunk hash can
  never equal the deployed one; compare the chunk's *content*.
- **Railway redeploys on every push to `master`** — batch docs/memory commits.
- **`schema.sql` is never executed.** Only the boot migrations in `server.js` (and a controller's lazy
  `CREATE TABLE`) shape a deployed DB. `/store` swallows per-table errors into `[]`; a literal route
  after a `/:param` sibling 404s.

## Notifications and access

SSE via `services/alertStream.js` + `GET /api/alerts/stream`. Use `fetch` + `ReadableStream`, **not
`EventSource`**. **`targetRole` is one column — a role-addressed row reaches exactly one role**; address
**one row per user** (`usersWithAnyRole` + `notifyUsers`).

Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`, `socialworker`,
`houseparent`. Effective access = `accessibleModules` + `subModules` + `permissions` via
`buildAccessSnapshot()`.

- **An *empty* `accessibleModules` means "fall back to the role's full matrix".** Read the **role
  definition** (`getRoleDefinition(role)`), never the stored grant. Write path:
  `accessDefaults.canonicalizeModules` — a dropped alias is a **silent revocation**. The boot migration
  refills only `nurse`/`educator`/`houseparent`, so `[]` on the other three is the seed, not a repair.
- **`/alerts` has no module guard**; `DELETE /api/alerts/:id` checks only `findVisible`, so any recipient
  can delete a role-addressed alert for everyone. `/violations` and `/phaseProgress` are likewise
  unguarded.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`); the seed writes
  `assignmentType = 'houseparent'` (never accept the old `'household'` typo). `/violations` and
  `/phaseProgress` are deliberately **facility-wide** for Houseparents. **Forward-only.**
- **Seed creds** (`scripts/seedDatabase.js`): `centerhead`/`centerhead123`, `socialworker`/`social123`,
  `psychologist`/`psych123`, `nurse`/`nurse123`, `educator`/`educator123`, `HP n`/`hp n 123`.

## Tooling

`backboard.railway.com/graphql/v2`. **Workspace** token → `Authorization: Bearer <t>`; project token →
`Project-Access-Token`. **Never probe a workspace token with `me`/`projectToken`** — one unauthorised
field invalidates the selection set. A query inline in `node -e` is mangled by shell escaping — **write
it to a file**. Helpers: `C:/tmp/railway-deploy.js`, `wait-migration.js`. **`deploymentLogs` carries
request-time errors** with stack and path.

- Playwright lives in the managed node workspace (`channel: 'msedge'`). **Never re-login in a loop** —
  login rate-limits (429, per-IP *per username*, 10/15 min); cache the token to a file across scripts.
- **6 tests fail in this sandbox, identically at HEAD** (5 in `jwt-secret.test.js`, 1 dialog-guard):
  `spawnSync … node.exe EBUSY`. Keep whole-suite backups **outside** the repo.
- **Verifying a push — the remote-tracking ref lies.** The sandbox **discards writes to
  `refs/remotes/`**; ask the server — `git ls-remote origin master`.
- **Behavioural controller tests without a DB:** stub `src/config/database` in `require.cache` before
  requiring the controller, dispatch on the SQL text, split column/value lists on **top-level commas**
  (`tests/intervention-schedule.test.js`).
- **Windows traps:** Python text-mode writes convert LF → CRLF (multi-line markers stop matching; use
  `newline=''`); Python resolves `/tmp` as `C:\tmp` (use `"$(cygpath -w /tmp)/x.py"`).
