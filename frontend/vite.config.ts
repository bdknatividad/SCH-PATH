import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  build: {
    /*
     * Vendor grouping.
     *
     * Route-level `React.lazy` already took the entry chunk from 2.17 MB to
     * ~317 KB, so this is about caching rather than first-paint. Rollup's
     * default hoists shared dependencies into whichever chunk imports them
     * first, which means a routine edit to an app module changes the hash of
     * the chunk carrying React and the router — and every user re-downloads
     * them. Pinning the vendors into their own chunks keeps those files
     * byte-stable across deploys, so a returning user fetches only what
     * actually changed.
     *
     * Two deliberate omissions, both learned from the build output:
     *
     *   · `pdfjs-dist` is NOT listed. It ships its own asynchronous sub-chunks
     *     (the worker, and the CMaps) that Rollup already emits and that the
     *     library loads at runtime by URL. Pinning it into one manual chunk
     *     would collapse those and leave the worker unresolvable.
     *
     *   · `pdf-lib` is grouped with the app code that uses it rather than
     *     hoisted, because only four modules import it; giving it a shared
     *     chunk would make the Dashboard download it as a shared dependency of
     *     a route it does not need.
     */
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          const path = id.replace(/\\/g, '/');

          // Left to Rollup — see the note above.
          if (path.includes('pdfjs-dist')) return undefined;

          // React and its scheduler must stay together: react-dom reaches into
          // scheduler internals, and splitting them produces duplicate copies.
          if (/node_modules\/(react|react-dom|scheduler)\//.test(path)) return 'vendor-react';

          // The router is large and changes rarely; its own cache bucket means
          // app edits never invalidate it.
          if (/node_modules\/(react-router|react-router-dom|@remix-run)\//.test(path)) {
            return 'vendor-router';
          }

          // Dates are used across nearly every module. `date-fns` is not
          // tree-shaken here because the app imports named helpers from the
          // package root, so it belongs in a shared chunk rather than being
          // copied into each route.
          if (path.includes('node_modules/date-fns')) return 'vendor-date';

          // The component primitives and their positioning engine. Shared by
          // most routes, so hoisting them stops each route chunk repeating them.
          if (
            path.includes('node_modules/@radix-ui') ||
            path.includes('node_modules/@floating-ui') ||
            path.includes('node_modules/@popperjs') ||
            path.includes('node_modules/react-remove-scroll') ||
            path.includes('node_modules/aria-hidden')
          ) {
            return 'vendor-ui';
          }

          return undefined;
        },
      },
    },
  },
})
