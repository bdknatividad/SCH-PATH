# SCH-PATH — Deployment Guide

Frontend on **Vercel**, backend on **Render**, database on a **managed MySQL**
provider (Railway / Aiven / Clever Cloud). Every step below is something you do
by hand; nothing in this guide has been run for you.

---

## 0. Before you start — read this

Two facts about this system drive the whole plan.

**1. Uploaded files live inside the database.** Every document, PDF, signature
and TRI/Anecdotal/Medical/QPR file is stored as base64 text in MySQL `LONGTEXT`
columns. There is no S3 bucket and no filesystem storage to configure — but it
also means **your database size is your file-storage size**. Watch this number;
it is the first free-tier limit you will hit.

**2. The backend reads PDF templates out of the frontend folder at runtime.**
When it publishes an Anecdotal Report, a TRI record or an Incident Report it
loads the official blank form from:

```
frontend/public/forms/Anecdotal Report.pdf
frontend/public/forms/tri.pdf
frontend/public/forms/incident-report.pdf
frontend/src/assets/sch-logo.png
```

This is why the backend's Docker build context must be the **repository root**
and not `backend/`. If you build with `backend/` as the context, those four
files are not in the image and every one of those published documents fails at
request time. The supplied `backend/Dockerfile` handles this; just do not change
the context.

**Database must be MySQL.** The code uses MySQL-specific SQL (`ON DUPLICATE KEY
UPDATE`, `INFORMATION_SCHEMA`, `ENGINE=InnoDB`, `mysql2/promise`). A PostgreSQL
instance will not work without a substantial rewrite.

---

## 1. Create the repository and push

From the project root (`C:\sept23`):

```bash
git init
git add .
git commit -m "SCH-PATH: audited and production-ready"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

A `.gitignore` is already in place, so `node_modules/`, `dist/`, every `.env`
and the stale `dist-verify*` / `.verify-build*` folders are excluded. Confirm
before pushing:

```bash
git status --short          # expect: nothing unexpected
git ls-files | wc -l        # expect: 490-500 source files, not thousands
```

> **Note on the stray build folders.** `frontend/dist-verify*`, `.verify-build*`,
> `.buildcheck-*` and `.vb-verify-g` (~155 MB of stale build output) are still
> on disk. They are correctly ignored by git, so they will not be pushed. The
> tooling in this environment blocks recursive deletes on those paths, so
> removing them is left to you — see §7. Nothing depends on them.

---

## 2. Create the MySQL database

Pick one free MySQL provider. **Railway** is the simplest; **Aiven** and
**Clever Cloud** also have free MySQL tiers.

1. Create a MySQL instance.
2. Copy the connection details: host, port, user, password, database name.
3. Note whether the provider requires TLS (Railway and Aiven do).

**If the provider does not let you choose a database name**, create one:

```sql
CREATE DATABASE sch_path_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`utf8mb4` is required — `utf8` truncates 4-byte characters and the schema
already declares `utf8mb4_unicode_ci` throughout.

You do **not** need to create any tables. The backend creates and upgrades the
entire schema itself on every startup, and seeds the default users.

---

## 3. Deploy the backend to Render

1. Render → **New** → **Web Service** → connect your repository.
2. Settings:
   - **Language / Runtime:** `Docker`
   - **Root Directory:** leave as the **repository root** (not `backend`)
   - **Dockerfile Path:** `backend/Dockerfile`
   - **Instance Type:** Free
   - **Health Check Path:** `/api/health`
3. Add these environment variables (Render → Environment):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DB_HOST` | from §2 |
| `DB_PORT` | from §2 (usually `3306`) |
| `DB_USER` | from §2 |
| `DB_PASSWORD` | from §2 |
| `DB_NAME` | `sch_path_db` |
| `DB_SSL` | `true` (or `false` if your provider has no TLS) |
| `JWT_SECRET` | generate — see below |
| `JWT_EXPIRE` | `24h` |
| `CORS_ORIGIN` | leave empty for now; set in §5 |

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **The server will refuse to start** if `JWT_SECRET` is missing, shorter than
> 16 characters, or still looks like a placeholder (`change_this...`, `example`,
> etc.). That is deliberate — a guessable secret lets anyone mint a token for
> any role.

4. Deploy. In the logs you should see, in order:
   - `✅ Database connected successfully`
   - a series of `Migration: ...` lines
   - `✅ API routes mounted`
   - `SCH-PATH Backend Server` and the listening port

   If you see `❌ Database connection failed`, the `DB_*` values are wrong.
   If you see `❌ JWT_SECRET ...`, fix that variable.

5. Copy the service URL, e.g. `https://sch-path-api.onrender.com`.
6. Verify: open `https://sch-path-api.onrender.com/api/health` — expect
   `{"success":true,"message":"API is running",...}`.

> **Free-tier cold starts.** A free Render service sleeps after ~15 minutes of
> inactivity and takes ~30–60 seconds to wake. The first request after a sleep
> will be slow. The app shows a spinner and then a clear timeout message rather
> than hanging forever, but do not mistake a cold start for a broken deployment.

---

## 4. Deploy the frontend to Vercel

1. Vercel → **Add New** → **Project** → import your repository.
2. Settings:
   - **Root Directory:** `frontend`  ← important
   - **Framework Preset:** `Vite` (should be auto-detected)
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. Add the environment variable — **before the first build**:

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://sch-path-api.onrender.com/api` |

Your Render URL from §3, with `/api` on the end. No trailing slash needed.

> **Vite inlines `VITE_*` values at build time.** Setting or changing this
> variable requires a **redeploy** — editing it alone changes nothing in the
> already-built bundle.

4. Deploy and copy your Vercel URL, e.g. `https://sch-path.vercel.app`.

`frontend/vercel.json` is already committed. It configures the SPA rewrite
(every non-asset path serves `index.html`, so a refresh on `/children/CH001`
does not 404) and long-lived caching for hashed assets.

> **The rewrite deliberately spares a specific list of paths:**
> `assets/`, `forms/`, `cmaps/`, `fonts/`, `pdf.worker.mjs`, `tri-form.pdf`,
> `vite.svg` and `favicon.ico`. Anything not on that list is treated as a client
> route and served `index.html`.
>
> The important one is **`pdf.worker.mjs`**. It is a real 1.9 MB JavaScript file
> at the site root that `pdf.js` loads as a Web Worker. If the rewrite catches
> it, the worker becomes HTML and **every PDF in the app silently stops
> rendering** while the rest of the system looks fine. §6.3a is the check.

> **If you add a new static file to `frontend/public/`**, add its path to that
> exclusion list too, or it will be served as `index.html` in production.

---

## 5. Connect the two — lock down CORS

This step is what makes the pair actually work, and it is easy to skip.

1. Render → your service → **Environment**.
2. Set **`CORS_ORIGIN`** to your Vercel URL:

   ```
   https://sch-path.vercel.app
   ```

   Multiple origins are comma-separated, and trailing slashes are tolerated:

   ```
   https://sch-path.vercel.app,https://www.your-domain.com
   ```

3. Save — Render restarts the service automatically.

**How this behaves:**

- **`CORS_ORIGIN` empty** → any origin may call the API. Fine for local
  development; not something to leave on a public production API.
- **`CORS_ORIGIN` set** → only the listed origins get an `Access-Control-*`
  header. Everything else is refused by the browser.

**If you added a Vercel preview or custom domain** and the app suddenly cannot
reach the API, this is the first thing to check. Look for a CORS error in the
browser console and add the origin to this variable.

---

## 6. Verify the deployment

Work through this list in order. Each step catches a different class of problem.

### 6.1 Reachability

- `https://<render>.onrender.com/api/health` returns success JSON.
- The Vercel URL loads the login screen.

### 6.2 Log in

Sign in as `centerhead` with the seeded password. If the login screen loads but
signing in fails, check the browser console:

- `CORS` error → §5 (`CORS_ORIGIN`).
- `404` on `/api/...` → `VITE_API_URL` is wrong, or you did not redeploy after
  setting it. Inspect the loaded JS bundle for your Render hostname.

> **Change the seeded passwords immediately.** The seed accounts use their
> documented default passwords; they are public knowledge to anyone who reads
> the repository.

### 6.3 The modules

Open each of these and confirm real data appears, not an empty shell:

Dashboard · Child Records · Activities · Assessments · Health · Account
Management · Reports · Violations · Court Records · Social Worker · Documents ·
Education · TRI

> **Each module now loads as its own JS chunk.** The first time you open one, the
> browser fetches a small extra file, so expect a brief "Loading…" then the page.
> On a slow connection the first visit to a heavy module (Documents, Child Detail,
> Reports, TRI) can take a moment. That is the code splitting working, not a hang.
> A module that stays on "Loading…" forever means its chunk 404'd — check the
> browser console for the failing file name and confirm
> `frontend/vercel.json`'s `rewrites` did not swallow it.

### 6.3a PDF rendering — verify the worker loads

**This is the one deployment-specific trap, and it only shows up in production.**

`pdf.js` runs in a Web Worker loaded from `/pdf.worker.mjs`, a 1.9 MB file that
sits in `public/` and is served from the site root. An SPA rewrite rule will
happily rewrite that path to `index.html`, at which point the worker is
HTML instead of JavaScript and **every PDF stops rendering** while the rest of
the app looks perfectly healthy.

The fix is already in `frontend/vercel.json` — `pdf.worker.mjs` is excluded from
the rewrite. Verify it survived:

```bash
curl -sI https://<your-app>.vercel.app/pdf.worker.mjs
```

Expect `200` and a JavaScript content type. If you instead get `200 text/html`,
the rewrite is eating it — and `curl -s .../pdf.worker.mjs | head -c 60` would
show `<!DOCTYPE html>`.

**Then confirm PDFs actually render,** because a 404 worker does not always throw:

1. Open a resident in Child Records — the Admission Slip preview should draw.
2. Open the TRI module and page through the form.
3. Generate any report PDF (Reports → Daily).
4. Open the browser console and confirm **no** `Setting up fake worker` warning,
   which is what pdf.js logs when it silently falls back after a worker failure.

### 6.4 File upload and download — the highest-risk path

This exercises base64-into-MySQL, the largest payload the app handles.

1. Child Records → a resident → Documents → upload a multi-page PDF.
2. Confirm it appears without a full page reload.
3. **View** it, **download** it, **print** it.
4. Reload the browser and confirm it is still there (proves it persisted, not
   just rendered from local state).
5. Upload something with a large file size and confirm it succeeds — this is the
   `max_allowed_packet` path.

> **If uploads fail above a certain size:** the MySQL instance's
> `max_allowed_packet` is too low. The backend raises it per session
> automatically and tries the global setting too; if the provider denies the
> global change, set it on the instance itself (64 MB is the target) or check
> whether the free tier caps it.

### 6.5 The approval workflow

- Submit a document for review.
- Approve it as Center Head → status becomes **Approved**.
- Submit another, reject it with a reason → status becomes **Rejected**, and the
  reason is visible to the submitter (not collapsed into "No Access").
- Confirm the notification reaches the right role.

### 6.6 Signatures and generated PDFs

These exercise the bundled templates — the §0 risk.

- **TRI:** complete and publish a TRI record for a resident. Confirm the
  official form is produced with the entries overlaid.
- **Anecdotal Report:** create one, accept it, confirm it publishes as the
  official form.
- **Incident Report:** generate a Form 08.
- **Discharge Report:** open it and confirm **two** signature pads appear —
  "Prepared by signature" and "Approving authority signature" — and that both
  print on the generated report.

> **If a generated PDF comes out blank or the server logs a missing-template
> error**, the Docker build context was `backend/` instead of the repository
> root (§3, step 2). Rebuild with the correct context.

### 6.7 Permissions — spot-check the ones that matter

Sign in as each role and verify the boundary holds. Then try to bypass it by
typing the URL directly:

| Role | Must NOT be able to |
|---|---|
| Houseparent | Open Child Records, Health, Court Records, Reports; see medical records |
| Educator | Upload or manage documents; see medical records |
| Nurse | See Court Records, Reports, Account Management |
| Psychologist | See Health, Court Records, Account Management |

For each blocked page, typing the URL directly must show the "No module access"
screen — not the page. If a page renders, the problem is on the API side, not
the UI.

### 6.8 On a phone

Open the Vercel URL on an actual phone (not just a narrow desktop window — the
input-zoom and keyboard behaviours are the whole point).

1. **Log in.** The login form fits without sideways scrolling.
2. **Tap an email/password field.** iOS must **not** zoom the page in. If it
   does, the 16px input rule in `theme.css` was lost.
3. **Open the menu.** The drawer slides in, the page behind it does not scroll,
   and the close button works.
4. **Rotate to landscape and back.** The drawer must not stay stuck open with
   the page frozen.
5. **Open a record with a long form** — Child Records → a resident. Scroll from
   top to bottom; the page should scroll as one surface, and the address bar
   should collapse as you scroll down.
6. **Tables.** Open Health and TRI. Wide tables scroll sideways *within their
   own box*; the page itself must never drag left/right.
7. **Sign something.** Open the Discharge Report and tap a signature pad. The
   canvas must be tall enough to write in — not a thin strip.
8. **Reports.** Generate a report; the popup shows a 2-up summary on a phone and
   4-up on desktop, and the tables scroll rather than overflow.

> **The printed output is deliberately unchanged.** The phone-only rules for the
> report grids and padding are reverted inside `@media print`, so a PDF saved
> from a phone is laid out identically to one saved from a desktop.

### 6.8 Notifications

- Trigger an action that creates a notification for another role.
- Sign in as that role and confirm the badge count matches the list.
- Mark one read; reload; confirm it stays read.

---

## 7. Housekeeping on your machine

Two optional cleanups, both local-only.

**Remove the stale build folders** (~155 MB). Nothing references them and they
are git-ignored, so this is purely to reclaim disk:

```powershell
cd C:\sept23\frontend
Remove-Item -Recurse -Force .buildcheck-2, .vb-verify-g, .verify-build,
  .verify-build-2, dist-verify, dist-verify-acct, dist-verify-flat,
  dist-verify-pw, dist-verify-tri
```

**Review `backend/data/store.json`.** It is a leftover JSON fallback store from
before the system moved to MySQL. Nothing in `backend/src` reads it, and it
contains a plaintext `centerhead` credential. It is git-ignored so it will not
be pushed, but you should delete or blank it locally:

```powershell
Remove-Item C:\sept23\backend\data\store.json
```

---

## 8. Reference

### Files added for deployment

| File | Purpose |
|---|---|
| `frontend/vercel.json` | SPA rewrite + asset caching (see §4 on the worker exclusion) |
| `frontend/.env.example` | `VITE_API_URL` documentation |
| `backend/Dockerfile` | Backend image; bundles the PDF/logo templates |
| `backend/.dockerignore` | Keeps the build context small |
| `backend/.env.example` | Documents every backend variable |
| `render.yaml` | Optional reproducible Render service definition |
| `.gitignore` | Excludes deps, build output, env files and stale artifacts |

### Files added for mobile + performance (§11)

| File | Purpose |
|---|---|
| `frontend/src/app/utils/lazyComponent.tsx` | `React.lazy` wrapper accepting named or default exports, plus the route loading fallback |
| `frontend/vite.config.ts` | `manualChunks` vendor grouping (notably: must not pin `pdfjs-dist`) |
| `frontend/src/styles/theme.css` | Mobile baseline — 16px inputs, text wrap, media clamp, safe-area |
| `frontend/index.html` | `viewport-fit=cover`, `theme-color` |

### Why Vercel + Render rather than a single service

The backend can serve the built frontend itself (`server.js` does exactly this
when `frontend/dist` exists). A single Render service would avoid CORS and the
API-URL variable entirely — and would also avoid the cold-start penalty, since
there would be no second service to wake. Vercel was the stated preference and
is a better static host, so the split is what is configured. If you would rather
have one service, see §9.

### Free-tier limits to watch, in the order you will hit them

1. **Database size** — it stores your uploaded files as base64. Roughly a third
   larger than the raw files, since base64 inflates by ~33%. This is the real
   ceiling.
2. **Render cold starts** — ~30–60s after 15 minutes idle.
3. **Render build minutes** — the free plan has a monthly allowance.
4. **Vercel bandwidth** — generous for this kind of app, unlikely to bind.

---

## 9. Optional: collapse to a single service

If the two-service split becomes annoying, you can serve the frontend from the
backend instead:

1. Build the frontend locally (`cd frontend && npm run build`).
2. Add `COPY frontend/dist ./frontend/dist` to `backend/Dockerfile`, after
   building it in a stage.
3. Remove `VITE_API_URL` — the fallback `/api` becomes correct, because the app
   and the API are now the same origin.
4. Leave `CORS_ORIGIN` empty.
5. Delete the Vercel project.

This removes two moving parts and the cold-start penalty. The trade-off is that
static asset delivery is now Render's job rather than Vercel's.

---

## 10. What was fixed before deployment

The audit found and fixed 12 failing tests and four real defects. Full detail is
in `.workbuddy-ai/memory/2026-09-23.md`; the security-relevant ones:

- **Upload permission bypass.** `documentController.create()` skipped its role
  check entirely when a document title had no entry in
  `DOCUMENT_ROLE_PERMISSIONS`. Three titles the frontend sends were missing, so
  any role could upload a Court Order, an OCP Resolution or a Diversion Plan
  Referral Letter. Added the missing entries.
- **Task names offered as uploadable documents.** The upload picker folded
  `requiredTasks` into its document list, presenting phase tasks like
  "Counseling sessions" as document types with no permission entry — the same
  open-upload condition. Now reads only the document lists.
- **Medical data leaked to the Houseparent role.** The redaction helpers failed
  *open*: an account with an empty `accessibleModules` list falls back to its
  role's full matrix, so a Houseparent (seeded with `[]`) received
  `medicalRecords` despite the role being defined as having no medical access.
  Both helpers now read the role definition and fail closed.
- **Houseparent held Child Records and a Medical tab**, contradicting its own
  description. Removed.
- **Discharge Report had lost one of its two signatures.** Restored.

Test status: **766/766 backend tests pass**; the frontend builds cleanly.

---

## 11. Mobile and performance work

Both were applied after the audit above.

### 11.1 Performance — the bundle is now split

The app shipped as **one 2,173 KB chunk (658.6 KB gzip)**. Every route was a
static import, so the login screen downloaded both PDF engines, the zip library
and the component kit before it could draw a username field.

Routes are now loaded on demand (`React.lazy` via `@/app/utils/lazyComponent`)
and the vendors are pinned into their own cache buckets (`vite.config.ts` →
`build.rollupOptions.output.manualChunks`).

| | Before | After |
|---|---|---|
| Entry download (login + shell), gzip | **658.6 KB** | **141.8 KB** |
| Chunks | 1 | 55 |
| `pdf-lib` (431 KB) | always | only when generating a PDF |
| `pdfjs-dist` (463 KB) | always | only when viewing a PDF |

**5.3× smaller first load.** The two PDF engines are now fetched only by the
modules that use them — a user who never opens a document never downloads them.

No functionality was removed. `Layout` and `LoginPage` stay static on purpose:
they are on the critical path regardless, so splitting them would add a request
for nothing.

> **Do not add `pdfjs-dist` to `manualChunks`.** It ships its own asynchronous
> worker and CMaps sub-chunks that Rollup emits and the library resolves at
> runtime by URL. Pinning it into one chunk collapses those and breaks the
> worker. There is a comment in `vite.config.ts` saying so.

### 11.2 Mobile

The root causes, rather than per-page patches:

- **iOS input zoom.** Safari zooms the page in when a focused field's font-size
  is under 16px and never zooms back out. Many fields here are `text-xs`, so
  every phone form was a fight. One rule in `theme.css` sets 16px inputs below
  `lg`, instead of editing dozens of components.
- **Nested scroll area.** `<main>` was an `overflow-auto` box rather than the
  page scrolling. That broke the collapsing address bar, pull-to-refresh, and
  keyboard-avoidance on long forms. Below `lg` the document now scrolls
  normally; from `lg` up the two-column desktop shell is unchanged.
- **The menu drawer did not lock the page.** Scrolling it scrolled the content
  behind it. Now pinned with the scroll offset restored on close.
- **Sticky header below `lg`**, so the menu button is reachable from anywhere on
  a long record.
- **Signature canvas** was a fixed 1000×300 box, which collapses to a ~90px
  strip on a phone — too thin to sign. It now keeps a usable aspect ratio in
  portrait. The emitted PNG is byte-compatible, so nothing downstream changed.
- **Report print layouts** were the one place producing genuinely broken phone
  output: 4-up summary cards in ~360px, and four wide tables with no scroll
  container. Both fixed — and reverted under `@media print`, so the saved PDF is
  byte-for-byte what it was.
- **Overflow hardening:** `min-w-0` on the content column, `overflow-wrap` on
  text elements, `max-width: 100%` on media, and `min-width: 0` on date inputs.
  These remove the whole class of sideways-drag bugs rather than the instances
  found.

Nothing was hidden or disabled on mobile — every module remains fully usable,
which is what the brief required.

The frontend has 9 pre-existing TypeScript errors. They are **not** build
blockers — `vite build` does not run `tsc` — and they are unchanged from before
this work. Worth cleaning up eventually, but not a deployment risk.
