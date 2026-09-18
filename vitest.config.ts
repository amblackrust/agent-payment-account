import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'tests/**/*.test.ts',
    ],
  },
})
