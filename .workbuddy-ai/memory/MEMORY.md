# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, branch `master` — auto-deploys Railway (API+DB) + Vercel, **no CI**. Live:
`sch-path-production.up.railway.app` + `sch-path.vercel.app`. **No MySQL locally — verify against the
live pair.** Skills: `sch-path-repo-ops`, `sch-path-module`, `sch-path-rbac-role`,
`sch-path-deploy-verify`. Full rationale for everything below is in the daily logs
(`2026-09-23` … `2026-09-29`).

## Deploy / partner edits
`inchan <akosichano01@gmail.com>` edits via GitHub web upload ("Add files via upload") — that
**replaces the blob**, so a fix made since their copy was taken vanishes silently. Gate an incoming
change with `git merge-tree --write-tree --name-only <a> <b>`, then `vite build` (the only gate that
sees a `.tsx` parse error).

## Time on the wire
DB holds UTC; `dateStrings: true` yields zone-less literals JS reads as local, fixed at the response
boundary (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays bare;
`WALL_CLOCK_DATETIME_COLUMNS` is `+08:00`, not `Z`. **Never derive "now" from `toISOString()`** — use
`getCurrentPHDate()` / `getCurrentPHDateTime()`. One side only = 8-hour skew.

## Files kept byte-identical (edit one, copy over the other)
- `rbac.definition.json` — `backend/src/config/` ↔ `frontend/src/app/config/`.
- `documentCategories.json` — same pair, pinned by `document-categories.test.js` (which also pins the
  folder list). Rules run in order, first match wins; **no broad keyword** (a `discharge` keyword steals
  the Pre-integration "Discharge Form"). A new category needs a `DOCUMENT_READ_ROLES_BY_CATEGORY` entry.

## Backend rules that have already cost a bug
- **`errorHandler` does not mask MySQL errors**: `ER_*` → 400 + `sqlMessage`; four schema codes fire an
  auto `syncSchema(pool)`. A plain `Error` from a service is still a 500 — validate in the
  **controller** with `ApiError(400, …)`.
- **New column** → guarded boot migration in a shape `schema-contract.test.js` can parse. **New index**
  → `ensureIndex(...)` **inside** `runMigrations()` (outside = boot-time ReferenceError). `mapRow`
  emits only `col in row`.
- **`constants.js` `columns` is both the read projection and the write allow-list** — a column the SQL
  `orderBy` uses is not necessarily one the API returns. Check `columns` before reading a field off a
  fetched row; a TS interface for a server payload must mark omitted fields optional.
- **A wide JSON/TEXT column turns `ORDER BY` into a 400** (`ER_OUT_OF_SORTMEMORY`, swallowed as "no
  records"). An index is not enough — set `sortInApplication: true`.
- **Only `houseparent` is scoped** (`utils/residentScope.js`), forward-only. Seed creds in
  `backend/src/scripts/seedDatabase.js`. No `admin` account; never reset a real account to get a token.
- **A notification is invisible to its own actor** (`actorUsername <> ?`). `isSnapshot()` must require
  `Array.isArray(subject.modules)`.
- **An admission's classification is derived from `children.status`, never asked for**
  (`admissions.admissionStatus` = New / Returning Resident (Abscond/Tumakas) / Relapse) and is
  **stored, not recomputed** — renaming the label needs an idempotent boot migration in `server.js`.
- **A rule put in `submit` does not cover an upload that arrives already `Submitted`** —
  `documentController.create` must apply it too. Related: only an `Approved` document counts toward a
  phase (`PhaseProgress.tsx`).
- **Dual verification**: `boundVerificationSide(user)` is the single place resolving a role's bound side
  (psychologist→psych, socialworker→sw, else null). The "two different people" guard is now
  unreachable (the route admits only those three roles), so the Center Head can sign both sides.
  `admin` is not on the review route but the UI offers admin the dropdown → 403; unfixed.

## Frontend traps
- A client guard on `canOpenModule` in front of an endpoint gated by `authorize(role list)` asks a
  different question than the server — use the capability form `userCan(user, module, action)`.
- `useSubModuleTab` must apply `?tab=` on *change*, not on disagreement.
- A load-path write gated on an empty table is a **resurrection hazard** (empty is a legitimate
  state). A delete must `await` before removing the row locally.
- `truncate` under `table-layout: auto` clips the table's trailing columns → `table-fixed` + declared
  header widths.
- `Dashboard.tsx` is the chunk every role loads — anything statically imported by it ships to a
  Houseparent too. Keep heavy deps lazy (`lazyComponent` + `<Suspense>`) or on demand
  (`await import('mammoth')`), and verify in `dist` that a Node/browser-dual package bundled the
  **browser** build. Check the build output before adding a heavy import.
- Every role early-returns into its own dashboard; the shared one below is the fallback for an
  unrecognised role. Figures are computed once in `Dashboard.tsx` and passed as **props** — never
  recounted locally.
- `1rem` is 14px (`theme.css`). Tap-target floors live only in the `@media (pointer: coarse)` block;
  `TabsTrigger` and `.pdf-overlay-cell` are excluded. A centred dialog needs `max-h` + `overflow-y-auto`;
  full-screen editors use `!h-[100dvh]`.
- PDF overlays are sized in `cqw` against a `container-type: inline-size` parent — never px or `vw`.
- Three backend tests read components as text and pin full-screen dialog class strings — update the pin
  in the same commit.

## Filing a generated document
**There is no bundled HTML→PDF path.** `Reports.tsx` loads `html2pdf` from a CDN client-side. To file a
generated report, `8fbb1c7` uses `jspdf` + `html2canvas` (dynamically imported) and writes into a
**hidden same-origin iframe** first — its stylesheet uses bare selectors (`body`, `table`, `.section`)
that would restyle the whole app — and strips the report's own `window.onload → window.print()`.

## The Center Head dashboard (`GET /api/dashboard/center-head`)
One endpoint, one SQL predicate per section, every list the rows behind its own count. Each section
wrapped in `safe()` (degrades to empty on `ER_NO_SUCH_TABLE`; several tables have no boot migration —
never add an unguarded query). Four silent failure modes it has already produced:
1. **`tallyBy(rows, key)` requires its key** — a tile reading 0 while its neighbour is non-zero is this.
2. **`Promise.all` of `pool.query` returns `[rows, fields]` per element** — destructure `[[rows]]`.
3. **Never let one params array serve two predicates with opposite orders** — the range becomes
   `>= end AND <= start`, matches nothing, no error. Assert the bound **values**, not the `?`-count.
4. **`documents.submittedAt` is NULL on almost every pending document** → `COALESCE(d.submittedAt,
   d.uploadedAt)`; tell is a date column empty on plainly-recent rows.

Period-scoped (`?period=YYYY-MM`); **the period must not move `today`**, and the month must be validated
or `2026-13` reads zero. Tile definitions (active resident = Child Records Active read at period end,
etc.) and the full section list are in the 2026-09-29 log.

## Seeing the rendered page
**You cannot see the rendered page from the source — build a local copy against the live database and
screenshot it.** The harness is a small Node server serving the built `dist` **and proxying `/api` to
Railway**, then Playwright on system Chrome (full recipe in the 2026-09-27 log). Trap: **Git Bash
rewrites a leading-slash env var into a Windows path**, so pass `VITE_API_URL` as a full URL and then
grep the built entry chunk to confirm what baked.

## Live credentials
Verified live 2026-09-29: `centerhead`/`centerhead123`, `nurse`/`nurse123`. `nurse`/`nurse1234` is a
**401 — wrong**. Believed good: `educator`/`educator123`, `socialworker`/`socialworker123`,
`houseparent1`/`houseparent123`. Logins are **rate-limited** — log in once per role and reuse
`context.storageState()`, or a 429 reads as a clean pass covering nothing.
