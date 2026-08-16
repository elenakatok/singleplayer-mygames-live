import { describe, it, expect } from 'vitest'
import { loadPdConfig, type PdConfig } from '../src/pd/config'
import { pdResolveKc, toClientKcQuestions, pdKcScoringSet, resolveKcQuestions } from '../src/pd/questions'
import { lockedKcQuestionIds } from '../src/pd/kcLock'
import { payoff, parsePayoffs } from '../src/pd/payoff'
import { botMove, type Move } from '../src/pd/strategy'
import { totals, toClientHistory, type StoredRound } from '../src/pd/rounds'
import { Timestamp } from 'firebase-admin/firestore'

// ═══════════════════════════════════════════════════════════════════════════════
// BATTLE OF THE SEXES — the worked example of a NON-DILEMMA 2×2 played on this
// engine. It exercises three things pd's own 1/15/0/10 default never could:
//
//   • an ASYMMETRIC matrix (O is not the transpose of Y),
//   • a THREE-value option ladder (Y = 2,0,0,1 has three distinct values), with
//     TWO questions sharing the correct answer 0,
//   • move wording that is not "Cooperate"/"Defect".
//
// ⚠ THE MOVE NAMES HERE APPEAR NOWHERE ELSE IN THE CODEBASE, deliberately. Every
// assertion that they are PRESENT is paired with an assertion that the shipped
// defaults are ABSENT — a surface that renders both would pass the first alone.
// ═══════════════════════════════════════════════════════════════════════════════

/** Two words used nowhere else in this repo, so a hit is never a coincidence. */
const OPERA = 'Zarquon'
const BOXING = 'Blorptide'

/** Textbook Battle of the Sexes. You prefer your own venue, they prefer theirs, and
 *  both prefer agreeing to disagreeing. Y = 2,0,0,1 / O = 1,0,0,2. */
const BOS_RAW = {
  labels: { C: OPERA, D: BOXING },
  unit: 'points',
  payoffs: {
    you_cc: 2, you_cd: 0, you_dc: 0, you_dd: 1,
    other_cc: 1, other_cd: 0, other_dc: 0, other_dd: 2,
  },
}

const bos = (): PdConfig => loadPdConfig(BOS_RAW)

// ═══════════════════════════════════════════════════════════════════════════════
// THE OPTION LADDER AT FEWER THAN FOUR DISTINCT VALUES
// ═══════════════════════════════════════════════════════════════════════════════

describe('the option ladder does not assume four distinct values', () => {
  it('renders THREE options for a matrix with three distinct Y values', () => {
    const resolved = pdResolveKc(bos())
    expect(resolved.length).toBe(4)
    for (const q of resolved) {
      // Length asserted BEFORE any every/some over it.
      expect((q.options ?? []).length).toBe(3)
      expect((q.options ?? []).map(o => o.value)).toEqual(['0', '1', '2'])
    }
  })

  it('renders TWO options for a matrix with two distinct Y values', () => {
    const cfg = loadPdConfig({
      ...BOS_RAW,
      payoffs: { ...BOS_RAW.payoffs, you_cc: 2, you_cd: 0, you_dc: 0, you_dd: 2 },
    })
    const resolved = pdResolveKc(cfg)
    expect(resolved.length).toBe(4)
    for (const q of resolved) expect((q.options ?? []).length).toBe(2)
  })

  it('⚠ NEGATIVE CONTROL — pd’s own default matrix still renders FOUR', () => {
    // The path this whole block exercises is unreachable on the shipped defaults,
    // which is why it went untested until Battle of the Sexes turned up.
    const resolved = pdResolveKc(loadPdConfig({}))
    expect(resolved.length).toBe(4)
    for (const q of resolved) expect((q.options ?? []).length).toBe(4)
  })

  it('every question’s OWN correct answer is present among its options', () => {
    const resolved = pdResolveKc(bos())
    expect(resolved.length).toBe(4)
    for (const q of resolved) {
      const values = (q.options ?? []).map(o => o.value)
      expect(values.length).toBeGreaterThan(0)
      expect(values).toContain(q.correct_value)
    }
  })

  it('TWO QUESTIONS SHARE the correct answer 0, and both grade against it', () => {
    const resolved = pdResolveKc(bos())
    // Expected written from the matrix by hand: Y(C,C)=2, Y(C,D)=0, Y(D,C)=0, Y(D,D)=1.
    expect(resolved.map(q => q.correct_value)).toEqual(['2', '0', '0', '1'])
    const zeros = resolved.filter(q => q.correct_value === '0')
    expect(zeros.length).toBe(2)
    expect(zeros.map(q => q.field)).toEqual(['kc_cd', 'kc_dc'])

    // The grader's scoring set carries BOTH, each with its own key — a set keyed by
    // correct answer rather than by field would collapse them into one.
    const scoring = pdKcScoringSet(bos())
    expect(scoring.length).toBe(4)
    expect(scoring.filter(q => q.correct_value === '0').map(q => q.field)).toEqual(['kc_cd', 'kc_dc'])
    expect(new Set(scoring.map(q => q.field)).size).toBe(4)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE LOCK, MEASURED AGAINST A COLLAPSED LADDER
// ═══════════════════════════════════════════════════════════════════════════════

describe('kcLock on a Battle of the Sexes matrix', () => {
  it('still measures ALL FOUR as locked', () => {
    // kcLock perturbs each of the eight by a different multiple, so a collapsed live
    // ladder (three values) becomes an uncollapsed probe ladder (four) — the text moves
    // either way, and the classification does not depend on the ladder staying the
    // same length.
    const locked = lockedKcQuestionIds(bos())
    expect(locked.size).toBe(4)
    expect([...locked].sort()).toEqual(['kc_cc', 'kc_cd', 'kc_dc', 'kc_dd'])
  })

  it('the reason holds: each question’s text moves when the parameters move', () => {
    const live = resolveKcQuestions(bos().payoffs, 'points', { C: OPERA, D: BOXING })
    const other = resolveKcQuestions(bos().payoffs, 'credits', { C: 'Aaa', D: 'Bbb' })
    expect(live.length).toBe(4)
    for (let i = 0; i < live.length; i++) {
      expect(live[i].prompt).not.toBe(other[i].prompt)
      expect(live[i].explanation).not.toBe(other[i].explanation)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE MOVE WORDING, ACROSS THE WHOLE SERVER-RENDERED KC SURFACE
// ═══════════════════════════════════════════════════════════════════════════════

describe('⚠ the KC surface carries the INSTANCE wording and nothing else', () => {
  const resolved = pdResolveKc(bos())
  /** Everything the server produces for the KC: prompts, options, explanations, keys. */
  const surface = JSON.stringify(resolved)

  it('the fixture actually reached the surface (guards the absence assertion below)', () => {
    expect(resolved.length).toBe(4)
    expect(surface).toContain(OPERA)
    expect(surface).toContain(BOXING)
  })

  it('⚠⚠ neither shipped default word appears ANYWHERE on it', () => {
    // THE POINT OF THIS TEST. Asserting only that the new words are present would pass
    // against a surface that shows both — which is exactly the failure being guarded.
    expect(surface).not.toContain('Cooperate')
    expect(surface).not.toContain('Defect')
  })

  it('…and the same holds for the student payload, key stripped', () => {
    const client = JSON.stringify(toClientKcQuestions(resolved))
    expect(client).toContain(OPERA)
    expect(client).toContain(BOXING)
    expect(client).not.toContain('Cooperate')
    expect(client).not.toContain('Defect')
    expect(client).not.toContain('correct_value')
  })

  it('…and for the explanations, which are earned by answering', () => {
    const explanations = resolved.map(q => q.explanation ?? '')
    expect(explanations.length).toBe(4)
    expect(explanations.every(e => e.length > 0)).toBe(true)
    for (const e of explanations) {
      expect(e).not.toContain('Cooperate')
      expect(e).not.toContain('Defect')
    }
    expect(explanations.some(e => e.includes(OPERA))).toBe(true)
    expect(explanations.some(e => e.includes(BOXING))).toBe(true)
  })

  /**
   * ⚠⚠ THE DRIFT PIN, HALF ONE OF TWO. `frontend/src/pd/derivedKc.test.ts` asserts the
   * settings page's client-side mirror produces these EXACT strings for this EXACT
   * fixture. Edit either side's templates and one of the two suites fails.
   */
  it('DRIFT PIN — the exact strings the client mirror must reproduce', () => {
    expect(resolved.map(q => q.prompt)).toEqual([
      `You choose ${OPERA} and the other player also chooses ${OPERA}. How many points do YOU get?`,
      `You choose ${OPERA} and the other player chooses ${BOXING}. How many points do YOU get?`,
      `You choose ${BOXING} and the other player chooses ${OPERA}. How many points do YOU get?`,
      `You choose ${BOXING} and the other player also chooses ${BOXING}. How many points do YOU get?`,
    ])
    expect((resolved[0].options ?? []).map(o => o.label)).toEqual(['0 points', '1 point', '2 points'])
    expect(resolved.map(q => q.explanation)).toEqual([
      `When you both choose ${OPERA}, you each get 2 points.`,
      `Choosing ${OPERA} while they choose ${BOXING} gets you 0 points; they get 0 points.`,
      `Choosing ${BOXING} while they choose ${OPERA} gets you 0 points; they get 0 points.`,
      `When you both choose ${BOXING}, you each get 1 point.`,
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// A PLAYED GAME ON THIS MATRIX
// ═══════════════════════════════════════════════════════════════════════════════

describe('Battle of the Sexes plays, and the numbers land in the right places', () => {
  const p = bos().payoffs

  it('each cell pays Y to the student and O to the bot, from the same cell', () => {
    // Written by hand from the matrix, not read back off `p`.
    expect(payoff('C', 'C', p)).toEqual({ studentYears: 2, botYears: 1 })
    expect(payoff('C', 'D', p)).toEqual({ studentYears: 0, botYears: 0 })
    expect(payoff('D', 'C', p)).toEqual({ studentYears: 0, botYears: 0 })
    expect(payoff('D', 'D', p)).toEqual({ studentYears: 1, botYears: 2 })
  })

  it('a full game against tit-for-tat produces the right history and totals', () => {
    const moves: Move[] = ['C', 'D', 'D', 'C']
    const history: Move[] = []
    const rows: StoredRound[] = []
    for (let i = 0; i < moves.length; i++) {
      const bot = botMove('tft', history)
      const r = payoff(moves[i], bot, p)
      rows.push({
        round: i + 1, student_move: moves[i], bot_move: bot,
        student_years: r.studentYears, bot_years: r.botYears,
        played_at: Timestamp.fromMillis(0),
      })
      history.push(moves[i])
    }
    expect(rows.length).toBe(4)
    // TFT: C, then mirrors → C C D D. Cells: (C,C) (D,C) (D,D) (C,D).
    expect(rows.map(r => r.bot_move).join('')).toBe('CCDD')
    expect(rows.map(r => r.student_years)).toEqual([2, 0, 1, 0])
    expect(rows.map(r => r.bot_years)).toEqual([1, 0, 2, 0])
    expect(totals(rows)).toEqual({ student: 3, bot: 3 })
    const client = toClientHistory(rows)
    expect(client.length).toBe(4)
    expect(client.map(r => r.studentTotal)).toEqual([2, 2, 3, 3])
    expect(client.map(r => r.botTotal)).toEqual([1, 1, 3, 3])
  })

  it('parsePayoffs round-trips the asymmetric matrix untouched', () => {
    expect(parsePayoffs(BOS_RAW.payoffs)).toEqual(BOS_RAW.payoffs)
  })
})
