# SCH-PATH — Project Notes

Long-term notes for `C:\sept23`. Stack: React 18 + Vite 6 + TS + Tailwind 4
(frontend), Express 4 + mysql2 + JWT (backend). MySQL-only.

## Conventions that are easy to break

### Backend tests read frontend source as text
`backend/tests/*.test.js` has no frontend test runner, so it pins frontend
behaviour by regex against `.tsx` source. Consequences:
- Renaming a state variable or parameter in a pinned component breaks a
  **backend** test. The pin is often a literal identifier, not a pattern.
- Relaxing such a test is sometimes correct (it was asserting a calling
  convention rather than behaviour) — but check that first.
- Run `cd backend && node --test "tests/**/*.test.js"` after any frontend edit to
  `App.tsx`, `Layout.tsx`, `PhaseProgress.tsx`, `SignaturePad.tsx`,
  `ChildRecords.tsx`, `Tri.tsx`, `Health.tsx`.

### Verbatim no-backticks rule
Several components build print HTML inside JS **template literals**
(`Reports.tsx`, `PhaseProgress.tsx`, `Tri.tsx`). A backtick inside a CSS comment
in those blocks terminates the string and produces a confusing `TS1005`. Write
comments there without backticks.

### RBAC definition is duplicated byte-for-byte
`backend/src/config/rbac.definition.json` and
`frontend/src/app/config/rbac.definition.json` are asserted equal by a test.
Edit one, then copy it over the other.

### `accessDefaults.js` needs the `rbac.` prefix
`rbac.CHILD_RECORD_TABS_MODULE`, not the bare name — the bare identifier is not
in scope in that file and throws at require time, breaking unrelated tests with
HTTP 500s.

## Frontend build / bundling

- Route-level lazy loading lives in `App.tsx` via
  `@/app/utils/lazyComponent` — it handles the codebase's mix of named and
  default exports. Add new routes that way, not with static imports.
- **Never add `pdfjs-dist` to `manualChunks`.** It emits its own async worker and
  CMaps chunks resolved at runtime by URL; pinning it breaks the worker. See the
  comment in `vite.config.ts`.
- Entry-chunk budget: keep it near **142 kB gzip**. If it grows much beyond that,
  a heavy import has leaked into the shell or `LoginPage`.
- `vite build` does **not** run `tsc`. There are 9 long-standing type errors in
  `AssessmentDetail.tsx`, `Assessments.tsx`, `ChildDetail.tsx`,
  `ChildRecords.tsx`; they do not block the build. Do not "fix" them casually —
  check the change does not alter the pinned text those components' tests read.

## Deployment invariants

- All uploaded files are **base64 inside MySQL `LONGTEXT` columns**. There is no
  filesystem or S3 layer. Database size is therefore the primary free-tier
  constraint, and MySQL is mandatory (the code uses `ON DUPLICATE KEY UPDATE`,
  `INFORMATION_SCHEMA`, `max_allowed_packet`).
- The backend reads PDF templates and the logo from the **frontend tree** at
  runtime (`../../../frontend/public/forms`, `frontend/src/assets/sch-logo.png`).
  The Docker build context must be the **repository root** and the image must
  carry those files. Do not "fix" the context to `backend/`.
- `frontend/vercel.json`'s SPA rewrite excludes a whitelist of root paths. Any
  new file added to `frontend/public/` **must** be added to that exclusion, or it
  is served as `index.html` in production. `pdf.worker.mjs` is the one that
  breaks everything visibly if missed.
- PDF form templates live in `frontend/public/forms/` (18 referenced, 20 on
  disk). If a generated PDF is blank in production, check the Docker context
  before anything else.

## Access model summary

Roles: `centerhead` (fullAccess), `admin`, `nurse`, `psychologist`, `educator`,
`socialworker`, `houseparent`. Effective access = `accessibleModules` +
`subModules` + `permissions` on the user row, resolved through
`buildAccessSnapshot()`.

**Known trap:** `buildAccessSnapshot()` treats an *empty* `accessibleModules`
array as "fall back to the role's full matrix". Code that decides redaction must
read the **role definition** (`getRoleDefinition(role)`), never the stored grant,
or an account seeded with `[]` gains everything. `childController.js` has the
correct pattern in `roleCanReachMedicalTab` / `roleCanReachHealth`.
