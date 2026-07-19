import type { ReactNode } from 'react'
import { GameHeader, typography } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// PageShell — the single-player family's page chrome. Shared GameHeader (the myGames
// logo header; no role-sheet links — this family has no roles) plus a centered
// <main> that is fluid and responsive (the `.sp-main` class carries the media query;
// these games are played on phones outside class). Matches eBay's shell shape.
// ═══════════════════════════════════════════════════════════════════════════════

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader />
      <main className="sp-main">{children}</main>
    </div>
  )
}
