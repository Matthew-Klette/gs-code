import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/auth/loopback.ts'],
      reporter: ['text', 'html'],
    },
  },
});
