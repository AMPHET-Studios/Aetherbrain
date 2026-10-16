import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Tests are judged in UTC, wherever they run: a date made from a timestamp (an imported chat's title, a due date) is the
// machine's local day otherwise, and the same test passed in CI (UTC) and failed on a laptop (a chat made late in the evening
// in the Americas is the next day in UTC). Set here so every worker inherits it.
process.env['TZ'] = 'UTC'

export default defineConfig({
  resolve: {
    alias: {
      '@aether/core': r('./packages/core/src/index.ts'),
      '@aether/graph': r('./packages/graph/src/index.ts'),
      '@aether/ui': r('./packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    // A test that imports the whole UI package cold (React, three, the store) takes seconds on a busy or slow machine, and the
    // default 5 s timed out in a full run now and then: a gate must not go red for that. A test that really hangs still fails.
    testTimeout: 20_000,
  },
})
