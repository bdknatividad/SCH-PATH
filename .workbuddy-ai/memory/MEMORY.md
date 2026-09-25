# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, branch `master` (only branch). Live pair: `sch-path-production.up.railway.app`
(API) + `sch-path.vercel.app` (SPA). No MySQL locally — verify against the live pair. History lives in
the daily logs; this file is rules only.

## Easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text, so renaming a state variable in a
  pinned component breaks a *backend* test. `\s*` where a call may wrap; flatten when the pin depends
  on indentation; `[^)]*` breaks on nested parens — use `[^;]*`. Re-run the suite after editing a
  pinned component.
- **Mutation discipline.** Neuter, confirm the test *fails*, restore unconditionally from bytes
  captured at apply time (never `git checkout --`). Print `matched N occurrence(s)`, exit non-zero on
  zero. Run the suite from bash — a node process cannot spawn the managed node binary.
- **`errorHandler` masks every MySQL error** (`ER_*` → "Database error occurred"). A bare out-of-scope
  identifier is a live 500 (hence the `rbac.` prefix in `accessDefaults.js`). A plain `Error` from a
  service is a **500, not a 400** — validate in the **controller** with `ApiError(400, …)`; grep
  `throw new Error(` under `services/`. Bind `toMysqlDateTime()`, not `toISOString()`.
  `ER_DATA_TOO_LONG` is masked: the bound is the declared width of the source column.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status then shape; a
  path that misses the API gets the SPA rewrite's `index.html` at 200. `.blob()` only inside
  `fetchBinary` (pinned). `/forms/*.pdf` are same-origin `arrayBuffer()`, not `apiUrl`.
- **A NOT NULL column is a silent feature blocker.** `CREATE TABLE IF NOT EXISTS` does nothing to a
  deployed table — add a guarded boot migration (read `IS_NULLABLE`, then `ALTER … MODIFY COLUMN`,
  try/catch + `console.warn`). Normalize nulls at every boundary that puts a row into state, save
  responses included; a nullable text column needs `blankToNull`.
- **`ensureColumn` vs `Object.entries`.** `schema-contract.test.js`'s `parseEnsureColumns` sees
  `ensureColumn('t','c',…)` and `for (…of [...])`, but NOT an object literal iterated with
  `Object.entries`. A column the app writes that no parsed migration creates is missing on every
  deployed DB.
- **`manilaToday` lives in `utils/triPeriod.js`** — a controller calling it without the require fails
  `manila-today-in-queries.test.js`.
- **Display-name keys (recurring class).** Add an id column beside the name, read the id first, gate the
  name comparison on `<idColumn> IS NULL`, backfill only where the name resolves to exactly one
  account, 400 on an unknown id, and declare the column in `ensureTable`, the boot migration and
  `schema.sql`.
- **One implementation, not two.** `ChildRecords.tsx` and `ChildDetail.tsx` each carry a copy of the
  Admission Slip drawing code; the slip opened from `/children` comes from **ChildDetail**. Shared
  helper `utils/admissionSlipMarkings.ts`.
- **`rbac.definition.json` is duplicated byte-for-byte** (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy over the other.
- **No backticks** in print-HTML template literals (`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`) —
  ends the string → `TS1005`.
- **PDF geometry has three y conventions** (`pdfPercentTop` centres on a bottom-left centre, `pdfTop`
  takes a lower edge, `HOUSEPARENT_SIGNATURE_BOX.top` a top-left upper edge) and a rule's ink sits
  below its baseline — crop the render; text extraction cannot tell whether a stamp landed on blank
  template. And **a label is not a value**: a renamed option keeps its stored value.

## Time on the wire

DB holds UTC; `dateStrings: true` gives a zone-less literal JS parses as local, fixed at the response
boundary (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays bare;
`WALL_CLOCK_DATETIME_COLUMNS` is `+08:00`, not `Z`. Never derive "now" from `toISOString()` — use
`getCurrentPHDate()`/`getCurrentPHDateTime()`. Converting one side only = **8-hour skew**.

## Build and deploy

- Lazy routes via `@/app/utils/lazyComponent`. **Never add `pdfjs-dist` to `manualChunks`**. Entry
  chunk budget ≈ 142 kB gzip.
- `vite build` does not run `tsc`; 9 known type errors in 4 components don't block it. It cannot empty
  `dist/assets` here — build to a fresh dir with `--emptyOutDir`.
- Uploads are **base64 in MySQL `LONGTEXT`**. Docker context is the **repository root**: the backend
  reads PDF templates and the logo from the frontend tree at runtime.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs`: never `immutable`, always `?v=${pdfjs.version}`.** Unhashed paths revalidate;
  hashed may be `immutable`.
- `VITE_API_URL` is baked at build time, so **a local chunk hash never matches Vercel's** — compare
  asset names between two *deployments*, never against a local build. It **must** be set on Vercel.
  Railway redeploys on every push to `master`.
- **`schema.sql` is never executed** — only boot migrations in `server.js` and lazy `CREATE TABLE`s
  shape a deployed DB. `/store` swallows per-table errors into `[]`; a literal route after a `/:param`
  sibling 404s. **There is no CI** — `master` auto-deploys on both hosts.

## Notifications and access

**`targetRole` is one column — address one row per user** (`usersWithAnyRole` + `notifyUsers`). SSE
lives in `services/alertStream.js` (`GET /api/alerts/stream`, read with `fetch` +
`ReadableStream`, **not** `EventSource`). Roles: `centerhead` (fullAccess), `admin`, `nurse`,
`psychologist`, `educator`, `socialworker`, `houseparent`; access = `accessibleModules` + `subModules`
+ `permissions` via `buildAccessSnapshot()`.

- **An empty `accessibleModules` means "fall back to the role's full matrix".** Read the role
  definition, never the stored grant; a dropped alias in `accessDefaults.canonicalizeModules` is a
  **silent revocation**.
- `/alerts`, `/violations`, `/phaseProgress` have no module guard; `DELETE /api/alerts/:id` lets any
  recipient delete a role-addressed alert for everyone.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), forward-only. Seed
  creds: `centerhead`/`centerhead123`, `socialworker`/`social123`, `psychologist`/`psych123`,
  `nurse`/`nurse123`, `educator`/`educator123`, `HP n`/`hp n 123`.

## Tooling

- **6 tests fail here, identically at HEAD** (5 `jwt-secret.test.js`, 1 dialog-guard): `spawnSync …
  EBUSY`. Back up outside the repo.
- **`core.autocrlf=true`** rewrites the working tree to CRLF on checkout/merge; 7 tests match `\n`
  literally and then fail for a reason unrelated to the code. Run `C:\tmp\lf-fix.py` after any git
  command that rewrites files.
- **Verifying a push:** the sandbox discards writes to `refs/remotes/` — ask the server,
  `git ls-remote origin master`.
- **`401` is not evidence a route exists** — a global `authenticate` runs before routing.
  `git merge-tree --write-tree --name-only <a> <b>` = dry-run merge with conflict paths, no
  working-tree touch.
- Behavioural controller tests without a DB: stub `src/config/database` in `require.cache`, then
  dispatch on the SQL text. Verifying a deployed bundle: grep the chunk for **property** names.
- Vercel API: `Authorization: Bearer <team token>`; a **team token 404s on `/v2/user`** — normal, not
  a bad token. Use `GET /v9/projects`, `GET /v6/deployments?projectId=…`, `GET /v6/deployments/{id}/files`.
- `backboard.railway.com/graphql/v2`: workspace token → `Authorization: Bearer`, project token →
  `Project-Access-Token`.
- Playwright lives in the managed node workspace (`channel: 'msedge'`); login rate-limits (429) — cache
  the token. **Windows traps:** Python text-mode writes convert LF → CRLF (use `newline=''`); python's
  `/tmp` is `C:\tmp` but `$(cygpath -w /tmp)` is `%TEMP%` — pass the literal `C:/tmp/x.py`; restore a
  mutated file with `Path.write_bytes`. Heredocs piped to `node -e` get shell-mangled — write the
  script with the file tool.
