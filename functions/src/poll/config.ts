// ═══════════════════════════════════════════════════════════════════════════════
// Poll — per-game constants + the question data model + the three shipped defaults.
// Questions are DATA OBJECTS (standing platform constraint), never hardcoded inline
// arrays in a component. Poll spec §4.
// ═══════════════════════════════════════════════════════════════════════════════

export const POLL_GAME_ID = 'poll'
export const POLL_COLLECTION_PREFIX = 'poll'
export const POLL_CORS_ORIGINS = ['https://poll.mygames.live']

export const INSTANCES_COLLECTION = 'poll_game_instances'
export const PARTICIPANTS_COLLECTION = 'poll_participants'
export const CONFIG_DOC = 'main' // poll_game_instances/{id}/config/main  (client-readable)

// ── Question model (Poll spec §4.3, §4.5) ───────────────────────────────────────
export type PollQuestionType = 'text' | 'mc'
export interface PollOption { value: string; label: string }
export interface PollQuestion {
  id: string
  type: PollQuestionType
  prompt: string
  visible: boolean       // default false — the instructor turns questions on
  order: number
  system: boolean        // true = shipped default (non-deletable); false = instructor-authored
  options?: PollOption[] // mc only, in DEFINED ORDER
}

// ── The three defaults — ALL HIDDEN by default (Poll spec §4.1) ─────────────────
// Prompt-editable, reorderable, hideable, but NOT deletable. Q2's options are in RANK
// order (not alphabetical) — the pie slices follow this order.
export const POLL_DEFAULT_QUESTIONS: PollQuestion[] = [
  {
    id: 'deals_experience', type: 'text', system: true, visible: false, order: 1,
    prompt: 'Briefly describe the kinds of deals you have participated in',
  },
  {
    id: 'skill_level', type: 'mc', system: true, visible: false, order: 2,
    prompt: 'Rate your skill level relative to others in the class',
    options: [
      { value: 'top', label: 'Top quartile' },
      { value: 'second', label: 'Second quartile' },
      { value: 'third', label: 'Third quartile' },
      { value: 'fourth', label: 'Fourth quartile' },
    ],
  },
  {
    id: 'learning_goals', type: 'text', system: true, visible: false, order: 3,
    prompt: 'Briefly describe the things you want to learn about deal making',
  },
]

/** The ids of the shipped defaults — used to enforce non-deletability. */
export const SYSTEM_QUESTION_IDS: ReadonlySet<string> = new Set(POLL_DEFAULT_QUESTIONS.map(q => q.id))

// ── Parsing / loading ───────────────────────────────────────────────────────────

/** Defensive parse of a stored question. Returns null on any malformed entry. */
export function parseQuestion(raw: unknown): PollQuestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  if (typeof q.id !== 'string' || !q.id) return null
  if (q.type !== 'text' && q.type !== 'mc') return null
  if (typeof q.prompt !== 'string') return null
  const question: PollQuestion = {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    visible: q.visible === true,
    order: typeof q.order === 'number' ? q.order : 0,
    system: q.system === true,
  }
  if (q.type === 'mc') {
    if (!Array.isArray(q.options)) return null
    const options: PollOption[] = []
    for (const o of q.options) {
      if (typeof o !== 'object' || o === null) return null
      const oo = o as Record<string, unknown>
      if (typeof oo.value !== 'string' || typeof oo.label !== 'string') return null
      options.push({ value: oo.value, label: oo.label })
    }
    if (options.length === 0) return null
    question.options = options
  }
  return question
}

/** The effective question list for an instance: the stored list if present + valid,
 *  else the shipped defaults. Always returned sorted by `order`. */
export function loadQuestions(configData: Record<string, unknown> | undefined): PollQuestion[] {
  const stored = configData?.questions
  if (Array.isArray(stored)) {
    const parsed = stored.map(parseQuestion).filter((q): q is PollQuestion => q !== null)
    if (parsed.length > 0) return [...parsed].sort((a, b) => a.order - b.order)
  }
  return [...POLL_DEFAULT_QUESTIONS].sort((a, b) => a.order - b.order)
}
