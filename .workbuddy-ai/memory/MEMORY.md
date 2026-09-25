# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, `master`. Live pair: `sch-path-production.up.railway.app` (API) +
`sch-path.vercel.app`. **History lives in the daily logs; this file is rules only.** No MySQL here —
verify on the live pair (served artifact, real UI via Playwright, API with a token).

## Easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text: renaming a state variable in a
  pinned component breaks a *backend* test. `\s*` where a call may wrap; flatten (`replace(/\s+/g,' ')`)
  when a pin would depend on indentation; `[^)]*` breaks on nested parens (`includes('x')`) — use
  `[^;]*`. Re-run `cd backend && node --test "tests/**/*.test.js"` after editing a pinned component.
- **Pin both ends — and the middle.** `documents.admissionId` was written by every writer and read by
  the resolver, but `/store` (the SPA's only bulk read, and the only query naming columns instead of
  `SELECT *`) omitted it, so it never reached the browser. Field looks absent → check the **read path**.
- **Mutation discipline.** Neuter, confirm the test *fails*, restore from bytes captured at apply time
  (not `git checkout --`, unconditionally). Print `matched N occurrence(s)`; exit non-zero on zero.
  Mutate **every** file the contract spans. **Never run the suite from the harness** — a node process
  cannot spawn the managed node binary (`execFileSync` → `status: null`).
- **`errorHandler` masks every MySQL error** — all `ER_*` → "Database error occurred". A **bare
  identifier out of scope is a live 500, not a load error** (hence the `rbac.` prefix in
  `accessDefaults.js`). Bind `toMysqlDateTime()`, not `toISOString()`; `normalizeDatetimes` walks
  `req.body` only.
- **A plain `Error` from a service is a 500, not a 400** (only `ApiError`/`ER_*`/`ValidationError`/JWT
  errors map). Validate in the **controller** with `ApiError(400, …)`; grep `throw new Error(` under
  `services/`.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status **then shape**;
  an HTML body throws — a path that misses the API gets the SPA rewrite's `index.html` at 200.
  `.blob()` only inside `fetchBinary` (pinned); `/forms/*.pdf` are same-origin, `arrayBuffer()`, not
  `apiUrl`.
- **A PDF template rendered as a DOM background needs the same cover the writer paints.** The TRI editor
  stacks `<PdfPage pageNumber={8}>` under absolutely-positioned names, so a name the PDF writer paints
  out with a white band is **not** painted out on screen — the two print over each other. Text
  extraction cannot see it (both names are in the layer); screenshot and crop. Form, download and
  published copy must read one constant.
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

DB holds **UTC**; `dateStrings: true` gives a zone-less literal JS parses as **local**, fixed at the
**response boundary** (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays **bare**;
`WALL_CLOCK_DATETIME_COLUMNS` (from `datetime-local`) is `+08:00`, not `Z`. **Never derive "now" from
`toISOString()`** — use `getCurrentPHDate()`/`getCurrentPHDateTime()`. Converting one side of a
comparison only = **8-hour skew** (`comparableStamp` vs `comparableBoundary`).

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
  `publishMissingTriDocuments()` at boot); a publish fault must be **reported**, not a silent
  `documentId: null`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs`: never `immutable`, always `?v=${pdfjs.version}`.** Unhashed paths revalidate;
  hashed may be `immutable`.
- `VITE_API_URL` is baked at build time and **must** be set on Vercel — so a local entry-chunk hash can
  never equal the deployed one; compare the chunk's *content*.
- **Railway redeploys on every push to `master`** — batch docs/memory commits.
- **`schema.sql` is never executed.** Only the boot migrations in `server.js` (and a controller's lazy
  `CREATE TABLE`) shape a deployed DB. `/store` swallows per-table errors into `[]`; a literal route
  after a `/:param` sibling 404s.

## Notifications and access

SSE via `services/alertStream.js` + `GET /api/alerts/stream`: `fetch` + `ReadableStream`, **not**
`EventSource`. **`targetRole` is one column — a role-addressed row reaches exactly one role**; address
**one row per user** (`usersWithAnyRole` + `notifyUsers`). Roles: `centerhead` (fullAccess), `admin`,
`nurse`, `psychologist`, `educator`, `socialworker`, `houseparent`; effective access =
`accessibleModules` + `subModules` + `permissions` via `buildAccessSnapshot()`.

- **An *empty* `accessibleModules` means "fall back to the role's full matrix".** Read the **role
  definition** (`getRoleDefinition(role)`), never the stored grant. Write path:
  `accessDefaults.canonicalizeModules` — a dropped alias is a **silent revocation**. The boot migration
  refills only `nurse`/`educator`/`houseparent`, so `[]` on the other three is the seed, not a repair.
- **`/alerts` has no module guard**, and `DELETE /api/alerts/:id` checks only `findVisible` — any
  recipient can delete a role-addressed alert for everyone. `/violations`, `/phaseProgress` likewise.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`); the seed writes
  `assignmentType = 'houseparent'` (never the old `'household'` typo). `/violations` and
  `/phaseProgress` are deliberately **facility-wide** for Houseparents. **Forward-only.**
- **Seed creds** in `scripts/seedDatabase.js`: `centerhead`/`centerhead123`, `socialworker`/`social123`,
  `psychologist`/`psych123`, `nurse`/`nurse123`, `educator`/`educator123`, `HP n`/`hp n 123`.

## Tooling

`backboard.railway.com/graphql/v2`: **workspace** token → `Authorization: Bearer <t>`, project token →
`Project-Access-Token`. **Never probe a workspace token with `me`/`projectToken`** — one unauthorised
field voids the selection set. Inline GraphQL in `node -e` gets shell-mangled — **write it to a file**.

- Playwright lives in the managed node workspace (`channel: 'msedge'`). **Never re-login in a loop** —
  login rate-limits (429, per-IP *per username*, 10/15 min); cache the token to a file across scripts.
- **`401` is not evidence a route exists.** A global `authenticate` runs **before** routing, so every
  unknown `/api` path answers 401 too. Prove a route with an **authenticated** call: a bogus path
  `404`s, a bogus param `400`s from the handler's own message.
- **Verifying a deployed bundle:** grep the chunk for **property** names (`designatedPersonnel`,
  `canSignOfficial`) — the minifier renames local `const`s, so a 0 count for a local name proves nothing.
- **6 tests fail in this sandbox, identically at HEAD** (5 in `jwt-secret.test.js`, 1 dialog-guard):
  `spawnSync … node.exe EBUSY`. Keep whole-suite backups **outside** the repo.
- **Verifying a push — the remote-tracking ref lies.** The sandbox **discards writes to
  `refs/remotes/`**; ask the server — `git ls-remote origin master`.
- **Behavioural controller tests without a DB:** stub `src/config/database` in `require.cache` before
  requiring the controller, dispatch on the SQL text, split column/value lists on **top-level commas**
  (`tests/intervention-schedule.test.js`).
- **Windows traps:** Python text-mode writes convert LF → CRLF (use `newline=''`); Python resolves `/tmp`
  as `C:\tmp` (use `"$(cygpath -w /tmp)/x.py"`); `shutil.copyfile` fails on Windows (`_samefile`) —
  restore a mutated file with `Path.write_bytes(original)`.
