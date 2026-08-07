import { describe, it, expect, vi } from 'vitest'
// Dashboard/Reports reach api.ts → ../firebase, which initializes Firebase on import and
// throws in Node. Only their COLUMN ARRAYS are touched here; nothing is rendered.
vi.mock('../firebase', () => ({ auth: {}, db: {}, functions: {} }))
import { lastNameOf, compareByLastName, rowsByLastName } from './sortName'
import { buildColumns } from './Dashboard'
import { rosterColumns } from './Reports'

// ⚠⚠ THE NEGATIVE CONTROL IS THE POINT OF THIS FILE. Every ordering assertion below is
// chosen so that sorting the DISPLAY STRING — the first-name sort that shipped before
// 2026-08-07 — produces a DIFFERENT answer and fails. Verified by mutation: replacing
// `compareByLastName` with `(a, b) => a.localeCompare(b)` fails 5 of these.

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
})

describe('compareByLastName', () => {
  const sorted = (names: string[]) => [...names].sort(compareByLastName)

  it('⚠ NEGATIVE CONTROL: orders by surname, not by given name', () => {
    // First-name sort gives Adam, Zoe. Last-name sort gives Zoe Adams, Adam Zephyr.
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
    expect(lastNameOf('Ana de Souza').localeCompare(
      lastNameOf('Bob De Souza'), undefined, { sensitivity: 'base' })).toBe(0)
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
})

describe('rowsByLastName', () => {
  const row = (name: string | null, participantId = 'p1') => ({ name, participantId })

  it('falls back to the participant id when the name is null', () => {
    expect(rowsByLastName(row(null, 'aaa'), row(null, 'bbb'))).toBeLessThan(0)
  })

  it('an unnamed row still orders against a named one, not collapsing to ""', () => {
    expect(rowsByLastName(row('Zoe Adams'), row(null, 'zzz'))).toBeLessThan(0)
  })
})

// ── the columns actually wired to it ───────────────────────────────────────────

const mk = (over: Partial<Record<string, unknown>> = {}) => ({
  participantId: 'p', name: 'A B', roundsPlayed: 0, roundsWon: 0, profitTotal: 0,
  finished: false, normalizedScore: null, knowledgeCheckScore: null, rounds: [],
  ...over,
}) as never

describe('both instructor rosters sort people by last name', () => {
  const dashName = buildColumns(8).find(c => c.key === 'name')!
  const repName = rosterColumns(() => {}).find(c => c.key === 'name')!

  it('⚠ NEGATIVE CONTROL: the dashboard Name column is a surname sort', () => {
    const a = mk({ name: 'Zoe Adams' })
    const b = mk({ name: 'Adam Zephyr' })
    expect(dashName.compare(a, b)).toBeLessThan(0)
  })

  it('⚠ NEGATIVE CONTROL: the class report Name column is a surname sort', () => {
    const a = mk({ name: 'Zoe Adams' })
    const b = mk({ name: 'Adam Zephyr' })
    expect(repName.compare(a, b)).toBeLessThan(0)
  })

  it('the two surfaces use the SAME comparator, so they cannot disagree', () => {
    const pairs: [string, string][] = [
      ['Zoe Adams', 'Adam Zephyr'], ['Adam Smith', 'Zoe Smith'], ['Kim Jr.', 'Ana de la Cruz'],
    ]
    for (const [x, y] of pairs) {
      const a = mk({ name: x }), b = mk({ name: y })
      expect(Math.sign(dashName.compare(a, b))).toBe(Math.sign(repName.compare(a, b)))
    }
  })

  it('every other dashboard column tiebreaks on last name rather than arrival order', () => {
    for (const col of buildColumns(8)) {
      if (col.key === 'name') continue
      // Two rows equal on the column's own quantity, differing only by name.
      const a = mk({ name: 'Zoe Adams' })
      const b = mk({ name: 'Adam Zephyr' })
      expect(col.compare(a, b)).toBeLessThan(0)
    }
  })

  it('every other report column tiebreaks on last name too', () => {
    for (const col of rosterColumns(() => {})) {
      if (col.key === 'name') continue
      const a = mk({ name: 'Zoe Adams' })
      const b = mk({ name: 'Adam Zephyr' })
      expect(col.compare(a, b)).toBeLessThan(0)
    }
  })
})
