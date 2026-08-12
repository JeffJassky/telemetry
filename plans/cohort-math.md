# Cohort / funnel math — extracted from maxed

Recon target: `src/server/scripts/telemetry-verify.ts` (the harness) and the code it
exercises. **The harness itself contains no funnel math.** It is an assertion driver;
every formula lives in the modules it imports. Sources, all under
`/Users/jeffjassky/Projects/Amplify11/MaxMarketing/`:

| file | role |
| --- | --- |
| `src/server/telemetry/funnel.ts` | **all** cohort/funnel math (`loadFunnelIndex`, `summarizeStages`, `median`, `cohortKey`, `accountsStuckAt`, `summarizeExits`) |
| `src/server/telemetry/queries.ts` | `customerMatch()` — the admin-exclusion predicate |
| `src/shared/telemetry/events.ts` | stage list + order, exit list, actor roles |
| `src/server/telemetry/recordEvent.ts` | dedupe key construction (`milestone:{accountId}:{key}`) — the once-per-account guarantee the math depends on |
| `src/server/models/UserEvent.ts` | field defaults + the partial-unique index that enforces it |
| `src/server/routes/adminTelemetry.ts` | how the cohort window is derived from a request; cohort slicing |
| `src/server/scripts/telemetry-verify.ts` | the known-answer fixture (§6) and the admin-exclusion assertion (§5) |

Stage list, in funnel order (`events.ts:62-70`), `order = i + 1`
(`funnel.ts:54-59`):

```
1 signed_up   2 wizard_started   3 topic_finalized   4 saw_first_data
5 plans_viewed   6 plan_selected   7 converted
```

Exits are **not** stages (`events.ts:136-147`): `trial_expired`
(`lifecycle.trial_expired`), `subscription_deleted`
(`billing.subscription_deleted`).

---

## 1. Every computed quantity, as a formula

Notation: `A` = the set of `AccountFunnel` objects passed to `summarizeStages`.
`stage(a, k)` = `a.stages[k]`, present or absent. `t(a, k)` =
`a.stages[k].at.getTime()`. `DAY_MS = 86_400_000` (`funnel.ts:254`).

### 1.1 Cohort membership — who is in `A`

`loadFunnelIndex` (`funnel.ts:125-193`). Two reads.

**Query A — the cohort** (`funnel.ts:135-142`), verbatim:

```ts
const signupMatch = customerMatch({
  type: "milestone",
  name: SIGNUP_EVENT_NAME,                      // "milestone.signed_up"
  at: { $gte: cohortStart, $lte: cohortEnd },
  accountId: scope ? { $in: scope } : { $ne: null },
});
```

```
A = { accountId : ∃ row with
        row.actorRole ≠ "admin"                 (customerMatch, queries.ts:38)
      ∧ row.type    = "milestone"
      ∧ row.name    = "milestone.signed_up"
      ∧ cohortStart ≤ row.at ≤ cohortEnd        ← CLOSED on both ends
      ∧ row.accountId ∈ scope  (or ≠ null when no scope) }
```

Inputs read: `actorRole`, `type`, `name`, `at`, `accountId`.

`signupAt(a) = row.at` of that signup row (`funnel.ts:149`), and
`stages.signed_up` is seeded from the same row (`funnel.ts:150`) — stage 1 is
therefore *always* present for every member of `A`.

`accounts: []` short-circuit when the cohort is empty (`funnel.ts:154-156`).

**Query B — every other stage + exits** (`funnel.ts:161-171`), verbatim:

```ts
customerMatch({
  accountId: { $in: cohortIds },
  at: { $gte: cohortStart },                     // ← lower bound, NO upper bound
  $or: [
    { type: "milestone", name: { $in: MILESTONE_EVENT_NAMES } },
    { name: { $in: FUNNEL_EXIT_EVENT_NAMES } },
  ],
})
```

```
stage(a, k) present  ⟺  ∃ row: row.accountId = a
                          ∧ row.actorRole ≠ "admin"
                          ∧ row.type = "milestone" ∧ row.name = "milestone."+k
                          ∧ row.at ≥ cohortStart                (no upper bound)
stage(a, k).at       =  min over such rows of row.at            (funnel.ts:180-181)
exit(a, e).at        =  min over rows with row.name = e.eventName ∧ at ≥ cohortStart
                                                                (funnel.ts:184-189)
```

The `min` is written as `if (!prev || r.at < prev.at)` — **strictly** less-than, so
on a tie the first row in Mongo's return order wins (only `at` is retained, so the
result is unaffected). Query B is issued **without `.sort()`**.

### 1.2 `median` — `funnel.ts:247-252`, verbatim

```ts
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
```

```
median(∅)        = null
median, n odd    = s[⌊n/2⌋]
median, n even   = (s[n/2 − 1] + s[n/2]) / 2          ← arithmetic mean of the two middles
```

No rounding. Numeric sort comparator (not lexicographic).

### 1.3 `summarizeStages` — `funnel.ts:276-319`

Emits **one row per stage in `FUNNEL_STAGES`, always all 7**, even when the count
is 0. Iteration carries `prevKey` = the immediately preceding stage key, `null`
for stage 1.

Per stage `k` with predecessor `p`:

| quantity | formula | source |
| --- | --- | --- |
| `reached` (set) | `{ a ∈ A : stage(a,k) present }` | `funnel.ts:281` |
| `accounts` | `\|reached\|` | `funnel.ts:308` |
| `first` | `\|{ a ∈ A : stage(a, "signed_up") present }\|` | `funnel.ts:303` |
| `pctOfFirst` | `first > 0 ? (\|reached\| / first) × 100 : null` | `funnel.ts:310` |
| `prevReached` | `p ? \|{ a ∈ A : stage(a,p) present }\| : —` | `funnel.ts:292-296` |
| `pctOfPrevious` | `p == null ? null : (prevReached > 0 ? (\|reached\| / prevReached) × 100 : null)` | `funnel.ts:311` |
| `fromSignup` (sample) | `[ (t(a,k) − signupAt(a).getTime()) / DAY_MS  for a ∈ reached, signupAt(a) ≠ null ]` | `funnel.ts:283-287` |
| `medianDaysFromSignup` | `median(fromSignup)` | `funnel.ts:312` |
| `fromPrev` (sample) | `[ (t(a,k) − t(a,p)) / DAY_MS  for a ∈ A with **both** p and k present ]` | `funnel.ts:293-299` |
| `medianDaysFromPrevious` | `p ? median(fromPrev) : null` | `funnel.ts:313` |
| `stuckAccounts` | `p == null ? 0 : \|{ a ∈ A : stage(a,p) present ∧ stage(a,k) absent }\|` | `funnel.ts:292-300, 314` |

Verbatim, the two subtle lines:

```ts
pctOfPrevious: prevKey ? (prevReached > 0 ? (reached.length / prevReached) * 100 : null) : null,
```

```ts
if (prevKey) {
  for (const a of accounts) {
    const p = a.stages[prevKey];
    if (!p) continue;
    prevReached += 1;
    const cur = a.stages[st.key];
    if (cur) fromPrev.push((cur.at.getTime() - p.at.getTime()) / DAY_MS);
    else stuck += 1;
  }
}
```

Note `pctOfPrevious`'s numerator is `reached.length` — **all** accounts that
reached `k`, including those that never reached `p` — while the denominator counts
only accounts that reached `p`. It is a ratio of two independent counts, not a
conversion rate, and can exceed 100 (see §2.4).

Percentages are on a **0–100** scale, unrounded floats. Days are **fractional**
floats, unrounded, and may be negative if a stage timestamp precedes its
predecessor's.

### 1.4 `summarizeExits` — `funnel.ts:327-333`

```
accounts(e) = |{ a ∈ A : a.exits[e] present }|
```

One row per entry in `FUNNEL_EXITS`, in declaration order, always emitted.

### 1.5 `accountsStuckAt` — `funnel.ts:336-341`, verbatim

```ts
export function accountsStuckAt(accounts: AccountFunnel[], key: MilestoneKey): AccountFunnel[] {
  const idx = FUNNEL_STAGES.findIndex((s) => s.key === key);
  if (idx < 0) return [];
  const next = FUNNEL_STAGES[idx + 1];
  return accounts.filter((a) => a.stages[key] && (!next || !a.stages[next.key]));
}
```

```
stuckAt(k) = { a ∈ A : stage(a,k) present ∧ (k is last stage ∨ stage(a, next(k)) absent) }
```

**This is a different definition of "stuck" from `StageSummary.stuckAccounts`.**
`stuckAccounts` on the row for stage `k` = accounts that reached `k−1` and not `k`
(drop-off *into* `k`). `accountsStuckAt(k)` = accounts that reached `k` and not
`k+1` (drop-off *out of* `k`). Related by
`|accountsStuckAt(k)| = stuckAccounts(next(k))` for every non-terminal `k`; for the
terminal stage `converted` the `!next` clause makes every converted account "stuck",
which is almost certainly not intended (§2.7).

### 1.6 `cohortKey` — `funnel.ts:233-245`

```
grain = "month" → d.toISOString().slice(0, 7)          e.g. "2026-07"
grain = "week"  → ISO-8601 week-year + week number      e.g. "2026-W31"
```

The week branch verbatim:

```ts
const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayNum = (t.getUTCDay() + 6) % 7;                       // Mon=0 … Sun=6
t.setUTCDate(t.getUTCDate() - dayNum + 3);                    // → Thursday of this week
const isoYear = t.getUTCFullYear();
const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000));
return `${isoYear}-W${String(week).padStart(2, "0")}`;
```

Everything is UTC. Time-of-day is discarded. Weeks start Monday. Applied to
`a.signupAt` only; accounts with `signupAt === null` are dropped from the cohort
slices (`adminTelemetry.ts:660-666`).

### 1.7 Where the cohort window comes from

`adminTelemetry.ts:648` — `cohortStart = f.start`, `cohortEnd = f.end`, i.e. the
same window the rest of the dashboard uses. `parseFilters`
(`adminTelemetry.ts:150-181`):

```ts
if (q.start && q.end) {
  start = new Date(`${q.start}T00:00:00.000Z`);
  end   = new Date(`${q.end}T23:59:59.999Z`);
} else {
  const window = days && days > 0 ? days : 7;
  end = new Date();                                  // NOW, not end-of-day
  start = new Date();
  start.setUTCDate(start.getUTCDate() - (window - 1));
  start.setUTCHours(0, 0, 0, 0);
}
```

All UTC. Explicit ranges are whole UTC days, closed. The default range's `end` is
the current instant, so the window is not day-aligned at the top.

### 1.8 Stuck drill-down (route level) — `adminTelemetry.ts:684-699`

```
list  = accountsStuckAt(A, stuckAt)
sort  = descending by stages[stuckAt].at        (most recent arrival first)
slice = first 200
daysSinceReached = (Date.now() − stages[stuckAt].at.getTime()) / 86_400_000
```

`daysSinceReached` is a **display field**, not a filter — see §2.7.

### 1.9 The once-per-account guarantee the math rests on

`recordEvent.ts:186`:

```ts
dedupeKey: `milestone:${args.accountId}:${args.key}`
```

against the partial-unique index `{ dedupeKey: 1 }` with
`partialFilterExpression: { dedupeKey: { $type: "string" } }`
(`UserEvent.ts:137-140`). So at most one row per `(accountId, milestoneKey)` —
which is why `loadFunnelIndex` needs no `$min` and calls the in-memory
`r.at < prev.at` guard a belt-and-braces for the index-build race
(`funnel.ts:179-180`).

---

## 2. Edge-case semantics, as rules

**R1 — Median of an even-length set: arithmetic mean of the two middles.**
`(s[n/2 − 1] + s[n/2]) / 2` (`funnel.ts:251`). Not the lower middle. Not
interpolated otherwise.

**R2 — Median of an empty set: `null`.** Not `0`, not omitted. The key is always
present in the emitted object with value `null` (`funnel.ts:248`). Same for
`medianDaysFromPrevious` on stage 1, which is `null` *by construction* rather than
by empty-set (`funnel.ts:313`) — indistinguishable in the output.

**R3 — `pctOfPrevious` when the previous count is 0: `null`.** Not `0`, not
`Infinity`, not `NaN` (`funnel.ts:311`). Stage 1 is also `null` (no predecessor
exists). `pctOfFirst` follows the same shape: `null` when `first === 0`
(`funnel.ts:310`), otherwise `0` is a legitimate value.

**R4 — The funnel is LITERAL, never backfilled or monotonic.** A subject is
counted at stage N **only** if a `milestone.{N}` row exists for it. Reaching N+1
does not imply N. Stated in the file header (`funnel.ts:24-28`):

> Stages are ordered but NOT gated: an account can reach stage 6 without a
> recorded stage 2 (deep link, or an operator did it for them). Each stage reports
> its own count, so a later stage can legitimately exceed an earlier one — a data
> fact, not a bug.

Consequences a reimplementation must reproduce: stage counts are **not** required
to be non-increasing; `pctOfPrevious` may exceed 100; a skipping subject
contributes to `accounts` for the later stage but not to `prevReached`,
`fromPrev`, or `stuckAccounts` for it.

**R5 — Cohort assignment is by the `signed_up` MILESTONE specifically, never by
first event.** `name: "milestone.signed_up"` with `type: "milestone"`
(`funnel.ts:136-137`). An account whose earliest event is a page view three weeks
before signup is still assigned by the signup row. An account with **no**
`milestone.signed_up` row inside the window is **absent from the cohort entirely** —
all of its other milestones are invisible, not counted at any stage.

**R6 — The cohort window is CLOSED on both ends, in UTC.**
`{ $gte: cohortStart, $lte: cohortEnd }` (`funnel.ts:138`). A signup at exactly
`cohortStart` is in; a signup at exactly `cohortEnd` is in. UTC throughout — every
boundary is built with `Date.UTC` / `…T00:00:00.000Z` / `setUTCHours`
(`adminTelemetry.ts:158-165`), and `cohortKey` uses only `getUTC*`
(`funnel.ts:235-243`). No local-time path exists anywhere in this stack.

**R7 — Stages are collected with lower bound `cohortStart` and NO upper bound.**
`at: { $gte: cohortStart }` (`funnel.ts:163`). Two consequences:

- *No upper bound:* a `converted` landing months after `cohortEnd` still counts for
  its cohort. Deliberate and asserted (`telemetry-verify.ts:371-374`,
  "conversions landing after the cohort window still count").
- *Lower bound:* a milestone whose `at` is **before** `cohortStart` is dropped even
  for a cohort member. This is unremarked in the source (see AMBIGUOUS-1).

**R8 — Time-to-step is measured from the SIGNUP MILESTONE TIMESTAMP, and
separately from the PREVIOUS STAGE'S TIMESTAMP. Never from the cohort window
start.** `medianDaysFromSignup` uses `a.signupAt` (`funnel.ts:286`),
`medianDaysFromPrevious` uses `a.stages[prevKey].at` (`funnel.ts:298`). Units are
fractional days (`ms / 86 400 000`), unrounded. For stage 1 the `fromSignup` sample
is all zeros (same row), so `medianDaysFromSignup === 0`, not `null`.

**R9 — An account missing `signupAt` is excluded from the `fromSignup` sample but
still counted in `accounts`.** `if (!a.signupAt) continue;` (`funnel.ts:285`).
Unreachable via `loadFunnelIndex` (which always sets it) but reachable if
`summarizeStages` is fed accounts from elsewhere; a port must keep the branch.

**R10 — "Stuck at" has NO time threshold. The predicate is purely structural.**
Two distinct predicates, both threshold-free:

- `StageSummary.stuckAccounts` on stage `k`: `stage(a, k−1) present ∧ stage(a, k) absent`.
- `accountsStuckAt(k)`: `stage(a, k) present ∧ (k is terminal ∨ stage(a, k+1) absent)`.

Nothing anywhere compares an elapsed time against a cutoff. The route's
`daysSinceReached` is computed for display only and never filtered on
(`adminTelemetry.ts:697-698`). The `.slice(0, 200)` cap is a response-size limit
applied **after** a descending sort on `reachedAt` — so the drill-down list shows
the *most recent* 200 stuck accounts, i.e. the least stale ones.

**R11 — Admin exclusion is applied at the DATABASE READ, in both funnel queries,
via `customerMatch()`.** `queries.ts:35-39`, verbatim:

```ts
export function customerMatch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { actorRole: { $ne: "admin" }, ...extra };
}
```

- It is a **denylist of one role**, not an allowlist: `user` and `system` both
  count, deliberately (`queries.ts:18-32`) — filtering to `user` alone would drop
  webhook conversions and operator-completed steps.
- `$ne: "admin"` also matches rows where `actorRole` is missing or null.
- It is applied at **query A** (cohort membership) and **query B** (stages/exits).
  An admin-actor `signed_up` therefore removes the account from the cohort
  entirely, not just from one stage.
- The row is still written and still findable by the raw explorer — exclusion is a
  read-time policy, not a write-time drop (`telemetry-verify.ts:265-268`).
- `loadAccountMilestones` also applies it (`funnel.ts:203`); the raw explorer and
  per-account timeline deliberately do not (`queries.ts:15-16`).
- `extra` is spread **after** the filter, so a caller passing `actorRole` would
  silently override the safeguard. No current caller does.

**R12 — Duplicate-row tie-breaking.** For stages and exits, the earliest `at`
wins, strictly (`funnel.ts:181, 188`). Cohort membership does **not** do this:
`byAccount.set(...)` overwrites, so if an account somehow has two signup rows in
window, `signupAt` is whichever Mongo returned **last** — and query A has no
`.sort()` (AMBIGUOUS-2).

### Divergence hazards found while reading (relevant to any equivalence test)

These are behaviours a "clean" reimplementation would naturally *not* reproduce.
Decide deliberately whether to port or fix them.

**H1 — `recordEvents` (bulk) silently drops `actorRole` and `surface`.**
`recordEvent.ts:203-212` maps only `userId, accountId, type, name, at, source,
meta, dedupeKey`. The schema default is `actorRole: "user"`
(`UserEvent.ts:116`), so **every bulk-written row is recorded as customer
traffic**, whatever the caller passed. The single-row `recordEvent` path handles it
correctly (`recordEvent.ts:127`). The harness only ever tests the admin path
through `recordMilestone` → `recordEvent`, so this is untested.

**H2 — The milestone dedupe key does not include `actorRole`.**
`milestone:{accountId}:{key}` (`recordEvent.ts:186`). If admin support browsing
fires a client milestone (e.g. `saw_first_data`) for an account **first**, that
admin row wins the unique index and the customer's later genuine milestone is
swallowed as a duplicate (`recordEvent.ts:135`). The account then permanently shows
that stage as never reached — the admin row is excluded at read time and no
customer row exists. A stage can be destroyed by support traffic, silently.

**H3 — `accountsStuckAt("converted")` returns every converted account** (§1.5),
because the terminal stage has no successor to fail.

**H4 — `pctOfPrevious` mixes populations** (§1.3, R4). Documented as intentional in
the header comment, but it means the number is not the conversion rate a reader
will assume.

### AMBIGUOUS

**AMBIGUOUS-1 — the `at: { $gte: cohortStart }` lower bound on query B.**
The *behaviour* is unambiguous: pre-`cohortStart` milestones are dropped for cohort
members. The *intent* is not, and the code comments only ever justify the missing
**upper** bound (`funnel.ts:159-160`). Two readings:

- **(a) Deliberate**: a stage cannot precede the cohort window, so this is a
  semantic rule. Consequence for a port: keep the bound; a backfilled or imported
  milestone dated before the window must not count.
- **(b) Incidental**: it exists to keep the query index-led over the `at`-leading
  indexes and to bound the scan, and the author assumed no milestone can precede a
  signup that is itself ≥ `cohortStart`. Consequence for a port: drop the bound and
  collect the account's whole life, which changes results only for backdated or
  out-of-order writes.

They differ only for a cohort member with a milestone timestamped before
`cohortStart` — possible via backfill, importer, or a milestone written with an
`at` earlier than its own signup. Fixture account `a12` exercises exactly this
case, and the expected output below is computed under reading **(a)**, the
as-written behaviour.

**AMBIGUOUS-2 — `signupAt` when an account has two in-window signup rows.**
`funnel.ts:144-153` overwrites per row with no ordering and no `.sort()` on the
query, so `signupAt` is whichever row the server returned last — nondeterministic.
Cannot occur while the dedupe index holds (that is the point of §1.9), but *is*
reachable through the documented index-build race (`recordEvent.ts:60-72`). A port
should pick `min(at)` (matching the stage/exit rule, R12) and say so; do not treat
"last wins" as a specification.

---

## 3. Proposed fixture + expected output

### 3.1 Fixture

Cohort window (closed, UTC):

```
cohortStart = 2026-07-01T00:00:00.000Z
cohortEnd   = 2026-07-31T23:59:59.999Z
scope       = null (all accounts)
grain       = "week"
```

12 subjects. All timestamps UTC. `actor` is `actorRole` as stored on the row.
Rows marked ✗ are expected to be invisible to the funnel; the reason is in the
last column.

| subject | step | timestamp | actor | |
| --- | --- | --- | --- | --- |
| a01 | signed_up | 2026-07-01T00:00:00.000Z | user | left boundary, exactly `cohortStart` → **in** (R6) |
| a01 | wizard_started | 2026-07-02T00:00:00.000Z | user | |
| a01 | topic_finalized | 2026-07-04T00:00:00.000Z | user | |
| a01 | saw_first_data | 2026-07-05T00:00:00.000Z | user | |
| a02 | signed_up | 2026-07-31T23:59:59.999Z | user | right boundary, exactly `cohortEnd` → **in** (R6) |
| a02 | wizard_started | 2026-08-02T23:59:59.999Z | user | after `cohortEnd`, still counts (R7) |
| a03 | signed_up | 2026-06-30T23:59:59.999Z | user | ✗ 1 ms before `cohortStart` → whole account excluded (R5/R6) |
| a03 | wizard_started | 2026-07-03T00:00:00.000Z | user | ✗ account not in cohort |
| a04 | signed_up | 2026-08-01T00:00:00.000Z | user | ✗ 1 ms after `cohortEnd` → whole account excluded |
| a05 | signed_up | 2026-07-05T12:00:00.000Z | user | |
| a05 | wizard_started | 2026-07-06T12:00:00.000Z | user | |
| a05 | topic_finalized | 2026-07-09T12:00:00.000Z | user | |
| a05 | saw_first_data | 2026-07-10T12:00:00.000Z | user | |
| a06 | signed_up | 2026-07-06T00:00:00.000Z | user | |
| a06 | wizard_started | 2026-07-08T00:00:00.000Z | user | |
| a06 | *exit* `lifecycle.trial_expired` | 2026-07-20T00:00:00.000Z | system | exit, type `lifecycle` |
| a06 | *exit* `lifecycle.trial_expired` | 2026-07-21T00:00:00.000Z | system | repeat — first wins (R12) |
| a07 | signed_up | 2026-07-07T00:00:00.000Z | user | |
| a07 | wizard_started | 2026-07-10T00:00:00.000Z | user | |
| a07 | topic_finalized | 2026-07-12T00:00:00.000Z | user | |
| a08 | signed_up | 2026-07-08T00:00:00.000Z | user | never leaves stage 1 |
| a09 | signed_up | 2026-07-09T00:00:00.000Z | user | |
| a09 | wizard_started | 2026-07-11T00:00:00.000Z | user | |
| a09 | saw_first_data | 2026-07-12T00:00:00.000Z | **admin** | ✗ admin actor → stage dropped, account stays (R11) |
| a10 | signed_up | 2026-07-10T00:00:00.000Z | **admin** | ✗ admin signup → whole account excluded from cohort (R11) |
| a10 | wizard_started | 2026-07-11T00:00:00.000Z | user | ✗ account not in cohort |
| a11 | signed_up | 2026-07-11T00:00:00.000Z | user | the skipper |
| a11 | wizard_started | 2026-07-13T00:00:00.000Z | user | |
| a11 | topic_finalized | 2026-07-14T00:00:00.000Z | user | |
| a11 | saw_first_data | 2026-07-15T00:00:00.000Z | user | |
| a11 | plan_selected | 2026-07-20T00:00:00.000Z | user | **skips `plans_viewed`** (R4) |
| a11 | converted | 2026-08-05T00:00:00.000Z | system | after `cohortEnd`, counts (R7) |
| a12 | signed_up | 2026-07-12T00:00:00.000Z | user | |
| a12 | wizard_started | 2026-06-25T00:00:00.000Z | user | ✗ before `cohortStart` → dropped by query B (R7 / AMBIGUOUS-1) |

Nobody reaches `plans_viewed` — that stage is the empty one, and it is what makes
`plan_selected`'s previous count zero.

**Cohort membership (9 accounts):** `a01, a02, a05, a06, a07, a08, a09, a11, a12`.
**Excluded (3):** `a03` (before window), `a04` (after window), `a10` (admin signup).
`totalAccounts = 9`.

**Per-account stage sets after `loadFunnelIndex`:**

| | signed_up | wizard_started | topic_finalized | saw_first_data | plans_viewed | plan_selected | converted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a01 | ✓ | ✓ | ✓ | ✓ | | | |
| a02 | ✓ | ✓ | | | | | |
| a05 | ✓ | ✓ | ✓ | ✓ | | | |
| a06 | ✓ | ✓ | | | | | |
| a07 | ✓ | ✓ | ✓ | | | | |
| a08 | ✓ | | | | | | |
| a09 | ✓ | ✓ | | | | | |
| a11 | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| a12 | ✓ | | | | | | |
| **count** | **9** | **7** | **4** | **3** | **0** | **1** | **1** |

### 3.2 Expected `summarizeStages(index.accounts)`

Seven rows, in order. `first = 9`. Percentages are exact rationals × 100 — assert
with a tolerance of 1e-9, not equality on the decimal shown.

| order | key | accounts | pctOfFirst | pctOfPrevious | medianDaysFromSignup | medianDaysFromPrevious | stuckAccounts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | signed_up | 9 | 100 | **null** | **0** | **null** | 0 |
| 2 | wizard_started | 7 | 700/9 ≈ 77.77777777777779 | 700/9 ≈ 77.77777777777779 | 2 | 2 | 2 |
| 3 | topic_finalized | 4 | 400/9 ≈ 44.44444444444444 | 400/7 ≈ 57.14285714285714 | **3.5** | 2 | 3 |
| 4 | saw_first_data | 3 | 300/9 ≈ 33.33333333333333 | 75 | 4 | 1 | 1 |
| 5 | plans_viewed | **0** | **0** | **0** | **null** | **null** | 3 |
| 6 | plan_selected | 1 | 100/9 ≈ 11.11111111111111 | **null** | 9 | **null** | 0 |
| 7 | converted | 1 | 100/9 ≈ 11.11111111111111 | 100 | 25 | 16 | 0 |

Each row also carries `label` and `description` copied from
`MILESTONE_LABELS` (`funnel.ts:56-58, 306-307`).

Derivations of the interesting cells:

- **row 1 `medianDaysFromSignup = 0`** — the sample is nine zeros (stage 1's
  timestamp *is* `signupAt`). `median` of an odd-length all-zero set = 0. Not
  `null`.
- **row 2 medians** — sample (days from signup) `a01 1, a02 2, a05 1, a06 2,
  a07 3, a09 2, a11 2` → sorted `[1,1,2,2,2,2,3]`, n=7 odd, `mid = 3` → `2`.
  `fromPrev` is the same set (predecessor is `signed_up`, all seven have it) → `2`.
  a02's span is `2026-08-02T23:59:59.999Z − 2026-07-31T23:59:59.999Z` = exactly
  `2 × 86 400 000` ms → `2.0`.
- **row 3 `medianDaysFromSignup = 3.5` — the EVEN-LENGTH median.** Sample
  `a01 3, a05 4, a07 5, a11 3` → sorted `[3,3,4,5]`, n=4, `mid = 2` →
  `(s[1] + s[2]) / 2 = (3 + 4) / 2 = 3.5`. A lower-middle implementation would
  return `3` here — this cell is the discriminating assertion for R1.
- **row 3 `medianDaysFromPrevious = 2`** — `a01 2, a05 3, a07 2, a11 1` → sorted
  `[1,2,2,3]` → `(2 + 2) / 2 = 2`.
- **row 3 `stuckAccounts = 3`** — reached `wizard_started`, not `topic_finalized`:
  `a02, a06, a09`.
- **row 4 `stuckAccounts = 1`** — `a07` only.
- **row 5 — the EMPTY stage.** `accounts = 0`, so `pctOfFirst = 0/9 × 100 = 0`
  (a real zero, not null, because `first > 0`), `pctOfPrevious = 0/3 × 100 = 0`
  (a real zero, because `prevReached = 3 > 0`), both medians `null` (empty
  samples, R2), and `stuckAccounts = 3` (`a01, a05, a11` reached
  `saw_first_data` and stopped).
- **row 6 — the ZERO-PREVIOUS stage.** `prevReached = 0` (nobody has
  `plans_viewed`) → `pctOfPrevious = null` (R3), **not** `Infinity`, not `100`,
  not `0` — even though `accounts = 1`. `medianDaysFromPrevious = null` because
  the `fromPrev` loop only visits accounts that have the *previous* stage, and
  `a11` does not: the skipper contributes to `accounts` but to nothing else on
  this row (R4). `medianDaysFromSignup = 9` (`07-20 − 07-11`).
  `stuckAccounts = 0` — no account had `plans_viewed` to be lost from.
- **row 7** — `a11` only. `pctOfPrevious = 1/1 × 100 = 100`.
  `medianDaysFromSignup = 25` (`2026-08-05 − 2026-07-11`),
  `medianDaysFromPrevious = 16` (`2026-08-05 − 2026-07-20`). The conversion is
  **after `cohortEnd`** and still counts.

### 3.3 Expected `summarizeExits(index.accounts)`

| key | label | accounts |
| --- | --- | --- |
| trial_expired | Trial expired | **1** |
| subscription_deleted | Subscription canceled | **0** |

`a06.exits.trial_expired.at === 2026-07-20T00:00:00.000Z` — the **first** of the
two repeats (R12).

### 3.4 Expected `accountsStuckAt`

| key | result |
| --- | --- |
| signed_up | `[a08, a12]` (2) |
| wizard_started | `[a02, a06, a09]` (3) |
| topic_finalized | `[a07]` (1) |
| saw_first_data | `[a01, a05, a11]` (3) |
| plans_viewed | `[]` (0) |
| plan_selected | `[]` (0) — a11 has `converted` |
| converted | **`[a11]` (1)** — terminal-stage quirk, H3 |

Order within each result follows the order of `index.accounts` (i.e. Mongo's
return order for query A) — do not assert on it; sort before comparing.

### 3.5 Expected cohort slices — `cohortKey(a.signupAt, "week")`

| subject | signupAt (date) | weekday | cohortKey |
| --- | --- | --- | --- |
| a01 | 2026-07-01 | Wed | `2026-W27` |
| a05 | 2026-07-05 | Sun | `2026-W27` |
| a06 | 2026-07-06 | Mon | `2026-W28` |
| a07 | 2026-07-07 | Tue | `2026-W28` |
| a08 | 2026-07-08 | Wed | `2026-W28` |
| a09 | 2026-07-09 | Thu | `2026-W28` |
| a11 | 2026-07-11 | Sat | `2026-W28` |
| a12 | 2026-07-12 | Sun | `2026-W28` |
| a02 | 2026-07-31 | Fri | `2026-W31` |

a05 (Sunday) landing in W27 with a01 (Wednesday), and a06 (Monday) starting W28,
is the Monday-start assertion. a02's `23:59:59.999` timestamp collapsing to a plain
date is the time-of-day-discarded assertion. Month grain: all nine are `2026-07`.

Cohorts sorted ascending by key (`adminTelemetry.ts:667-668`), stage counts per
slice:

| cohort | accounts | signed_up | wizard_started | topic_finalized | saw_first_data | plans_viewed | plan_selected | converted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-W27 | 2 | 2 | 2 | 2 | 2 | 0 | 0 | 0 |
| 2026-W28 | 6 | 6 | 4 | 2 | 1 | 0 | 1 | 1 |
| 2026-W31 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |

Selected slice-level values worth asserting (same formulas, smaller populations):

- **2026-W27** `medianDaysFromSignup`: `topic_finalized` = `(3 + 4)/2 = 3.5`,
  `saw_first_data` = `(4 + 5)/2 = 4.5` — two more even-length medians.
  `plan_selected.pctOfPrevious = null` and `converted.pctOfPrevious = null`
  (both predecessors are empty here).
- **2026-W28** `wizard_started.pctOfPrevious = 4/6 × 100 ≈ 66.66666666666666`;
  `topic_finalized` sample `[3, 5]` → median `4`; `plan_selected.pctOfPrevious =
  null`; `converted.pctOfPrevious = 100`.
- **2026-W31** (single account) `topic_finalized.pctOfPrevious = 0/1 × 100 = 0`
  but `saw_first_data.pctOfPrevious = null` (its predecessor count is 0) — the
  pair that separates "genuinely zero" from "undefined".

---

## 4. Mapping onto `@jeffjassky/telemetry` primitives

Field correspondence: maxed `at` → `occurredAt`; `accountId` → a subject ref
`account:<id>` in `subjectKeys`/`dims`; `actorRole` → the `actor` field, whose
**type prefix** (`admin:u_1` → `admin`) is what the rollup gate reads
(`src/server/rollups.ts:103-106`).

| quantity | package primitive | notes |
| --- | --- | --- |
| stage membership + stage timestamp | **lifetime rollup family** (`bucket` absent), `by: ['subject']`, `subjects: ['account']`, one family per milestone key. `firstAt` **is** `stages[k].at` | exact match, and strictly better than maxed: maxed enforces once-ness with a unique index and loses the repeat count; the rollup keeps `count` alongside `firstAt` |
| `signupAt`, cohort membership | the `signed_up` lifetime family's `firstAt` | see gap G1 — the range filter does not apply to `firstAt` |
| exit first-occurrence (`lifecycle.trial_expired` repeats daily) | lifetime rollup family, `firstAt` | maxed does this min in JS (`funnel.ts:186-188`); the rollup's `$min` does it on write |
| admin exclusion | `RollupSpec.actors` (`registry.ts:28-34`), applied at **write** time in `recordRollup` | semantic differences below (G2) |
| per-account milestone strip (`loadAccountMilestones`) | `queries.journey()` — `RollupModel.find({ tenantId, dims: subjectRef, bucketAt: { $exists: false } }).sort({ firstAt: 1 })` (`query.ts:319-322`) | direct equivalent for one subject |
| cohort week/month grain | `truncate(d, 'week' \| 'month')` (`rollups.ts:77-86`) — UTC, **Monday-start weeks** | grouping is equivalent to `cohortKey`; the *label* differs (a `Date` vs `"2026-W31"` / `"2026-07"`). ISO week-year boundary cases (late Dec / early Jan) group identically because both key off the Monday |
| `pctOfFirst`, `pctOfPrevious`, `stuckAccounts`, both medians, `accountsStuckAt` | **nothing** — pure functions over the assembled index | must be added to the package (a `queries.funnel()` or a dashboard view). The UI's existing `FunnelSteps` is a different, weaker calculation (G4) |
| raw fallback / re-deriving a stage definition | `TelemetryModel` (`occurredAt`, `subjectKeys`, `actor`) | lets a port reproduce maxed's read-time actor filtering exactly, at scan cost |

### Gaps — what the package cannot currently express

**G1 — cohort selection filters the wrong field, with the wrong interval.**
`queries.rollups()` (`query.ts:277-288`) applies `params.range` to `bucketAt` for
bucketed families and **`lastAt`** for lifetime ones:

```ts
match[bucketed ? 'bucketAt' : 'lastAt'] = { $gte: params.range.from, $lt: params.range.to };
```

Cohort membership needs `firstAt ∈ [start, end]`. `lastAt` is the *most recent*
occurrence; for a once-per-subject milestone `firstAt === lastAt`, so a signup
family happens to work — but only because it is deduped, and only until something
re-emits `signed_up`. Two further mismatches: the range is **half-open**
(`$gte … $lt`) where maxed is **closed** (`$gte … $lte`, R6), and `sort: 'firstAt'`
is supported while *filtering* on `firstAt` is not. There is an index for it
(`{ tenantId, as, subjectType, firstAt }`, `rollups.ts:49`) — only the query
surface is missing. Needs: a `firstRange` param, and a decision on interval
closure.

**G2 — the actor gate is an allowlist applied at write time; maxed's is a denylist
applied at read time.** `recordRollup` (`rollups.ts:103-106`):

```ts
if (spec.actors && doc.actor) {
  const actorType = String(doc.actor).split(':')[0];
  if (!spec.actors.includes(actorType)) return;
}
```

- Both let a record with **no** actor through, matching `$ne: "admin"`'s treatment
  of missing/null. Equivalent today.
- `actors: ['user', 'system']` reproduces the current policy, but a **new** actor
  type would be excluded by the package and included by maxed. If the intent is
  "everything except admin", the package needs a denylist form (`notActors`) — the
  reasoning in `queries.ts:18-32` is explicitly about *not* being an allowlist.
- Write-time application means the policy **cannot be re-derived**: flipping it
  requires a rollup rebuild from raw. Maxed can change it per query. Worth stating
  as a deliberate trade in the build plan, not discovering later.

**G3 — no multi-subject rollup read.** `queries.rollups()` takes a single `dims`
string (`query.ts:278`). Assembling a funnel index for N cohort accounts means
either N queries, or one unfiltered family scan capped by `limits.rollups`
(`query.ts:284`) — which silently truncates a cohort larger than the cap and
produces a wrong-but-plausible funnel. Needs `dims: { $in: [...] }` and/or a
purpose-built funnel query that fetches all milestone families for a cohort in one
pass.

**G4 — the shipped UI funnel is not this math.** `src/ui/pages.jsx:446-466`
derives steps by counting `rows.length` per milestone family with `limit: 1_000`
(so it is capped, and it ignores the cohort entirely), and
`src/ui/atoms.jsx:329` renders conversion as
`Math.round((s.count / steps[i-1].count) * 100)` guarded by
`steps[i-1].count > 0` — i.e. **rounded**, and **omitted** rather than `null` when
the previous step is empty. Both diverge from R3 and from "no rounding". If the
maxed math lands in the package, this component should consume it rather than keep
its own.

**G5 — no `stuckAccounts` / drop-off drill-down primitive**, and no notion of a
terminal stage. Whichever definition of "stuck" the package adopts (§1.5), name it
unambiguously — maxed shipping both meanings under one word is the trap.
