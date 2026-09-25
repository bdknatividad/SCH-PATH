/**
 * The notification push channel.
 *
 * ## Why this exists
 *
 * The feed was pull-only. `Notifications.tsx` polled `GET /api/alerts` every 30
 * seconds and again on window focus, so a notification arrived up to half a
 * minute late — and only if the reader came back to the tab. For an approval
 * workflow that delay is the whole feature: a Houseparent submits a TRI, and the
 * Social Worker or Center Head who is supposed to act on it does not know.
 *
 * ## The frame carries no data, on purpose
 *
 * Every frame is a bare "the feed changed". The client answers it by re-running
 * the same scoped `GET /api/alerts` it already used, which applies the real
 * visibility rule (`notificationService.visibilityClause`).
 *
 * That is deliberate. Putting the alert body on the wire would mean a second
 * implementation of "who may see this notification" living here, and the push
 * channel would immediately become a way to leak one. Because the client
 * re-reads through the scoped endpoint, delivering the signal to a *superset* of
 * the intended recipients is harmless — the worst case is a client refreshing
 * and finding nothing new. So role-addressed alerts go to everyone holding that
 * role without re-deriving the caseload filter, and the actor receiving their own
 * signal is a wasted refresh rather than a disclosure.
 *
 * ## Why SSE and not a WebSocket
 *
 * The traffic is one-way, low-volume and infrequent, which is exactly what
 * Server-Sent Events are for. It is plain HTTP through the existing auth
 * middleware, needs no dependency, and needs no separate port or upgrade
 * handshake. The browser's own `EventSource` cannot send an `Authorization`
 * header, so the client consumes the stream with `fetch` + a `ReadableStream`
 * instead — see `streamAlerts` in `frontend/src/services/api.ts`. That keeps the
 * bearer token in a header rather than in a query string, where it would be
 * written to every access log on the way.
 *
 * ## Scope
 *
 * Connections live in the process's memory. That is correct for this deployment
 * (one backend instance) and would need a shared bus the moment it is not.
 */

/** @type {Map<string, Set<{res: import('express').Response, role: string}>>} */
const clientsByUser = new Map();

/** How often a comment frame is sent so an idle connection is not reaped. */
const HEARTBEAT_MS = 25000;

/**
 * Registers an open response as a listener for one user.
 *
 * @param {{ id?: string, role?: string }} user
 * @param {import('express').Response} res
 * @returns {{ userId: string, res: import('express').Response, role: string }}
 */
function subscribe(user, res) {
  const userId = String(user?.id || '');
  const client = { userId, res, role: String(user?.role || '').toLowerCase() };

  if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
  clientsByUser.get(userId).add(client);

  return client;
}

/**
 * Removes a listener. Safe to call twice — a closed socket and an explicit
 * teardown both reach here.
 *
 * @param {{ userId: string, res: import('express').Response }|null} client
 */
function unsubscribe(client) {
  if (!client) return;
  const set = clientsByUser.get(client.userId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) clientsByUser.delete(client.userId);
}

/**
 * Writes one frame to one listener, dropping it if the socket has gone.
 *
 * A write to a socket the client already closed throws `ERR_STREAM_WRITE_AFTER_END`
 * or `EPIPE`; neither should interrupt delivery to the other listeners, so it is
 * caught and the dead client is removed.
 *
 * @param {{ userId: string, res: import('express').Response, role: string }} client
 * @param {string} payload
 * @returns {boolean} false when the listener had already gone.
 */
function writeTo(client, payload) {
  try {
    client.res.write(payload);
    return true;
  } catch {
    unsubscribe(client);
    return false;
  }
}

/**
 * Tells the listeners whose feed may have changed to re-read it.
 *
 * @param {{ targetUserId?: string|null, targetRole?: string|null }} audience
 * @returns {number} how many listeners were actually written to. A listener whose
 *   socket had already gone is dropped and not counted — the number is used to
 *   reason about delivery, so an attempt that failed must not look like one that
 *   succeeded.
 */
function publish({ targetUserId = null, targetRole = null } = {}) {
  const payload = 'event: alerts\ndata: {}\n\n';
  let delivered = 0;

  if (targetUserId) {
    const set = clientsByUser.get(String(targetUserId));
    if (set) {
      for (const client of [...set]) { if (writeTo(client, payload)) delivered += 1; }
    }
    // A row addressed to a specific account is not also delivered by role, which
    // mirrors the visibility rule: `targetUserId` wins over `targetRole`.
    return delivered;
  }

  if (targetRole) {
    const role = String(targetRole).toLowerCase();
    for (const set of [...clientsByUser.values()]) {
      for (const client of [...set]) {
        if (client.role === role && writeTo(client, payload)) delivered += 1;
      }
    }
  }

  return delivered;
}

/** Sends a heartbeat to every listener, dropping the ones that have gone. */
function heartbeat() {
  for (const set of [...clientsByUser.values()]) {
    for (const client of [...set]) writeTo(client, ': keep-alive\n\n');
  }
}

let heartbeatTimer = null;

/** Starts the shared heartbeat. Idempotent. */
function startHeartbeat() {
  if (heartbeatTimer) return heartbeatTimer;
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  // Do not hold the process open for this.
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  return heartbeatTimer;
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** How many listeners are open, and for how many users. For tests and diagnostics. */
function stats() {
  let connections = 0;
  for (const set of clientsByUser.values()) connections += set.size;
  return { users: clientsByUser.size, connections };
}

/** Drops every listener. For tests. */
function reset() {
  clientsByUser.clear();
  stopHeartbeat();
}

module.exports = {
  subscribe,
  unsubscribe,
  publish,
  heartbeat,
  stats,
  reset,
  startHeartbeat,
  stopHeartbeat,
  HEARTBEAT_MS,
};
