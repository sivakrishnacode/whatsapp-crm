import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside the react-server condition. The tests
      // cover pure functions that merely live beside server code, so the
      // marker is replaced with an empty module here and nowhere else.
      'server-only': fileURLToPath(
        new URL('./test/server-only-stub.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    clearMocks: true,
  },
});
