import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts, which sets `root: 'ui'` so the dashboard builds as its own
 * page. The suite spans both halves — the collector and parsers under src/, the components
 * under ui/ — so it needs the package root instead.
 *
 * The collector tests are plain assertions against recorded fixtures and want no DOM; the
 * component tests do. The default is node, and a component file opts in with
 * `@vitest-environment happy-dom` in its first docblock.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    root: '.',
    include: ['src/**/*.test.ts', 'ui/**/*.test.ts'],
    environment: 'node',
    // The fixtures are read from disk and one of them is 62 KB of job rows; the default
    // isolation forks a worker per file, which costs more than these tests do.
    pool: 'threads',
  },
});
