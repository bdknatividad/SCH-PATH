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
- **A new column needs a guarded boot migration**, declared in a shape `schema-contract.test.js` can
  parse (it does not see an `Object.entries` literal). `mapRow` emits only `col in row`, so a
  `constants.js` column is load-bearing for the read path — and a key absent from every row proves the
  column is missing from the deployed DB.
- **A wide JSON/TEXT column turns `ORDER BY` into a 400.** MySQL filesorts a row together with the
  columns it carries, inside `sort_buffer_size` (256 KB default) — a 277 KB `files` blob on
  `education_records` gave `ER_OUT_OF_SORTMEMORY`, masked by `errorHandler` and swallowed by the UI as
  "no records". An index is **not** sufficient (with few rows the optimizer keeps the filesort): set
  `sortInApplication: true` on the resource in `constants.js` and let `baseController.getAll` sort in JS
  (NULLs last, numeric-aware). An unknown column is rejected at prepare time, so the sort error is
  invisible until the column exists — expect two sequential fixes, not one.
- **A resident-scoped filter must know how the resource is keyed** — `rowResidentIds()` reads
  `residentId`, but a `children` row is keyed by `id`, so the Houseparent filter in `/store` dropped
  every resident. Fixed in `ab3fc51`, pinned by `tests/store-houseparent-caseload.test.js`.
- **`rbac.definition.json` is duplicated byte-for-byte** (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy over the other.
- The module-authoring traps — the NOT NULL column rule, `manilaToday`, the display-name keying class,
  the duplicated Admission Slip code, the print-HTML backtick rule, the three PDF y conventions, and the
  one-way door out of `Absconded` — are in the **`sch-path-module`** skill.

## Time on the wire

DB holds UTC; `dateStrings: true` gives a zone-less literal JS parses as local, fixed at the response
boundary (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays bare;
`WALL_CLOCK_DATETIME_COLUMNS` is `+08:00`, not `Z`. Never derive "now" from `toISOString()` — use
`getCurrentPHDate()`/`getCurrentPHDateTime()`. Converting one side only = **8-hour skew**.

## Build and deploy

- Lazy routes via `@/app/utils/lazyComponent`. **Never add `pdfjs-dist` to `manualChunks`**. Entry chunk
  budget ≈ 142 kB gzip (currently 112.15 kB / 33.28 kB gzip).
- `vite build` does not run `tsc`; 9 known type errors in 4 components don't block it. It cannot empty
  `dist/assets` here — build to a fresh dir with `--emptyOutDir`. **The build is the only gate that sees
  a `.tsx` parse error**: `node --check` only takes `.js`/`.mjs`, and the suite reads `.tsx` as *text*,
  so a duplicate declaration (e.g. `const isAbsconded` twice in `ChildDetail.tsx` after a merge splice)
  is invisible to both and shows up only as `[vite:esbuild] Transform failed`. Run the build before
  claiming a merge is clean. Note `.gitignore` has `dist/` and `dist-verify*/` but **not** `dist-<anything
  else>/` — a build dir with another name shows up as untracked.
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
- A new **index** needs `ensureIndex(table, name, column)` inside `runMigrations()`, alongside
  `ensureColumn` — `CREATE TABLE IF NOT EXISTS` never revisits an existing table. A helper called
  *outside* `runMigrations()` is a boot-time ReferenceError that `node --check` cannot see.
- **When a fix makes an endpoint fail *differently*, that is progress, not a regression.** Read the new
  error instead of re-opening the old one: `/api/education-records` went `ER_BAD_FIELD_ERROR` →
  `ER_OUT_OF_SORTMEMORY` → 200 across three commits, and the second failure was only reachable after the
  first was fixed.

## Notifications and access

**`targetRole` is one column — address one row per user** (`usersWithAnyRole` + `notifyUsers`). SSE lives
in `services/alertStream.js` (`GET /api/alerts/stream`, read with `fetch` + `ReadableStream`, **not**
`EventSource`). Access = `accessibleModules` + `subModules` + `permissions` via `buildAccessSnapshot()`.

- **An empty `accessibleModules` means "fall back to the role's full matrix".** Read the role definition,
  never the stored grant; a dropped alias in `accessDefaults.canonicalizeModules` is a **silent
  revocation**.
- **A session with `fullAccess` but no `modules` is not a resolved snapshot.** `isSnapshot()` must require
  `Array.isArray(subject.modules)`; `AuthContext` stores `fullAccess` on the *user* beside a null `access`,
  so a loose guard mistook the user object for a snapshot and `snapshot.modules.some(...)` crashed
  `/violations` for every session restored from localStorage (i.e. every non-full-access role). Build test
  fixtures from the server's own `buildAccessSnapshot()` + `listAccessibleMenus()` — a hand-rolled fixture
  with `access: null, fullAccess: false` nearly got this dismissed as an artifact.
- **A notification is invisible to its own actor** — `visibilityClause` ends with `actorUsername <> ?`.
  Never diagnose a "missing" notification from the actor's own account.
- `/alerts`, `/violations`, `/phaseProgress` have no module guard; `DELETE /api/alerts/:id` lets any
  recipient delete a role-addressed alert for everyone.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), forward-only. Seed creds
  are in `backend/src/scripts/seedDatabase.js` (`centerhead`/`centerhead123` works live). **There is no
  `admin` account**, and the live `socialworker` password is **not** the seed — do not reset a real
  account to get a token.
- `/store` answers `{success, data}` — mounted **under `/api`**, so the path is `/api/store`; a bare
  `/store` is a 404 (same for `/api/dashboard/schedule-summary`). `/api/children` is ungated at the
  mount and scopes Houseparents
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
  `subprocess.run(['npx', …])` is **not** resolvable on Windows (`FileNotFoundError`) — pass a command
  string with `shell=True`, and restore mutated files in a `finally` that verifies by sha256.

## Skills

Deep workflows live there, not here: `sch-path-module`, `sch-path-rbac-role`,
`sch-path-deploy-verify`, `safe-codebase-audit`.
