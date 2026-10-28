import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', ...(process.env.AH_MCP_LIVE ? [] : ['tests/live/**'])],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
