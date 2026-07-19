import { defineConfig, configDefaults } from 'vitest/config'

// Default `npm test` (vitest run) is emulator-free: pure unit tests only.
// Emulator-backed rules tests (*.emulator.test.ts) run via `npm run test:rules`,
// which boots the Firestore emulator first.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.emulator.test.ts', 'lib/**'],
  },
})
