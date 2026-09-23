const API_BASE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL ?? '/api')
  : '/api';

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
