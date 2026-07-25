import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import {
  PD_CORS_ORIGINS, INSTANCES_COLLECTION, CONFIG_DOC, TRUTH_DOC,
  HARD_MIN_ROUNDS, HARD_MAX_ROUNDS, loadPdConfig, parseAddedKcQuestion,
  type PdAddedKcQuestion,
} from './config'
import { resolveKcQuestions } from './questions'

// ═══════════════════════════════════════════════════════════════════════════════
// PD settings callables (Slice 5). pdGetConfig returns the whole editable config for
// the settings page; pdUpdateConfig validates and writes it back. Same shape as
// poll's instructorConfig pair.
//
// WHAT IS AND IS NOT EDITABLE:
//   editable   payoff matrix, move labels, unit, round RANGE, KC on/off, added KC
//              questions, debrief on/off + prompt
//   derived    the four matrix-comprehension KC questions — computed from the matrix
//              at serve and grade time, never stored as text (see questions.ts). They
//              are RETURNED here read-only so the settings page can preview what the
//              current matrix produces.
//   fixed      the bot strategies (TFT/GRIM) — not configurable, by decision
//   truth      the DRAWN round count — never returned here, never editable. Only its
//              range is. Editing the range does not redraw an initialized instance
//              (init.ts); `roundsDrawn` below tells the instructor which state they
//              are in without revealing the number.
// ═══════════════════════════════════════════════════════════════════════════════

export const pdGetConfig = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  const [configSnap, truthSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
  ])

  const config = loadPdConfig(configSnap.data())

  return {
    ok: true as const,
    payoffs: config.payoffs,
    labels: config.labels,
    unit: config.unit,
    minRounds: config.minRounds,
    maxRounds: config.maxRounds,
    kcEnabled: config.kcEnabled,
    addedKcQuestions: config.addedKcQuestions,
    debriefEnabled: config.debriefEnabled,
    debriefPrompt: config.debriefPrompt,
    /**
     * Read-only preview of what the CURRENT matrix derives, so the settings page can
     * show the instructor the four questions their payoff edits just produced.
     * Instructor-side, so the answer key may be included here.
     */
    derivedKcPreview: resolveKcQuestions(config.payoffs, config.unit, config.labels).map(q => ({
      field: q.field,
      prompt: q.prompt,
      options: q.options ?? [],
      correct_value: q.correct_value,
    })),
    /** Has the hidden round count already been drawn for this instance? A BOOLEAN —
     *  never the number, even for the instructor's settings page (they have the
     *  reports for that). Drives the "range edits will not affect this instance"
     *  warning. */
    roundsDrawn: typeof truthSnap.data()?.rounds === 'number',
  }
})

/** Reads one optional field; `undefined` means "not being changed". */
const has = (d: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(d, k)

export const pdUpdateConfig = onCall({ cors: PD_CORS_ORIGINS }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const patch: Record<string, unknown> = {}

  // ── Payoff matrix — four finite, non-negative numbers ─────────────────────
  if (has(data, 'payoffs')) {
    const p = (typeof data.payoffs === 'object' && data.payoffs !== null ? data.payoffs : {}) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const key of ['both_cooperate', 'sucker', 'temptation', 'both_defect']) {
      const v = p[key]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new HttpsError('invalid-argument', `Payoff "${key}" must be a number of 0 or more.`)
      }
      out[key] = v
    }
    patch.payoffs = out
  }

  // ── Move labels — two non-empty strings ───────────────────────────────────
  if (has(data, 'labels')) {
    const l = (typeof data.labels === 'object' && data.labels !== null ? data.labels : {}) as Record<string, unknown>
    const C = typeof l.C === 'string' ? l.C.trim() : ''
    const D = typeof l.D === 'string' ? l.D.trim() : ''
    if (!C || !D) throw new HttpsError('invalid-argument', 'Both move labels are required.')
    patch.labels = { C, D }
  }

  // ── Unit — one non-empty word ─────────────────────────────────────────────
  if (has(data, 'unit')) {
    const unit = typeof data.unit === 'string' ? data.unit.trim() : ''
    if (!unit) throw new HttpsError('invalid-argument', 'The unit is required.')
    patch.unit = unit
  }

  // ── Round range — integers, min ≤ max, both inside the hard bounds ────────
  if (has(data, 'minRounds') || has(data, 'maxRounds')) {
    const min = data.minRounds
    const max = data.maxRounds
    if (typeof min !== 'number' || !Number.isInteger(min) || typeof max !== 'number' || !Number.isInteger(max)) {
      throw new HttpsError('invalid-argument', 'Both round-range bounds must be whole numbers.')
    }
    if (min < HARD_MIN_ROUNDS || max < HARD_MIN_ROUNDS) {
      throw new HttpsError('invalid-argument', `Rounds must be at least ${HARD_MIN_ROUNDS}.`)
    }
    if (min > HARD_MAX_ROUNDS || max > HARD_MAX_ROUNDS) {
      throw new HttpsError('invalid-argument', `Rounds cannot exceed ${HARD_MAX_ROUNDS}.`)
    }
    if (min > max) {
      throw new HttpsError('invalid-argument', 'The minimum number of rounds cannot exceed the maximum.')
    }
    patch.min_rounds = min
    patch.max_rounds = max
  }

  // ── Knowledge check ───────────────────────────────────────────────────────
  if (has(data, 'kcEnabled')) {
    if (typeof data.kcEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'kcEnabled must be true or false.')
    patch.kc_enabled = data.kcEnabled
  }

  if (has(data, 'addedKcQuestions')) {
    if (!Array.isArray(data.addedKcQuestions)) {
      throw new HttpsError('invalid-argument', 'addedKcQuestions must be an array.')
    }
    const parsed: PdAddedKcQuestion[] = []
    const seen = new Set<string>()
    for (const raw of data.addedKcQuestions) {
      const q = parseAddedKcQuestion(raw)
      if (!q) {
        throw new HttpsError('invalid-argument',
          'An added question is incomplete — every question needs a prompt, and a multiple-choice question needs at least two options and a correct answer among them.')
      }
      // The derived four own the kc_ namespace; parseAddedKcQuestion already refuses
      // it, and this second check keeps the error message specific.
      if (q.id.startsWith('kc_')) {
        throw new HttpsError('invalid-argument', 'An added question cannot use a reserved kc_ id.')
      }
      if (seen.has(q.id)) throw new HttpsError('invalid-argument', `Duplicate question id: ${q.id}`)
      seen.add(q.id)
      parsed.push(q)
    }
    patch.added_kc_questions = parsed
  }

  // ── Debrief ───────────────────────────────────────────────────────────────
  if (has(data, 'debriefEnabled')) {
    if (typeof data.debriefEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'debriefEnabled must be true or false.')
    patch.debrief_enabled = data.debriefEnabled
  }
  if (has(data, 'debriefPrompt')) {
    const prompt = typeof data.debriefPrompt === 'string' ? data.debriefPrompt.trim() : ''
    if (!prompt) throw new HttpsError('invalid-argument', 'The debrief prompt is required.')
    patch.debrief_prompt = prompt
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpsError('invalid-argument', 'Nothing to update.')
  }

  const db = admin.firestore()
  const instanceRef = db.collection(INSTANCES_COLLECTION).doc(gameInstanceId)
  // merge:true — a settings save touches only the fields it was given, so it can
  // never clobber a sibling setting or, more importantly, anything an in-progress
  // game depends on. The drawn round count is in truth/, which this never writes.
  await instanceRef.collection('config').doc(CONFIG_DOC).set(patch, { merge: true })

  // Return the re-read effective config, so the page shows what was actually stored
  // (including any defaulting) rather than what it hoped it sent.
  const [configSnap, truthSnap] = await Promise.all([
    instanceRef.collection('config').doc(CONFIG_DOC).get(),
    instanceRef.collection('truth').doc(TRUTH_DOC).get(),
  ])
  const config = loadPdConfig(configSnap.data())

  return {
    ok: true as const,
    payoffs: config.payoffs,
    labels: config.labels,
    unit: config.unit,
    minRounds: config.minRounds,
    maxRounds: config.maxRounds,
    kcEnabled: config.kcEnabled,
    addedKcQuestions: config.addedKcQuestions,
    debriefEnabled: config.debriefEnabled,
    debriefPrompt: config.debriefPrompt,
    derivedKcPreview: resolveKcQuestions(config.payoffs, config.unit, config.labels).map(q => ({
      field: q.field,
      prompt: q.prompt,
      options: q.options ?? [],
      correct_value: q.correct_value,
    })),
    roundsDrawn: typeof truthSnap.data()?.rounds === 'number',
  }
})
