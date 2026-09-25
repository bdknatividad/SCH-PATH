# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, branch `master` (only branch). Live pair:
`sch-path-production.up.railway.app` (API) + `sch-path.vercel.app` (SPA). No MySQL locally — verify
against the live pair. Rationale for every rule below is in the daily logs; this file is rules only.

## Easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text, so renaming a state variable in a
  pinned component breaks a *backend* test. `\s*` where a call may wrap; flatten when the pin depends on
  indentation; `[^)]*` breaks on nested parens — use `[^;]*`.
- **Mutation discipline.** Neuter, confirm the test *fails*, restore unconditionally from bytes captured
  at apply time (never `git checkout --`). Print `matched N occurrence(s)`, exit non-zero on zero. Run
  the suite from bash — a node process cannot spawn the managed node binary.
- **`errorHandler` masks every MySQL error** (`ER_*` → "Database error occurred"). A bare out-of-scope
  identifier is a live 500 (hence the `rbac.` prefix in `accessDefaults.js`). A plain `Error` from a
  service is a **500, not a 400** — validate in the **controller** with `ApiError(400, …)`; grep
  `throw new Error(` under `services/`. Bind `toMysqlDateTime()`, not `toISOString()`.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status then shape; a
  path that misses the API gets the SPA rewrite's `index.html` at 200. `.blob()` only inside
  `fetchBinary` (pinned). `/forms/*.pdf` are same-origin `arrayBuffer()`, not `apiUrl`.
- **A NOT NULL column is a silent feature blocker.** `CREATE TABLE IF NOT EXISTS` does nothing to a
  deployed table — add a guarded boot migration (read `IS_NULLABLE`, then `ALTER … MODIFY COLUMN`,
  try/catch + `console.warn`). Normalize nulls at every boundary that puts a row into state; a nullable
  text column needs `blankToNull`.
- **`ensureColumn` vs `Object.entries`.** `schema-contract.test.js`'s `parseEnsureColumns` sees
  `ensureColumn('t','c',…)` and `for (…of [...])`, but NOT an object literal iterated with
  `Object.entries`. A column the app writes that no parsed migration creates is missing on every
  deployed DB.
- **`manilaToday` lives in `utils/triPeriod.js`** — calling it without the require fails
  `manila-today-in-queries.test.js`.
- **A resident-scoped filter must know how the resource is keyed.** `rowResidentIds()` reads
  `residentId`; a `children` row is keyed by `id`, so the Houseparent filter in `/store` matched nothing
  and dropped **every** resident while `GET /children` returned the real caseload. Fixed in `ab3fc51`,
  pinned by `tests/store-houseparent-caseload.test.js`. Hidden because `DataContext` overwrites the
  Houseparent list from `/resident-assignments/my-residents`.
- **Keying a link on a display name (recurring class).** Add an id column beside the name, read the id
  first, gate the name comparison on `<idColumn> IS NULL`, backfill only where the name resolves to
  exactly one account, 400 on an unknown id, and declare the column in `ensureTable`, the boot migration
  and `schema.sql`.
- **No API path back from `Absconded`** without fabricating an admission cycle: `PUT /children/:id` is
  refused by `assertResidentNotAbsconded`, and only `readmit` and the admissions create path write
  `children.status = 'Active'` — both insert an `admissions` row.
- **One implementation, not two.** `ChildRecords.tsx` and `ChildDetail.tsx` each carry a copy of the
  Admission Slip drawing code; the slip opened from `/children` comes from **ChildDetail**. Shared helper
  `utils/admissionSlipMarkings.ts`.
- **`rbac.definition.json` is duplicated byte-for-byte** (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy over the other.
- **No backticks** in print-HTML template literals (`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`) —
  ends the string → `TS1005`.
- **PDF geometry has three y conventions** (`pdfPercentTop` centres on a bottom-left centre, `pdfTop`
  takes a lower edge, `HOUSEPARENT_SIGNATURE_BOX.top` a top-left upper edge); a rule's ink sits below its
  baseline. Crop the render — text extraction cannot tell whether a stamp landed on blank template. And
  **a label is not a value**: a renamed option keeps its stored value.

## Time on the wire

DB holds UTC; `dateStrings: true` gives a zone-less literal JS parses as local, fixed at the response
boundary (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays bare;
`WALL_CLOCK_DATETIME_COLUMNS` is `+08:00`, not `Z`. Never derive "now" from `toISOString()` — use
`getCurrentPHDate()`/`getCurrentPHDateTime()`. Converting one side only = **8-hour skew**.

## Build and deploy

- Lazy routes via `@/app/utils/lazyComponent`. **Never add `pdfjs-dist` to `manualChunks`**. Entry chunk
  budget ≈ 142 kB gzip (currently 111 kB / 32.9 kB gzip).
- `vite build` does not run `tsc`; 9 known type errors in 4 components don't block it. It cannot empty
  `dist/assets` here — build to a fresh dir with `--emptyOutDir`.
- Uploads are **base64 in MySQL `LONGTEXT`**. Docker context is the **repository root** (Railway
  `dockerfilePath = backend/Dockerfile`): the backend reads PDF templates and the logo from the frontend
  tree at runtime.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs`: never `immutable`, always `?v=${pdfjs.version}`.** Unhashed paths revalidate;
  hashed may be `immutable`.
- `VITE_API_URL` is baked at build time, so **a local chunk hash never matches Vercel's** — compare two
  *deployments*, or grep the served bundle for string literals.
- **`schema.sql` is never executed** — only boot migrations in `server.js` and lazy `CREATE TABLE`s shape
  a deployed DB. `/store` swallows per-table errors into `[]`; a literal route after a `/:param` sibling
  404s. **There is no CI** — `master` auto-deploys on both hosts.

## Notifications and access

**`targetRole` is one column — address one row per user** (`usersWithAnyRole` + `notifyUsers`). SSE lives
in `services/alertStream.js` (`GET /api/alerts/stream`, read with `fetch` + `ReadableStream`, **not**
`EventSource`). Access = `accessibleModules` + `subModules` + `permissions` via `buildAccessSnapshot()`.

- **An empty `accessibleModules` means "fall back to the role's full matrix".** Read the role definition,
  never the stored grant; a dropped alias in `accessDefaults.canonicalizeModules` is a **silent
  revocation**.
- **A notification is invisible to its own actor** — `visibilityClause` ends with `actorUsername <> ?`.
  Never diagnose a "missing" notification from the actor's own account.
- `/alerts`, `/violations`, `/phaseProgress` have no module guard; `DELETE /api/alerts/:id` lets any
  recipient delete a role-addressed alert for everyone.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), forward-only. Seed creds:
  `centerhead`/`centerhead123`, `socialworker`/`social123`, `psychologist`/`psych123`,
  `nurse`/`nurse123`, `educator`/`educator123`, `HP n`/`hp n 123`. **There is no `admin` account**; the
  live `socialworker` password is **not** `social123` — do not reset a real account to get a token.
- `/store` answers `{success, data}`. `/api/children` is ungated at the mount and scopes Houseparents
  inside the controller; `/store` has no `children` key in `STORE_MODULE_BY_RESOURCE`. `/api/tri` (list)
  is gated by the **Houseparent** module while `/api/tri/monitor` and `/summary` are role-gated. A 404 on
  `GET /api/admissions`, `/resident-assignments`, `/discharge-plans` or `/incident-reports` is correct —
  those routers have no `GET /`.

## Tooling

- **6 tests fail here, identically at HEAD** (5 `jwt-secret` — the child's captured output is empty, the
  sandbox blocks `spawnSync`; 1 dialog-guard). Back up outside the repo.
- **`core.autocrlf=true`** rewrites the working tree to CRLF on checkout/merge; several tests match `\n`
  literally and then fail for a reason unrelated to the code. Run `C:\tmp\lf-fix.py` after any git
  command that rewrites files — it also makes `git status` list ~22 files whose content equals HEAD;
  `git add -A` clears the false positives.
- **Verifying a push:** the sandbox discards writes to `refs/remotes/` — ask the server,
  `git ls-remote origin master`. `git merge-tree --write-tree --name-only <a> <b>` = dry-run merge.
- **`401` is not evidence a route exists** — a global `authenticate` runs before routing. **Never pass
  `null`/`undefined` for headers in a probe**: a `headers || AUTH` fallback turns an "expect 401" into an
  authenticated write — that is how a probe absconded a live resident. And check what success looks like
  first: `POST /api/documents {title:'x'}` returns **201**, so only `{}` is refused.
- Behavioural controller tests without a DB: stub `src/config/database` in `require.cache`, then dispatch
  on the SQL text. The schema can be audited live without DB access because `mapRow` only emits
  `col in row`.
- Vercel API: `Authorization: Bearer <team token>`; a **team token 404s on `/v2/user`** — normal. Use
  `GET /v9/projects`, `GET /v6/deployments?projectId=…` (returns `uid`, not `id`).
  `backboard.railway.com/graphql/v2`: workspace token → `Authorization: Bearer`, project token →
  `Project-Access-Token`.
- Playwright lives in the managed node workspace (`channel: 'msedge'`); login rate-limits (429) — cache
  the token. **Windows traps:** Python text-mode writes convert LF → CRLF (use `newline=''`); python's
  `/tmp` is `C:\tmp` but `$(cygpath -w /tmp)` is `%TEMP%`; restore a mutated file with `Path.write_bytes`.
  Heredocs piped to `node -e` get shell-mangled — write the script with the file tool.

## Skills

Deep workflows live in the user-level skills, not here: `sch-path-module` (wiring a new module),
`sch-path-rbac-role` (a role's permissions), `sch-path-deploy-verify` (proving what the live pair
serves), `safe-codebase-audit`.
