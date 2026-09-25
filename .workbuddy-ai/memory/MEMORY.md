# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, branch `master`. Live pair: `sch-path-production.up.railway.app` (API) +
`sch-path.vercel.app`. **History lives in the daily logs; this file is rules only.** No reachable MySQL
here — verify on the live pair: the **served artifact** (a lazy route's fix lands in a *route chunk*,
not the entry chunk), the **real UI** (Playwright, real login, assert rendered output not HTTP 200s),
the **API** with a token.

## Conventions that are easy to break

- **Frontend pins.** `backend/tests/*.test.js` reads `.tsx` as text, so renaming a state variable in a
  pinned component breaks a *backend* test. `\s*` where a call
  may wrap; flatten (`replace(/\s+/g,' ')`) when a pin would depend on indentation; `[^)]*` breaks on
  nested parens like `includes('x')` — use `[^;]*`. Re-run `cd backend && node --test
  "tests/**/*.test.js"` after editing any pinned component.
- **Mutation discipline.** Neuter, confirm the test *fails*, then restore from bytes captured at apply
  time — not `git checkout --`, and unconditionally. Print `matched N occurrence(s)`; exit non-zero on
  zero. A mutation that does not change behaviour proves nothing. Mutate **every** file the contract
  spans. **Never run the suite from the harness** — a node process cannot spawn the managed node binary
  (`execFileSync` throws with `status: null`).
- **`errorHandler` masks every MySQL error** — all `ER_*` → "Database error occurred", `err.message`
  dropped in production; the Railway runtime log is the only source of truth. A **bare identifier not in
  scope is a live 500, not a load error** (`violationGuideController` called `normalizeRole`
  unimported; `accessDefaults.js` is the same shape).
- **A plain `Error` from a service is a 500, not a 400.** Only `ApiError`, `ER_*`, `ValidationError` and
  the JWT errors map to a status; the rest fall to `err.statusCode || 500`. Validate in the
  **controller** with `ApiError(400, …)`; grep `throw new Error(` under `services/`.
- **`res.ok` is not proof a file endpoint returned a file.** `fetchBinary` checks status **then shape**;
  an HTML body throws, because a path that never reaches the API gets the SPA rewrite's `index.html` at
  200. `.blob()` only inside `fetchBinary` (pinned); `/forms/*.pdf` are same-origin, read via
  `arrayBuffer()`, not `apiUrl`.
- **Display-name keys (recurring class).** Add an id column beside the name, read the id first, gate the
  name comparison on `<idColumn> IS NULL` (migration aid only), backfill only where the name resolves to
  exactly one account, 400 on an unknown id, and declare the column in `ensureTable`, the boot migration
  **and** `schema.sql`.
- **`ER_DATA_TOO_LONG`** hides behind that masking: compare against what the code *writes*, never a
  sample row, and derive the bound from the **declared width of the source column**.
  `ensureColumnLength()` widens idempotently at boot and logs only **after** the ALTER succeeds. Widths
  live in `schema.sql` **and** the `server.js` CREATE TABLEs, which must agree.
- **Idempotence — compare what you *write*.** `seedOfficialViolationGuide()` compared stored rows against
  the **raw** source text, but `parseGuideRequirement()` blanks `officialText` for a `Psychosocial
  Activity` requirement — so 52 of 99 sets were deleted and re-created on **every boot**, silent until an
  `ON DELETE RESTRICT` FK aborted the sync. Run the check through the **writer's own transform**, and
  order the rows it reads deterministically.
- **No backticks** in print-HTML template literals (`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`) — a
  backtick in a CSS comment terminates the string → `TS1005`.

## Time on the wire

DB holds **UTC**; `dateStrings: true` delivers a zone-less literal that JS parses as **local**. Fixed at
the **response boundary** (`utils/serverTime.js` + `middleware/isoTimestamps.js`, wrapping `res.json`
before `/api`). `DATE` columns stay **bare**; `WALL_CLOCK_DATETIME_COLUMNS` is filled from a
`datetime-local` and labelled `+08:00`, not `Z`, and the list is asserted whole. **Never derive "now"
from `toISOString()`** — use `getCurrentPHDate()` / `getCurrentPHDateTime()` (`utils/dateFormatter.ts`).

## Build and deploy invariants

- Lazy routes go through `@/app/utils/lazyComponent` in `App.tsx`. **Never add `pdfjs-dist` to
  `manualChunks`** — it emits its own async worker and CMaps chunks resolved at runtime by URL; pinning
  it breaks the worker. Entry-chunk budget near **142 kB gzip**.
- `vite build` does **not** run `tsc`; 9 known type errors in 4 components do not block the build. It
  cannot finish in this sandbox either (the safe-delete shim refuses to empty `dist/assets`) — use `vite
  build --outDir /c/tmp/dist-verify --emptyOutDir`.
- Uploads are **base64 inside MySQL `LONGTEXT`** — no filesystem or S3 layer, so DB size is the
  free-tier constraint.
- Docker context is the **repository root**, not `backend/`: the backend reads PDF templates
  and the logo from the **frontend tree** at runtime. `COPY backend/src` is a **directory** copy, but the
  frontend tree is copied file-by-file — **every frontend file the backend resolves at request time
  needs a `COPY` line, and the build will not tell you**.
- **A publisher with a non-fatal catch needs a retry path** — TRI `finalize` swallows a render failure so
  an approval is never rolled back, so `publishMissingTriDocuments()` (at boot) finishes the job; the
  Anecdotal Report publishes *before* flipping status instead. A publish fault must be **reported**, not
  a silent `documentId: null`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths; a new file in
  `frontend/public/` **must** be added or it is served as `index.html`.
- **`/pdf.worker.mjs` must not be `immutable`, and its URL must carry a version query.**
  `GlobalWorkerOptions.workerSrc` must be
  `` `/pdf.worker.mjs?v=${pdfjs.version}` ``. **Unhashed paths must revalidate; hashed ones may be
  `immutable`.**
- `VITE_API_URL` is baked at build time and **must** be set on Vercel. So **a local build's entry-chunk
  hash can never equal the deployed one** — compare the chunk's *content*.
- **Railway redeploys on every push to `master`** — a docs-only commit restarts production. Batch
  memory/comment commits.
- **`schema.sql` is never executed.** Only the boot migrations in `server.js` (and a controller's own
  lazy `CREATE TABLE`) shape a deployed database. `seedDatabase()`'s one shared try/catch made the first
  failure skip every later step (fixed `5b68857`); `/store` swallows per-table errors into `[]`; a
  literal route after a `/:param` sibling 404s for its whole life.

## Notifications and access model

SSE via `services/alertStream.js` + `GET /api/alerts/stream`. Use `fetch` + `ReadableStream`, **not
`EventSource`**. **`targetRole` is one column, so a role-addressed row reaches exactly one role** —
address **one row per user** (`usersWithAnyRole` + `notifyUsers`).

Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`, `socialworker`,
`houseparent`. Effective access = `accessibleModules` + `subModules` + `permissions`, via
`buildAccessSnapshot()`.

- **An *empty* `accessibleModules` means "fall back to the role's full matrix".** Read the **role
  definition** (`getRoleDefinition(role)`), never the stored grant. The **write** path is
  `accessDefaults.canonicalizeModules` (`userController` 209/366/544/666, `server.js:1324`) — a dropped
  alias is a **silent revocation**. The boot migration refills `accessibleModules` only for
  `nurse`/`educator`/`houseparent`, so a `[]` on `centerhead`/`socialworker`/`psychologist` is the
  original seed, *not* a repair.
- **`/alerts` has no module guard**, and `DELETE /api/alerts/:id` checks only `findVisible` — any
  recipient can delete a role-addressed alert for everyone, contradicting the per-user read state the
  module is built around. `/violations` and `/phaseProgress` are likewise mounted unguarded.
- **Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), and the seed writes
  `assignmentType = 'houseparent'`. Never widen a reader to accept the old `'household'` typo (fixed
  `effd62d`): the seed creates the full houseparent × child cross product. `/violations` and
  `/phaseProgress` are deliberately **facility-wide** for Houseparents. **Forward-only.**

## Inspecting Railway / tooling

`backboard.railway.com/graphql/v2`. A **workspace** token uses `Authorization: Bearer <t>`; a project
token uses `Project-Access-Token`. **Never probe a workspace token with `me` or `projectToken`** — one
unauthorised field invalidates the whole selection set. Project/service/env ids and log helpers:
`C:/tmp/railway-deploy.js`, `wait-migration.js` (list deployments, dump the runtime log, grep the boot
log for a migration line). **`deploymentLogs` carries request-time errors** with stack and path.

- Playwright is in the managed node workspace (`channel: 'msedge'`). **Never re-login in
  a loop** — the login route rate-limits (429); a poll that fetches a token per attempt then sends
  `Bearer undefined` → a burst of `401 Invalid token`. Cache the token to a file, across scripts.
- **6 tests fail in this sandbox, identically at HEAD** (5 in `jwt-secret.test.js`, 1 dialog-guard):
  `spawnSync … node.exe EBUSY`. Keep whole-suite backups **outside** the repo.
- **Verifying a push — the remote-tracking ref lies.** The sandbox **discards writes to
  `refs/remotes/`**; ask the server — `git ls-remote origin master`.
- **Behavioural controller tests without a database:** stub `src/config/database` in `require.cache`
  before requiring the controller, then dispatch on the SQL text; split column/value lists on
  **top-level commas**. See `tests/intervention-schedule.test.js`.