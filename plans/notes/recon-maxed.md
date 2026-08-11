# telemetry in maxed — recon

> **Not a design input. Not read by the build.**
>
> `product-ideas.md` is the specification and the build plan; it wins every
> conflict, and nothing in this file describes what to build. The design
> questions this recon existed to answer are closed, and everything worth
> carrying was folded into the spec on its own merits.
>
> What survives here has one job each: **facts about the MaxMarketing repo**,
> for the host's migration onto the package — a separate job, after
> extraction — and **one bug found in that repo**, which still needs filing
> against it per `standards/done.md`.
>
> The shapes described below (stored milestones, dedupe machinery, a closed
> type enum, a checkpoint collection, a hand-applied admin filter) are
> deliberately not carried forward.

Source: `~/Projects/Amplify11/MaxMarketing`, branch `main`.
Read-only. The repo had 38 pre-existing modified files at recon time; nothing
here touched any of them.

---

## Framing: this is an audit, not a spec source

`product-ideas.md` was written *from* this rebuild and names its v1 bugs
directly — the conflated actor/subject, the `saw_first_data` page-view
derivation, the single-membership account guess. Recon is not going to
discover the design; the design already absorbed it.

So this document answers three narrower questions:

1. **Does the config surface in `product-ideas.md` cover what actually
   exists?** (Mostly yes — §Delta lists the misses.)
2. **What does the reference implementation know that the design doc
   doesn't say?** (§What maxed contributes — eight items, one of them
   important.)
3. **What in the design has no implementation behind it at all?**
   (§Unproven — most of the config surface. That is the real risk.)

---

## Surface

| Area | Files | ~Lines |
|---|---|---|
| Vocabulary | `src/shared/telemetry/events.ts` | 177 |
| Engine | `src/server/telemetry/{recordEvent,context,queries,funnel,checkpoint}.ts` | 770 |
| Batch | `src/server/telemetry/{nightlySweep,maileryBridge}.ts` | 1,076 |
| Models | `src/server/models/{UserEvent,UserEventDaily,AccountStateDaily}.ts` | 282 |
| Ingest route | `src/server/routes/events.ts` | 196 |
| Read API | `src/server/routes/adminTelemetry.ts` | 1,337 |
| Client SDK | `src/client/src/utils/telemetry.ts` | 111 |
| Admin UI | `src/client/src/views/AdminTelemetryView.vue` | 1,898 |
| Verify harness | `src/server/scripts/telemetry-verify.ts` | 427 |
| **Total** | | **~6,274** |

Plus **28 emitter call sites** in 10 files outside the feature — `auth.ts` (7),
`billing.ts` (5), `stripe-webhook.ts` (4), `aeo-v2.ts` (3),
`connectionRequests.ts` (2), `shopify.ts` (2), `events.ts` (2), `trial.ts`,
`connectionTrialHook.ts`, `autoSignIn.ts`. Client emitters: `main.ts` (the
single `page.view` router hook), `PlansView`, `AeoTopicCreateView`,
`AeoDashboardView`.

`sources.yaml` estimated "~1,400 lines core, ~1,900 admin view." The admin view
is exact; core is **~2,500** once the batch layer and models are counted, which
matters because `product-ideas.md`'s size estimate benchmarks against the 1,400
figure.

---

## Host couplings → candidate adapters

| Coupling | Where | Adapter shape | In the design? |
|---|---|---|---|
| Auth / identity | `context.ts` → `req.user`, `AccountMembership` | `actor(req) → { type, id, role, canAccess }` | ✅ `actor` |
| Membership authorization | `context.ts:52` — claimed accountId checked against `AccountMembership` | folded into `canAccess` | ✅ |
| Auth middleware | `routes/events.ts:71`, `adminTelemetry.ts:78` — `requireAuth`, `requireAdmin` | host mounts the guard | ✅ (mailery principle) |
| Logger | every file — `../logger` (pino) | `logger` adapter | ✅ |
| Subject state | `nightlySweep` → `billing/lifecycle.ts`, `AccountSubscription`, AEO models | `state(id)` per subject type | ✅ `state` |
| Subject enumeration | `nightlySweep` enumerates `clientAccountModel` | `find(criteria)` + host-owned sweep | ✅ `find` |
| Subject labels | `adminTelemetry` → `clientAccountModel`, `User` | `describe(ids)` | ✅ `describe` |
| CRM write-back | `maileryBridge` → `CrmActivity`, `deriveEngagement` | `on(name, fn)` hook | ✅ Hooks |
| External scanner state | `checkpoint.ts` — watermark for `mailer_sends` | **nothing** | ❌ see Delta |
| Surface detection | `context.ts:66` — `_shopifyBearerShop` → `shopify_embedded` | `via`, stamped per writer | ✅ superseded |
| Rate limiter | `routes/events.ts:58` — `express-rate-limit`, keyed by user id | per-writer limits | ✅ Writers |
| Plan/lifecycle vocabulary | `shared/billing/plans.ts`, `shared/crm/enums.ts` | host config, not package | ✅ |

**Every adapter the design names is exercised here, and one adapter the design
lacks is exercised here.** That is the recon's definition-of-done met.

---

## Mount points

| Route prefix | Mounted in | Behind |
|---|---|---|
| `/api/events` | `src/server/index.ts:359` | own `router.use(requireAuth)`; mounted *before* the app-wide `/api` auth at :386 |
| `/api/admin/telemetry` | `src/server/index.ts:369` | `router.use(requireAuth, requireAdmin)` at `adminTelemetry.ts:78` |

Both guard themselves rather than relying on the mount. Body parsing is
app-wide (`express.json({ limit: '10mb' })` at :184), which is why the beacon
carries its own 2 KB content-length wall — a package-owned parser would be
traps #5.

The nightly job is not a route: `src/queue/aeo.ts:1353` dynamically imports
`runTelemetryNightly`. Scheduling lives entirely in the host, which is what the
design already requires.

---

## Woven together with

- **`nightlySweep` is four jobs in one** (`nightlySweep.ts:1-24`). Only legs 1
  and 3 are telemetry. Leg 2 also stamps `dataReady*` columns on
  `ClientAccount` and writes BigQuery; leg 0 stamps CRM columns. Extracting the
  package cuts through the middle of this function — the host keeps a sweep that
  calls `telemetry.refresh()` and then does its own CRM/BigQuery work.
- **`maileryBridge` is a CRM feature wearing a telemetry hat.** Of its 529
  lines, the `email.*` event emission is maybe a third; the rest stamps
  `firstEmailSentAt`/`lastContactedAt` and writes `CrmActivity`. In the package
  this splits: events via a host-run importer, CRM writes via `on()`.
- **`AccountStateDaily` serves telemetry and finance.** It backs funnel-as-of-
  last-month *and* MRR-over-time. The host will want it after extraction
  regardless of what the package stores.
- **`adminTelemetry.ts` merges CRM activity into the account timeline**
  (`CrmActivity` at :53). The drawer shows both streams; only one is ours.

---

## Capabilities

**Present:** page views · once-per-account milestones (stored, dedupe-key
enforced) · one hardcoded 7-stage funnel with 2 exits · cohort funnels by ISO
week/month · median time-to-stage and time-from-previous · stuck-at drill-down ·
raw event explorer with cursor pagination · per-account and per-user timelines ·
byName/byPage/byAccount/bySource/byType breakdowns · daily rollup with a
live-today splice · daily state snapshots · lifecycle transition detection ·
email lifecycle bridge · actor-role labeling with admin exclusion · meta
sanitization and size cap · query result caching · a 427-line verification
harness.

**Absent:** anonymous subjects and identity stitching (the beacon is behind
`requireAuth`, so the funnel starts at signup *by construction*) · any subject
type other than the hardcoded `userId`/`accountId` pair · multiple funnels ·
writers · `forget`/erasure of any kind · retention curves · sampling · throttle ·
aliases · redaction · relations · event TTL or any retention policy · a client
buffer (single `fetch` per event, `keepalive: true`) · a CLI.

**Shape of the key decisions** — this is what the design generalized:

| Decision | maxed's shape | Design's shape |
|---|---|---|
| Subject | hardcoded `userId` + `accountId` columns | declared subject types |
| Milestone | **stored** rows, `type: "milestone"`, dedupe key `milestone:{acct}:{key}`, partial-unique index | **derived** at query time, `firsts` table as cache |
| Funnel | one, `MILESTONES` const, compile-time | `funnels: {}` config, N per host |
| Taxonomy | closed `type` enum + `as const` client allowlist | freeform names, compile-time types only |
| Admin exclusion | `customerMatch()` called by hand at each site | `exclude: { actorRole: ['admin'] }` config |
| Writers | two implicit paths (in-process, browser) | declared writers with per-writer allow/backdate |
| Ingest trust | `requireAuth` on the beacon | per-writer, `anon: true` optional |
| Rollup | one grain `(day, type, name)` | open question in the design |

---

## What maxed contributes that `product-ideas.md` does not already say

Eight items. Ranked by whether they change the build plan.

**1. The rollup splice contract, and what may not be spliced.**
`adminTelemetry.ts:9-21` states a rule the design does not contain:
`UserEventDaily.userCount`/`accountCount` are distinct-*within*-a-day and are
**not summable** across days or across names — a user active Mon and Tue is one
user; a user who fired two event names the same day is one user. So DAU/WAU/MAU
and every distinct count read raw, always, regardless of window. Any filter the
rollup has no dimension for (accountId, userId, source, route, lifecycle)
forces the whole window to raw. This is the sharpest thing in the
implementation and it bears directly on the design's open question about rollup
grain. **Carry it verbatim.**

**2. The response reports which store answered it.** Every spliced endpoint
returns `dataSource`. A number whose provenance is invisible is a number nobody
can debug. Cheap, and not in the design.

**3. A checkpoint primitive for incremental external scanners.**
`checkpoint.ts` — 64 lines, `(key) → high-water mark`, advisory because every
downstream writer is idempotent, and deliberately rewound by a safety overlap
each run. The design covers *push* (`on()`, at-least-once) but has no answer for
*pull*: "scan a foreign collection incrementally and backfill events from it."
The mailery bridge is exactly that, and the design files it under Hooks, which
is the wrong slot. Either it is a documented host pattern or it is a primitive —
**decide in the build plan.**

**4. Index-readiness gating on the first deduped write.**
`recordEvent.ts:73-81`: Mongoose builds indexes asynchronously, so on a cold
database the first writes land *before* the unique index exists and duplicate
silently — invisible until someone reads a doubled funnel. `Model.init()` is
awaited once per process and cached. The design's `firsts` table has a unique
`{subject, name}` index and inherits this failure mode exactly. (Foundry
`standards/traps.md` #3 is the general form; the design's write path doesn't
mention it.)

**5. Drop meta, never truncate.** `recordEvent.ts:87-109` and
`routes/events.ts:98-118`, with the reason stated twice: *a truncated object is
a lie — a partial id reads as a real one; a missing one is honestly missing.*
A 4 KB serialized cap plus a shape guard (scalars only, ≤12 keys, ≤200-char
strings, one nesting level). The design has `redact` (removes known-bad) but no
bound on the unknown. Different mechanisms; both wanted.

**6. A telemetry endpoint has exactly one failure mode.** `routes/events.ts`
answers **204 before doing any work**, 204 on rate-limit, 204 on oversized body,
204 on an unknown event name. Never 4xx: *"a telemetry 4xx surfacing in the
console reads to everyone downstream as a broken page."* Rate limiting keys on
user id, not IP, so one office behind a NAT doesn't limit itself. The design
covers limits and caps at principle level; it does not state the
never-return-an-error invariant or the respond-first ordering.

**7. Funnel semantics that the design leaves open.** From `funnel.ts:24-33`:
stages are ordered but **not gated** — an account can reach stage 6 without
stage 2 (deep link, or an operator did it for them), so a later stage may
legitimately exceed an earlier one, and that is a data fact rather than a bug.
The cohort window bounds the **signup date only**; later milestones are
collected with no upper bound, so a conversion after the window still counts for
the cohort that produced it. Also concrete: `stuckAccounts`, `pctOfPrevious`,
`medianDaysFromSignup`, `medianDaysFromPrevious`, and UTC ISO-week cohort keys.

**8. A standalone verification harness.** `telemetry-verify.ts`, 427 lines,
asserts dedupe under re-run, admin rows never reaching the funnel, and funnel
math against fixtures. `standards/testing.md` wants exactly this for
multi-source extractions; here it exists already and should become the package's
suite rather than being rewritten.

Two smaller ones, noted and not elaborated: query caching (10-min TTL,
in-flight coalescing, 60-entry cap) and the throttled `lastSeenAt` liveness
stamp (15 min, single round trip via the filter, `timestamps: false`) — the
latter is host domain and the package should say so out loud, since the beacon
route currently owns it.

---

## Unproven: design surface with no implementation behind it

Zero lines of maxed exercise any of these:

anon subjects · `link()` · `forget()` / `keepCounts` · writers · `sample` ·
`throttle` · `aliases` · `redact` · `belongsTo` / relations · dotted-path
`where` · `retention()` · `firsts` · `stamp` · multiple funnels · multiple
subject types · the CLI · `on()` · `stats()` · `onSlowQuery` ·
`dashboard.links` / `views`.

That is most of the config surface. It isn't wrong — it's a one-implementation
extraction, so per `README.md` there is no second data point to diff against and
the divergence table that normally derives config doesn't exist. The design
compensated by reasoning from the category instead, which is legitimate and is
also why its own Sequencing step 1 says: *express maxed's current taxonomy as
config, and if it needs special cases, the config layer isn't real.*

**That test is the highest-value thing the build plan can do**, and it can be
done on paper before any code: write maxed's 7 milestones, 2 exits, 5 client
event names, admin exclusion, and account/user subjects as a literal config
block. Anything that doesn't fit is a design bug found for free.

---

## Smells / suspected bugs

Recorded, not fixed.

**1. `recordEvents()` silently drops `actorRole` and `surface`. Real, live.**

`recordEvent.ts:203-212` builds its bulk documents from `userId, accountId,
type, name, at, source, meta, dedupeKey` — `actorRole` and `surface` are in
`RecordEventArgs` and in the single-row path at :120-132, but not in the bulk
mapping. The schema defaults `actorRole` to `"user"`.

Both bulk callers explicitly set it, with a comment explaining why:
`nightlySweep.ts:303` and `maileryBridge.ts:158`, both `actorRole: "system" as
const`. Every lifecycle and email row therefore lands as `actorRole: "user"`.

Blast radius today is contained but real:
- `customerMatch()` is `{ $ne: "admin" }`, so aggregate *counts* are unaffected —
  `system` and `user` both pass. This is luck, not design.
- The events explorer returns `actorRole` per row (`adminTelemetry.ts:900`) and
  offers it as a filter (`:1326`). Every bridged and swept row is mislabeled as
  customer-produced on the one surface built to show provenance.
- Latent: the moment any aggregate filters `actorRole: "user"` — which
  `UserEvent.ts:79-81` incorrectly claims `customerMatch()` already does — system
  rows silently join customer numbers.

For the package this argues one thing: **the bulk path must not be a second
implementation of the row builder.** One function builds a document; the bulk
writer maps over it.

**2. Doc/code divergence on `customerMatch`.** `UserEvent.ts:79-81` says
customer-facing aggregates "filter on `actorRole: "user"`". `queries.ts:38`
implements `{ $ne: "admin" }`, and `queries.ts:18-32` argues at length why `$ne`
is the correct choice. The model comment is stale and describes a filter that
would drop every webhook conversion. Harmless today, and it is exactly the
comment someone will implement from later.

**3. `mongoose.model()` claimed unconditionally.** `UserEvent.ts:142`,
`UserEventDaily`, `AccountStateDaily`, `checkpoint.ts:35`. Correct for an app,
fatal for a library — `OverwriteModelError` on a second call. Foundry
`standards/traps.md` #2; the template's `model-factory.js` already fixes it.
Noting it so the port doesn't copy the pattern across.

**4. No retention policy on `userevents`.** No TTL index, no purge job, nothing
in the nightly sweep. The design's `keep: { events: '90d' }` has no counterpart
here, and `notes-high-volume.md` treats unbounded growth as the central risk.
Not a bug in an app that has run months; a bug in a package that ships.

**5. `/breakdown` `byAccount` slices in memory.** `adminTelemetry.ts:820` —
`.slice(0, limit)` after an unbounded fetch, where the sibling aggregations use
`{ $limit }` inside the pipeline. Cap is applied, but after the rows are already
in the process.

---

## Next

Single implementation, so per `process/1-recon.md:95` synthesis is skipped —
there is nothing to diff. Straight to `/build-plan telemetry`.

The build plan should open with the paper test from §Unproven, then resolve the
two decisions this recon surfaced: whether the checkpoint watermark is a
primitive or a documented host pattern, and whether `keep`/TTL ships in v1 or
waits.

`sources.yaml` updated: `paths`, `has`, `lacks` filled for this implementation.
