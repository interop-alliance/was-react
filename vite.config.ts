import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The Playwright dev server serves an otherwise-empty test page and imports
  // the library dynamically from the test. Point the dep optimizer at the two
  // entry modules so their (large) dependency graph is pre-bundled at cold
  // start, rather than lazily on the first dynamic import -- lazy discovery
  // re-optimizes mid-request and fails the in-flight module fetch.
  optimizeDeps: {
    entries: ['src/index.ts', 'src/mui/index.ts']
  },
  // A dedicated port (with strictPort so Vite fails loudly instead of
  // silently drifting to another port) keeps the Playwright suite from
  // accidentally talking to some other project's dev server on 5173.
  server: {
    port: 5183,
    strictPort: true
  },
  test: {
    include: ['test/node/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Default to node (crypto/IndexedDB tests); React hook/component tests
    // opt into jsdom per-file via `// @vitest-environment jsdom`.
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
