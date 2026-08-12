import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StartedBanner, STARTED_BANNER_TEXT } from './StartedBanner'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SHARED "STUDENTS HAVE ALREADY STARTED" BANNER — behaviour, and adoption.
//
// ⚠⚠ THE SECOND HALF OF THIS FILE READS SOURCE FILES, WHICH IS UNUSUAL AND DELIBERATE.
// Rendering all six Settings pages would mean six Firebase mocks and six full config
// fixtures, and two of the six games have no render test to hang them on (scorecard and
// forecast — see the report). But the risk this component exists to prevent is not a
// rendering bug: it is SIX HAND-PLACED COPIES DRIFTING INTO SIX WORDINGS. That risk lives
// in the source, so that is where it is checked. A page that re-inlines the sentence, or
// quietly stops importing the component, fails here.
// ═══════════════════════════════════════════════════════════════════════════════

const GAMES = ['scorecard', 'pd', 'pricing', 'newsvendor', 'forecast', 'procurement'] as const
const settingsSrc = (game: string) =>
  readFileSync(join(__dirname, '..', game, 'Settings.tsx'), 'utf8')

describe('StartedBanner — behaviour', () => {
  it('⚠ RENDERS NOTHING on a fresh instance', () => {
    // MUTANT: always render (drop the `if (!started) return null`). → fails.
    expect(renderToStaticMarkup(<StartedBanner started={false} testIdPrefix="x" />)).toBe('')
  })

  it('⚠ RENDERS once a student has started', () => {
    // MUTANT: never render. → fails.
    const html = renderToStaticMarkup(<StartedBanner started testIdPrefix="x" />)
    expect(html).toContain('Students have already started')
    expect(html).toContain('the reports cannot separate them')
    expect(html).toContain('data-testid="x-started-banner"')
  })

  it('carries the prefix it is given, so each harness can address its own', () => {
    for (const p of ['sc', 'pd', 'pricing', 'nv', 'fc', 'proc']) {
      expect(renderToStaticMarkup(<StartedBanner started testIdPrefix={p} />))
        .toContain(`data-testid="${p}-started-banner"`)
    }
  })

  it('⚠ the string is SCORECARD\'S, unchanged — it shipped first and is the reference', () => {
    expect(STARTED_BANNER_TEXT).toBe(
      '⚠ Students have already started. Editing the rules now means different students '
      + 'played different games — the reports cannot separate them.',
    )
  })
})

describe('adoption — all six games, one component', () => {
  it('⚠⚠ ALL SIX IMPORT IT', () => {
    // MUTANT: drop the import from any one page (or hand-roll a copy there). → fails,
    // naming the game.
    for (const g of GAMES) {
      expect(settingsSrc(g), `${g} does not import StartedBanner`)
        .toContain("from '../shared/StartedBanner'")
    }
  })

  it('⚠⚠ AND ALL SIX RENDER IT — importing without using it would pass the check above', () => {
    for (const g of GAMES) {
      expect(settingsSrc(g), `${g} imports StartedBanner but never renders it`)
        .toMatch(/<StartedBanner\s+started=/)
    }
  })

  it('⚠⚠ NONE OF THEM INLINES THE SENTENCE — the drift this component prevents', () => {
    // MUTANT: reword the banner in one game by pasting the text back into its page.
    // → fails, naming that game. This is the check that makes "one string" true rather
    // than merely intended.
    for (const g of GAMES) {
      const src = settingsSrc(g)
      expect(src, `${g} has the banner sentence inline`)
        .not.toContain('Editing the rules now means different students')
    }
  })

  it('each passes a predicate rather than a literal — the moment differs per game', () => {
    // ⚠ NOT a uniform boolean: scorecard and pd/pricing fire when an irreversible
    // per-student draw happens at FIRST LOAD; newsvendor, forecast and procurement when a
    // round is actually played, because nothing is drawn before that. See the component
    // header. A page hard-coding `started={true}` would pass every other check here.
    for (const g of GAMES) {
      expect(settingsSrc(g), `${g} hard-codes the predicate`)
        .not.toMatch(/<StartedBanner\s+started(\s*=\s*\{(true|false)\})?\s+/)
    }
  })
})

describe("scorecard's KC-specific save-time trigger is GONE", () => {
  it('⚠⚠ DELETED — one mechanism, not two (Elena, 08-11)', () => {
    // MUTANT: restore it (re-add the `startedWarning` prop and its markup). → fails.
    // It fired when the VISIBLE GRADED SET changed, after the instructor had already made
    // the edit. The standing banner covers it, needs no baseline and no definition of "a
    // change", and is on screen before they touch anything.
    const src = settingsSrc('scorecard')
    expect(src).not.toContain('sc-kc-started-warning')
    expect(src).not.toContain('you have changed which graded questions')
    expect(src).not.toContain('pool two different denominators')
    // ⚠ And its supporting state went with it — a dead comparison left behind would be
    // re-wired by the next person who saw it.
    expect(src).not.toContain('gradedChanged')
    expect(src).not.toContain('gradedAtLoad')
  })

  it('⚠ but the OTHER save-time warning stays — it is not the same thing', () => {
    // §9.1's pre-stage caution is about WHERE a question is asked, not about who has
    // started, and the banner says nothing about it.
    expect(settingsSrc('scorecard')).toContain('sc-kc-pre-stage-warning')
  })
})

describe('the section-scoped notices survive in all five', () => {
  it('⚠ they say what the banner cannot — what editing THAT section does', () => {
    // MUTANT: remove any one of them as "duplicated by the banner". → fails, naming it.
    const expected: [string, string][] = [
      ['pd', 'each has drawn their number of rounds'],
      ['pricing', 'Editing the market'],
      ['newsvendor', 'Editing these does'],
      ['procurement', 'a student has already played a round in this instance'],
    ]
    for (const [g, phrase] of expected) {
      expect(settingsSrc(g), `${g} lost its section-scoped notice`).toContain(phrase)
    }
  })
})
