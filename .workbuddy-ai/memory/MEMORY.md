# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 (frontend), Express 4 + mysql2
+ JWT (backend). MySQL-only. Repo `bdknatividad/SCH-PATH`, branch `master`.

## Conventions that are easy to break

### The suite pins frontend behaviour by regex against `.tsx` source
`backend/tests/*.test.js` has no frontend runner, so it reads frontend source as
text. Consequences:
- Renaming a state variable or parameter in a pinned component breaks a
  **backend** test. The pin is often a literal identifier.
- Relaxing such a test is sometimes correct — it was asserting a calling
  convention rather than behaviour — but check that first.
- Match with `\s*` where a call may wrap onto the next line, and flatten
  (`replace(/\s+/g,' ')`) when a pin would otherwise depend on indentation.
  `[^)]*` breaks on nested parens like `includes('x')`; use `[^;]*` or `[^]*?`.
- Run `cd backend && node --test "tests/**/*.test.js"` after editing `App.tsx`,
  `Layout.tsx`, `PhaseProgress.tsx`, `SignaturePad.tsx`, `ChildRecords.tsx`,
  `Tri.tsx`, `Health.tsx`, `QuarterlyProgressReport.tsx`, `api.ts`.

### Verifying a guard: mutate, then restore from your own copy
The suite is source-text scanning, so a guard can pass vacuously. Neuter the
code, confirm the test actually *fails*, then restore **from a backup you made**
— not `git checkout --`, because the fix is normally still uncommitted and HEAD
does not contain it. Have the mutator print `matched N occurrence(s)` and exit
non-zero on zero. **Restore must be an unconditional `copyFileSync`**: validating
the match string in restore mode always fails, because the mutation removed it.

### Verbatim no-backticks rule
Several components build print HTML inside JS **template literals**
(`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`). A backtick inside a CSS comment
there terminates the string and produces a confusing `TS1005`. Write those
comments without backticks.

### `rbac.definition.json` is duplicated byte-for-byte
`backend/src/config/` and `frontend/src/app/config/` are asserted equal. Edit
one, copy it over the other.

### `accessDefaults.js` needs the `rbac.` prefix
`rbac.CHILD_RECORD_TABS_MODULE`, not the bare name — the bare identifier is not
in scope there and throws at require time, breaking unrelated tests with 500s.

### A plain `Error` from a service is a 500, not a 400
`middleware/errorHandler.js` maps only `ApiError`, `ER_*`, `ValidationError` and
the JWT errors to a status; anything else falls through to
`err.statusCode || 500`, and production masks the message to "Internal server
error". So a service validating by throwing a bare `Error` reports the caller's
mistake as a server fault with nothing to act on. Validate in the
**controller** and throw `ApiError(400, …)`; leave the service's throw as a
programmer-error guard. `POST /alerts {}` was 500, now 400. When auditing an
endpoint's error contract, grep `throw new Error(` under `services/`.

### Binary endpoints: `res.ok` is not proof the body is the file
`api.ts` exports `fetchBinary(path, init)` — use it for anything that answers
with bytes (stored documents, generated PDFs, the bulk ZIP). It joins the base
through `apiUrl`, checks the status, **then the shape**: an HTML body throws
"The file request did not reach the API…". Why it exists: a path that never
reaches the API is answered by the frontend host's SPA rewrite with `index.html`
and a **200**, so `res.ok` is true and the "file" is the app's own HTML. Fed to
pdf.js that surfaces as a *render* failure — a message about the viewer, which
is the side that works.

**`.blob()` is now allowed only inside `fetchBinary`** and a test pins that.
`/forms/*.pdf` are same-origin static assets read as `arrayBuffer()` and must
NOT go through `apiUrl` (that would 404 them at the backend).

### Verifying a push — the remote-tracking ref lies
`GIT_TERMINAL_PROMPT=0` is set and `git-credential-manager.exe` reads Windows
Credential Manager non-interactively, so `git push` works without a prompt. But
**the sandbox discards writes to `refs/remotes/`**: after a push the server
accepted, `git log origin/master..HEAD` still lists those commits and
`git fetch` *prints* the update while `git rev-parse origin/master` stays stale.
Ask the server — `git ls-remote origin master` — and to make the local ref agree,
edit the `refs/remotes/origin/master` line in `.git/packed-refs` by hand.

### Behavioural controller tests without a database
Inject a pool stub into `require.cache` for `src/config/database` *before*
requiring the controller, then dispatch on the SQL text in a fake
`query(sql, params)`. Patterns: `tests/violation-verification-access.test.js`,
`tests/access-request-history-identity.test.js`. If validation precedes the
first query, no stub is needed at all — drive the controller with fake
`req`/`res` and assert the real status (`tests/notifications.test.js`).

### Keying a relationship on a display name (the recurring defect class)
Where a link is stored as a printed name: add an id column *beside* the name;
read the id first; gate the old name comparison on `<idColumn> IS NULL` so it is
only a migration aid; backfill only where the name resolves to exactly one
account; refuse an unknown id with a 400; and declare the column in **all**
places the table is created (`ensureTable`, `server.js` boot migration,
`schema.sql`). Applied to `admissions.houseparentUserId` (item 51) and
`accessRequests.reviewedById` (item 50). The failure is always silent — the
wrong list comes back — so it needs tests, not a smoke test.

### Windows traps when scripting
- **Python text-mode writes convert LF → CRLF.** A test locating a block by a
  multi-line marker containing `\n` stops matching: `indexOf` gives `-1` and
  `slice(-1)` yields a one-character block, which fails or passes for the wrong
  reason. Normalize on read and write LF deliberately with `newline=''`.
- **Python resolves `/tmp` as `C:\tmp`.** A helper written to `/tmp/x.py` is not
  readable by `python /tmp/x.py` under Git Bash. Use `"$(cygpath -w /tmp)/x.py"`.

## Frontend build / bundling

- Route-level lazy loading lives in `App.tsx` via `@/app/utils/lazyComponent`
  (it handles the mix of named and default exports). Add new routes that way.
- **Never add `pdfjs-dist` to `manualChunks`.** It emits its own async worker and
  CMaps chunks resolved at runtime by URL; pinning it breaks the worker.
- Entry-chunk budget: keep it near **142 kB gzip** (currently ~110 kB / 32 kB
  gzip). Growth means a heavy import leaked into the shell or `LoginPage`.
- `vite build` does **not** run `tsc`. There are 9 long-standing type errors in
  `AssessmentDetail.tsx` (4), `Assessments.tsx` (1), `ChildDetail.tsx` (3),
  `ChildRecords.tsx` (1); they do not block the build. Do not "fix" them
  casually — check the change does not alter pinned text.
- **`vite build` cannot finish in this sandbox**: the safe-delete shim refuses to
  let vite empty `dist/assets` (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`). It
  transforms all ~1973 modules first, so the code is verified; for a real
  artifact build to a throwaway dir —
  `vite build --outDir /c/tmp/dist-verify --emptyOutDir`.

## Deployment invariants

- All uploaded files are **base64 inside MySQL `LONGTEXT`**. No filesystem or S3
  layer, so DB size is the primary free-tier constraint. MySQL is mandatory
  (`ON DUPLICATE KEY UPDATE`, `INFORMATION_SCHEMA`, `max_allowed_packet`).
- The backend reads PDF templates and the logo from the **frontend tree** at
  runtime (`../../../frontend/public/forms`, `frontend/src/assets/sch-logo.png`).
  The Docker build context must be the **repository root**. Do not "fix" it to
  `backend/`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths. Any
  new file in `frontend/public/` **must** be added to that exclusion or it is
  served as `index.html`. `pdf.worker.mjs` is the one that breaks everything.
- **`/pdf.worker.mjs` must NOT be cached `immutable`, and its URL must carry a
  version query.** Two separate traps, both proven in production on 2026-09-25:
  1. It sits at an **unhashed** URL, so `immutable` is a one-way door. The worker
     was once served `application/octet-stream` (two Content-Type rules in
     `c5d95f1`, and Vercel's **last match wins**) plus `nosniff`, and because it
     was `max-age=31536000, immutable` every browser that loaded the app in that
     2h23m window kept the broken copy **for a year, without revalidating**. The
     header was fixed in `2437e39` and it changed nothing for those browsers —
     hence a **new URL** is the only cure. Now `max-age=0, must-revalidate` (the
     file has an ETag, so the cost is a 304).
  2. Every `GlobalWorkerOptions.workerSrc` must be
     `` `/pdf.worker.mjs?v=${pdfjs.version}` `` — the version comes from `pdfjs`
     itself, so a library bump changes the cache key and the worker cannot drift
     out of step with the API that loads it. A bare path is the poisoned URL.
  Pinned by `backend/tests/pdf-worker-cache-key.test.js`. `vercel.json` is JSON
  and cannot carry this comment, hence this entry. General rule: **hashed paths
  may be `immutable`; unhashed paths must revalidate.**
- PDF form templates live in `frontend/public/forms/` (18 referenced, 20 on
  disk). If a generated PDF is blank in production, check the Docker context
  first.
- `VITE_API_URL` is baked at build time and **must** be set on Vercel. The
  baseline hardcoded `'/api'` in production, which broke every request on the
  split deployment. `api.ts` exports `API_BASE_URL`/`apiUrl` for the callers
  that cannot use `request()`.

## Access model

Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`,
`socialworker`, `houseparent`. Effective access = `accessibleModules` +
`subModules` + `permissions` on the user row, via `buildAccessSnapshot()`.

**Known trap:** `buildAccessSnapshot()` treats an *empty* `accessibleModules` as
"fall back to the role's full matrix". Code deciding redaction must read the
**role definition** (`getRoleDefinition(role)`), never the stored grant, or an
account seeded with `[]` gains everything. `childController.js` has the correct
pattern in `roleCanReachMedicalTab` / `roleCanReachHealth`.

**The write path for `accessibleModules` is `accessDefaults.canonicalizeModules`**
(`userController` 209/366/544/666, `server.js:1324`). It must delegate to
`rbac.normalizeModuleKey` — the single place that knows every legacy spelling —
then order by `MODULE_ORDER`. It used to carry a parallel alias table and
mishandled 4 of the 5 aliases: `Intervention` went to the legacy spelling
`Intervention Tracker` instead of `Violations`, and `Case Progress` /
`Education Progress` were dropped. Because it is the write path, a dropped alias
is a silent revocation, and `MODULE_ORDER` doubling as the allow-list is what let
a legacy name be persisted as a module. `MODULE_ORDER` must name canonical
modules only.

**Read `[]` carefully.** The boot migration only refills `accessibleModules` for
`nurse` / `educator` / `houseparent`, so `centerhead` / `socialworker` /
`psychologist` hold `[]` from the original seed. A `[]` on those three is *not*
evidence a repair ran — check `nurse`/`educator` instead.

**`/alerts` has no module guard.** `router.use('/alerts', authenticate,
alertRoutes)` — no `requireModule` — so every authenticated account reaches the
whole alert surface. That makes `DELETE /api/alerts/:id` cross-user destructive:
`notificationService.remove()` deletes the row plus its `alertReads` and the only
check is `findVisible` ("can I see it"), so any one recipient can delete a
role-addressed alert for everyone sharing it, contradicting the per-user read
state the module is built around. `DataContext.tsx` → `deleteResource('alerts',
id)` reaches it from the UI for every role. Unresolved: fixing it needs an
`alertDismissals` table (per-user, consistent with `alertReads`) or a
manager-only delete, and both change UX. `/violations` and `/phaseProgress` are
likewise mounted without a module guard.

**Caseload scope:** only `houseparent` is scoped (`utils/residentScope.js`), and
the seed writes `assignmentType = 'houseparent'` — the one value every reader
grants scope on. The old `'household'` seed value was a typo, fixed 2026-09-24
(`effd62d`). Never widen a reader to accept `'household'`: the seed creates the
full houseparent × child cross product, so accepting it would hand every
Houseparent every resident. `/violations` and `/phaseProgress` are deliberately
**facility-wide** for Houseparents.

**That seed fix is forward-only.** `seedResidentAssignments` keys its idempotency
on `(userId, residentId)` and ignores `assignmentType`, so on an already-seeded
database every pair is present with the old value and no corrected row is
inserted. The live demo still shows seeded Houseparents an empty caseload until
those rows are rewritten — a deliberate access change awaiting a decision. The
seed also never writes `admissions.houseparentOnDuty`, so the legacy fallback in
`residentScope.js` does not cover seeded Houseparents.

## Traps that make a failure look like a non-failure

**One shared try/catch in `seedDatabase()` made the whole seed skippable.** The
steps ran inside a single try/catch, so the first failure silently skipped every
later one. On production `seedDefaultUsers` threw `Duplicate entry 'UHP01'` —
the seed looks users up *by username* but inserts *by id*, and an operator had
renamed `HP 1` → `HP1`, freeing the username while keeping the id. That one
error meant `reconcileSeededAccessGrants`, `seedResidentAssignments` and the
violation-guide sync **never ran on any boot**. Fixed in `5b68857`:
`runSeedStep` isolates each step, the id is the account's identity (a rename is
reported, not thrown), and the reconciliation runs **first**. If a seed step's
effect is ever missing, check the boot log for `Seeding step failed (...)` before
suspecting the deploy.

**`/store` swallows per-table errors.** Each table is wrapped in try/catch and
assigned `[]` on error, logged only server-side, so a *broken* table and a
genuinely *empty* one are indistinguishable from outside — both render "no
records". Compare `/store` against the individual endpoint for the same table.

**A literal route declared after a `/:param` sibling is unreachable.** Express
matches in declaration order, so `router.get('/:id')` above
`router.get('/daily-data')` meant the literal path could never be called — it
404'd as "report not found" for its whole life while the route file advertised
it. Fixed in `reportRoutes.js`; guarded by `tests/route-shadowing.test.js`. Keep
literal paths above catch-alls.

**Checking the deployment without logging in:** `GET /api/health/db` →
`200 {database:'connected', latencyMs}` or `503 {database:'unreachable'}`. It is
the *readiness* check; `/api/health` stays a dependency-free *liveness* check and
must stay that way — pointing it at the database would let a DB blip
restart-loop the service (`tests/health-readiness.test.js` pins the separation).
`railway.toml`'s `healthcheckPath` is still `/api/health`; moving it is a
deliberate restart-on-DB-loss choice that has not been made.

## Inspecting the Railway deployment (read the log, don't guess)

Endpoint `https://backboard.railway.com/graphql/v2`. A **workspace** token uses
`Authorization: Bearer <t>`; a project token uses `Project-Access-Token`. `me` is
unavailable to a workspace token by design, so start from `projects(first: 20)`.

Project `fabulous-radiance` `840f2fbc-7579-4294-9715-8c0cfd7d06a7`; services
`SCH-PATH` `b5fb305f-e348-4f2f-982b-49fbd38e929f` and `MySQL`
`350dae90-e97f-497d-939b-14e25e3500e3`; environment `production`
`655addcf-10cf-4feb-b720-b2b5775790d1`. (The project is named
`fabulous-radiance`, not "SCH-PATH".)

```
deployments(input: {projectId, environmentId, serviceId}, first: N)
  { edges { node { id status createdAt meta } } }        # meta.commitHash
deploymentLogs(deploymentId: $id, limit: 1000) { timestamp message severity }
buildLogs(deploymentId: $id) { ... }
```

Helpers are `C:/tmp/railway*.js`, reading the token from `C:/tmp/.railway-token`.
**Delete that file and revoke the token when finished.** A deployment list shows
only the newest as live; older entries read `REMOVED` (superseded), which looks
like a stall but is not.

## Local tooling

- Node binary moves between patch releases:
  `C:/Users/Administrator/.workbuddy-ai/binaries/node/versions/`. Check the
  directory before assuming a script is broken — a stale path fails with a bare
  "No such file or directory".
- Playwright lives in the managed node workspace, not the frontend project.
  `channel: 'msedge'` uses the installed Edge; its own Firefox needs
  `node node_modules/playwright/cli.js install firefox` and must be launched as
  `pw.firefox.launch()` — `chromium.launch({ channel: 'firefox' })` is rejected.
- The user's screenshots are recoverable from
  `~/.workbuddy-ai/clipboard-images/`. Check them before guessing what was seen.
- **6 tests fail in this sandbox and fail identically at HEAD** (5 in
  `jwt-secret.test.js`, 1 dialog-guard): `spawnSync … node.exe EBUSY`. The
  sandbox refuses to spawn the managed node binary as a child. Prove it by
  stashing and running clean before blaming a change.
