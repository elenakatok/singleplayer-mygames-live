import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  forecastGetConfig, forecastUpdateConfig, forecastInstructorSession,
  instructorErrorMessage,
  type ForecastConfigResult,
} from './api'
import {
  KnowledgeCheckSettings,
  type KcSettingsDraft, type KcSettingsQuestion, type KcSettingsStage,
} from '../shared/KnowledgeCheckSettings'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — instructor settings (spec §3).
//
// ⚠⚠ THE MODEL IS EDITED HERE, AND ONLY THROUGH A CALLABLE. `truth/main` is rules-denied
// to every client — including an authenticated instructor — so this page CANNOT reach it
// with the Firestore SDK, by design. It goes through forecastGetConfig /
// forecastUpdateConfig, which use the Admin SDK server-side. Nothing on this page
// imports `db`, and nothing should.
//
// ⚠ THE PAGE IS SPLIT THE WAY THE DATA IS. "What students see" is config/main;
// "The demand model" is truth/main and is labelled as the answer key. Presenting them
// as one undifferentiated form would invite exactly the mistake the split exists to
// prevent — someone adding a field to the wrong half.
//
// ⚠ WARN, NEVER BLOCK (spec §3, §3a, §5a). The server returns a `warnings` array and
// this page shows it prominently, but nothing here refuses a pedagogically-questionable
// edit. Only structurally impossible values are rejected, server-side, because those are
// typos rather than choices.
//
// ⚠⚠ THE KNOWLEDGE CHECK IS NOW EDITABLE — and the reason it used to say otherwise is
// still true, so the caution is REWRITTEN rather than deleted (convergence spec §3).
//
// The old sentence was "Not editable. The questions carry their own numbers on purpose:
// the knowledge check runs before play, so a question derived from this instance would
// print part of the answer on the screen before the one where students are asked to work
// it out." Every clause of that is still correct — but it was an argument against DERIVING
// the questions from the instance, not against an instructor rewording one. The stems stay
// hand-written and stay independent of a, b, H and σ; what changes is that you may now edit
// the words, hide a question, reorder the list, or add your own.
//
// ⚠ THE CAUTION THAT SURVIVES, AND IT IS SHARPER HERE THAN IN ANY OTHER GAME IN THE FAMILY:
// do not write THIS instance's model into a question. Newsvendor's equivalent warning is
// about making an answer readable off the play screen; here the KC runs BEFORE play, so a
// stem quoting the trend or the high-season lift hands the student the answer to the whole
// exercise on the screen before they start. The same goes for a question you ADD to the
// before-play stage. The after-play stage is safe on that count — students have already
// forecast every month — but it sits BEFORE the reveal, so a question there must not quote
// the model either.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ⚠ The stage labels are THIS GAME'S, passed as props — the shared block knows nothing
 * about forecasting. The after-play stage's note is the one an instructor most needs: it
 * is placed after the student's own results and BEFORE the model reveal, and the server
 * refuses the reveal until every visible row in it is answered.
 */
const KC_STAGES: KcSettingsStage[] = [
  { id: 'pre', label: 'Before play', note: 'Asked before the first month is forecast.' },
  {
    id: 'post',
    label: 'After the results, before the reveal',
    note: 'Asked once students have seen their own results — their MSE, accuracy and bonus — '
      + 'but BEFORE they are shown how demand was actually generated. ⚠ The reveal is held '
      + 'back until every visible question here is answered, so anything you add is answered '
      + 'without the answer key in view. A hidden question does not hold it back.',
  },
]

/** ⚠ The debrief row's id IS its stored answer key. Nothing moves. */
const DEBRIEF_ROW_ID = 'debrief_method'

const card = {
  background: colors.white,
  border: `1px solid ${colors.borderMid}`,
  borderRadius: 8,
  padding: '1rem 1.1rem',
  marginBottom: '1.25rem',
} as const

const label = {
  display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.2rem',
} as const

const input = {
  width: '9rem', fontSize: '0.9rem', padding: '0.4rem 0.5rem', borderRadius: 4,
  border: `1px solid ${colors.inputBorder}`, fontVariantNumeric: 'tabular-nums' as const,
} as const

const row = { marginBottom: '0.75rem' } as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function Settings() {
  const session = useInstructorSession(forecastInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ForecastConfigResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** The edit buffer — string-typed, because a half-typed number is not a number. */
  const [draft, setDraft] = useState<Record<string, string>>({})
  // ═══════════════════════════════════════════════════════════════════════════
  // THE KNOWLEDGE CHECK — the SHARED block (convergence spec §2, §8.3).
  //
  // ⚠ The read-only preview <ol> and the debrief prompt textarea are both gone; both are
  // rows in the list now. Forecast supplies only the stage labels, the toggle copy, and
  // the one-row translation below.
  // ═══════════════════════════════════════════════════════════════════════════
  const [kcDraft, setKcDraft] = useState<KcSettingsDraft | null>(null)

  /** The server's inventory in the shared block's shape — the debrief row included. */
  function kcQuestions(r: ForecastConfigResult): KcSettingsQuestion[] {
    return [...r.kc.builtIn, ...r.kc.added, r.kc.debrief]
  }

  /**
   * ⚠⚠ THE DEBRIEF ROW IS BACKED BY ITS OWN CONFIG KEYS, NOT BY THE THREE CONVERGENCE
   * MAPS — that is what makes folding it into the list a UI change with NO STORAGE
   * MIGRATION (spec D9). Inside the block it behaves like any row, so its edits land in
   * `overrides[id]` and `hidden[id]`; this pair translates those to and from
   * `debriefPrompt` / `debriefEnabled` at the boundary. The server never sees either, and
   * REFUSES them if a hand-made call sends one.
   *
   * ⚠ `addedKcQuestions` is carried through untouched. It has always round-tripped through
   * this page while never being rendered, so an instance may ALREADY hold added questions
   * injected by callable. Adoption must show them, not drop them.
   */
  function seedKc(r: ForecastConfigResult): KcSettingsDraft {
    return {
      enabled: r.config.kcEnabled,
      hidden: {
        ...r.kcHidden,
        ...(r.config.debriefEnabled ? {} : { [DEBRIEF_ROW_ID]: true }),
      },
      order: { ...r.kcOrder },
      overrides: { ...r.kcOverrides },
      added: (r.config.addedKcQuestions as KcSettingsDraft['added']).map(q => ({ ...q })),
    }
  }

  /** The draft, split back into the callable's real field names. */
  function kcPatch(d: KcSettingsDraft) {
    const { [DEBRIEF_ROW_ID]: debriefHidden, ...hidden } = d.hidden
    const { [DEBRIEF_ROW_ID]: debriefOverride, ...overrides } = d.overrides
    return {
      kcEnabled: d.enabled,
      kcHidden: hidden,
      kcOrder: d.order,
      kcOverrides: overrides,
      addedKcQuestions: d.added.map(q => ({
        ...q,
        // The shared draft types `stage` as a plain string (generic across six games);
        // forecast's callable takes its own two-value union.
        stage: q.stage === 'post' ? ('post' as const) : ('pre' as const),
      })),
      debriefEnabled: debriefHidden !== true,
      // ⚠ Falls back to what is stored, so a save that never touched the paragraph sends
      // its prompt unchanged rather than blanking it — the callable rejects an empty one.
      debriefPrompt: debriefOverride?.prompt ?? data?.config.debriefPrompt ?? '',
    }
  }

  const load = useCallback(async () => {
    try {
      const r = await forecastGetConfig()
      setData(r)
      setDraft({
        rounds: String(r.config.rounds),
        numHistory: String(r.config.numHistory),
        forecastMin: String(r.config.forecastMin),
        forecastMax: String(r.config.forecastMax),
        productName: r.config.productName,
        unitLabel: r.config.unitLabel,
        debriefPrompt: r.config.debriefPrompt,
        a: String(r.model.a),
        b: String(r.model.b),
        H: String(r.model.H),
        sigma: String(r.model.sigma),
        highSeasonMonths: r.model.highSeasonMonths.join(','),
        monthOffsets: r.model.monthOffsets.join(','),
        seed: r.seed ?? '',
        demandDraw: r.model.demandDraw,
      })
      setKcDraft(seedKc(r))
      setError(null)
    } catch (err) {
      setError(instructorErrorMessage(err))
    }
  }, [])

  useEffect(() => { if (session.kind === 'ready') void load() }, [session, load])

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true); setNote(null)
    try {
      const r = await forecastUpdateConfig(patch)
      setData(r)
      setKcDraft(seedKc(r))
      setNote('Saved.')
    } catch (err) {
      setNote(instructorErrorMessage(err))
    } finally { setSaving(false) }
  }

  if (session.kind !== 'ready' || (!data && !error)) {
    return <InstructorChrome title="Forecasting Game — settings"><p>Loading…</p></InstructorChrome>
  }
  if (error || !data) {
    return (
      <InstructorChrome title="Forecasting Game — settings">
        <p style={{ color: '#c00' }}>{error}</p>
      </InstructorChrome>
    )
  }

  const num = (k: string) => Number(draft[k])
  const set = (k: string, v: string) => setDraft(d => ({ ...d, [k]: v }))

  const numField = (key: string, text: string, hint?: string) => (
    <div style={row}>
      <label style={label} htmlFor={`fc-set-${key}`}>{text}</label>
      <input
        id={`fc-set-${key}`}
        data-testid={`fc-set-${key}`}
        type="number"
        value={draft[key] ?? ''}
        onChange={e => set(key, e.target.value)}
        style={input}
      />
      {hint && <div style={{ fontSize: '0.73rem', color: colors.textSecondary, marginTop: '0.15rem' }}>{hint}</div>}
    </div>
  )

  // ⚠ THE QUERY STRING IS CARRIED FORWARD — `?token=`/`?_gid=` is how the instructor
  // session identifies the instance across pages.
  const navLinks = [
    { label: 'Dashboard →', href: `/dashboard${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  return (
    <InstructorChrome title="Forecasting Game — settings" navLinks={navLinks} onNavigate={navigate}>
      {/* ── The warnings (spec §3, §3a, §5a) — advice, never a block ────────── */}
      {data.warnings.length > 0 && (
        <section
          data-testid="fc-settings-warnings"
          style={{ ...card, background: '#fffbeb', borderColor: '#fde68a' }}
        >
          <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.5rem' }}>Worth knowing</h2>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.83rem', lineHeight: 1.6 }}>
            {data.warnings.map((w, i) => <li key={i} data-testid={`fc-warning-${i}`}>{w}</li>)}
          </ul>
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.76rem', color: colors.textSecondary }}>
            These are advisory. Nothing here is blocked — it is your call.
          </p>
        </section>
      )}

      {note && (
        <p data-testid="fc-settings-note" style={{ fontSize: '0.85rem', marginBottom: '1rem', color: colors.textSecondary }}>
          {note}
        </p>
      )}

      {/* ── What students see (config/main) ─────────────────────────────────── */}
      <section style={card}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>What students see</h2>
        <p style={{ margin: '0 0 0.9rem', fontSize: '0.8rem', color: colors.textSecondary }}>
          These are readable by the student&rsquo;s browser, and every one of them is
          printed on screen anyway.
        </p>
        {numField('rounds', 'Months to forecast', 'Shown to the student as “month k of N”.')}
        {numField('numHistory', 'Months of history', 'Five years (60) is the published history.')}
        {numField('forecastMin', 'Lowest allowed forecast')}
        {numField('forecastMax', 'Highest allowed forecast', 'Keep this generous — a tight range is a hint.')}
        <div style={row}>
          <label style={label} htmlFor="fc-set-productName">Product name</label>
          <input
            id="fc-set-productName" data-testid="fc-set-productName"
            value={draft.productName ?? ''} onChange={e => set('productName', e.target.value)}
            style={{ ...input, width: '18rem' }}
          />
        </div>
        <button
          data-testid="fc-save-config"
          disabled={saving}
          onClick={() => void save({
            rounds: num('rounds'),
            numHistory: num('numHistory'),
            forecastMin: num('forecastMin'),
            forecastMax: num('forecastMax'),
            productName: draft.productName,
          })}
          style={{
            padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
            background: colors.text, color: colors.white, border: 'none', borderRadius: 6,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </section>

      {/* ── The demand model (truth/main) — THE ANSWER KEY ──────────────────── */}
      <section style={{ ...card, borderColor: '#fca5a5' }}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>The demand model — the answer key</h2>
        <p style={{ margin: '0 0 0.9rem', fontSize: '0.8rem', color: colors.textSecondary }}>
          <strong>Students never see any of this.</strong> Working it out from the demand
          history is the exercise, so these values are stored where no browser can read
          them and are revealed only on the debrief screen, after a student has finished
          and written their answer.
        </p>
        <p style={{ margin: '0 0 0.9rem', fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums' }}>
          demand = {data.model.a} + {data.model.b} × month + {data.model.H} in{' '}
          {data.model.highSeasonMonths.map(m => MONTHS[m - 1]).join(' and ')} + noise (sd {data.model.sigma})
        </p>
        <p data-testid="fc-model-draw-summary" style={{ margin: '0 0 0.9rem', fontSize: '0.8rem', color: colors.textSecondary }}>
          Currently: <strong>
            {data.model.demandDraw === 'common'
              ? 'every student faces the same months'
              : 'each student faces their own months'}
          </strong>
          {data.model.demandDraw === 'common' && (data.seed
            ? ' (reproducible — this instance uses a seed)'
            : ' (unique to this instance)')}.
        </p>
        {numField('a', 'Intercept (a)', 'The low-season level at month 0.')}
        {numField('b', 'Trend per month (b)')}
        {numField('H', 'High-season lift (H)')}
        {numField('sigma', 'Noise standard deviation (σ)', 'Sets the floor: no forecast can beat σ².')}
        <div style={row}>
          <label style={label} htmlFor="fc-set-highSeasonMonths">High-season months</label>
          <input
            id="fc-set-highSeasonMonths" data-testid="fc-set-highSeasonMonths"
            value={draft.highSeasonMonths ?? ''} onChange={e => set('highSeasonMonths', e.target.value)}
            style={{ ...input, width: '12rem' }}
          />
          <div style={{ fontSize: '0.73rem', color: colors.textSecondary, marginTop: '0.15rem' }}>
            Comma-separated month numbers. 11,12 is November and December.
          </div>
        </div>
        {/* ⚠ THE DRAW MODE WAS MISSING FROM THIS PAGE UNTIL 08-02, and its absence is
            why a bug in it took three rounds to find: it is the setting that decides
            whether students share a series, and there was no way to see or change it. */}
        <div style={row}>
          <label style={label} htmlFor="fc-set-demandDraw">Demand each student faces</label>
          <select
            id="fc-set-demandDraw" data-testid="fc-set-demandDraw"
            value={draft.demandDraw ?? 'common'}
            onChange={e => set('demandDraw', e.target.value)}
            style={{ ...input, width: '22rem' }}
          >
            <option value="common">Everyone gets the SAME months</option>
            <option value="perStudent">Each student gets their OWN months</option>
          </select>
          <div style={{ fontSize: '0.73rem', color: colors.textSecondary, marginTop: '0.15rem' }}>
            {draft.demandDraw === 'perStudent'
              ? 'No student can hand the class the answers — but two students\' MSEs are '
                + 'not strictly comparable, and the class chart averages unrelated series.'
              : 'Every student is scored on identical data, so their MSEs are directly '
                + 'comparable. A student who finishes early can hand the class the answers; '
                + 'the outcomes report flags anyone whose error is below what the noise allows.'}
          </div>
        </div>

        <div style={row}>
          <label style={label} htmlFor="fc-set-seed">Determinism seed</label>
          <input
            id="fc-set-seed" data-testid="fc-set-seed"
            value={draft.seed ?? ''} onChange={e => set('seed', e.target.value)}
            style={{ ...input, width: '12rem' }}
          />
          <div style={{ fontSize: '0.73rem', color: colors.textSecondary, marginTop: '0.15rem' }}>
            {/* ⚠ THE SEED DOES NOT CONTROL WHETHER STUDENTS SHARE A SERIES — the
                setting above does. The seed only controls REPRODUCIBILITY, and the two
                are easy to conflate. */}
            <strong>Leave this blank unless you want to repeat a specific set of months.</strong>
            {' '}It does not decide whether students share demand — the setting above does.
            {draft.demandDraw === 'perStudent'
              ? ' Blank means real randomness; a value makes each student\'s own months reproducible.'
              : ' Blank still gives everyone the same months, unique to this instance. '
                + 'Setting a value makes those months reproducible — so ANOTHER instance with '
                + 'the same seed would get the identical series, which is how last term\'s '
                + 'class could hand this term the answers.'}
            {/* ⚠ THIS USED TO SAY "the five-year history is fixed either way", which was
                true of the SEED and false of everything else — and read as a blanket
                promise that the history never moves. It moves whenever a, b, H, σ or the
                high season moves, because it is generated FROM them. */}
            {' '}The five-year history does not depend on the seed — but it is drawn from
            the demand model above, so editing any of those parameters redraws it.
          </div>
        </div>
        <button
          data-testid="fc-save-model"
          disabled={saving}
          onClick={() => void save({
            a: num('a'),
            b: num('b'),
            H: num('H'),
            sigma: num('sigma'),
            highSeasonMonths: (draft.highSeasonMonths ?? '')
              .split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n)),
            demandDraw: draft.demandDraw ?? 'common',
            seed: draft.seed ?? '',
          })}
          style={{
            padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
            background: colors.text, color: colors.white, border: 'none', borderRadius: 6,
          }}
        >
          {saving ? 'Saving…' : 'Save the model'}
        </button>
      </section>

      {/* ── The knowledge check — the SHARED block (convergence spec §2) ─────── */}
      {kcDraft && (
        <KnowledgeCheckSettings
          testIdPrefix="fc-kc"
          questions={kcQuestions(data)}
          stages={KC_STAGES}
          draft={kcDraft}
          onChange={setKcDraft}
          // ⚠ D12 — THE TOGGLE GATES GRADED QUESTIONS ONLY, and the copy says exactly that.
          // The debrief paragraph has its own visibility checkbox in the list below.
          enableNote={(
            <>
              Off removes the nine graded questions and any graded question you have added.
              ⚠ It does <em>not</em> remove the written answer after the results, or any
              free-text question you have added. Those are ungraded, and each has its own
              visibility checkbox below.
            </>
          )}
          // ⚠ NO STARTED-BANNER IS PASSED, DELIBERATELY. Forecast has an `anyRoundsPlayed`
          // signal, and the server puts it to work — it is one of the inputs to the
          // `warnings` array at the top of this page, whose copy is entirely about
          // REDRAWING THE DEMAND HISTORY when a model parameter changes. That is not a
          // page-level "students have already started" banner like scorecard's. Spec §10
          // records this as a decision pending for pd, pricing, newsvendor and now forecast,
          // to be swept once rather than invented separately in each game.
        />
      )}
      {kcDraft && (
        // ⚠ THE KC SAVES ON ITS OWN BUTTON, like every other section on this page. Forecast
        // splits its saves by DESTINATION — "what students see" writes config/main, "the
        // demand model" writes truth/main — and folding the question list into either would
        // make an unrelated edit ride along with a model change. The shared block deliberately
        // ships no Save of its own, so each game places one where its page already puts them.
        <div style={{ marginTop: '-0.75rem', marginBottom: '1.25rem' }}>
          <button
            data-testid="fc-save-kc"
            disabled={saving}
            onClick={() => void save(kcPatch(kcDraft))}
            style={{
              padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
              background: colors.text, color: colors.white, border: 'none', borderRadius: 6,
            }}
          >
            {saving ? 'Saving…' : 'Save the questions'}
          </button>
        </div>
      )}
    </InstructorChrome>
  )
}
