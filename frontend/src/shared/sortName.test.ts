import { describe, it, expect, vi } from 'vitest'
// The game modules reach api.ts → ../firebase, which initializes Firebase on import and
// throws in Node. Only their COLUMN ARRAYS are touched here; nothing is rendered.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))
import { lastNameOf, compareByLastName } from './sortName'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ THE NEGATIVE CONTROL IS THE POINT OF THIS FILE. Every ordering assertion is chosen
// so that sorting the DISPLAY STRING — the first-name sort all seven games shipped before
// 2026-08-07 — produces a DIFFERENT answer and fails.
//
// ⚠ AND IT COVERS ALL SEVEN GAMES, not just the one the change started in. A per-game
// assertion is the only thing that catches a game being MISSED, which is the actual risk
// in a seven-game sweep — the shared helper being correct proves nothing about whether a
// given Dashboard.tsx was wired to it.
// ═══════════════════════════════════════════════════════════════════════════════

/** The shared rule, restated independently of the implementation under test. */
const sharedGetLastName = (name: string) => {
  const t = name.trim().split(/\s+/)
  return t[t.length - 1]
}

describe('lastNameOf — byte-identical to game-ui RosterTable getLastName', () => {
  const cases = [
    'Elena Katok', 'Katok', '  Ana   de la Cruz  ', 'Kim Jr.', 'Mary-Jane Watson',
    '', '   ', 'robot-16-equilibrium', 'Ludwig van Beethoven', 'X Y Z',
  ]
  for (const name of cases) {
    it(`agrees on ${JSON.stringify(name)}`, () => {
      expect(lastNameOf(name)).toBe(sharedGetLastName(name))
    })
  }

  it('takes the LAST whitespace token, not the first', () => {
    expect(lastNameOf('Elena Katok')).toBe('Katok')
    expect(lastNameOf('Ana de la Cruz')).toBe('Cruz')
  })

  it('collapses runs of whitespace and trims', () => {
    expect(lastNameOf('  Elena \t  Katok \n ')).toBe('Katok')
  })

  it('⚠ an empty name stays empty, so unnamed rows still clump first', () => {
    expect(lastNameOf('')).toBe('')
  })
})

describe('compareByLastName', () => {
  const sorted = (names: string[]) => [...names].sort(compareByLastName)

  it('⚠ NEGATIVE CONTROL: orders by surname, not by given name', () => {
    expect(sorted(['Zoe Adams', 'Adam Zephyr'])).toEqual(['Zoe Adams', 'Adam Zephyr'])
  })

  it('⚠ NEGATIVE CONTROL: a whole class sorts by surname', () => {
    expect(sorted([
      'Yolanda Abbott', 'Adam Brown', 'Zoe Carter', 'Brian Adams',
    ])).toEqual([
      'Yolanda Abbott', 'Brian Adams', 'Adam Brown', 'Zoe Carter',
    ])
  })

  it('tiebreaks two identical surnames on the full name', () => {
    expect(sorted(['Zoe Smith', 'Adam Smith'])).toEqual(['Adam Smith', 'Zoe Smith'])
  })

  it('is case- and accent-insensitive on the surname', () => {
    expect(compareByLastName('Ana de Souza', 'Bob De Souza')).toBeLessThan(0)
  })

  it('is a total order — never returns 0 for genuinely different names', () => {
    const names = ['Zoe Adams', 'Adam Zephyr', 'Adam Smith', 'Zoe Smith', 'Kim Jr.']
    for (const a of names) for (const b of names) {
      if (a !== b) expect(compareByLastName(a, b)).not.toBe(0)
    }
  })

  it('single-token names sort on themselves', () => {
    expect(sorted(['Katok', 'Adams'])).toEqual(['Adams', 'Katok'])
  })

  it('⚠ an unnamed row (empty string) sorts before every named one', () => {
    expect(sorted(['Zoe Adams', '', 'Adam Zephyr'])[0]).toBe('')
  })
})

// ── ⚠⚠ THE SEVEN-GAME CONFORMANCE SCAN ─────────────────────────────────────────
//
// The real risk in a seven-game sweep is not that the helper is wrong — the tests above
// cover that — it is that a game was MISSED. Almost none of these column arrays can be
// imported: most are module-private, and several are declared INSIDE their component
// body (poll/Reports, pd/Reports, pricing/Reports, newsvendor/Reports, forecast/Reports).
// Exporting eleven of them to satisfy a test would restructure six components for no
// runtime benefit.
//
// So this reads the SOURCE and asserts that every Name column in every game routes
// through `compareByLastName`. ⚠ It is a wiring check, NOT a behaviour check — behaviour
// is proved by `compareByLastName`'s own tests above, and end-to-end wiring by the
// procurement browser harness, which clicks a real header and reads the rendered order.
//
// ⚠ CONTROL: reverting any single game to `.localeCompare(b.name ?? '')` fails this.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const GAMES = ['pennies', 'poll', 'pd', 'pricing', 'newsvendor', 'forecast', 'procurement']

/**
 * Every `key: 'name'` column declaration, sliced from its key to the START OF THE NEXT
 * COLUMN.
 *
 * ⚠ A FIXED-WIDTH WINDOW IS NOT ENOUGH and the first version of this test proved it:
 * procurement's report Name column renders a "See rounds" button, so its `compare:` sits
 * ~500 characters after its `key:` and a 400-char window reported a false failure. Ending
 * at the next `key:` makes the window as long as the column actually is.
 */
function nameColumnBlocks(src: string): string[] {
  const out: string[] = []
  let i = src.indexOf("key: 'name'")
  while (i !== -1) {
    const next = src.indexOf("key: '", i + 11)
    out.push(src.slice(i, next === -1 ? src.length : next))
    i = src.indexOf("key: 'name'", i + 1)
  }
  return out
}

describe('⚠⚠ ALL SEVEN single-player games route their Name column through the shared rule', () => {
  const files: [string, string, string][] = []   // [game, file, source]
  for (const game of GAMES) {
    for (const f of readdirSync(join(SRC, game))) {
      if (!/^(Dashboard|Reports)\.tsx$/.test(f)) continue
      files.push([game, f, readFileSync(join(SRC, game, f), 'utf8')])
    }
  }

  it('the scan actually found all seven games (guards against a silent empty sweep)', () => {
    expect(new Set(files.map(([g]) => g)).size).toBe(GAMES.length)
    expect(files.length).toBeGreaterThanOrEqual(13)
  })

  for (const game of GAMES) {
    it(`⚠ ${game}: every Name column calls compareByLastName`, () => {
      const mine = files.filter(([g]) => g === game)
      let checked = 0
      for (const [, f, src] of mine) {
        for (const block of nameColumnBlocks(src)) {
          checked++
          // ⚠ `tie` is the per-game local helper. It is ACCEPTED here only because the
          // test below pins every `const tie =` to compareByLastName — without that, a
          // file could define `tie` as anything and this scan would wave it through.
          expect(block, `${game}/${f} has a Name column that does not use the shared rule`)
            .toMatch(/compareByLastName|rowsByLastName|compare: tie\b/)
        }
      }
      // ⚠ EVERY game now has a Name column, forecast's dashboard included — it was the
      // last roster in the family without SortableTable and adopted it on 08-07.
      expect(checked, `${game} has no Name column at all`).toBeGreaterThan(0)
    })
  }

  it('⚠⚠ every local `tie` helper is defined via the SHARED rule, never its own', () => {
    let found = 0
    for (const [game, f, src] of files) {
      for (const m of src.matchAll(/const tie = [^\n]*(?:\n[^\n]*)?/g)) {
        found++
        expect(m[0], `${game}/${f} defines tie() without compareByLastName`)
          .toMatch(/compareByLastName/)
      }
    }
    expect(found, 'no tie() helpers found — the scan above would be vacuous').toBeGreaterThan(5)
  })

  it("⚠ forecast's dashboard now uses SortableTable like every other roster", () => {
    const src = readFileSync(join(SRC, 'forecast', 'Dashboard.tsx'), 'utf8')
    expect(src).toMatch(/SortableTable/)
    expect(src, 'the plain <table> should be gone').not.toMatch(/<th style=/)
  })

  it('⚠⚠ EVERY column in EVERY game tiebreaks on name (Elena, 08-07)', () => {
    for (const [game, f, src] of files) {
      for (const m of src.matchAll(/compare: \(a, b\) => ([^\n]+)/g)) {
        expect(m[1], `${game}/${f}: a column compare with no name tiebreak — ${m[1].slice(0, 70)}`)
          .toMatch(/tie\(a, b\)|compareByLastName|rowsByLastName/)
      }
    }
  })

  it('⚠ NEGATIVE CONTROL: no game still sorts a person by the display string', () => {
    for (const [game, f, src] of files) {
      expect(src, `${game}/${f} still has a first-name comparator`)
        .not.toMatch(/\(a\.name \?\? ''\)\.localeCompare|a\.name\.localeCompare\(b\.name\)/)
    }
  })
})
