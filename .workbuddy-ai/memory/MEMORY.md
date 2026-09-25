# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, `master`. Live pair: `sch-path-production.up.railway.app` (API) +
`sch-path.vercel.app`. **History lives in the daily logs; this file is rules only.** No MySQL here —
verify on the live pair.

## Easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text: renaming a state variable in a pinned
  component breaks a *backend* test. `\s*` where a call may wrap; flatten (`replace(/\s+/g,' ')`) when a pin
  would depend on indentation; `[^)]*` breaks on nested parens — use `[^;]*`. Re-run
  `cd backend && node --test "tests/**/*.test.js"` after editing one.
- **Pin both ends — and the middle.** `documents.admissionId` was written and read, but `/store` (the
  SPA's only bulk read, the only query naming columns instead of `SELECT *`) omitted it. Field looks
  absent → check the **read path**.
- **Mutation discipline.** Neuter, confirm the test *fails*, restore from bytes captured at apply time (not
  `git checkout --`, unconditionally). Print `matched N occurrence(s)`; exit non-zero on zero. Mutate
  **every** file the contract spans. **Never run the suite from the harness** — a node process cannot spawn
  the managed node binary (`execFileSync` → `status: null`).
- **`errorHandler` masks every MySQL error** — all `ER_*` → "Database error occurred". A **bare
  identifier out of scope is a live 500, not a load error** (hence the `rbac.` prefix in
  `accessDefaults.js`); a plain `Error` from a service is a **500, not a 400** (only
  `ApiError`/`ER_*`/`ValidationError`/JWT map), so validate in the **controller** with `ApiError(400, …)`
  and grep `throw new Error(` under `services/`. Bind `toMysqlDateTime()`, not `toISOString()`;
  `normalizeDatetimes` is `req.body`-only. `ER_DATA_TOO_LONG` hides behind the masking: compare against
  what the code *writes*, never a sample row; bound = the **declared width of the source column**.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status **then shape**; an
  HTML body throws — a path that misses the API gets the SPA rewrite's `index.html` at 200. `.blob()` only
  inside `fetchBinary` (pinned); `/forms/*.pdf` are same-origin, `arrayBuffer()`, not `apiUrl`.
- **A PDF template drawn as a DOM background must match the writer — but only where the template is
  blank.** TRI's editor stacks `<PdfPage pageNumber={8}>` under absolutely-positioned names. Page 8 row 1
  is **empty** (the app prints all three); row 2 **already prints its two names and they are correct**, so
  the app stamps no name and **must not paint a cover band** (an earlier design hid a right name). Text
  extraction cannot tell; crop the render. All three render paths (form, download, published copy) read one
  constant.
- **Three y conventions, and `top` means two things.** `pdfPercentTop(centerY, height)` (`Tri.tsx`) centres
  an `h`-tall box on a bottom-left `centerY`; `pdfTop(topFromBottom, height)` (`AnecdotalReports.tsx`) takes
  a bottom-left lower edge; `HOUSEPARENT_SIGNATURE_BOX.top` (`anecdotalReportPdf.js`) is a **top-left upper
  edge**. A rule's **ink sits below its reported baseline** (TRI row 1: baseline 772.75, ink 770.57–772.5)
  — clearance checks use the ink.
- **A signature column names the LINE, not the office-holder.** `triRecords` keys its lines
  `adminofficer`/`swo1`/`swo2`/`swo3`, but `swo2`/`swo3` read `centerheadSignature`/`sectionchiefSignature`
  (those hold live data). Deriving the column from the key (`${key}Signature`) reads `undefined` and prints
  a **blank line, not an error**.
- **Display-name keys (recurring class).** Add an id column beside the name, read the id first, gate the
  name comparison on `<idColumn> IS NULL` (migration aid only), backfill only where the name resolves to
  exactly one account, 400 on an unknown id, and declare the column in `ensureTable`, the boot migration
  **and** `schema.sql`.
- **`rbac.definition.json` is duplicated byte-for-byte** (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy it over the other.
- **No backticks** in print-HTML template literals (`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`) — a
  backtick in a CSS comment ends the string → `TS1005`.

## Time on the wire

DB holds **UTC**; `dateStrings: true` gives a zone-less literal JS parses as **local**, fixed at the
**response boundary** (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays **bare**;
`WALL_CLOCK_DATETIME_COLUMNS` (from `datetime-local`) is `+08:00`, not `Z`. **Never derive "now" from
`toISOString()`** — use `getCurrentPHDate()`/`getCurrentPHDateTime()`. Converting one side of a
comparison only = **8-hour skew** (`comparableStamp` vs `comparableBoundary`).

## Build and deploy

- Lazy routes via `@/app/utils/lazyComponent` in `App.tsx`. **Never add `pdfjs-dist` to `manualChunks`**
  (own async worker/CMaps). Entry chunk ≈ **142 kB gzip** budget.
- `vite build` does **not** run `tsc`; 9 known type errors in 4 components don't block it. It cannot
  finish in this sandbox (safe-delete shim refuses to empty `dist/assets`) — use
  `vite build --outDir /c/tmp/dist-verify --emptyOutDir`.
- Uploads are **base64 in MySQL `LONGTEXT`** — no filesystem/S3; DB size is the free-tier constraint.
  Docker context is the **repository root**, not `backend/`: the backend reads PDF templates and the logo
  from the **frontend tree** at runtime — **every such file needs a `COPY` line and the build won't tell
  you**.
- **A publisher with a non-fatal catch needs a retry path** (TRI `finalize` →
  `publishMissingTriDocuments()` at boot); a publish fault must be **reported**, not a silent
  `documentId: null`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs`: never `immutable`, always `?v=${pdfjs.version}`.** Unhashed paths revalidate;
  hashed may be `immutable`.
- `VITE_API_URL` is baked at build time and **must** be set on Vercel — so a local entry-chunk hash never
  equals the deployed one.
- **Railway redeploys on every push to `master`** — batch docs/memory commits. **Vercel can silently skip a
  push** — check the commit's statuses, not the bundle.
- **`schema.sql` is never executed.** Only the boot migrations in `server.js` (and a controller's lazy
  `CREATE TABLE`) shape a deployed DB. `/store` swallows per-table errors into `[]`; a literal route
  after a `/:param` sibling 404s.

## Notifications and access

SSE via `services/alertStream.js` + `GET /api/alerts/stream`: `fetch` + `ReadableStream`, **not**
`EventSource`. **`targetRole` is one column — a role-addressed row reaches one role**; address
**one row per user** (`usersWithAnyRole` + `notifyUsers`). Roles: `centerhead` (fullAccess), `admin`,
`nurse`, `psychologist`, `educator`, `socialworker`, `houseparent`; effective access =
`accessibleModules` + `subModules` + `permissions` via `buildAccessSnapshot()`.

- **An *empty* `accessibleModules` means "fall back to the role's full matrix".** Read the **role
  definition** (`getRoleDefinition(role)`), never the stored grant. Write path:
  `accessDefaults.canonicalizeModules` — a dropped alias is a **silent revocation**. The boot migration
  refills only `nurse`/`educator`/`houseparent`, so `[]` on the other three is the seed, not a repair.
- **`/alerts` has no module guard**, and `DELETE /api/alerts/:id` checks only `findVisible` — any
  recipient can delete a role-addressed alert for everyone. `/violations`, `/phaseProgress` too.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`); the seed writes
  `assignmentType = 'houseparent'`. `/violations` and `/phaseProgress` are **facility-wide** for
  Houseparents on purpose. **Forward-only.**
- **Seed creds** in `scripts/seedDatabase.js`: `centerhead`/`centerhead123`, `socialworker`/`social123`,
  `psychologist`/`psych123`, `nurse`/`nurse123`, `educator`/`educator123`, `HP n`/`hp n 123`.

## Tooling

`backboard.railway.com/graphql/v2`: **workspace** token → `Authorization: Bearer <t>`, project token →
`Project-Access-Token`. **Never probe a workspace token with `me`/`projectToken`** — one unauthorised
field voids the selection set. Inline GraphQL in `node -e` gets shell-mangled — **use a file**.

- Playwright lives in the managed node workspace (`channel: 'msedge'`). **Never re-login in a loop** —
  login rate-limits (429, per-IP *per username*, 10/15 min); cache the token.
- **`401` is not evidence a route exists.** A global `authenticate` runs **before** routing, so every
  unknown `/api` path answers 401 too. Prove a route with an **authenticated** call: a bogus path
  `404`s, a bogus param `400`s from the handler's own message.
- **Verifying a deployed bundle:** grep the chunk for **property** names — the minifier renames locals, so
  a 0 count proves nothing.
- **6 tests fail here, identically at HEAD** (5 `jwt-secret.test.js`, 1 dialog-guard): `spawnSync …
  node.exe EBUSY`. Back up outside the repo.
- **Verifying a push — the remote-tracking ref lies.** The sandbox **discards writes to
  `refs/remotes/`**; ask the server: `git ls-remote origin master`.
- **Behavioural controller tests without a DB:** stub `src/config/database` in `require.cache` before
  requiring the controller, then dispatch on the SQL text (`tests/intervention-schedule.test.js`).
- **Windows traps:** Python text-mode writes convert LF → CRLF (use `newline=''`); python's `/tmp` is
  `C:\tmp` but `$(cygpath -w /tmp)` is `%TEMP%` — pass the literal `C:/tmp/x.py`; restore a mutated file
  with `Path.write_bytes(original)`, not `shutil.copyfile`.
