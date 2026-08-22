import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { penniesGetConfig, penniesUpdateConfig, penniesInstructorSession, CLASSROOM_URL } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// Settings (spec §9). Two per-instance fields: True value (currency, default 3.50)
// and Jar image (path). Game-local (the shared SettingsPage hardcodes generic
// callable names). Saving writes through penniesUpdateConfig — the true value into
// the rules-denied truth/main, the jar image into config/main; reads come back via
// penniesGetConfig, never a direct Firestore read (spec §4.4).
// ═══════════════════════════════════════════════════════════════════════════════

export default function Settings() {
  const session = useInstructorSession(penniesInstructorSession)
  const [reverse, setReverse] = useState(false)
  const [trueValue, setTrueValue] = useState('')
  const [pennyValue, setPennyValue] = useState('')
  const [pennyCount, setPennyCount] = useState('')
  const [jarImage, setJarImage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    penniesGetConfig()
      .then(cfg => {
        setReverse(cfg.reverse)
        setTrueValue(String(cfg.true_value))
        setPennyValue(String(cfg.penny_value))
        setPennyCount(String(cfg.penny_count))
        setJarImage(cfg.jar_image)
        setLoaded(true)
      })
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load settings.'))
  }, [session.kind])

  const handleSave = async () => {
    if (!jarImage.trim()) { setErr('Jar image path is required.'); return }
    const tv = Number(trueValue)
    const pv = Number(pennyValue)
    const pc = Number(pennyCount)
    // Only the ACTIVE mode's fields are required; the other mode's stored values are kept.
    if (reverse) {
      if (!Number.isFinite(pv) || pv <= 0) { setErr('Dollars per penny must be a positive number.'); return }
      if (!Number.isInteger(pc) || pc < 0) { setErr('Penny count must be a whole number of 0 or more.'); return }
    } else {
      if (!Number.isFinite(tv) || tv < 0) { setErr('True value must be a number of $0 or more.'); return }
    }
    // Send reverse + jar_image always, plus every numeric field that parses — so toggling
    // modes never silently drops the other mode's saved number.
    const patch: {
      reverse: boolean; jar_image: string
      true_value?: number; penny_value?: number; penny_count?: number
    } = { reverse, jar_image: jarImage.trim() }
    if (Number.isFinite(tv) && tv >= 0) patch.true_value = tv
    if (Number.isFinite(pv) && pv > 0) patch.penny_value = pv
    if (Number.isInteger(pc) && pc >= 0) patch.penny_count = pc

    setSaving(true); setErr(null); setMsg(null)
    try {
      await penniesUpdateConfig(patch)
      setMsg('Saved.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const navigate = useNavigate()
  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]
  const chrome = (body: React.ReactNode) => (
    <InstructorChrome title="Settings — Jar of Pennies" navLinks={navLinks} onNavigate={navigate}>
      <div style={{ maxWidth: 640 }}>{body}</div>
    </InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open settings from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }

  const fieldStyle = { width: '100%', fontSize: '1rem', padding: '0.5rem 0.6rem', borderRadius: 4, border: '1px solid #cbd5e1', boxSizing: 'border-box' as const }

  return chrome(
    <>
      {!loaded && !err && <p>Loading settings…</p>}
      {loaded && (
        <>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', color: colors.text }}>
              Auction type
            </label>
            <select
              data-testid="pennies-mode"
              value={reverse ? 'reverse' : 'forward'}
              onChange={e => setReverse(e.target.value === 'reverse')}
              style={fieldStyle}
            >
              <option value="forward">Forward — bidders guess the jar’s value (highest bid wins)</option>
              <option value="reverse">Reverse — suppliers bid to supply (lowest bid wins)</option>
            </select>
            <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
              {reverse
                ? 'Each penny represents a dollar cost. The lowest bidder wins the contract and earns their bid minus the true cost.'
                : 'Students bid on the money in the jar. The highest bidder wins and earns the true value minus their bid.'}
            </p>
          </div>

          {reverse ? (
            <>
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', color: colors.text }}>
                  Dollars per penny
                </label>
                <input
                  data-testid="pennies-penny-value"
                  type="number" min="0" step="1" value={pennyValue}
                  onChange={e => setPennyValue(e.target.value)} style={fieldStyle}
                />
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
                  What each penny in the jar is worth. Shown to students (“each penny represents ${pennyValue || '…'}”)
                  and used to read shorthand entries — a bid below this is read as that many pennies.
                </p>
              </div>
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', color: colors.text }}>
                  Penny count (secret)
                </label>
                <input
                  data-testid="pennies-penny-count"
                  type="number" min="0" step="1" value={pennyCount}
                  onChange={e => setPennyCount(e.target.value)} style={fieldStyle}
                />
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
                  The jar’s actual number of pennies — the secret suppliers estimate. True cost ={' '}
                  <strong>
                    {(() => {
                      const pc = Number(pennyCount), pv = Number(pennyValue)
                      return Number.isFinite(pc) && Number.isFinite(pv)
                        ? '$' + (pc * pv).toLocaleString('en-US')
                        : '—'
                    })()}
                  </strong>. Stored securely and never shown to students.
                </p>
              </div>
            </>
          ) : (
            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', color: colors.text }}>
                True value (USD)
              </label>
              <input
                data-testid="pennies-true-value"
                type="number" min="0" step="0.01" value={trueValue}
                onChange={e => setTrueValue(e.target.value)} style={fieldStyle}
              />
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
                The actual amount in the jar. Stored securely and never shown to students.
              </p>
            </div>
          )}

          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem', color: colors.text }}>
              Jar image (path)
            </label>
            <input
              data-testid="pennies-jar-image-path"
              type="text" value={jarImage}
              onChange={e => setJarImage(e.target.value)} style={fieldStyle}
            />
            <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
              Site-relative path, e.g. <code>/jarofpennies.jpg</code>. Change the jar and the true value to re-run.
            </p>
          </div>

          {err && <p style={{ color: '#c00' }}>{err}</p>}
          {msg && <p data-testid="pennies-save-msg" style={{ color: '#137333' }}>{msg}</p>}

          <button
            onClick={() => void handleSave()}
            disabled={saving}
            style={{
              padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              backgroundColor: saving ? '#999' : colors.text, color: colors.white,
              border: 'none', borderRadius: 6,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    </>,
  )
}
