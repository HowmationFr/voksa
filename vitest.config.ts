import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    globals: false,
    // webstorePatch.test.ts mocks 'electron' INSIDE the library's ESM build:
    // vi.mock only reaches modules Vite processes, not externalized deps.
    server: { deps: { inline: ['electron-chrome-web-store'] } },
  },
});
