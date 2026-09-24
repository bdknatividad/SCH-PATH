/**
 * Route shadowing — a literal path that can never be reached.
 *
 * Express matches routes in declaration order. So
 *
 *     router.get('/:id', ...)          <- registered first
 *     router.get('/daily-data', ...)   <- unreachable forever
 *
 * is a silent defect: `/:id` wins the match, the handler looks up a record whose
 * id is the literal string, and the caller gets "not found". Nothing errors at
 * boot, no test failed, and the route file still advertises the endpoint — which
 * is exactly how `GET /api/reports/daily-data` spent its life being unreachable
 * while the source said it existed.
 *
 * Measured against the live deployment before the fix: 117 read probes across
 * every route, zero server errors, and this was the only endpoint that could not
 * be called. The sweep that found it had to be told the endpoint list by hand —
 * which is why this test derives the list from the source instead.
 *
 * The rule: for one verb, a literal path may not be declared after a
 * parameterised route of the same segment depth.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const VERBS = ['get', 'post', 'put', 'patch', 'delete'];

/** Every route declared for one verb in one file, in declaration order. */
function routesFor(src, verb) {
  const re = new RegExp(`router\\.${verb}\\(\\s*['"]([^'"]+)['"]`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ path: m[1], index: m.index });
  return out;
}

const depthOf = (p) => p.split('/').filter(Boolean).length;

function shadowedIn(src) {
  const found = [];
  for (const verb of VERBS) {
    const routes = routesFor(src, verb);
    for (let i = 0; i < routes.length; i++) {
      const later = routes[i];
      if (later.path.includes(':')) continue; // only literal paths can be shadowed
      for (let j = 0; j < i; j++) {
        const earlier = routes[j];
        if (!earlier.path.includes(':')) continue;
        // `/:id` matches exactly one segment, so it cannot swallow `/a/b`.
        if (depthOf(earlier.path) !== depthOf(later.path)) continue;
        found.push({ verb: verb.toUpperCase(), shadowed: later.path, by: earlier.path });
        break;
      }
    }
  }
  return found;
}

test('no literal route path is shadowed by an earlier parameterised route', () => {
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10, `expected the route files, found ${files.length}`);

  const problems = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    for (const s of shadowedIn(src)) {
      problems.push(`${file}: ${s.verb} '${s.shadowed}' is unreachable — '${s.by}' is declared earlier`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    'a parameterised route declared before a literal sibling makes the literal one ' +
      `unreachable, because Express matches in declaration order:\n  ${problems.join('\n  ')}`,
  );
});

test('the reports router declares its literal paths before the :id catch-all', () => {
  // The concrete instance. Kept separate from the sweep above so that a future
  // reader can see which endpoint this was about without running the general
  // rule in their head.
  const src = fs.readFileSync(path.join(ROUTES_DIR, 'reportRoutes.js'), 'utf8');
  const daily = src.indexOf("router.get('/daily-data'");
  const byId = src.indexOf("router.get('/:id'");

  assert.ok(daily !== -1, "expected router.get('/daily-data') in reportRoutes.js");
  assert.ok(byId !== -1, "expected router.get('/:id') in reportRoutes.js");
  assert.ok(
    daily < byId,
    "GET /api/reports/daily-data must be declared before GET /api/reports/:id, " +
      'or the catch-all swallows it and the endpoint 404s as "report not found"',
  );
});
