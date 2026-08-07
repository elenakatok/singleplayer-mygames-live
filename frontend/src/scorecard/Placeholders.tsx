import { PageShell } from '../shared/PageShell'

// ═══════════════════════════════════════════════════════════════════════════════
// ⚠⚠ CHECKPOINT 3 REPLACES ALL THREE OF THESE. They exist only because App.tsx's
// per-game map requires a Play/Dashboard/Settings/Reports quartet, and scorecard needs a
// routing entry before its Play screen is reachable at all.
//
// ⚠ THEY MUST NOT BE LIVE WHEN ELENA DEPLOYS. The deploy is a CP4 step and CP3 lands
// first, so the sequence is safe — but if anything ever reorders that, an instructor
// would open Settings and find this page. Each one therefore SAYS SO, in as many words,
// rather than rendering an empty shell that reads as a broken page.
//
// Checkpoint 3 builds, per spec §11 and §3.1:
//   Dashboard — the instructor's live roster
//   Settings  — the config form AND the §3.1 induced-behaviour panel (which already
//               exists server-side: functions scorecard/validate.ts inducedBehaviour)
//   Reports   — Tier 1 roster, Tier 2 free text, Tier 3 class charts
// ═══════════════════════════════════════════════════════════════════════════════

function NotYet({ page, builds }: { page: string; builds: string }) {
  return (
    <PageShell>
      <h2 style={{ marginTop: 0 }}>Supplier Scorecard — {page}</h2>
      <p style={{ color: '#a00', fontWeight: 600 }}>
        This page is not built yet.
      </p>
      <p style={{ color: '#444' }}>
        The Scorecard game is mid-build: the student flow is complete, and {builds} arrives
        at Checkpoint 3. If you are seeing this in a live class, the game was deployed
        early — please tell Elena.
      </p>
    </PageShell>
  )
}

export function ScorecardDashboard() {
  return <NotYet page="Dashboard" builds="the instructor roster" />
}

export function ScorecardSettings() {
  return (
    <NotYet
      page="Settings"
      builds="the configuration form and the induced-behaviour panel"
    />
  )
}

export function ScorecardReports() {
  return <NotYet page="Reports" builds="all three report tiers" />
}
