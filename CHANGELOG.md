# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [0.3.0]

### Added
- `beforeSend` on `CreateClientOptions` — the last gate before a record joins
  the queue, and the one place every kind passes through. Return the record to
  keep it, a modified copy to redact it, `null` to drop it. A throwing hook
  drops the record and reports via `onError` (fail-closed: a half-applied
  redaction that still ships is worse than a lost record).
- `/web`: `ignoreErrors` (strings match by substring, RegExp by `test`) and
  `BENIGN_BROWSER_ERRORS`, the browser-raised non-errors filtered by default.

### Changed
- **`/web` now drops `ResizeObserver loop completed with undelivered
  notifications` (and `loop limit exceeded`) by default.** Chrome raises these
  as uncaught errors when an observer callback dirties layout; nothing is
  broken and nothing is actionable, but they fire often enough to bury real
  errors — one production host saw 49 of its last 50 error records come from
  this one message. Hosts that were counting them will see the count go to
  zero; `captureBenignErrors: true` restores the old behavior.

  Filtering here rather than at the platform edge is the point: swallowing
  `window.onerror` before the SDK sees it means winning a listener-registration
  race, and it misses every `captureError()` the app calls directly.

## [0.1.0] — first release

### Added
- Server core: host-owned registry, discriminated envelope (event / error /
  span / state / usage) on one Mongo collection, the rollup primitive, `emit()`,
  `forget()`, checkpoints.
- Write contract: idempotent `emit()` via `dedupeKey`, declarable durability
  (`EventSpec.durable` / per-call override), `EmitResult` outcomes, a boot
  warning when a spec's `data` inherits a finite TTL it never chose, and a
  stated cap + truncation marker on `body`.
- Ingest router and isomorphic client core, with adapters for web, React, Vue,
  Electron, and CLI. `pk_`/`sk_` key model; a publishable key never returns 4xx.
- Dashboard: six query primitives (records, series, distribution, rollups,
  trace, journey, funnel) plus `distinctCount`, the `ViewSpec` system, and the
  full React SPA.
- Cohort funnels ported from a real production host and proven against it cell
  by cell, and exact distinct counts with no approximation.
- A platform scope (`Viewer.tenantId: '*'`) for cross-tenant reads, authorized
  entirely by the host's `viewerAdapter` — `'*'` is reserved on every write path.
- `scripts/check-exports.mjs`, which diffs the built bundle against the
  hand-written `types/` declarations so the published contract cannot drift
  from what the package actually ships.
- Full VitePress documentation.
