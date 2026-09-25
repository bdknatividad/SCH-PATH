/**
 * Where the API lives.
 *
 * `VITE_API_URL` is baked in at build time, so Vercel must have it set before
 * the build runs. It is read in production as well as development: the previous
 * version hard-coded `'/api'` for production, which only works when the backend
 * serves the frontend from the same origin. Deployed to Vercel with the API on
 * a separate host, every request would have gone to `<vercel-domain>/api` and
 * 404'd — the app would load and then fail on the first call.
 *
 * The trailing slash is trimmed so `${API_BASE_URL}${path}` cannot produce a
 * double slash when the value is written as `https://host/api/`.
 *
 * Falling back to `/api` is deliberate and keeps the single-service deployment
 * (backend serving `frontend/dist`) working with no configuration at all.
 */
const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

/**
 * The API base URL, for the handful of callers that cannot use `request()`.
 *
 * `request()` builds `${API_BASE_URL}${path}`, so every call that goes through it
 * is correct. But the binary endpoints — document View/Download/Print, the ZIP
 * bulk download, and the PDF generators — use raw `fetch()` because they need a
 * `Blob` or an object URL rather than parsed JSON. Those were written with a
 * literal `'/api/...'`, which resolves against the *page* origin.
 *
 * In the split deployment (frontend on Vercel, API on Render) the page origin is
 * Vercel, so `/api/documents/.../file` never reached the API at all: Vercel's
 * SPA rewrite turned it into `index.html`, `res.ok` was true, and the "file" was
 * a copy of the app's HTML. Every View, Download, Print, bulk-ZIP and generated
 * PDF would have failed — on every device, since the bug is in the page origin
 * rather than in anything device-specific.
 *
 * Exported so those callers build the same URL the rest of the app does.
 */
export { API_BASE_URL };

/**
 * An authenticated `fetch` against the API, with the URL resolved properly.
 *
 * For binary and PDF endpoints. `path` is API-relative and may omit the leading
 * slash, e.g. `documentFileUrl('/documents/abc/file')`.
 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Authorization header for a raw `fetch` against the API. */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = localStorage.getItem('token');
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

/** What a binary endpoint hands back: the bytes, and the name the server chose. */
export interface BinaryPayload {
  blob: Blob;
  fileName: string | null;
}

/** A web page, however it was spelled — `<!DOCTYPE html>` or a bare `<html>`. */
const HTML_HEAD = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** The server's RFC 6266 filename, preferred over anything the client invents. */
function fileNameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (utf8) {
    try { return decodeURIComponent(utf8); } catch { /* malformed encoding */ }
  }
  return /filename="([^"]+)"/i.exec(disposition)?.[1] ?? null;
}

/** True when the body is the app's own HTML rather than the file that was asked for. */
async function looksLikeHtml(blob: Blob): Promise<boolean> {
  if (blob.size === 0) return false;
  try {
    return HTML_HEAD.test(await blob.slice(0, 64).text());
  } catch {
    return false;
  }
}

/**
 * An API path that answers with a file — a stored document, a generated PDF, the
 * bulk ZIP.
 *
 * `request()` parses JSON, so these endpoints fetch the bytes themselves. That
 * raw `fetch` is exactly where the split deployment used to fail, and it failed
 * *silently*: a path that never reached the API was answered by the frontend
 * host's SPA rewrite with `index.html` and **status 200**, so `response.ok` was
 * true and the "file" was a copy of the app's HTML. The caller then handed that
 * HTML to pdf.js, which could not parse it and reported a *render* failure —
 * naming the PDF viewer as the culprit when the real fault was a request that
 * never left the frontend.
 *
 * So the status is checked, and then the shape: a file is never HTML. Both
 * failures now say what actually happened.
 */
export async function fetchBinary(path: string, init: RequestInit = {}): Promise<BinaryPayload> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });

  if (!response.ok) {
    let message = `The server could not provide the file (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch { /* not a JSON error body */ }
    throw new Error(message);
  }

  const blob = await response.blob();
  const type = (blob.type || '').toLowerCase();
  if (type.includes('text/html') || await looksLikeHtml(blob)) {
    throw new Error(
      'The file request did not reach the API — the server answered with a web page instead of the file.'
    );
  }

  return { blob, fileName: fileNameFrom(response.headers.get('Content-Disposition')) };
}

// Hard cap so a stalled connection (backend down, DB hang, dropped proxy) cannot
// leave "Submitting…" spinners stuck forever. The user gets a clear timeout error
// and the action's `finally` block can run.
const REQUEST_TIMEOUT_MS = 25000;

/** Broadcast so AuthContext can clear the session when the token is rejected. */
export const UNAUTHORIZED_EVENT = 'auth:unauthorized';

/**
 * Phrases the browser and `fetch` produce when the request never reached the
 * server. They name nothing a person can act on ("Failed to fetch"), and in a
 * dialog they read as a defect in the app rather than in the connection.
 */
const NETWORK_NOISE = [
  'failed to fetch',
  'fetch failed',
  'networkerror',
  'network error',
  'network request failed',
  'load failed',
  'the internet connection appears to be offline',
  'the operation was aborted',
];

/**
 * A sentence to show a person for a failed request.
 *
 * Messages raised by `request` above are already meant for a reader — they come
 * from the API's own `message` field — so they are passed through. Anything else
 * (a `TypeError` from `fetch`, a browser network string, a thrown non-Error) is
 * replaced by the caller's fallback, so a raw failure can never reach a dialog.
 */
export function describeError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const message = error instanceof Error ? String(error.message || '').trim() : '';
  if (!message) return fallback;

  const lowered = message.toLowerCase();
  if (NETWORK_NOISE.some((noise) => lowered.includes(noise))) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  return message;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // Get token from localStorage
  const token = localStorage.getItem('token');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };

  // Add Authorization header if token exists
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Honour a caller-supplied signal (component unmount / superseded request) in
  // addition to the timeout signal. AbortSignal.any is not available in older
  // browsers or older DOM typings, so feature-detect it.
  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  const signal = options.signal && typeof anySignal === 'function'
    ? anySignal([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(`${API_BASE_URL}${normalizedPath}`, {
      ...options,
      headers,
      signal,
    });
    // A literal `null` body parses successfully, so normalise to an object
    // before reading `.error` / `.message` off it.
    const payload = (await response.json().catch(() => null)) ?? {};

    // An expired/invalid token must end the session, not just fail one request —
    // otherwise the UI stays "logged in" with stale cached data forever.
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      throw new Error(payload.message || 'Your session has expired. Please log in again.');
    }

    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? `: ${payload.error}` : '';
      throw new Error(`${payload.message || 'Request failed'}${detail}`);
    }

    // Several endpoints answer HTTP 200 with `{ success: false }`. Treating that
    // as success handed `undefined` back to callers, which then crashed or
    // pushed `undefined` rows into list state.
    if (payload && typeof payload === 'object' && payload.success === false) {
      const detail = typeof payload.error === 'string' ? `: ${payload.error}` : '';
      throw new Error(`${payload.message || 'Request failed'}${detail}`);
    }

    return payload;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      // A caller-initiated abort is not a timeout.
      if (options.signal?.aborted) throw err;
      throw new Error('Request timed out. Please check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function loginRequest(username: string, password: string) {
  // `user` carries the identity and the server-resolved access matrix; `access`
  // carries the same matrix in snapshot form. Both are optional-shaped because
  // an older server returns only the identity fields.
  const result = await request<{
    success: boolean;
    data: {
      user: {
        id?: string;
        username: string;
        role: string;
        fullName?: string | null;
        accessibleModules: string[];
        childRecordTabs?: string[];
        subModules?: Record<string, string[]>;
        fullAccess?: boolean;
        permissions?: Record<string, string[]>;
        menus?: import('../app/config/rbac').AccessibleMenu[];
      };
      token: string;
      access?: import('../app/config/rbac').AccessSnapshot;
    };
  }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

  return result.data;
}

export async function getStore() {
  const result = await request<{ success: boolean; data: any }>('/store');
  return result.data;
}

export async function createResource<T>(resource: string, data: T) {
  const result = await request<{ success: boolean; data: T }>(`/${resource}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

  return result.data;
}

export async function updateResource<T>(resource: string, id: string, data: Partial<T>) {
  const result = await request<{ success: boolean; data: T }>(`/${resource}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  return result.data;
}

export async function deleteResource(resource: string, id: string) {
  await request<{ success: boolean }>(`/${resource}/${id}`, {
    method: 'DELETE',
  });
}

/** The notification stream's path. */
export const ALERT_STREAM_PATH = '/alerts/stream';

/**
 * Subscribes to the server's notification stream and calls `onSignal` whenever
 * the caller's feed changes. Resolves when the stream ends.
 *
 * ## Why `fetch` and not `EventSource`
 *
 * `EventSource` cannot send an `Authorization` header, so using it would mean
 * putting the bearer token in a query string — written to every access log on the
 * way, and into browser history. Reading the body with a `ReadableStream` keeps
 * the token in the header, where the rest of the app already puts it.
 *
 * ## What a signal means
 *
 * The frame carries no alert. It means "re-read the feed", and the caller is
 * expected to re-run its scoped `GET /api/alerts`. The server deliberately does
 * not decide visibility twice; see `backend/src/services/alertStream.js`.
 *
 * @param onSignal called once per frame from the server, including the initial
 *   `ready` frame, so the caller's first refresh happens on connect.
 * @param signal aborts the subscription; pass the one from the effect's cleanup.
 */
export async function streamAlerts(onSignal: () => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(apiUrl(ALERT_STREAM_PATH), {
    headers: authHeaders({ Accept: 'text/event-stream' }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`The notification stream could not be opened (HTTP ${response.status}).`);
  }

  // The same trap `fetchBinary` guards against: a path that never reaches the API
  // is answered by the frontend host's SPA rewrite with `index.html` and a 200.
  // A page is not an event stream, and without this the reader would simply hang.
  const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    throw new Error('The notification stream did not reach the API — the server answered with something else.');
  }
  if (!response.body) {
    throw new Error('The notification stream returned no body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. A single newline only separates
      // fields within one frame, so matching on `\n` alone would split a frame
      // across two signals.
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        // `: keep-alive` comments are not changes.
        if (/^(?:event|data):/m.test(frame)) onSignal();
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    // Releasing the lock lets the connection be torn down cleanly on abort.
    reader.cancel().catch(() => undefined);
  }
}
