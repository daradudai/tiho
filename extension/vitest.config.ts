import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Unit tests: `*.test.ts(x)` anywhere under tests/ (Playwright specs are
// `*.spec.ts` and run via playwright.config.ts).
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/stress/**', 'tests/e2e/**'],
    testTimeout: 20_000,
  },
});
