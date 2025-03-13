import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests in each file serially
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    // Only run one test file at a time
    fileParallelism: false,
    // Ensure the test worker doesn't run multiple tests in parallel
    maxWorkers: 1,
    minWorkers: 1,
    // Also limit concurrency within each file
    maxConcurrency: 1,
  },
});