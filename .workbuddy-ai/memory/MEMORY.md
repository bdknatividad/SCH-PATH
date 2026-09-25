# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, `master`. Live pair: `sch-path-production.up.railway.app` (API) +
`sch-path.vercel.app`. History lives in the daily logs; this file is rules only. No MySQL here —
verify on the live pair.

## Easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text: renaming a state variable in a
  pinned component breaks a *backend* test. `\s*` where a call may wrap; flatten when the pin would
  depend on indentation; `[^)]*` breaks on nested parens — use `[^;]*`. Pin the **read path** too,
  not just the write. Re-run the suite after editing a pinned component.
- **Mutation discipline.** Neuter, confirm the test *fails*, restore from bytes captured at apply
  time (never `git checkout --`), unconditionally. Print `matched N occurrence(s)`, exit non-zero on
  zero. Mutate **every** file the contract spans. Never run the suite from the harness — a node
  process cannot spawn the managed node binary.
- **`errorHandler` masks every MySQL error** (all `ER_*` → "Database error occurred"). A bare
  out-of-scope identifier is a live 500 (hence the `rbac.` prefix in `accessDefaults.js`). A plain
  `Error` from a service is a **500, not a 400** — validate in the **controller** with
  `ApiError(400, …)`, and grep `throw new Error(` under `services/`. Bind `toMysqlDateTime()`, not
  `toISOString()`. `ER_DATA_TOO_LONG` hides behind the masking: the bound is the declared width of
  the **source column**, never a sample row.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status **then
  shape**; a path that misses the API gets the SPA rewrite's `index.html` at 200. `.blob()` only
  inside `fetchBinary` (pinned). `/forms/*.pdf` are same-origin, `arrayBuffer()`, not `apiUrl`.
- **A NOT NULL column is a silent feature blocker.** `CREATE TABLE IF NOT EXISTS` does nothing to a
  deployed table — add a guarded boot migration (read `IS_NULLABLE` first, then `ALTER … MODIFY
  COLUMN`, in try/catch with `console.warn`). Normalize nulls at **every** boundary that puts a row
  into state, including all save responses.
- **Display-name keys (recurring class).** Add an id column beside the name, read the id first, gate
  the name comparison on `<idColumn> IS NULL`, backfill only where the name resolves to exactly one
  account, 400 on an unknown id, and declare the column in `ensureTable`, the boot migration **and**
  `schema.sql`.
- **One implementation, not two.** `ChildRecords.tsx` and `ChildDetail.tsx` each carry a copy of the
  Admission Slip drawing code with different coordinates; the slip opened from `/children` comes from
  **ChildDetail**. A fix in one writer prints nothing in production — the live PDF's text layer is
  what catches it.
- **`rbac.definition.json` is duplicated byte-for-byte** (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy it over the other.
- **No backticks** in print-HTML template literals (`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`) —
  a backtick in a CSS comment ends the string → `TS1005`.
- **PDF geometry: three y conventions, and `top` means two things** (`pdfPercentTop` centres a box on
  a bottom-left centre; `pdfTop` takes a lower edge; `HOUSEPARENT_SIGNATURE_BOX.top` is a top-left
  upper edge). A rule's ink sits **below** its baseline — clearance uses the ink. Text extraction
  cannot tell whether a stamp landed on blank template; crop the render.
- **A label is not a value.** A renamed option keeps its stored value; never let a label leak into a
  comparison or a payload.

## Time on the wire

DB holds UTC; `dateStrings: true` gives a zone-less literal JS parses as **local**, fixed at the
response boundary (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays bare;
`WALL_CLOCK_DATETIME_COLUMNS` is `+08:00`, not `Z`. Never derive "now" from `toISOString()` — use
`getCurrentPHDate()`/`getCurrentPHDateTime()`. Converting one side only = **8-hour skew**.

## Build and deploy

- Lazy routes via `@/app/utils/lazyComponent`. **Never add `pdfjs-dist` to `manualChunks`**. Entry
  chunk budget ≈ 142 kB gzip.
- `vite build` does **not** run `tsc`; 9 known type errors in 4 components don't block it. It cannot
  empty `dist/assets` in this sandbox — build to a fresh dir with `--emptyOutDir`.
- Uploads are **base64 in MySQL `LONGTEXT`** — DB size is the free-tier constraint. Docker context is
  the **repository root**: the backend reads PDF templates and the logo from the frontend tree at
  runtime, so a new such file needs a `COPY` line and the build won't tell you.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs`: never `immutable`, always `?v=${pdfjs.version}`.** Unhashed paths revalidate;
  hashed may be `immutable`.
- `VITE_API_URL` is baked at build time and **must** be set on Vercel. Railway redeploys on every
  push to `master`; **Vercel can silently skip a push** — check the commit's statuses.
- **`schema.sql` is never executed** — only boot migrations in `server.js` and lazy `CREATE TABLE`s
  shape a deployed DB. `/store` swallows per-table errors into `[]`; a literal route after a
  `/:param` sibling 404s.

## Notifications and access

SSE via `services/alertStream.js` + `GET /api/alerts/stream` (`fetch` + `ReadableStream`, **not**
`EventSource`). **`targetRole` is one column — address one row per user** (`usersWithAnyRole` +
`notifyUsers`). Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`,
`socialworker`, `houseparent`; access = `accessibleModules` + `subModules` + `permissions` via
`buildAccessSnapshot()`.

- **An *empty* `accessibleModules` means "fall back to the role's full matrix".** Read the **role
  definition**, never the stored grant; a dropped alias in `accessDefaults.canonicalizeModules` is a
  **silent revocation**.
- **`/alerts`, `/violations`, `/phaseProgress` have no module guard**, and `DELETE /api/alerts/:id`
  lets any recipient delete a role-addressed alert for everyone.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), forward-only. Seed
  creds: `centerhead`/`centerhead123`, `socialworker`/`social123`, `psychologist`/`psych123`,
  `nurse`/`nurse123`, `educator`/`educator123`, `HP n`/`hp n 123`.

## Tooling

- `backboard.railway.com/graphql/v2`: workspace token → `Authorization: Bearer`, project token →
  `Project-Access-Token`. Never probe a workspace token with `me`/`projectToken`. Inline GraphQL in
  `node -e` gets shell-mangled — use a file.
- Playwright lives in the managed node workspace (`channel: 'msedge'`). Never re-login in a loop —
  login rate-limits (429, per-IP per username); cache the token.
- **`401` is not evidence a route exists** — a global `authenticate` runs before routing. Prove it
  with an authenticated call.
- Verifying a deployed bundle: grep the chunk for **property** names — the minifier renames locals.
- **6 tests fail here, identically at HEAD** (5 `jwt-secret.test.js`, 1 dialog-guard): `spawnSync …
  EBUSY`. Back up outside the repo.
- **Verifying a push:** the sandbox discards writes to `refs/remotes/` — ask the server,
  `git ls-remote origin master`.
- Behavioural controller tests without a DB: stub `src/config/database` in `require.cache`, then
  dispatch on the SQL text.
- **Windows traps:** Python text-mode writes convert LF → CRLF (use `newline=''`); python's `/tmp` is
  `C:\tmp` but `$(cygpath -w /tmp)` is `%TEMP%` — pass the literal `C:/tmp/x.py`; restore a mutated
  file with `Path.write_bytes`, not `shutil.copyfile`.
