/**
 * Small polyfills for browsers that are a version or two behind.
 *
 * The PDF viewer (pdf.js, through react-pdf) calls `URL.parse` and
 * `Promise.withResolvers`, which only exist in recent browsers (Chrome/Edge
 * 126+, Firefox 126+, Safari 18+). On an older browser that throws
 * "URL.parse is not a function" and the page crashes. These fill the gap with
 * the standard behaviour; on an up-to-date browser they do nothing.
 *
 * The PDF worker (`public/pdf.worker.mjs`) runs separately and carries the
 * same two polyfills at its top.
 */
const UrlWithParse = URL as unknown as { parse?: (url: string | URL, base?: string | URL) => URL | null };
if (typeof UrlWithParse.parse !== 'function') {
  UrlWithParse.parse = (url, base) => {
    try {
      return base === undefined ? new URL(url) : new URL(url, base);
    } catch {
      return null;
    }
  };
}

const PromiseWithResolvers = Promise as unknown as { withResolvers?: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } };
if (typeof PromiseWithResolvers.withResolvers !== 'function') {
  PromiseWithResolvers.withResolvers = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

export {};
