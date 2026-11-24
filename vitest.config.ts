import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@openview/protocol': path.join(rootDir, 'packages/protocol/src/index.ts'),
      '@openview/chart-engine': path.join(rootDir, 'packages/chart-engine/src/index.ts'),
      '@openview/script-runtime': path.join(rootDir, 'packages/script-runtime/src/index.ts'),
      '@openview/datafeed-sdk': path.join(rootDir, 'packages/datafeed-sdk/src/index.ts'),
      '@openview/drawings': path.join(rootDir, 'packages/drawings/src/index.ts'),
      '@openview/replay-engine': path.join(rootDir, 'packages/replay-engine/src/index.ts'),
      '@openview/broker-sdk': path.join(rootDir, 'packages/broker-sdk/src/index.ts'),
      '@openview/chart-types': path.join(rootDir, 'packages/chart-types/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
    ],
    environment: 'node',
    globals: false,
    testTimeout: 15000,
  },
});
