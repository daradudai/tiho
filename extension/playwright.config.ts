import { defineConfig } from '@playwright/test';

// Playwright suites:
//   npx playwright test --project=stress   quick runtime smoke on the mock chats (≈1 min)
//   npx playwright test --project=e2e      end-to-end / live smoke specs (tests/e2e)
// The full benchmark is a script: node tests/stress/run-stress.mjs (writes tests/stress/RESULTS.md).
export default defineConfig({
  testDir: 'tests',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'stress', testMatch: 'stress/**/*.spec.ts' },
    { name: 'e2e', testMatch: 'e2e/**/*.spec.ts' },
  ],
});
