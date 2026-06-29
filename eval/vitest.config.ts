// Dedicated vitest config for the eval/ directory.
// Bridge's vitest config restricts include to src/**, so eval lives behind its own config.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
    root: __dirname,
  },
});
