// ═══════════════════════════════════════════════════════════════════════════════
// The strategy id list, in its own module ON PURPOSE.
//
// ⚠ IT CANNOT LIVE IN `api.ts`. That module imports `../firebase`, which initializes
// the SDK at import time, so anything importing a VALUE from it drags Firebase into
// the module graph — and a pure unit test of the settings mirror then dies on
// `auth/invalid-api-key` before a single assertion runs. Type-only imports are erased
// and are fine; a `const` array is not. Found the hard way.
//
// Mirrors `functions/src/pd/strategy.ts`. Ids are STABLE — they are written into truth
// documents and read back for the life of an instance.
// ═══════════════════════════════════════════════════════════════════════════════

export type PdStrategy =
  | 'tft' | 'grim' | 'random' | 'always_first' | 'always_second' | 'alternate'

/** Every id, in the order settings lists them and the reports group them. */
export const PD_STRATEGIES: readonly PdStrategy[] = [
  'tft', 'grim', 'random', 'always_first', 'always_second', 'alternate',
] as const
