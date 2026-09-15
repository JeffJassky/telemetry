import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{js,ts}'],
    exclude: ['docs/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    globalSetup: ['./test/global-setup.ts'],
    // One mongod for the run (test/global-setup.ts); each suite runs in its own
    // fork against its own database (test/helpers.ts startDb names it by pid),
    // so files are free to run in parallel. singleFork used to be required
    // when every file booted its own mongod — that constraint is gone.
    pool: 'forks',
    // Parallel files only pay off with the dbPath on RAM (see global-setup);
    // on the SSD eight concurrent index builds queue on one fsync and the
    // slow suites time out. Opting out of the RAM disk opts out of parallelism.
    fileParallelism: process.env.TELEMETRY_TEST_RAMDISK !== '0',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{js,ts}'],
      exclude: ['src/**/index.{js,ts}', 'src/ui/**'],
    },
  },
});
