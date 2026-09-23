# ── SCH-PATH backend ──────────────────────────────────────────────────────
# Build context is the REPOSITORY ROOT, not backend/.
#
# Why: the backend reads several PDF templates and the organisation logo out of
# the frontend tree at runtime, resolving them relative to its own file location
# (`../../../frontend/...`):
#
#   frontend/public/forms/Anecdotal Report.pdf   → published Anecdotal Reports
#   frontend/public/forms/tri.pdf               → published TRI records
#   frontend/public/forms/incident-report.pdf   → published Incident Reports
#   frontend/src/assets/sch-logo.png            → Health + Quarterly PDF headers
#
# A backend-only build context would omit these and every one of those
# published documents would fail at request time. Copying the whole frontend
# tree is unnecessary though, so only the files that are actually read are
# copied — see the `templates` stage and the COPY lines below.
#
# On Render: set Root Directory to the repository root, and use this file as
# the Dockerfile path.

# ── Stage 1: install production dependencies ─────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# `bcrypt` is a native module and has no prebuilt binary for musl, so it is
# compiled here. build-base + python3 are the toolchain it needs. They stay in
# this stage only, so the runtime image does not carry a compiler.
RUN apk add --no-cache --virtual .build-deps build-base python3 \
    && npm ci --omit=dev \
    && apk del .build-deps

# ── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The backend, with the runtime assets it reaches into the frontend for.
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/package.json
COPY backend/src ./backend/src
# `backend/migrations/` is deliberately not copied: those are one-off .mjs
# scripts run by hand against a specific database, not part of boot. The schema
# is created and upgraded by `runMigrations()` inside server.js on every start.

# Runtime assets the backend reads from the frontend tree. These paths must
# keep the same depth relative to backend/src so the existing
# `../../../frontend/...` resolution keeps working untouched.
#
# `frontend/public/sch-logo.png` is deliberately absent: the logo lives only at
# `frontend/src/assets/sch-logo.png` (the PDF helpers list both paths and fall
# through to whichever exists), and `dist/assets/sch-logo-<hash>.png` is the
# Vite-renamed copy, which cannot be referenced by a fixed name. Both consumers
# are covered by the one file below.
COPY frontend/public/forms ./frontend/public/forms
COPY frontend/src/assets/sch-logo.png ./frontend/src/assets/sch-logo.png

# Run as the non-root user the base image provides.
RUN chown -R node:node /app
USER node

# Documentation only; the host decides the real port via $PORT.
EXPOSE 5000

WORKDIR /app/backend

# A lightweight liveness probe. The API answers /api/health without touching
# the database, so a slow database does not restart a healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
