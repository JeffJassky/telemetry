# Configuration

Everything `createTelemetry()` accepts, what it defaults to, and a reason to
change it that someone actually had. Router configuration lives with the routers
— see [Ingest & keys](/guide/ingest), [The dashboard](/guide/dashboard) and
[Adapters](/guide/adapters).

```ts
interface CreateTelemetryConfig<R extends Registry = Registry> {
  registry: R;
  connection: Connection | Mongoose;
  collection?: string;
  modelName?: string;
  pepper?: string;
  platforms?: readonly string[];
  bodyMax?: number;
  validation?: 'lenient' | 'strict';
  globalSubjectRefs?: boolean;
  subjectLinker?: SubjectLinker;
  subjectLinkTimeoutMs?: number;
  logger?: Logger;
}
```

Two keys are required (`registry`, `connection`); the other nine have defaults
that are correct for a single-instance host.

## `registry` — required

The host-owned event registry, from [`defineRegistry()`](/guide/registry).
`createTelemetry()` runs `validateRegistry()` on it at construction and throws
on misconfiguration, so a bad rollup shape fails deploy rather than producing an
unqueryable aggregate.

The type parameter flows through: `createTelemetry({ registry: REGISTRY })`
returns a `Telemetry<typeof REGISTRY>` whose `emit()` only accepts names in
that registry, with per-event `attrs` and `metrics` types.

It is also re-exposed as `t.registry`, which is how the router factories reach
it. Your own code should import its own registry module rather than reading it
back off the instance.

## `connection` — required

A mongoose `Connection`, or the `mongoose` module itself (in which case its
default connection is used). Both of these are correct:

```ts
createTelemetry({ registry, connection: mongoose });
createTelemetry({ registry, connection: mongoose.createConnection(url) });
```

**Change it when** telemetry belongs on a different database than your
application data — a separate connection is the whole mechanism, and nothing
else in the config needs to know.

Connect before you construct: the instance resolves `conn.db` for the side
collections.

## `collection`

**Default: `'telemetry'`.** The base collection name. Siblings derive from it,
so one string moves all seven:

| collection | contents |
|---|---|
| `telemetry` | the envelope, discriminated on `kind` |
| `telemetry_rollups` | derived aggregates, maintained on write |
| `telemetry_rejects` | quarantined writes, TTL 30 days |
| `telemetry_keys` | ingest keys (hashed secrets) |
| `telemetry_aliases` | anon → identified subject links |
| `telemetry_views` | user-saved dashboard views |
| `telemetry_checkpoints` | pull-importer watermarks |

**Change it when** an existing collection in the database already owns the name,
or when you are running a second, deliberately separate telemetry domain in the
same database. If you change it for a second instance on the same connection,
change [`modelName`](#modelname) too.

## `modelName`

**Default: `'Telemetry'`.** The mongoose model name. Discriminators and sibling
models derive from it (`Telemetry_event`, `TelemetryRollup`, `TelemetryKey`, …).

**Change it when two instances share one connection.** This is the sharpest edge
in the config surface:

> Mongoose keeps compiled models in a per-connection registry, and compiling a
> second model under a taken name throws `OverwriteModelError`. The package
> avoids the throw by reusing the already-compiled model — but that model closed
> over the **first** instance's registry, counters, platform enum and `bodyMax`.

So a second `createTelemetry()` on the same connection with the default
`modelName` gives you an instance that silently validates against someone else's
registry. Your events are unregistered and get quarantined; your counters stay
at zero.

```ts
const product = createTelemetry({ registry: PRODUCT, connection: conn });
const billing = createTelemetry({
  registry: BILLING,
  connection: conn,
  modelName: 'BillingTelemetry',      // ← without this, BILLING is ignored
  collection: 'billing_telemetry',
});
```

If you only ever construct one instance per connection — which is the normal
case, including tests that use a fresh in-memory server per file — leave it
alone.

## `pepper`

**Default: `process.env.TELEMETRY_PEPPER`.** A secret used by `forget()` to
rekey rollups pseudonymously: an erased subject's aggregates survive as
counts under a keyed hash instead of being deleted, so your historical numbers
do not move when someone exercises a deletion right.

There is no fallback default value, deliberately. `forget()` throws if neither
the config key nor the environment variable is set — a package-chosen constant
would make the pseudonymization reversible by anyone who read the source, which
is worse than not shipping it.

**Change it when** you would rather pass the secret through your own config
loader than the environment. **Do not rotate it casually:** rollup keys minted
under the old pepper will not match rows rekeyed under the new one.

## `platforms`

**Default: none — the builtin list is `['web', 'electron', 'ios', 'android',
'server', 'cli']`.** Host values **extend** that list; they never replace it, so
adding `'watchos'` keeps `'web'` valid.

```ts
createTelemetry({ registry, connection, platforms: ['watchos', 'tvos'] });
```

`client.platform` is an enum in the schema, which makes it the one closed field
on an otherwise open envelope. `name`, `feature`, `attrs` keys and subject types
are all open on purpose — the registry constrains them, not the schema. The
closed platform enum was the single place a host with a real platform outside the
list had to lie (usually by writing `'web'` for a desktop shell, corrupting every
platform breakdown it touched). Extending it is the fix; replacing it would just
move the lie.

**Change it when** you ship a client the builtin list does not name. The
TypeScript side is already open — `ClientContext['platform']` is a union with
`(string & {})`, so builtins autocomplete and your additions compile.

## `bodyMax`

**Default: `BODY_MAX_CHARS`, 16384.** The cap on the `body` field, in
characters.

`body` is the only unbounded field on the envelope, and it feeds Mongo's 16 MB
document ceiling. Every other bound in the package is stated and enforced —
`boundedMeta()` at 4 KB, ingest batches at 100 records / 512 KB, the payload
index budget at 24 — so this one is too.

Over the cap, `body` is clipped and **marked**:

```
…the first 16384 characters… [truncated 4211 chars]
```

and `counters.truncated` increments. This is the one place the package's
drop-never-truncate doctrine deliberately inverts, and the difference is the
data rather than the mood: `data` is structured evidence where a partial object
is a lie about what the caller sent, while `body` is prose where a marked prefix
is strictly more useful than nothing. The marker is visible so no reader mistakes
the prefix for the whole.

The cap is enforced in the schema's pre-validate hook, not in `emit()`, so every
write path is covered — `emit()`, ingest, and direct model use alike.

**Change it when** your bodies are systematically larger and you have the storage
(raise it), or when you are storing many rows with large bodies and want a harder
ceiling than the document limit (lower it). Note it is per instance, not per
event.

## `validation`

**Default: `'lenient'`.** What a vocabulary mismatch costs.

`'lenient'` — an attr or metric the registry does not accept is **stripped**,
its removal counted by name in `counters.attrsDropped` / `counters.metricsDropped`,
and the record is **written** with whatever survived.

`'strict'` — the record is quarantined whole, which is what every version
before 0.7.0 did unconditionally.

**Why the default moved.** A registry is a vocabulary maintained in one repo
about events emitted from another. The day a client ships a sixth value for a
five-value enum, strict mode throws away the WHOLE record — its name, its
subject, its metrics, its place in a funnel — to punish one attr. It does so
behind a `202`, so nothing surfaces at the emitter, and the loss is discovered
by reading the quarantine, which nobody does. Losing `export.completed` because
`outputs` gained an option is not validation working; it is a schema mismatch
deleting the evidence a product decision would have been made from.

Stripping keeps the honest part of the record and puts the drift in a counter
you can act on — the same trade `data` has always made, where an undeclared
payload is dropped and the row survives.

**What is NOT relaxed**, because these are not vocabulary problems:

| Still a hard reject | Why |
|---|---|
| a missing required **subject** | structural — a record about nobody cannot be aggregated by subject |
| `data` failing its schema | the one free-text corner, so it is a privacy boundary |
| span without `traceId`/`spanId`/`durationMs`, state without `state.to` | the kind's own contract |
| an unregistered event **name** | there is no spec to strip against |

Rollup cardinality is unaffected: a stripped attr simply resolves to the
family's [`dimDefault`](/guide/registry#dimdefault), exactly as an absent one
always did.

**Set `'strict'` when** a partial record is worse than no record — a billing or
audit domain where a row with a missing dimension would be read as fact. Money
already has a stronger guarantee (`kind: 'usage'` is insert-gated on
`idempotencyKey`), so this is rarer than it sounds.

**Watch `counters.attrsDropped`.** Under the lenient default it is the only
warning you get that a client has outrun the registry — there is no quarantine
row to notice any more, by design. It names the event and the key, which is the
zod line you are missing; the System page renders it, and `suggest.ts` turns it
into the line itself.

## `globalSubjectRefs`

**Default: `false`.** The host asserting that a subject ref (`type:id`) names
the **same party in every tenant**.

The package cannot verify that, so it is declared rather than detected. It has
exactly one effect today: `forget(tenantId, ref)` also erases that person's
**platform-scoped** saved dashboard views — the ones stored under `'*'`, which
is not a tenant and which a tenant-scoped erasure otherwise misses.

```ts
createTelemetry({ registry, connection, globalSubjectRefs: true });
```

**Turn it on when** your user ids come from one global identity system, so
`user:u_1` is one human everywhere. Erasure is then complete in one call.

**Leave it off when** ids are minted per tenant. There, `user:u_1` is a
different person in each tenant, and one tenant's erasure would delete another
tenant's views. The default is the conservative one because the package cannot
tell which world it is in, and the wrong guess in that direction destroys data
belonging to someone who never asked to be forgotten.

Note the asymmetry that makes this safe either way: `forget()` still refuses
`'*'` as the erasure *scope* — an unbounded rewrite of every tenant's rows. This
flag only reaches `'*'` rows owned by one named ref. Bounded by the person, never
by the tenant. See [Erasure](/guide/erasure).

## `subjectLinker`

**Default: absent.** A host hook that attaches additional subjects to a record
**at write time** — the one place in the config where the package asks *you* a
question about the row it is about to store.

```ts
createTelemetry({
  registry,
  connection: mongoose,
  subjectLinker: {
    link: (subjects) => {
      const machine = subjects.find((s) => s.type === 'machine');
      const userId = machine && OWNER_CACHE.get(machine.id);
      return userId ? [{ type: 'user', id: userId }] : [];
    },
  },
});
```

**Change it when** records arrive knowing one party and you know another. The
case it was built for: a desktop client knows its install and nothing else, so
every record carries `machine:<installId>` and no `user`. Joining that at read
time still leaves a cohort funnel anchored on `user` reading zero for every
desktop stage — a lifetime `by:['subject']` rollup is keyed on the subject the
record was written with, and no later join can reach back into it.

It runs once per record, on the ingest path, so it must answer from a **cache**.
It can never fail a write: a throw, a nonsense return value, or an overrun of
`subjectLinkTimeoutMs` all write the record with the subjects it came with and
move a counter. Six of those counters exist, and the five failure ones are the
difference between *"nothing links"* and *"the link is broken"*.

One trap is worth reading before you configure it: a linked subject whose type
the event does not declare is **written anyway** and reported in
`counters.subjectLinkUndeclared`. Do not "fix" that by declaring the type —
`EventSpec.subjects` is a REQUIRED list, so declaring `user` on a desktop event
makes it mandatory and quarantines every record from a machine nobody has
activated yet. Full semantics, merge order and counters are on
[Adapters](/guide/adapters#subjectlinker).

And one thing to plan for: linking runs at **write time**, so switching it on
does nothing for the records you already have — their user-keyed rollups have no
member for any of them. [`t.relink()`](/guide/adapters#relink) is the backfill,
and it is a dry run unless you pass `{ dryRun: false }`.

## `subjectLinkTimeoutMs`

**Default: `SUBJECT_LINK_TIMEOUT_MS` (50).** What `subjectLinker.link()` gets per
record before the write proceeds **unlinked** and `counters.subjectLinkTimeouts`
increments.

**Change it when** you have measured the resolver and know it needs more — and
know what that costs, because this number multiplies by every record in a batch.
The default is chosen so that a host outage degrades telemetry rather than
stalling ingest behind it. Ignored without a `subjectLinker`.

## `logger`

**Default: a no-op.** Any object with `info`, `warn` and `error` methods —
pino, console, whatever you already have.

```ts
createTelemetry({ registry, connection, logger: pino({ name: 'telemetry' }) });
```

**Change it when** you want to see the boot warnings. The one that matters is
emitted at construction, once per offending entry:

```
[telemetry] "page.view" declares `data` but inherits retentionDays=730 from
kind=event — its payloads are stamped to expire in 730 days, and that cannot be
undone after the write. Set an explicit retentionDays (null = immortal) to
choose, and to silence this.
```

`expiresAt` is stamped **per row at write time**, so this is not a policy you can
revise later: rows already written carry the fuse. With the default no-op
logger, that warning goes nowhere. See
[the registry's retention section](/guide/registry#retentiondays).

The logger is also exposed as `t.logger` and used by the router factories.

## Counters are part of the configuration story

Whatever you configure, the drops are countable. `t.counters` is a live object:

```ts
app.get('/metrics', (req, res) => res.json(t.counters));
```

| counter | increments when |
|---|---|
| `rejected` | unregistered name, failed validation, or `data` dropped as undeclared / out of bounds |
| `defaulted` | `service` or `release` was missing and got stamped `'unknown'` |
| `sampled` | the evidence plane declined a row (aggregates still updated) |
| `capped` | a burst cap declined a row (aggregates still updated) |
| `rollupSkipped` | a rollup dimension resolved empty and had no `dimDefault` |
| `deduped` | an insert-gated write lost to an existing `dedupeKey` / `usage.idempotencyKey` |
| `truncated` | a `body` was clipped to `bodyMax` |
| `attrsDropped` | an attr removed so the record could be written — undeclared, or a value outside the schema. Zero under `validation: 'strict'` |
| `metricsDropped` | the same, for metrics |
| `subjectsLinked` | a `subjectLinker` added a subject to a record — counted per subject |
| `subjectLinkMisses` | the linker answered `[]` — no link exists |
| `subjectLinkErrors` | the linker threw, rejected, or answered with something that is not a list of refs |
| `subjectLinkTimeouts` | the linker outran `subjectLinkTimeoutMs`; the record was written unlinked |
| `subjectLinkUndeclared` | a linked subject type the event does not declare — written, and reported |
| `subjectLinkCapped` | a linked subject over `SUBJECT_MAX` (8) on one record |

The six linking counters stay at zero without a `subjectLinker`.

Surface them. A silent drop that nobody counts is the failure mode this package
exists to prevent, and every one of these numbers has a configuration change
behind it.
