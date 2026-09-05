import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
  },
})
