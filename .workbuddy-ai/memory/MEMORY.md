# SCH-PATH — Project Notes

`C:\sept23`. React 18 + Vite 6 + TS + Tailwind 4 · Express 4 + mysql2 + JWT · MySQL-only. Repo
`bdknatividad/SCH-PATH`, branch `master` — **`master` auto-deploys on Railway + Vercel; there is no
CI**. Live: `sch-path-production.up.railway.app` (API) + `sch-path.vercel.app`. No MySQL
locally — verify against the live pair. Rationale is in the daily logs; build/deploy, tooling and git
rules are in `sch-path-repo-ops`.

## The partner edits by whole-file upload

`inchan <akosichano01@gmail.com>` edits via the GitHub web UI (subject "Add files via upload"). That
**replaces the blob** — no conflict, no warning — so a fix made to that file since their copy was
taken disappears silently. On 2026-09-26 their tree held 542 tracked files against master's 566 and
the merge needed a manual re-integration. Before trusting an incoming partner change:
`git merge-tree --write-tree --name-only <a> <b>`, then `vite build` — the only gate that sees a
`.tsx` parse error.

## Time on the wire

DB holds UTC; `dateStrings: true` yields a zone-less literal JS reads as local, fixed at the response
boundary (`utils/serverTime.js` + `middleware/isoTimestamps.js`). `DATE` stays bare;
`WALL_CLOCK_DATETIME_COLUMNS` is `+08:00`, not `Z`. Never derive "now" from `toISOString()` — use
`getCurrentPHDate()`/`getCurrentPHDateTime()`. One side only = **8-hour skew**.

## Rules that have already cost a bug

- `errorHandler` **no longer masks** MySQL errors: `ER_*` returns **400** with `code` + 200 chars of
  `sqlMessage`, and four schema codes fire an auto `syncSchema(pool)` ALTER on the live DB (once per
  60 s, then 409). A plain `Error` from a service is still a 500 — validate in the **controller** with
  `ApiError(400, …)`.
- `backend/tests/*.test.js` reads `.tsx` **as text**: renaming a pinned component's state variable
  breaks a *backend* test. `\s*` where a call may wrap; `[^;]*`, never `[^)]*`, across nested parens.
- A new column needs a guarded boot migration in a shape `schema-contract.test.js` can parse; a new
  index needs `ensureIndex(...)` **inside** `runMigrations()` — outside it is a boot-time
  ReferenceError. `mapRow` emits only `col in row`.
- A wide JSON/TEXT column turns `ORDER BY` into a 400 (`ER_OUT_OF_SORTMEMORY`, swallowed as "no
  records"). An index is not enough — set `sortInApplication: true` in `constants.js`. Expect two
  sequential fixes, not one.
- `rbac.definition.json` is duplicated byte-for-byte (`backend/src/config/` ↔
  `frontend/src/app/config/`) — edit one, copy over the other.
- Only `houseparent` is scoped (`utils/residentScope.js`), forward-only. Seed creds in
  `backend/src/scripts/seedDatabase.js` (`centerhead`/`centerhead123` works live). No `admin` account;
  never reset a real account to get a token.
- A notification is invisible to its own actor (`actorUsername <> ?`). `isSnapshot()` must require
  `Array.isArray(subject.modules)`, or `/violations` crashes on restored sessions.
