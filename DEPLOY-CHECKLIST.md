# SCH-PATH — Deployment Guide

Written 2026-09-23, immediately before the first production deploy.

**Verified state at time of writing:** backend `804/804` tests pass, frontend
build green in ~16s, `tsc --noEmit` at 9 known errors (all pre-existing, listed
in §8), no secrets tracked in git, and a clean server boot against MySQL.

Follow this top to bottom. Steps 1 and 5 are the two that are easiest to get
subtly wrong, so read those twice.

---

## 1. Architecture

```
   Browser
      │
      ├── https://your-app.vercel.app      ← Vercel, serves frontend/dist
      │        │
      │        └── fetch https://your-api.onrender.com/api/...
      │                   │
      │                   └── Render (Docker) ← backend/src/server.js
      │                              │
      │                              └── managed MySQL
      │
      └── same-origin /api  ← only if the backend serves the built frontend
```

Two services, one database. The backend is a Docker container; the frontend is
static files. They talk over CORS, which is why `CORS_ORIGIN` (Step 6) is a
required step and not an optional hardening.

---

## 2. Before you start — checklist

Have these ready:

- [ ] A GitHub account
- [ ] A Render account (sign in with GitHub)
- [ ] A Vercel account (sign in with GitHub)
- [ ] A managed MySQL instance — see Step 4
- [ ] The JWT secret from Step 3
- [ ] Your MySQL plan's **connection limit** (for `DB_POOL_LIMIT`, Step 6)

You do **not** need a domain. Both platforms give you a free subdomain.

**Before the first deploy, run the suite once:**

```bash
cd backend && node --test "tests/**/*.test.js"
```

Expect **849 passing, 0 failing**. A failure here means something in §10 has
regressed — fix it before deploying, not after.

---

## 3. Generate the JWT secret

The server refuses to start without a valid one. This is deliberate: a missing or
guessable secret lets anyone mint a token for any role, so `server.js` calls
`process.exit(1)` rather than falling back to a default.

Run this and copy the output somewhere safe:

```bash
"C:/Users/Administrator/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Result looks like `9f3c1a...` — 64 hex characters.

**Do not** reuse the placeholder from `.env.example`. The boot check rejects
anything shorter than 16 characters or matching a known placeholder.

---

## 4. Provision MySQL

The application uses MySQL-specific SQL throughout — a PostgreSQL instance will
not work.

### Recommended: Railway (fastest to start)

1. Go to `railway.app`, sign in with GitHub
2. **New Project** → **Provision MySQL**
3. Open the MySQL service → **Variables** tab, and note these five:
   - `MYSQLHOST`
   - `MYSQLPORT` (usually `3306`)
   - `MYSQLUSER`
   - `MYSQLPASSWORD`
   - `MYSQLDATABASE`
4. Open the **Connect** / **Networking** tab and make sure **public networking is
   enabled**. Render reaches the database over the public internet; without this
   the connection is refused and the deploy fails at boot.

### For anything longer-lived: Aiven

Railway's free MySQL is a trial and will expire. Aiven's free tier is durable.
Same five values, same step — `render.yaml` already lists Aiven as supported.

### You do not need to create any tables

`runMigrations()` builds and upgrades the entire schema on every boot, then
`seedDatabase()` creates the default users. Point it at an empty database and
start the service.

---

## 5. Push the code to GitHub

**This is the step most likely to go wrong.** The repository currently has one
baseline commit, and every fix from this session is uncommitted. If you push
without committing, you deploy the code *with* the bugs.

### What you upload, and what you must not

Git decides this for you. `.gitignore` already excludes the four things people
usually get wrong, so there is no folder to hand-pick and nothing to delete
first:

| Path | Uploaded? | Why |
|---|---|---|
| `backend/node_modules/` | **No** | Rebuilt by `npm install` from `package-lock.json` |
| `frontend/node_modules/` | **No** | Same — and it is ~67,000 files, which would make the push unusably slow |
| `frontend/dist/` | **No** | Rebuilt by Vercel on every deploy; a committed copy goes stale silently |
| `backend/.env`, `frontend/.env` | **No** | Secrets. Set them in the Render/Vercel dashboards instead |
| `backend/data/store.json` | **No** | Dead JSON fallback that still holds a plaintext credential |
| every `.ts`, `.tsx`, `.js`, `.json`, `.sql` under `backend/src`, `frontend/src` | **Yes** | The application |
| `DEPLOY-CHECKLIST.md`, `render.yaml`, `frontend/vercel.json`, `backend/Dockerfile` | **Yes** | The deploy configuration itself |

So: **no, you do not include `node_modules`, and you do not include `dist`.**
Commit everything with `git add -A` and git applies those rules for you.

Check what is uncommitted:

```bash
cd /c/sept23
git status --short
```

You should see about **38 modified files and 17 new ones**, including
`frontend/src/app/components/ui/modalLayer.ts`, `backend/tests/concurrent-users.test.js`,
and `backend/tests/session-cache.test.js`. Commit them all:

```bash
git add -A
git commit -m "Fix document admission merging, modal overlay click-through, and multi-user correctness"
```

Confirm the commit contains the fixes, and — more importantly — that no
dependency folder slipped in:

```bash
git log --oneline
git show --stat HEAD | head -40
git ls-files | grep -c "node_modules" || echo "OK: 0 node_modules files tracked"
```

That last command must print `OK: 0 node_modules files tracked`. If it prints a
number, `node_modules` was force-added at some point and the push will be
enormous — remove it with `git rm -r --cached backend/node_modules` (and the
frontend equivalent) before pushing.

Then create the repository. On github.com: **New repository**, give it a name,
and **do not** add a README, `.gitignore`, or license — an initialised repo
creates a commit that conflicts with your local history.

```bash
git remote add origin https://github.com/YOUR-USERNAME/sch-path.git
git push -u origin master
```

Verify `.env` was **not** pushed:

```bash
git ls-files | grep -E "\.env$" || echo "OK: no .env tracked"
```

It is normal for the two `git ls-files | grep …` checks to be the only ones
printing anything — that is the point of them.

---

## 6. Deploy the backend on Render

1. Go to `render.com` → **New** → **Blueprint**
2. Connect your `sch-path` repository
3. Render reads `render.yaml` and shows one service, `sch-path-api`
4. It prompts for the values marked `sync: false`. Fill them in:

| Key | Value |
|---|---|
| `DB_HOST` | your `MYSQLHOST` |
| `DB_PORT` | your `MYSQLPORT` |
| `DB_USER` | your `MYSQLUSER` |
| `DB_PASSWORD` | your `MYSQLPASSWORD` |
| `DB_NAME` | your `MYSQLDATABASE` |
| `DB_SSL` | `true` |
| `DB_POOL_LIMIT` | `20` (or about half your provider's connection cap) |
| `JWT_SECRET` | the hex string from Step 3 |
| `CORS_ORIGIN` | **leave blank for now** — set in Step 7 |

Three details that matter:

- **`DB_SSL` must be exactly `true`** — lowercase, as a string. `database.js`
  compares `process.env.DB_SSL === 'true'`, so `True` or `1` silently does not
  enable TLS and managed MySQL refuses the connection.
- **Do not set `PORT`.** Render assigns it and the server reads
  `process.env.PORT || 5000`. Hardcoding 5000 fails the health check.
- **Leave `CORS_ORIGIN` blank on this pass.** Blank means "allow any origin",
  which is what lets you confirm the API works before locking it down.
- **`DB_POOL_LIMIT` is the ceiling on simultaneous database access.** 20 is a
  sane default; raise it if several people will be working at once, but keep it
  under the plan's connection allowance (a free managed MySQL tier often allows
  only 20–30). Setting it too high produces "Too many connections" for
  *everyone*, which is worse than being slow.

5. Deploy, and watch the log. A healthy boot looks like:

```
✅ API routes mounted
✅ Database connected successfully
Migration: documents table ensured.
Migration: documents.admissionId backfilled for N row(s).   ← on an existing DB
Anecdotal Report template: /app/frontend/public/forms/Anecdotal Report.pdf
SCH-PATH Backend Server
```

6. Copy the service URL — something like `https://sch-path-api.onrender.com`

**Verify before continuing:**

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
```

You want an HTTP 200. This endpoint deliberately does not touch the database, so
it proves the process is up even if the database is slow.

### Reading the log

| Line | Meaning |
|---|---|
| `❌ JWT_SECRET ...` then exit | The secret is missing, too short, or a placeholder |
| `Database connection failed` | Wrong host/port/credentials, or public networking is off |
| `Migration warning ...` | Non-fatal. The server starts; one backfill was skipped |
| `Anecdotal Report template could not be found` | Non-fatal warning, but Anecdotal Reports cannot publish PDFs |

---

## 7. Deploy the frontend on Vercel

1. Go to `vercel.com` → **Add New** → **Project** → pick `sch-path`
2. **Set Root Directory to `frontend`** — this is the single most common failure.
   The build needs `frontend/package.json`; leave it at the repo root and Vercel
   finds no Vite project and fails.
3. Vercel detects the framework from `frontend/vercel.json`. Leave the build and
   output settings alone — they are already correct.
4. Under **Environment Variables**, add one:

| Name | Value |
|---|---|
| `VITE_API_URL` | `https://YOUR-RENDER-SERVICE.onrender.com/api` |

Two things about this value:

- **The `/api` suffix is required.** Without it every request 404s.
- **Vite inlines it at build time.** If you change it later you must redeploy —
  editing the variable alone has no effect on the running site.

5. Deploy, and copy your URL, e.g. `https://sch-path.vercel.app`

---

## 8. Close the CORS loop

Back in **Render → your service → Environment**:

| Key | Value |
|---|---|
| `CORS_ORIGIN` | `https://sch-path.vercel.app` |

Use your real Vercel URL, with no trailing slash. Save — Render redeploys
automatically.

**This step is required.** While `CORS_ORIGIN` is blank the API answers anything;
once you set it, it becomes an allow-list and a request from any other origin is
refused by the browser. Skipping it leaves you with a frontend that loads but
cannot talk to its API.

If you later add a custom domain, comma-separate the origins:

```
https://sch-path.vercel.app,https://your-domain.com
```

---

## 9. Smoke test

Work through this in order. Each step tests something the previous one cannot.

### 9.1 The app loads

Open your Vercel URL. You should get the login screen, not a blank page and not
a Vercel 404.

### 9.2 Log in

Default accounts are seeded on first boot:

| Username | Password | Role |
|---|---|---|
| `centerhead` | `centerhead123` | Center Head |
| `socialworker` | `social123` | Social Worker |
| `nurse` | `nurse123` | Nurse |
| `educator` | `educator123` | Educator |
| `psychologist` | `psych123` | Psychologist |
| `HP 1` … `HP 10` | `hp1 123` … `hp10123` | Houseparent |

**Change the `centerhead` password immediately after this step.** These are
public defaults sitting in the repository.

If login fails with a network error, it is almost always Step 8.

### 9.3 The bug you reported — modal overlay

Log in as `centerhead` (or any account holding the Documents review tab):

1. **Documents** → **Pending Review**
2. Find a document → **Approve**
3. The confirmation appears → **Approve Document**
4. The "Document approved" dialog appears

**Pass condition: the OK button clicks normally.** The screen may dim behind the
dialog, but OK must respond, and closing it must restore normal page interaction.
You must **not** need Esc.

### 9.4 The other bug — admission folder separation

1. Open a resident who has been admitted more than once
2. **Documents** → the **Folders by Child** view

**Pass condition:** each admission gets its own folder, numbered oldest first —
`1st Admission`, `2nd Admission`, `3rd Admission`, … A document filed during the
second admission must stay in the second folder, not appear in the third.

### 9.5 PDF publishing

Open any Anecdotal Report that has been approved or any TRI record and generate
its PDF. This is the check that proves the Docker build copied the templates in
correctly. If it fails, the boot log will say the template was not found.

---

### 9.6 Use it from two devices

This is what "upload on the phone, see it on the PC" depends on. Do it with the
real devices, not two browser tabs.

1. On your **Android phone**, open the Vercel URL and log in
2. Upload a document (test with a **camera photo**, not a small file — see §10)
3. On your **PC**, open the same URL, log in as the same user
4. Open **Documents** and find the file you just uploaded

**Pass condition: the document is there, and View / Download work.**

If the list is stale, switch away from the tab and back — the module refreshes on
window focus. If the row appears but View fails, that is the bug fixed in §10
(`apiUrl`), not a sync problem.

**Why this works:** documents are stored in MySQL (`documents.fileData`, a
`LONGTEXT` column) — not on the device and not on a local disk. `refreshData()`
calls `GET /api/store`, and `fileData` is deliberately excluded from that bulk
payload for size reasons, so the bytes are fetched per-document from
`GET /api/documents/:id/file`. Nothing about a document is cached in
`localStorage`; the only thing stored there is the auth token. So any device that
can reach the API sees the same data.

**One thing that does need care:** `CORS_ORIGIN` is matched on *origin*, not on
device. Both your phone and your PC send the same
`https://your-app.vercel.app` origin, so the single value from Step 8 covers both.
You do not need to list each device.

### 9.7 Several people at once

The system has to hold up with more than one person using it, each seeing only
what their role allows. Do this with two real sessions — two browsers, or one
browser plus your phone.

**A. Two people, one record (concurrency)**

1. Session **A**: open a resident in **Child Records**, and leave it open
2. Session **B**: as the same role, edit **and save** that same resident
3. Session **A**: now save your edit

**Pass:** session A is told the record "was changed by … after you opened it",
then reloads and reapplies. It must **not** silently overwrite B's change.

**B. Two roles, one dataset (RBAC)**

Sign in as two different roles and confirm each sees only its own modules:

| Check | Expected |
|---|---|
| Sidebar | Only the modules that role holds — no greyed-out extras |
| A module the role lacks, typed directly in the URL | Empty / refused, **not** the other role's data |
| `GET /api/store` in DevTools (as the restricted role) | The gated collections come back as `[]` |
| Documents list | Only documents that role may read |

**C. Shared workstation (session teardown)**

1. Log in as one user, open **Education** and **Account Management** (so both
   caches are written)
2. Log out
3. In DevTools → Application → Local Storage, check the key list

**Pass:** no `education*`, `userAccounts`, `children`, `staff`, `alerts`,
`courtRecords`, `violations`, `assessments`, `reports`, or `activitiesRecords`
keys remain. Only the session keys may be left, and even those are removed.

If any of those survive, the next person on that machine can read the previous
user's records without logging in as them — see §10.

**D. Sustained load**

Open the app in several tabs and click through the heavier modules for a minute
or two. Watch the Render log for `ER_CON_COUNT_ERROR` / "Too many connections" —
that means `DB_POOL_LIMIT` is above your plan's allowance; lower it.

**E. Creating an account online**

This is the one to run last, because it needs two admins at the same moment.

1. Session **A** and session **B**, both signed in as **Center Head**, both on
   **Account Management**
2. Create a new account in **A** (e.g. `nurse.test1`, role Nurse)
3. Within the same second, create a *different* account in **B**
   (e.g. `nurse.test2`, also Nurse)
4. Reload both sessions

**Pass:** all three rows are present on both sides — `nurse.test1`,
`nurse.test2`, and the real accounts — each with its own id. Reload once more;
nothing shifts.

**Fail symptoms:** one of the two new accounts disappears after reload, two
accounts show the *same* id, or an account appears in the creator's list but not
in the other session's. That is the client-minted-id defect returning; run
`node --test tests/concurrent-users.test.js` — four tests cover it.

Since account creation is an online, server-allocated operation, it also needs
the backend reachable — if it fails instantly with "Failed to fetch", that is
Step 8 (CORS), not this.

---

## 10. Known issues, and what is not a bug

### Not bugs

**The first request after idle takes 30–60 seconds.** The Render free tier sleeps
after about 15 minutes of inactivity. This is the platform, not the application.
Upgrade the plan if it matters for a demo.

**The 9 TypeScript errors.** `tsc --noEmit` reports 9 errors, all pre-existing,
none in code touched by this session. Vite does not run `tsc` during `build`, so
they do not affect deployment:

- `AssessmentDetail.tsx` — `violationIds`, `interventionTrackerId`,
  `interventionRequirementId`, `schedulingMode` not on the union type
- `Assessments.tsx` — `undefined` not assignable to `Assessment | null`
- `ChildDetail.tsx` — three implicit `any` parameters
- `ChildRecords.tsx` — `style` prop not on the PDF component's types

### Fixed — would have broken the deploy

**Every file download and PDF generation would have failed.** `.` Eight places
called `fetch('/api/...')` with a literal path, which the browser resolves against
the *page* origin. On Vercel that origin is the Vercel host, and Vercel's SPA
rewrite turns `/api/...` into `index.html` — so `res.ok` came back true and the
"file" was a copy of the app's own HTML. Affected: document View, Download,
Print, bulk ZIP, the Anecdotal Report PDF, the Quarterly Progress Report PDF and
its template. Fixed by routing them all through `apiUrl()` from
`services/api.ts`, with `tests/api-base-url.test.js` guarding it.

The same mistake had already been fixed once inside `api.ts` itself — its
`API_BASE_URL` comment describes the identical symptom — but the raw `fetch`
calls that cannot use `request()` were missed.

**Uploads between roughly 7.5 MB and 10 MB were refused with a useless error.**
`.` A file is sent base64-encoded inside a JSON body, which inflates it by about
a third. The form said "Max 10MB" and the client check allowed 10 MB, but the
server's `express.json({ limit: '10mb' })` applied to the *body* — so a 10 MB file
arrived as 13.3 MB and was rejected by `body-parser` with a 413 **before any
handler ran**, surfacing as a bare "Request failed".

This is worst on a phone, which is the point: camera photos and scans routinely
land between 8 MB and 12 MB, so the uploads most likely to be attempted from
Android were the ones refused.

Fixed by raising the body limit to `16mb` and making the client's ceiling a
single named constant (`MAX_UPLOAD_BYTES`, `MAX_UPLOAD_LABEL`) that the label,
the check, and the server limit are all verified against by
`tests/upload-limits.test.js`.

**The admission backfills were silently dead.** Both
`backfillDocumentAdmissions()` and `backfillPhaseProgressAdmissions()` called
`pool.query(...)` while `pool` was imported only *inside* the cron callbacks
further down `server.js`. Every boot logged

```
Migration warning (documents admission backfill): pool is not defined
```

and continued. Because `server.js` was never loaded by any test, this was
invisible to the suite — and on a database with pre-existing documents it would
have left every `admissionId` at `NULL`, which is exactly the condition the
returning-resident fix exists to prevent.

Fixed by importing `pool` at module level, with `tests/boot-migrations.test.js`
added so it cannot regress.

**Concurrent users could collide on a record id.** `.`. The frontend computed the
next sequential id from the list it had on screen (`CH001` → `CH006`) and posted
it as the new record's id. The backend ignores a client-supplied id and allocates
its own, so neither request *failed* — but the optimistic row in the browser was
reconciled by matching that id, which could never match. Two people adding a
record at the same moment therefore saw a phantom row that never resolved.

Worst instance: `Health.tsx` minted `HLT<n>` the same way, so two nurses filing a
health record concurrently derived the identical id.

Fixed by removing every client-side id mint and letting the server allocate, with
a random `provisionalKey()` used only for optimistic rendering in
`DataContext.addDocument`. Guarded by `tests/concurrent-users.test.js`, which
scans **every** `.ts`/`.tsx` file for the `padStart(3, '0')` id shape.

**A refresh that was issued first but answered last could overwrite newer data.**
`.` `/store` is re-read on mount, on window focus, and after most actions. Those
calls overlap, and responses can land out of order — so a record the user had
just seen appear could vanish until the next refresh. The store payload carries
no server timestamp to order by, so the client now tracks a generation counter
and only the newest response is allowed to write state (including the error path
and the loading flag). Same guard added to the alert feed, which polls every 30s.

**Two people editing one record was a silent last-write-wins.** `.`. Whoever
saved second overwrote the first person's change with no warning — and because
several callers send *partial* payloads (`{ notes }`, `{ phaseTasksCompleted }`),
the second save also destroyed fields it never mentioned.

Fixed with opt-in optimistic concurrency: the client sends the `updatedAt` it
rendered from, and `baseController.update` refuses with a **409** when the stored
row is newer, naming who changed it. A caller that sends no `updatedAt` behaves
exactly as before, so no existing client breaks.

**Signed-out data stayed readable on the workstation.** `.`. This is the one that
matters most for a shared facility PC. `AuthContext` clears a fixed list of
`localStorage` keys at logout, but the list had drifted from what the components
actually write:

| Component writes | Logout cleared |
|---|---|
| `educationVisitReports` | `educationSchoolVisits` ✗ |
| `educationProgressReports` | `educationProgressReports` ✓ |
| `educationStudents` | — ✗ |
| `userAccounts` | — ✗ |

So a Nurse could sign out and the next person on that machine could read the
previous user's Education records and the account roster **straight out of
`localStorage`** — no API call, no role check, nothing for the backend to refuse.
Two of the three Education keys and the whole account cache survived.

Fixed by correcting the list, and by `tests/session-cache.test.js`, which reads
the key literals out of the components that write them and fails if any written
key is not cleared — so a rename on either side breaks the build instead of
leaking in production.

**The database pool was capped at 10 connections with no way to raise it.** `.`
The pool is the hard ceiling on how many requests can touch MySQL at once; past
it, callers queue, so the symptom of a small pool is slowness rather than an
error. Now configurable via `DB_POOL_LIMIT` (default 20, capped at 200) so it can
be matched to the provider plan — **set it to roughly half the plan's connection
allowance**, leaving headroom for migrations, the cron jobs and any admin
session. Exceeding the provider cap returns "Too many connections" for every user
at once, which is why it is not simply raised higher.

**Creating a user account could be lost, or arrive under the wrong id.**
`.` — the same defect as the record-id collision above, in a second component,
and the last place it survived. `AccountManagement.handleAddUser` built the new
account with

```tsx
id: `U${String(Date.now()).slice(-4)}`,
```

and posted that object as the request body. So the id *was* transmitted, and
`Date.now()` truncated to four digits repeats every 10 seconds — two admins
creating an account in the same millisecond sent the same id. The backend was
already correct (`userController.register` allocates through
`insertWithGeneratedId` and ignores any id in the body), which is why the failure
was not a visible error: the account was created under a *server*-allocated id,
then appended to the admin's local list under the *client* id, so the roster
showed an entry that no longer matched anything after the next reload.

Fixed by dropping the `id` from the payload entirely and rebuilding the local
list from the response the server returns (`[...users, saved]`, where `saved` is
the row the API just wrote). Guarded by four tests in
`tests/concurrent-users.test.js`, two of which fail if the clock-derived id
returns.

### Still open, by choice

- `AnecdotalReport.tsx` and `Reports.tsx` use confirm-then-outcome dialogs. They
  pass the generic ordering scan but have no dedicated test pinning them.
- `assessments` and `education_records` carry no `admissionId` — by design, since
  the `documents` row is the single source of that link.
- The legacy `POST /api/children/:id/readmit` endpoint is retained and rewritten
  to write proper `admissions` rows.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Render build fails at `COPY` | Wrong Docker context | `render.yaml` sets `dockerContext: .` (repo root). Do not override it. |
| `❌ JWT_SECRET` then exit | Secret missing/short/placeholder | Regenerate per Step 3 |
| `Database connection failed` | Bad credentials or no public networking | Re-check the five `MYSQL*` values; enable public networking |
| Login spins then "Failed to fetch" | CORS | Step 8. Verify the origin matches exactly, no trailing slash. |
| Frontend loads, every call 404s | `VITE_API_URL` missing `/api` | Fix the variable **and redeploy** — it is build-time |
| Vercel: "No framework detected" | Root Directory not set | Set it to `frontend` |
| Document View/Download shows a blank page or the app itself | `/api` rewritten to `index.html` | Should be fixed; if it recurs, a `fetch('/api/...')` literal is back — use `apiUrl()` |
| Upload fails with "Request failed" on a large photo | Body too small for base64 | Should be fixed (`16mb`). Check `express.json({ limit })` in `server.js` |
| PDF generation fails at runtime | Templates missing from image | Check the boot log for the template line |
| "…was changed by X after you opened it" | Someone else saved the same record first | Working as intended — reload the record and reapply the edit |
| Records vanish then reappear on refresh | A slow refresh landed out of order | Should be fixed by the generation guard; check `loadStore` still bails on a stale `generation` |
| New admin account appears, then vanishes on reload | Client-minted `U…` id didn't match the server's | Should be fixed; run `node --test tests/concurrent-users.test.js` — the roster is now rebuilt from the API response |
| "Too many connections" from MySQL | `DB_POOL_LIMIT` above the provider cap | Lower it to about half the plan's allowance |
| A colleague's records visible on a shared PC | Cached data not cleared at logout | Should be fixed; run `node --test tests/session-cache.test.js` |
| `DB_POOL_LIMIT=abc` or `=0` | Invalid value | Ignored, falls back to 20 — no action needed |
| `/api/health` 200 but login 500 | Schema/migration problem | Read the boot log from the top |
| Uploaded on phone, missing on PC | Not a sync failure | Both read MySQL. Check they are the same user account and the same API host. |

---

## 12. Rollback

**Code.** Render and Vercel both keep every previous deployment. In either
dashboard, open the deployment list and promote the last known-good one. This is
instant and does not require a rebuild.

**Schema.** `runMigrations()` only ever *adds* tables, columns, and indexes. It
never drops or rewrites data, so an older build runs correctly against a newer
schema. Rolling the code back does not require rolling the database back.

Exception: `cleanupPhaseProgress.mjs` refuses to run if any returning resident is
on record, precisely so it cannot destroy the admission history.

**Database.** Take a provider-side snapshot before the first production deploy.
Railway and Aiven both offer this in their dashboard.

---

## 13. After the deploy

- [ ] Change the `centerhead` password
- [ ] Change or deactivate the other seeded accounts you do not need
- [ ] Confirm `CORS_ORIGIN` is set (not blank) in Render
- [ ] Enable a database backup schedule
- [ ] Decide whether the free tier's cold start is acceptable
- [ ] Record the actual deployed URLs somewhere your team can find them
