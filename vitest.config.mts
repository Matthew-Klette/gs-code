import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Shared CI runners (Windows especially) can stall disk I/O for seconds; keep the local default tight.
    testTimeout: process.env.CI ? 20_000 : 5_000,
    coverage: {
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/auth/loopback.ts'],
      reporter: ['text', 'html'],
    },
  },
});
