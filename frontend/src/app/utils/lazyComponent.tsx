import { lazy, ComponentType } from 'react';

/**
 * Route-level code splitting.
 *
 * Every module used to be a static import in `App.tsx`, which put the whole
 * application in one 2.17 MB chunk — including both PDF engines (`pdf-lib` and
 * `pdfjs-dist`, ~1.5 MB of source between them) and `jszip`, none of which the
 * login screen or the dashboards touch. The login page was downloading a
 * document renderer it could not reach.
 *
 * `lazyComponent` wraps `React.lazy` and accepts either export shape, because
 * this codebase has both: most modules use a named export (`export function
 * Dashboard`), while two use a default. `React.lazy` only understands default
 * exports, so a named one has to be re-mapped — that mapping is the whole
 * reason this helper exists rather than inlining `lazy(() => import(...))`
 * twenty times and getting the shape wrong in one of them.
 *
 * `import.meta.glob` is deliberately *not* used. It would be terser, but it
 * resolves every match eagerly into the module graph and makes the set of
 * chunks depend on a glob string, which is harder to review than an explicit
 * list. The explicit form also keeps each chunk's name stable in the build
 * output, which matters when reading a deployed bundle's network waterfall.
 */
const CHUNK_RELOAD_KEY = 'sch-path:chunk-reload';

/** A failed dynamic import of a build chunk (stale deploy, network blip). */
export function isChunkLoadError(error: unknown): boolean {
  const text = String((error as { message?: string })?.message || error || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .* failed|is not a valid JavaScript MIME type|Expected a JavaScript module/i.test(text);
}

export function lazyComponent<T extends ComponentType<any>>(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    let mod: Record<string, unknown>;
    try {
      mod = await loader();
      // Loaded fine: allow a future stale-chunk reload again.
      sessionStorage.removeItem(CHUNK_RELOAD_KEY);
    } catch (error) {
      // After a new deploy the page's chunk file names change, so a tab that
      // was already open asks for files that no longer exist (the host then
      // serves index.html, "not a JavaScript module"). Reload once to pick up
      // the new build instead of showing the error page. The guard stops a
      // reload loop if the chunk is genuinely broken.
      if (isChunkLoadError(error) && !sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
        window.location.reload();
        return new Promise<never>(() => {});
      }
      throw error;
    }

    // A default export wins when the name asked for is `default`.
    if (exportName === 'default') {
      const fallback = (mod as { default?: unknown }).default;
      if (!fallback) {
        throw new Error('lazyComponent: module has no default export');
      }
      return { default: fallback as T };
    }

    const named = mod[exportName];
    if (named) {
      return { default: named as T };
    }

    // Some bundlers interop a named export onto `default`. Accept that rather
    // than failing at runtime for a shape the bundler chose.
    const viaDefault = (mod as { default?: Record<string, unknown> }).default?.[exportName];
    if (viaDefault) {
      return { default: viaDefault as T };
    }

    throw new Error(
      `lazyComponent: no export "${exportName}" found ` +
        `(saw: ${Object.keys(mod).join(', ') || 'nothing'})`,
    );
  });
}

/**
 * Shown while a route's chunk is in flight.
 *
 * Kept inside the layout's content area rather than as a full-screen splash, so
 * navigating between modules does not blank the header and sidebar — a
 * full-screen flash on every click reads as the app reloading.
 */
export function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-gray-300 border-t-[#2F3E46]" />
        <span className="text-xs font-medium text-gray-500">Loading…</span>
      </div>
    </div>
  );
}
