import type { ReactNode } from 'react'
import { GameHeader, colors, shadows, layout, spacing } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// InstructorChrome — the single-player family's instructor page shell: the shared
// GameHeader, a sticky action bar, and a centered content area with a title. It is
// PURELY PRESENTATIONAL — everything is passed in as props, there is NO game logic,
// NO callable name, NO roster/matching/attendance/RTDB. It reuses the platform theme
// tokens so it matches the multiplayer dashboards' chrome pixel-for-pixel, but shares
// none of the shared InstructorDashboard's multiplayer machinery (which pennies, poll,
// and newsvendor don't have).
//
// The action bar's buttons are CALLER-SUPPLIED (`actions`), because the set differs per
// game: Jar of Pennies has a Score & Record button; a Poll has none. Nav links (e.g.
// Settings, Reports) are data + an onNavigate callback so the caller owns routing.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChromeNavLink {
  label: string
  /** Target href (the caller preserves any ?token=/?_gid= query params). */
  href: string
}

export function InstructorChrome({
  title,
  actions,
  navLinks,
  onNavigate,
  children,
}: {
  title: string
  /** Caller-supplied action-bar content (buttons, counts, messages). Omit for none. */
  actions?: ReactNode
  /** Nav buttons rendered on the right of the action bar. */
  navLinks?: ChromeNavLink[]
  /** Invoked with a nav link's href when clicked (caller wires client-side routing). */
  onNavigate?: (href: string) => void
  children: ReactNode
}) {
  const hasActions = actions != null
  const hasNav = navLinks != null && navLinks.length > 0

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <GameHeader />

      {(hasActions || hasNav) && (
        <div style={{
          position: 'sticky',
          top: 48,
          zIndex: 10,
          background: colors.white,
          borderBottom: `1px solid ${colors.borderMid}`,
          boxShadow: shadows.bar,
        }}>
          <div style={{
            maxWidth: layout.maxWidth,
            margin: '0 auto',
            padding: layout.actionBarPad,
            display: 'flex',
            alignItems: 'center',
            gap: spacing.gapBtn,
            flexWrap: 'wrap',
          }}>
            {actions}
            {hasActions && hasNav && (
              <div style={{ width: 1, alignSelf: 'stretch', background: colors.border, margin: '0 0.25rem' }} />
            )}
            {hasNav && navLinks!.map(l => (
              <button key={l.href} onClick={() => onNavigate?.(l.href)}>{l.label}</button>
            ))}
          </div>
        </div>
      )}

      <main style={{ maxWidth: layout.maxWidth, margin: '0 auto', padding: `1.5rem ${layout.pagePad} 3rem` }}>
        <h1 style={{ marginTop: 0, marginBottom: spacing.gapXl, fontSize: '1.25rem', fontWeight: 600 }}>{title}</h1>
        {children}
      </main>
    </div>
  )
}
