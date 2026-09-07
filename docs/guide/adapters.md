# Adapters

An adapter is the seam between this package and something it does not own. It
owns its own collections; it owns no user system, no auth, no session, no naming
of your entities. Each of those is an adapter.

They come in two directions, and documenting only one is what makes the other look
arbitrary:

- **Inbound** — the package asks the host a question. `resolveViewer(req)` → *who
  is looking, and how widely?*; `link(subjects)` → *who else is this record
  about?*
- **Outbound** — the host tells the package about a lifecycle event.
  `forget(tenantId, ref)` → *this person is gone.*

| Adapter | Direction | Passed to | Required |
|---|---|---|---|
| `contextAdapter` | in | `createIngest` | only for `session`-mode keys |
| `viewerAdapter` | in | `createDashboard` | **yes** |
| `subjectAdapter` | in | `createDashboard` | no |
| `subjectLinker` | in | `createTelemetry` | no |
| `onSlowQuery` | out (package → host) | `createDashboard`, `createQueries` | no |
| `logger` | out (package → host) | `createTelemetry` | no |
| `forget()` | out (host → package) | — it is a method | — |

---

## `contextAdapter` — inbound, ingest

```ts
interface ContextAdapter {
  resolveContext(req): IngestContext | null | Promise<IngestContext | null>;
}

interface IngestContext {
  tenantId: string;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  actor?: string;
}
```

The published signature types `req` as `unknown` so the package never forces an
Express version into your code — annotate it yourself:

```ts
import type { Request } from 'express';

app.use('/telemetry/ingest', createIngest({
  telemetry: t,
  contextAdapter: {
    resolveContext: (req: Request) => {
      const s = req.session;
      return s?.tenantId
        ? { tenantId: s.tenantId, subjects: [{ type: 'user', id: s.userId }], actor: `user:${s.userId}` }
        : null;
    },
  },
}));
```

**When it is called:** once per ingest batch, and **only** for keys minted with
`tenantMode: 'session'`. `fixed`-mode keys carry their tenant; `claimed`-mode keys
(secret keys only) let the payload assert one. There is no fourth path.

**What it is for:** turning a browser request with no credentials of its own into
an attributable one. The session cookie is the fact; the JavaScript payload is a
claim. What this adapter returns **outranks** anything the batch or the individual
record claimed — subjects merge lowest-to-highest as batch claims < record
subjects < host context.

**Pure read.** The host's middleware verifies upstream; the adapter reads what it
left on the request. Do not verify a JWT in here — it runs on every batch, and a
throw becomes a 500 where a `null` would have been a clean drop.

**When it is absent:** a `session`-mode key logs a warning and the batch is
refused — `202` with nothing accepted for a publishable key, `500 no_context_adapter`
for a secret one. Other key modes are unaffected.

**When it returns `null`:** the records are rejected and counted. A publishable key
still gets `202` — an unauthenticated browser is normal traffic, not an error, and
telemetry errors surfacing in a console read as a broken page. A secret key gets
`401 no_session`, because its caller is a programmer who can fix it.

See [Ingest & keys](/guide/ingest).

---

## `viewerAdapter` — inbound, dashboard

```ts
interface ViewerAdapter {
  resolveViewer(req): Viewer | null | Promise<Viewer | null>;
}

interface Viewer {
  tenantId: string;    // a tenantId, or PLATFORM_SCOPE ('*')
  role: string;        // 'admin' unlocks System writes within this scope
  viewerRef?: string;  // owns saved views, e.g. 'user:u_1'
}
```

```ts
app.use('/telemetry', createDashboard({
  telemetry: t,
  mountPath: '/telemetry',
  viewerAdapter: {
    resolveViewer: (req: Request) => {
      const u = req.session?.user;
      if (!u) return null;
      return {
        tenantId: u.isPlatformStaff ? '*' : u.tenantId,
        role: u.isAdmin ? 'admin' : 'member',
        viewerRef: `user:${u.id}`,
      };
    },
  },
}));
```

**When it is called:** on every `/api/*` request, before any handler. A `null`, or
a viewer with no `tenantId`, is a `401`.

**`createDashboard` refuses to construct without it.** Not a warning, not a
permissive default — a thrown error at boot:

> `telemetry: createDashboard requires a viewerAdapter — an unauthenticated
> telemetry dashboard is a data leak with charts`

Telemetry is the one surface that has read access to every subject, every payload
and every error message in the system. A default-open dashboard is worse than no
dashboard, because it looks like it is working.

**Returning `'*'` IS the authorization decision, and it is yours.** The package
never infers platform admin from a role name, a header, or a config flag. All it
does is make the escape hatch expressible and inside the boundary, so a host that
needs a cross-tenant read declares it here instead of reaching around
`t.scoped()` with a raw model. Return `'*'` only for viewers you have already
authorized — see [Queries](/guide/queries) for what changes under it.

**`role` is scoped to the returned `tenantId`.** `'admin'` unlocks System writes
(key revocation) and deleting other people's saved views *within that scope*. A
platform viewer's `role: 'admin'` is admin **of** the platform scope; it is not a
master key to tenants' saved state, which is matched literally and stays
invisible in both directions.

**`viewerRef` owns saved views.** Without it a viewer can still read and can still
save *shared* views, but a private view has no owner to belong to and is refused
with a `400`. Erasure follows `ownerRef` — see [Erasure](/guide/erasure).

---

## `subjectAdapter` — inbound, labels

```ts
interface SubjectAdapter {
  describe(refs: string[]): Promise<Record<string, { label: string; href?: string }>>;
}
```

```ts
subjectAdapter: {
  describe: async (refs) => {
    const ids = refs.filter((r) => r.startsWith('user:')).map((r) => r.slice(5));
    const users = await User.find({ _id: { $in: ids } }, 'name').lean();
    return Object.fromEntries(
      users.map((u) => [`user:${u._id}`, { label: u.name, href: `/admin/users/${u._id}` }]),
    );
  },
}
```

**When it is called:** from `GET /api/subjects/describe`, when the SPA has refs on
screen and wants names. Batched, and capped at 100 refs per request.

**Why it is an adapter and not a join:** the package stores `user:u_1` and nothing
else about `u_1`. It has no name, no email, no display rules, and deliberately no
copy of them — a denormalized email is a field nothing will ever clean up, which
is the erasure hole this package exists to avoid.

**When it is absent:** refs render raw. `user:u_1` is a perfectly usable label for
an operator and a completely honest one. The endpoint answers `{ refs: {} }`.

Returning a partial map is fine — refs you omit render raw too.

---

## `subjectLinker` — inbound, **write time** {#subjectlinker}

```ts
interface SubjectLinker {
  link(
    subjects: SubjectInput[],
    ctx: { name: string; tenantId: string },
  ): SubjectInput[] | Promise<SubjectInput[]>;
}
```

```ts
const t = createTelemetry({
  registry,
  connection: mongoose,
  subjectLinker: {
    // answer from a cache. This runs once per record, on the ingest path.
    link: (subjects) => {
      const machine = subjects.find((s) => s.type === 'machine');
      const userId = machine && OWNER_CACHE.get(machine.id);
      return userId ? [{ type: 'user', id: userId }] : [];
    },
  },
  subjectLinkTimeoutMs: 50,   // the default
});
```

**When it is called:** once per record on the way to disk — from `emit()` and
from the ingest router alike — after the registry check and before the record is
built. Never for a record that was never going to be written: an unregistered
name, a reserved tenant and a malformed `dedupeKey` are all refused before the
host is asked.

**Read the pair with `subjectAdapter`, because the names are close and the jobs
are not.** `subjectAdapter.describe()` is a **read**-time labeller: it turns
`user:u_1` into *"Dana Ellis"* on a screen and changes nothing about what is
stored. `subjectLinker.link()` **changes the row**.

**Why the write side needs its own seam at all.** A desktop client knows its
install and nothing else, so every record it sends carries
`machine:<installId>` and no `user`. Resolve that at read time and the raw rows
can be joined — but a cohort funnel anchored on `user` still reads **zero** for
every desktop stage, because a lifetime `by:['subject']` rollup is keyed on the
subject the record was written with, permanently. `import.completed` exists in
volume and is invisible to the only question anyone asked of it. Linking at
write time puts the party on the row **and** on its aggregates, and the second
half is the one no later join can reach.

**Merge semantics, in the order they apply:**

1. Linked refs are **appended** to the ones the record declared.
2. A `type:id` the record already carries is never doubled, and the **declared**
   one survives whole — including its `role`, which the caller knew and the
   linker is guessing at.
3. A linked type the event's `EventSpec.subjects` does not declare is **written
   anyway**, and counted in `counters.subjectLinkUndeclared`. See the warning
   below for why refusing it would be a rule that can only be obeyed by losing
   data.
4. Past `SUBJECT_MAX` (8) subjects on one record, further links are dropped and
   counted in `counters.subjectLinkCapped`. Room is measured against what the
   record brought, so its own refs are never displaced by a derived one.

::: warning Do not declare the linked type to "permit" the link
`EventSpec.subjects` is a **required** list: `model.ts` quarantines any record
missing a type declared there. So declaring `user` on `import.completed` does
not authorise the link, it makes `user` **mandatory** — and every record from a
machine that has not been activated yet fails validation and is thrown away.
That is the pre-activation funnel, deleted in order to describe the
post-activation one.

This is exactly why an undeclared linked type is written rather than refused. A
linked type is mandatory for nobody — linking exists *because* some records
resolve and some do not — so a refusal could only ever be satisfied by data
loss, and in practice would not be satisfied at all: the type stays undeclared,
every link is dropped, and the hook does nothing.

`subjectLinkUndeclared` is therefore a **report**, not an enforcement. It names
which event is carrying which extra type, so the registry can be corrected on
the day a link becomes total — and left alone while it is not.
:::

**It can never fail a write.** The call is wrapped in a timeout
(`subjectLinkTimeoutMs`, default 50 ms) and guarded against throws, rejections
and nonsense return values. Every one of those resolves the same way: the record
is written with the subjects it came with, and a counter moves. Ingest is
at-least-once and unattended — a resolver that hangs must cost a record its
`user`, never its existence. An unlinked row is a worse row; a dropped row is a
lie about what happened.

**So it must be cached.** It runs once per record. A resolver that queries the
database per record will spend its 50 ms and start writing everything unlinked,
which the timeout counter will say out loud and the funnel will not.

**Six counters, because six things can happen:**

| counter | |
|---|---|
| `subjectsLinked` | subjects actually **added** — two links on one record count twice |
| `subjectLinkMisses` | the host answered `[]`. *"No link exists"* is an answer, not a failure |
| `subjectLinkErrors` | threw, rejected, or answered with something that is not a list of refs |
| `subjectLinkTimeouts` | outran the budget; the record went to disk unlinked |
| `subjectLinkUndeclared` | a linked type the event does not declare — written, and reported |
| `subjectLinkCapped` | over `SUBJECT_MAX` on one record |

The failure four are the difference between *"nothing links"* and *"the link is
broken and every desktop row is landing anonymous"*, which is otherwise the same
silence. They surface on `t.counters`, on the dashboard's System page and in
`telemetry_health`, like every other counter.

**When it is absent:** nothing is called, nothing is counted, and the write path
is exactly the one that shipped before it existed. `t.linkSubjects` is `null`.

### Linking is not retroactive — `t.relink()` is how you catch up {#relink}

`subjectLinker` runs at **write time**, so configuring it fixes the future and
nothing else. That is not a limitation to work around, it is the same fact the
hook exists for, seen from the other side: a lifetime `by:['subject']` rollup is
keyed on the subject the record was written with, *permanently*, which is exactly
why read-time joining could not do this job — and exactly why the day you turn
the hook on splits your collection in two.

Records after that day carry `user:u_1` on the row and in every
`subjects:['user']` family. Records before it carry `machine:m1` and nothing
else. The family has no member for any of them, so a lifetime milestone is
missing the whole backlog and a cohort funnel anchored on `user` reads **zero**
for every stage those events feed — while the events sit there, real, correctly
timestamped, and unreachable. Nothing you do at read time closes that, because
the aggregate is already written.

`t.relink()` re-asks your linker about the records already on disk, updates the
rows, and replays the rollups the new subjects reach.

```ts
// DRY RUN by default — this is the safe call, and it writes nothing
const preview = await t.relink();
// { examined: 412_009, linked: 388_140, subjects: 388_140,
//   rollups: 388_140, misses: 23_869, errors: 0, skipped: 0 }

// then, having read that
await t.relink({ dryRun: false, onProgress: (p) => log.info('relink', p) });
```

| option | |
|---|---|
| `names` | restrict to these event names. Default: every stored record. A name the registry does not declare **throws**, before any I/O — a typo that relinks nothing looks exactly like a clean run |
| `since` | only records at/after this `occurredAt` |
| `limit` | stop after this many records are **examined** — a budget for the scan, not for the writes |
| `dryRun` | **defaults to `true`** |
| `batchSize` | records per batch, and the `onProgress` cadence. Default 500 |
| `onProgress` | cumulative counts after each batch. A printer that throws does not kill the backfill |

**`dryRun` defaults to `true`, and that default is the API.** This rewrites
historical aggregates. The short call has to be the one that cannot hurt you, so
writing is the thing you opt into. A dry run still asks your linker — there is no
other way to know what would link — so the six linking counters move; nothing on
disk does. Everything else it reports, including `rollups`, is produced by the
same code path that would have written it, so the preview is exact rather than
estimated.

**It is idempotent by construction, not by bookkeeping.** There is no watermark
and no marker field. A row that already carries the linked subject offers it to
the same merge `emit()` uses, the merge dedupes it, nothing is new — so nothing
is written and nothing is replayed. Run it twice, run it after a crash, run it
from cron: the second run reports `linked: 0` and changes nothing.

That property is load-bearing here in a way it is not elsewhere in the package.
`recordRollup` adds **1** per call, so a replay that happens twice inflates a
historical `count` — and an aggregate that is 1.3× too big is indistinguishable
from a real one. (An aggregate that is *short* announces itself against the rows
it came from, which is why the operation updates the row **before** replaying its
rollups: interrupted, it fails toward short, never toward long.)

**What it does not replay.** Only families that group by `subject` and whose
`subjects` filter admits one of the **new** refs. A family keyed on
`attr:feature` counted the record once at write time and cannot gain a group from
a new subject; a `subjects:['machine']` family was already satisfied by the ref
the record arrived with. Both are left exactly as they are.

**When there is no `subjectLinker`:** it returns `{ skipped: 1 }` and reads
nothing, rather than throwing — a host may call this from a boot path that does
not know how the instance was configured. And a stored row whose `name` the
registry no longer declares is skipped too, counted in the same field: its rollup
families are unknowable, so relinking the row would leave the row and its
aggregates disagreeing, which is the bug this whole operation exists to fix.

---

## `onSlowQuery` — outbound, observability

```ts
onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
```

```ts
createDashboard({
  telemetry: t,
  viewerAdapter,
  onSlowQuery: ({ op, ms, params }) => log.warn('telemetry slow read', { op, ms, params }),
});
```

**When it is called:** after any [read primitive](/guide/queries) exceeds `slowMs`
(default 500 ms). `op` is the primitive name, `params` the scope and filter it ran
with.

It is an adapter rather than a log line because a slow read is a *metric* in
whatever the host already uses for metrics, and the package has no opinion about
what that is. Note it fires on the read that finished — including one that threw.

**When it is absent:** nothing happens. Slow reads still complete.

---

## `logger` — outbound, diagnostics

```ts
interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

```ts
const t = createTelemetry({ registry, connection: mongoose, logger: console });
```

**When it is called:** rarely, and only where the alternative would be silence —
a boot-time warning that a spec declaring `data` inherited a retention nobody
chose, an ingest batch refused for a reserved tenant, a `session`-mode key with no
`contextAdapter`, a `5xx` inside the dashboard router.

**When it is absent:** it defaults to a no-op, which is deliberate. A telemetry
package that writes to stdout by default is a telemetry package your log budget
notices. Pass one in staging at minimum.

`logger` is **not** where drops are reported. `t.counters`, the rejects collection
and the System page are — see [Emitting records](/guide/emit). The logger is for
things a human has to read once, not for things a dashboard has to count.

---

## `forget()` — outbound, lifecycle

The one adapter that is a method rather than a callback, because the direction is
reversed: the host is telling the package that something happened.

```ts
await t.forget(tenantId, `user:${userId}`);
```

Call it from your account-deletion path. Nothing else will ever clean these rows
up — the package stores subject refs, actor refs and client fingerprints that
outlive the account by whatever the retention window says, and no TTL knows the
difference between "expired" and "erased".

Full semantics, including the `globalSubjectRefs` opt-in for platform-scoped saved
views, are on [Erasure](/guide/erasure).

---

## The shorthand rule

Every adapter here has exactly one method, and the object form is the one the
package accepts. That is on purpose: `resolveUser` shipped as a bare config field
in a sibling package and the reaction was, correctly, *"where is the adapter?"* The
function was the adapter — it just was not named like one.

`onSlowQuery` and `logger` are the exceptions, and they are exceptions because
neither is a seam to a host *system*: one is a metric sink, the other is a log
sink, and both already have a universal shape in every host.

## Where to go next

- [Ingest & keys](/guide/ingest) — `contextAdapter` in its three key modes
- [Emitting records](/guide/emit) — where `subjectLinker` sits in the write path
- [`t.relink()`](#relink) — the backfill for records written before you configured it
- [The dashboard](/guide/dashboard) — mounting behind `viewerAdapter`
- [Erasure](/guide/erasure) — the outbound direction in full
- [Configuration](/guide/configuration) — everything else on the factory
