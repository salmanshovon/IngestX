import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The SPA talks to Django on the SAME ORIGIN in development.
 *
 * This is not a convenience -- it is required. The backend sets
 * `SESSION_COOKIE_SAMESITE = "Lax"` (core/settings.py). `localhost:5173` and
 * `127.0.0.1:8000` are *different sites* to a browser, so a direct cross-site
 * XHR would have its session cookie dropped and every authenticated call would
 * 401. Proxying keeps the browser on one origin, which is also how production
 * serves the SPA, so dev and prod behave identically.
 *
 * Set `VITE_API_BASE_URL` to point at an absolute backend origin when the SPA is
 * genuinely served from a different host (then CORS must allow it).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:8000'

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // Mirrors the `paths` mapping in tsconfig.app.json. TypeScript and Vite
      // resolve modules independently; without this the dev server 504s on
      // every `@/…` import while the typecheck passes.
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: true,
      allowedHosts: true,
      port: Number(env.VITE_PORT || 5173),
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: false },
        '/healthz': { target, changeOrigin: false },
        '/readyz': { target, changeOrigin: false },
      },
    },
    preview: { host: true, allowedHosts: true, port: Number(env.VITE_PORT || 5173), strictPort: true },
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (id.includes('react-router') || id.includes('/react-dom/') || id.endsWith('/react/index.js')) {
              return 'react'
            }
            if (id.includes('@tanstack')) return 'query'
            if (id.includes('@radix-ui') || id.includes('lucide-react')) return 'ui'
            return undefined
          },
        },
      },
    },
  }
})