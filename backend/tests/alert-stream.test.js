/**
 * The notification push channel.
 *
 * The feed used to be pull-only: `Notifications.tsx` polled `GET /api/alerts`
 * every 30 seconds, so a Houseparent's TRI submission reached the reviewer up to
 * half a minute later — and only if the reviewer came back to the tab. For an
 * approval workflow that delay *is* the bug: the person who is supposed to act
 * does not know there is anything to act on.
 *
 * The fix is a Server-Sent Events channel. What these tests pin is the part that
 * can be broken without failing to compile or to serve:
 *
 *   - who a signal is delivered to (a role fan-out must not become a leak, and a
 *     single-account signal must not be duplicated by role);
 *   - that a signal is only ever sent for a row that was actually written, so a
 *     suppressed duplicate does not look like news;
 *   - that the frame carries no alert data, because the scoped `GET /api/alerts`
 *     is the single implementation of the visibility rule;
 *   - that the route is reachable at all (a literal path below `/:id` is not);
 *   - and that the client refuses a non-stream body, which is how the frontend
 *     host's SPA rewrite answers a path that never reaches the API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const alertStream = require('../src/services/alertStream');
const alertController = require('../src/controllers/alertController');
const notifications = require('../src/services/notificationService');

const SRC = path.resolve(__dirname, '../src');
const FRONTEND = path.resolve(__dirname, '../../frontend/src');
const read = (file) => fs.readFileSync(file, 'utf8');

// ── Doubles ─────────────────────────────────────────────────────────────────

/** An Express response that records what was written to it. */
function fakeRes() {
  return {
    headers: {},
    chunks: [],
    flushed: false,
    socket: { noDelay: false, setNoDelay() { this.noDelay = true; } },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() { this.flushed = true; },
    write(chunk) { this.chunks.push(chunk); return true; },
  };
}

/** A request whose `close`/`error` events the test can fire. */
function fakeReq(user) {
  const handlers = new Map();
  return {
    user,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return this;
    },
    emit(event) { for (const handler of handlers.get(event) || []) handler(); },
  };
}

/**
 * A pool stub for `notify()`.
 *
 * `insertWithGeneratedId` first runs `SELECT id FROM <table>` to compute the next
 * id, then the INSERT. Both are answered here; `insertError` makes the INSERT
 * fail, which is how the duplicate-suppression branch is reached.
 */
function stubExecutor({ insertError = null } = {}) {
  const inserts = [];
  return {
    inserts,
    async query(sql, params) {
      if (/^\s*SELECT id FROM/i.test(sql)) return [[], []];
      if (/^\s*INSERT INTO/i.test(sql)) {
        if (insertError) throw insertError;
        inserts.push(params);
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
  };
}

const dupEntry = () => Object.assign(new Error("Duplicate entry 'x' for key 'dedupeKey'"), { code: 'ER_DUP_ENTRY' });

test.afterEach(() => alertStream.reset());

// ── Who a signal reaches ────────────────────────────────────────────────────

test('a role-addressed signal reaches every listener holding that role, and nobody else', () => {
  const first = fakeRes();
  const second = fakeRes();
  const bystander = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, first);
  alertStream.subscribe({ id: 'U2', role: 'SocialWorker' }, second);
  alertStream.subscribe({ id: 'U3', role: 'houseparent' }, bystander);

  const delivered = alertStream.publish({ targetRole: 'socialworker' });

  assert.equal(delivered, 2);
  assert.equal(first.chunks.length, 1);
  assert.equal(second.chunks.length, 1, 'role matching must not depend on the stored casing');
  assert.equal(bystander.chunks.length, 0, 'a signal must not reach a role it was not addressed to');
});

test('a signal addressed to one account is not also fanned out by role', () => {
  // `targetUserId` wins over `targetRole`, mirroring the visibility rule. If both
  // applied, every notification addressed to a person would also wake everyone
  // holding that person's role — a wasted refresh on every alert, and a hint
  // about traffic that role has no business seeing.
  const addressee = fakeRes();
  const colleague = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, addressee);
  alertStream.subscribe({ id: 'U2', role: 'socialworker' }, colleague);

  const delivered = alertStream.publish({ targetUserId: 'U1', targetRole: 'socialworker' });

  assert.equal(delivered, 1);
  assert.equal(addressee.chunks.length, 1);
  assert.equal(colleague.chunks.length, 0);
});

test('one account open in two tabs is signalled on both', () => {
  const laptop = fakeRes();
  const phone = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'centerhead' }, laptop);
  alertStream.subscribe({ id: 'U1', role: 'centerhead' }, phone);

  assert.equal(alertStream.publish({ targetUserId: 'U1' }), 2);
  assert.equal(laptop.chunks.length, 1);
  assert.equal(phone.chunks.length, 1);
});

test('a listener whose socket has gone is dropped without silencing the others', () => {
  // A write to a closed socket throws `ERR_STREAM_WRITE_AFTER_END` or `EPIPE`.
  // Letting that propagate would abort the loop and leave every listener after
  // the dead one unsignalled — so the failure has to be caught per listener.
  const dead = { write() { throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' }); } };
  const alive = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, dead);
  alertStream.subscribe({ id: 'U2', role: 'socialworker' }, alive);

  const delivered = alertStream.publish({ targetRole: 'socialworker' });

  assert.equal(delivered, 1, 'the live listener must still be signalled');
  assert.equal(alive.chunks.length, 1);
  assert.deepEqual(alertStream.stats(), { users: 1, connections: 1 }, 'the dead listener must be removed');
});

test('a signal addressed to nobody reaches nobody', () => {
  const listener = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, listener);

  assert.equal(alertStream.publish({}), 0);
  assert.equal(alertStream.publish(), 0);
  assert.equal(listener.chunks.length, 0);
});

test('the frame is a bare signal, not the alert body', () => {
  // The whole design rests on this. A frame that carried the alert would be a
  // second implementation of "who may see this notification" living in the push
  // channel — and therefore a way to leak one. The client answers the signal by
  // re-reading the scoped endpoint.
  const listener = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, listener);

  alertStream.publish({ targetRole: 'socialworker' });

  assert.equal(listener.chunks[0], 'event: alerts\ndata: {}\n\n');
});

test('the heartbeat is a comment frame, so it is never mistaken for a change', () => {
  const listener = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, listener);

  alertStream.heartbeat();

  assert.equal(listener.chunks.length, 1);
  assert.match(listener.chunks[0], /^:/, 'a heartbeat must be an SSE comment');
  assert.doesNotMatch(listener.chunks[0], /^(?:event|data):/m,
    'a heartbeat must not look like a change — the client refreshes on any event/data frame');
});

test('unsubscribing twice is safe, and the last one out clears the user', () => {
  const first = fakeRes();
  const second = fakeRes();
  const clientA = alertStream.subscribe({ id: 'U1', role: 'nurse' }, first);
  const clientB = alertStream.subscribe({ id: 'U1', role: 'nurse' }, second);

  alertStream.unsubscribe(clientA);
  alertStream.unsubscribe(clientA); // a closed socket and an explicit teardown both land here
  assert.deepEqual(alertStream.stats(), { users: 1, connections: 1 });

  alertStream.unsubscribe(clientB);
  assert.deepEqual(alertStream.stats(), { users: 0, connections: 0 });
});

// ── A signal is only sent for a row that was written ────────────────────────

test('a notification that was actually written wakes the addressee', async () => {
  const listener = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, listener);

  const id = await notifications.notify(
    { type: 'Anecdotal Report', title: 'needs review', message: 'x', targetUserId: 'U1', dedupeKey: 'k' },
    stubExecutor()
  );

  assert.ok(id, 'the row must have been written');
  assert.equal(listener.chunks.length, 1, 'the writer must signal the stream');
});

test('a suppressed duplicate is not news, so it must not signal', async () => {
  // `notify()` swallows an `ER_DUP_ENTRY` on the dedupe key and returns null.
  // Signalling anyway would make every page reopen — which re-fires the same
  // business event — look like an incoming notification.
  const listener = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, listener);

  const id = await notifications.notify(
    { type: 'Anecdotal Report', title: 'needs review', message: 'x', targetUserId: 'U1', dedupeKey: 'k' },
    stubExecutor({ insertError: dupEntry() })
  );

  assert.equal(id, null, 'a duplicate must be suppressed');
  assert.equal(listener.chunks.length, 0, 'a suppressed duplicate must not signal');
});

test('a failed write must not signal either', async () => {
  const listener = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, listener);

  await assert.rejects(
    notifications.notify(
      { type: 'Anecdotal Report', title: 'needs review', message: 'x', targetUserId: 'U1', dedupeKey: 'k' },
      stubExecutor({ insertError: Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }) })
    )
  );

  assert.equal(listener.chunks.length, 0);
});

test('notifyUsers signals each recipient, and a role-addressed row signals by role', async () => {
  const byUser = fakeRes();
  const byRole = fakeRes();
  alertStream.subscribe({ id: 'U1', role: 'socialworker' }, byUser);
  alertStream.subscribe({ id: 'U2', role: 'centerhead' }, byRole);

  await notifications.notifyUsers(
    ['U1'],
    { type: 'Anecdotal Report', title: 'needs review', message: 'x', dedupeKey: 'k' },
    stubExecutor()
  );
  await notifications.notify(
    { type: 'TRI', title: 'needs review', message: 'x', targetRole: 'centerhead', dedupeKey: 'k2' },
    stubExecutor()
  );

  assert.equal(byUser.chunks.length, 1);
  assert.equal(byRole.chunks.length, 1, 'a role-addressed row must still reach the role');
});

test('the writer signals after the insert, never before', () => {
  // Ordering is the whole guarantee: signalling before the row exists means the
  // client re-reads the feed and finds nothing, and the notification is then
  // never seen until the next poll — the delay this channel exists to remove.
  const source = read(path.join(SRC, 'services/notificationService.js'));
  const body = source.slice(source.indexOf('async function notify('), source.indexOf('async function notifyUsers('));

  const insert = body.indexOf('insertWithGeneratedId(');
  const publish = body.indexOf('alertStream.publish(');
  const ret = body.indexOf('return id;');

  assert.ok(insert > 0, 'notify() must allocate an id and insert');
  assert.ok(publish > insert, 'the signal must come after the insert');
  assert.ok(ret > publish, 'and before the id is returned, so a caller awaiting notify() can rely on it');
});

// ── The endpoint ────────────────────────────────────────────────────────────

test('the stream response is an event stream that cannot be buffered or cached', () => {
  const res = fakeRes();
  const req = fakeReq({ id: 'U9', role: 'centerhead' });

  alertController.stream(req, res);

  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.match(res.headers['Cache-Control'], /no-cache/, 'a cached stream is a stale feed');
  assert.match(res.headers['Cache-Control'], /no-transform/, 'a transforming proxy would buffer the frames');
  assert.equal(res.headers['X-Accel-Buffering'], 'no',
    'without this a reverse proxy holds every frame until the connection closes');
  assert.equal(res.headers['Connection'], 'keep-alive');
  assert.equal(res.flushed, true, 'the headers must be flushed, or the client sees no response at all');
  assert.equal(res.socket.noDelay, true, 'Nagle would delay small frames');
  assert.deepEqual(alertStream.stats(), { users: 1, connections: 1 });
});

test('the stream opens with a ready frame, so the client knows it is connected', () => {
  const res = fakeRes();
  alertController.stream(fakeReq({ id: 'U9', role: 'centerhead' }), res);

  assert.equal(res.chunks[0], 'event: ready\ndata: {}\n\n');
});

test('closing the connection releases the listener and stops the heartbeat', () => {
  const res = fakeRes();
  const req = fakeReq({ id: 'U9', role: 'centerhead' });
  alertController.stream(req, res);
  assert.deepEqual(alertStream.stats(), { users: 1, connections: 1 });

  req.emit('close');

  assert.deepEqual(alertStream.stats(), { users: 0, connections: 0 });
  // Nothing left to keep alive: the timer must not survive the last connection.
  assert.doesNotThrow(() => alertStream.stopHeartbeat());
});

test('an error on the request also releases the listener', () => {
  const res = fakeRes();
  const req = fakeReq({ id: 'U9', role: 'centerhead' });
  alertController.stream(req, res);

  req.emit('error');

  assert.deepEqual(alertStream.stats(), { users: 0, connections: 0 });
});

test('GET /api/alerts/stream is declared above the /:id catch-all', () => {
  // Express matches in declaration order, so below `/:id` this path is read as
  // the id "stream" and answers 404 — the route file would still advertise it.
  const source = read(path.join(SRC, 'routes/alertRoutes.js'));
  const stream = source.indexOf("router.get('/stream'");
  const byId = source.indexOf("router.get('/:id'");

  assert.ok(stream > 0, "the stream route is missing");
  assert.ok(byId > 0, 'the /:id route is missing');
  assert.ok(stream < byId, 'a literal path below a /:param sibling is unreachable');
});

test('the stream handler is not wrapped in asyncHandler', () => {
  // The handler owns the response for the life of the connection. `asyncHandler`
  // awaits a promise that settles only when the client disconnects, and routes
  // any throw to the error middleware — which would try to write a JSON body onto
  // a response already committed as text/event-stream.
  const source = read(path.join(SRC, 'routes/alertRoutes.js'));

  assert.doesNotMatch(source, /asyncHandler\(alertController\.stream\)/,
    'the stream handler must be registered directly');
  assert.match(source, /router\.get\('\/stream', alertStreamHandler\)/);
});

// ── The client ──────────────────────────────────────────────────────────────

test('the client keeps the bearer token in a header, not in the query string', () => {
  // `EventSource` cannot set an Authorization header, which is exactly why the
  // client reads the body with `fetch` instead. Falling back to `EventSource`
  // would put the token in the URL — into every access log and the browser's
  // history.
  const source = read(path.join(FRONTEND, 'services/api.ts'));
  const body = source.slice(source.indexOf('export async function streamAlerts'));

  assert.match(body, /fetch\(apiUrl\(ALERT_STREAM_PATH\)/, 'the stream must go through the shared base URL');
  assert.match(body, /authHeaders\(/, 'and carry the app\'s auth headers');
  assert.doesNotMatch(body, /new EventSource\(/, 'EventSource cannot send the Authorization header');
});

test('the client refuses a body that is not an event stream', () => {
  // The same trap `fetchBinary` guards against: a path that never reaches the API
  // is answered by the frontend host's SPA rewrite with `index.html` and a 200.
  // A page is not a stream, and without this check the reader simply hangs.
  const source = read(path.join(FRONTEND, 'services/api.ts'));
  const body = source.slice(source.indexOf('export async function streamAlerts'));

  assert.match(body, /if \(!response\.ok\)/, 'a non-2xx must be rejected');
  // Pin the *guard*, not the string: `text/event-stream` also appears in the
  // `Accept` header above, so a loose match would still pass with the check gone.
  assert.match(body, /if \(!contentType[\s\S]{0,60}text\/event-stream/, 'the Content-Type must be checked');
  assert.match(body, /throw new Error\(/, 'and a wrong body must throw rather than hang');
});

test('the client splits frames on a blank line, not on a single newline', () => {
  // A single newline separates the fields *within* one frame, so splitting on it
  // would fire a signal mid-frame and lose the rest.
  const source = read(path.join(FRONTEND, 'services/api.ts'));
  const body = source.slice(source.indexOf('export async function streamAlerts'));

  assert.match(body, /\/\\r\?\\n\\r\?\\n\//, 'frames are separated by a blank line');
  assert.match(body, /reader\.cancel\(\)/, 'the reader must be released when the effect tears down');
});

test('the panel consumes the stream and keeps the poll as a fallback', () => {
  // The stream is what makes a notification immediate. The poll stays because it
  // is the only thing that still works if a proxy buffers or blocks the stream,
  // and a bell that silently stops updating is worse than a slow one.
  const source = read(path.join(FRONTEND, 'app/components/Notifications.tsx'));

  assert.match(source, /streamAlerts\(/, 'the panel must subscribe to the stream');
  assert.match(source, /setInterval\([\s\S]{0,120}30000\)/, 'the poll must remain as a fallback');
  assert.match(source, /controller\.abort\(\)/, 'the subscription must be torn down with the component');
  assert.match(source, /Math\.min\(1000 \* 2 \*\* \(attempt - 1\), 30000\)/,
    'a dropped stream must reconnect with capped backoff, not stay dead');
});
