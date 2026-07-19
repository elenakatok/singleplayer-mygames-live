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
  const [trueValue, setTrueValue] = useState('')
  const [jarImage, setJarImage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    penniesGetConfig()
      .then(cfg => {
        setTrueValue(String(cfg.true_value))
        setJarImage(cfg.jar_image)
        setLoaded(true)
      })
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load settings.'))
  }, [session.kind])

  const handleSave = async () => {
    const tv = Number(trueValue)
    if (!Number.isFinite(tv) || tv < 0) { setErr('True value must be a number of $0 or more.'); return }
    if (!jarImage.trim()) { setErr('Jar image path is required.'); return }
    setSaving(true); setErr(null); setMsg(null)
    try {
      await penniesUpdateConfig({ true_value: tv, jar_image: jarImage.trim() })
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
