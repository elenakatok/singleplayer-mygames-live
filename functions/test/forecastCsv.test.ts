import { describe, it, expect } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import { buildHistoryCsv, buildFullCsv, historyCsvFilename } from '../src/forecast/csv'
import { PUBLISHED_HISTORY } from '../src/forecast/history'
import { DEFAULT_MODEL, drawDemand } from '../src/forecast/demand'
import type { StoredRound } from '../src/forecast/rounds'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the two CSV exports (spec §4, §5) and their DIFFERENT freezing rules,
// plus the explicit no-leak assertions spec §12 requires of both files:
//
//   "The in-play file is asserted to stop at month 60; the final-screen file is
//    asserted to contain revealed periods only and never a future month."
//
// ⚠ AND THE AMENDED CONTRACT (spec §4, 08-02): NO pre-coded high-season indicator, in
// EITHER file. That is asserted as an ABSENCE below, not merely left untested — the
// column is the obvious thing for a future change to add back "helpfully", and the
// whole point is that noticing and coding the season are the student's job.
//
// These run at the pure-function level; the harness repeats them end-to-end against
// the real callable, because a file that is correct here and assembled wrongly there
// would still ship the leak.
// ═══════════════════════════════════════════════════════════════════════════════

/** Parse a CSV back into rows of cells. */
function parse(csv: string): string[][] {
  return csv.trimEnd().split('\r\n').map(line => {
    const out: string[] = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
        else if (ch === '"') inQ = false
        else cur += ch
      } else if (ch === '"') inQ = true
      else if (ch === ',') { out.push(cur); cur = '' }
      else cur += ch
    }
    out.push(cur)
    return out
  })
}

const round = (r: number, period: number, forecast: number, actual: number): StoredRound =>
  ({ round: r, period, forecast, actual, played_at: Timestamp.fromMillis(0) })

/** Twelve played months for a student, with real drawn demand. */
const PLAYED: StoredRound[] = Array.from({ length: 12 }, (_, i) =>
  round(i + 1, 61 + i, 800 + i * 10, drawDemand(DEFAULT_MODEL, 'csv-seed', 'stu-csv', 61 + i)))

describe('the IN-PLAY export — frozen at the history (spec §4)', () => {
  const csv = buildHistoryCsv(PUBLISHED_HISTORY)
  const rows = parse(csv)

  it('has exactly spec §4\'s amended columns: Time, Year, Month, Demand', () => {
    expect(rows[0]).toEqual(['Time', 'Year', 'Month', 'Demand'])
  })

  it('⚠ carries NO pre-coded high-season indicator (spec §4, amended 08-02)', () => {
    // Slide 11 presents adding the indicator as something the ANALYST does. Shipping
    // it would hand over both the noticing step and the coding step.
    expect(rows[0]).not.toContain('HighSeason')
    expect(csv).not.toMatch(/highseason|indicator|holiday|dummy/i)
    // Stronger: no column anywhere is a 0/1 flag. Every cell is a Time, a Year, a
    // month NAME or a demand — and demand is never 0 or 1 in this history.
    for (const r of rows.slice(1)) {
      expect(r).toHaveLength(4)
      expect(['0', '1']).not.toContain(r[3])
    }
  })

  it('supplies Month as a NAME, so the student can code the indicator themselves', () => {
    expect(rows[1][2]).toBe('Jan')
    expect(rows[11][2]).toBe('Nov')
    expect(rows[12][2]).toBe('Dec')
  })

  it('supplies Year, so a student can pivot by year', () => {
    expect(rows[1][1]).toBe('1')
    expect(rows[12][1]).toBe('1')
    expect(rows[13][1]).toBe('2')
    expect(rows[60][1]).toBe('5')
  })

  it('⚠ STOPS AT MONTH 60 — one header + sixty rows, no more (spec §12)', () => {
    expect(rows).toHaveLength(61)
    expect(rows[1][0]).toBe('1')
    expect(rows[60][0]).toBe('60')
    for (const r of rows.slice(1)) expect(Number(r[0])).toBeLessThanOrEqual(60)
  })

  it('carries the published demand values verbatim', () => {
    PUBLISHED_HISTORY.forEach((v, i) => expect(rows[i + 1][3]).toBe(String(v)))
  })

  it('does NOT grow when the student plays, and cannot see the model', () => {
    // "Frozen" AND "leak-free" in code rather than in a comment: buildHistoryCsv takes
    // ONE argument. There is no parameter through which a played month could enter,
    // and none through which a, b, H or σ could.
    expect(buildHistoryCsv.length).toBe(1)
    expect(buildHistoryCsv(PUBLISHED_HISTORY)).toBe(csv)
  })

  it('is labelled as the five-year history (spec §4)', () => {
    expect(historyCsvFilename(PUBLISHED_HISTORY)).toBe('demand-history-years-1-5.csv')
  })

  it('carries no model parameter anywhere in the text', () => {
    expect(csv).not.toMatch(/intercept|trend|sigma|lift|seasonality|seed/i)
  })
})

describe('the FINAL export — history plus played months only (spec §5, §12)', () => {
  const csv = buildFullCsv(PUBLISHED_HISTORY, PLAYED)
  const rows = parse(csv)

  it('has the history block, then one row per month PLAYED', () => {
    expect(rows[0][0]).toBe('Time')
    expect(rows).toHaveLength(1 + 60 + PLAYED.length)
  })

  it('⚠ carries NO high-season indicator either (spec §5 lists no such column)', () => {
    expect(rows[0]).toEqual([
      'Time', 'Year', 'Month', 'Demand',
      'Forecast', 'Error', 'AbsoluteError', 'SquaredError', 'AbsolutePercentageError',
    ])
    expect(csv).not.toMatch(/highseason|indicator|holiday|dummy/i)
    expect(buildFullCsv.length).toBe(2)      // no model parameter
  })

  it('⚠ CONTAINS REVEALED PERIODS ONLY — never a future month (spec §12)', () => {
    const lastPlayed = PLAYED[PLAYED.length - 1].period       // 72, with 12 of 24 played
    const times = rows.slice(1).map(r => Number(r[0]))
    expect(Math.max(...times)).toBe(lastPlayed)
    for (const future of [73, 78, 84]) expect(times).not.toContain(future)
  })

  it('leaves forecast and error blank on history rows, filled on played rows', () => {
    const historyRow = rows[1]
    expect(historyRow[3]).not.toBe('')          // Demand present
    expect(historyRow[4]).toBe('')              // Forecast blank
    expect(historyRow[5]).toBe('')              // Error blank

    const playedRow = rows[61]
    expect(playedRow[4]).toBe(String(PLAYED[0].forecast))
    expect(playedRow[5]).toBe(String(PLAYED[0].actual - PLAYED[0].forecast))
  })

  it('the error columns agree with an independent recomputation', () => {
    PLAYED.forEach((r, i) => {
      const row = rows[61 + i]
      const err = r.actual - r.forecast
      expect(row[3]).toBe(String(r.actual))
      expect(row[4]).toBe(String(r.forecast))
      expect(row[5]).toBe(String(err))
      expect(row[6]).toBe(String(Math.abs(err)))
      expect(row[7]).toBe(String(err * err))
      expect(Number(row[8])).toBeCloseTo(Math.abs(err) / r.actual, 5)
    })
  })

  it('a student who has played NOTHING gets the history and nothing more', () => {
    const none = parse(buildFullCsv(PUBLISHED_HISTORY, []))
    expect(none).toHaveLength(61)
    expect(Math.max(...none.slice(1).map(r => Number(r[0])))).toBe(60)
  })

  it('a FINISHED student gets all 84 months (spec §5)', () => {
    const all = Array.from({ length: 24 }, (_, i) =>
      round(i + 1, 61 + i, 900, drawDemand(DEFAULT_MODEL, 'csv-seed', 'stu-done', 61 + i)))
    const done = parse(buildFullCsv(PUBLISHED_HISTORY, all))
    expect(done).toHaveLength(1 + 84)
    expect(Math.max(...done.slice(1).map(r => Number(r[0])))).toBe(84)
  })

  it('blanks the percentage column on a zero-demand month rather than writing Infinity', () => {
    const zero = parse(buildFullCsv(PUBLISHED_HISTORY, [round(1, 61, 400, 0)]))
    const row = zero[61]
    expect(row[3]).toBe('0')
    expect(row[7]).toBe('160000')      // squared error still counts
    expect(row[8]).toBe('')            // APE blank
    expect(zero.join()).not.toMatch(/Infinity|NaN/)
  })
})

describe('CSV escaping', () => {
  it('quotes a value containing a comma', () => {
    const rows = parse('a,"b,c",d')
    expect(rows[0]).toEqual(['a', 'b,c', 'd'])
  })

  it('uses CRLF line endings (Excel is the target application)', () => {
    expect(buildHistoryCsv([1, 2])).toContain('\r\n')
  })
})
