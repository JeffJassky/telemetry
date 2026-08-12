# Erasure

```ts
const result = await t.forget('tn_1', 'user:u_1');
// { deleted, redacted, rollups, aliases, views }
```

One call in your account-deletion path. It deletes what only they were party to,
destroys the linkage on everything else, rekeys the aggregates they were counted
in, and reaches quarantine, aliases and saved views. Every count is returned so
the caller can log what actually happened.

`ref` is an `EntityRef` — `type:id`. Anything else throws before touching a
document. `forget()` is always awaited, so it throws rather than quarantining.

## Delete, or redact

The rule is about **parties**, not about kinds:

- **Delete** the row when the ref is the *sole* party on it — its only subject,
  with no other principals — and it is not `kind: 'usage'`.
- **Redact** the row otherwise.

Deleting a shared row would erase the other party's history too. A report that
`user:u_1` shared with `user:u_2` is `u_2`'s business record as much as `u_1`'s;
an org's activity does not disappear because one member left. `usage` rows are
always redacted — money is subject to statutory retention.

Redaction keeps the row and destroys the identifiers in it, in one pipeline
update:

- `subjects[]` — the matching entry's `id` becomes the pseudonym
- `subjectKeys[]` and `otherPrincipals[]` — the matching entry becomes the
  pseudonymous ref
- `actor` and `onBehalfOf` — rewritten when they were the ref
- `client` — **removed entirely.** User agent, OS, locale, timezone, screen size
  and connection are a fingerprint, so the whole subdocument goes rather than
  selected fields.
- `redactedAt` — stamped, so a redacted row is identifiable as one

The pseudonym keeps its `type:` prefix — `user:redacted_9f3c…` — so `subjectKeys`
stays re-derivable if the document is ever saved again, and so a redacted row is
still shaped like a row rather than becoming a special case for every reader.

Both the delete and the redact match on `subjectKeys` **or** `otherPrincipals`.
That second array is derived at write time as "actor / onBehalfOf not already in
subjects", and it exists for exactly this: an admin who impersonated someone, or
an actor who was never a subject, is still a person with a right to erasure.

## Rollups are rekeyed, never deleted

[Rollup documents](/guide/rollups) carrying the ref as a **dimension** are
rewritten under the pseudonymous ref: insert the rekeyed copy, delete the
original. (`_id` is immutable in Mongo, and the rollup `_id` is derived from the
dims, so this cannot be a `$set`.)

Deleting them would retroactively shrink every cohort the person was counted in.
Funnel denominators would change under you, published numbers would stop
reproducing, and the change would be invisible. Aggregates survive; the person
does not.

Only families that *held* an identifier are touched. An issue family keyed on
`error.fingerprint` never carried one, which is exactly why non-subject families
are safe to keep forever — and why subject dims are stored in their native
`type:id` form rather than the `label=value` form used for every other dim. The
match is `{ tenantId, dims: ref }`, and it depends on that.

Re-running `forget()` for the same ref collides on the rekeyed `_id`, which is
treated as a no-op: it means the erasure already happened. `forget()` is
idempotent — a second call finds nothing and changes nothing.

## Quarantine, aliases, saved views

**Quarantine.** `<collection>_rejects` holds raw payloads as sent, including the
ones that failed validation. Those are inside the erasure boundary and are
deleted by subject, actor or `onBehalfOf`. A rejected record is still a record
about a person.

**Aliases.** `<collection>_aliases` links an anonymous ref to a user ref after
[`$identify`](/guide/ingest). It is pure linkage with nothing to redact, so
matching on either side deletes the row.

**Saved views.** `ownerRef` is a person, so views follow the same delete-vs-redact
rule as rows: private views are deleted, shared views survive with `ownerRef`
rewritten to the pseudonym. A view the tenant relies on does not vanish because
its author left.

## Why `data` is unstored unless declared

The envelope's identifier-bearing fields are known and finite: `subjects`,
`actor`, `onBehalfOf`, `client`, and rollup dims. `data` is the one field that
could contain anything — and an arbitrary blob is where delete-by-subject stops
being a guarantee and becomes best-effort, because nothing can tell you whether a
nested payload mentions the person.

So the [registry](/guide/registry) closes it: `data` is **dropped at validation
unless the spec declares a schema for it**, and the drop is counted in
`counters.rejected`.

```ts
'llm.completion': {
  kind: 'span', origin: 'server', subjects: ['org'],
  // declared → stored, and you know exactly which keys can exist
  data: z.object({ temperature: z.number().optional(), max_tokens: z.number().int().optional() }).partial(),
  description: 'Single model call',
},
```

`boundedMeta()` is the escape hatch for hosts that genuinely need a loose bag:
scalars only, at most 12 keys, strings ≤ 200 chars, one nesting level, ≤ 4 KB
serialised. Out of bounds drops the **whole** object rather than truncating it, so
a stored payload is always exactly what the caller sent.

Declaring `data` is a decision about retention as well as erasure — a spec that
declares `data` and no `retentionDays` inherits the per-kind default, and
`expiresAt` is stamped per row at write time, so it cannot be changed afterwards.
`createTelemetry()` warns once at boot when that happens.

## The pepper

The pseudonym is `sha256(ref + pepper)`, truncated to 16 hex characters.

The pepper is a **secret**, passed as `pepper` on
[`createTelemetry()`](/reference/factory) or read from `TELEMETRY_PEPPER`.
`forget()` throws if neither is set — it will not fall back to a default, because
a guessable pseudonym is not a pseudonym. Without the secret, anyone holding the
database can hash a candidate ref and confirm which redacted rows were that
person's; a rainbow table over your user id space is cheap.

Rotating it does not un-erase anything, but it does break the link between rows
redacted before and after the rotation. That is usually fine and occasionally
surprising: two redactions of the same person under different peppers produce two
different pseudonyms, so the rows no longer group.

## What `forget()` will not do

### `'*'` is refused as the erasure scope

`forget(PLATFORM_SCOPE, ref)` throws. Erasure deletes and rewrites rows, so a
scope that matched everything would make one typo unbounded. A platform-wide
erasure is N tenant-scoped calls and the caller has to name each tenant.

This is not the same axis as *reach*, which is the next section. Reaching `'*'`
rows owned by one named person is bounded by the ref. Erasing **at** `'*'` would
be an unbounded rewrite of every tenant's rows. Reach and blast radius are
different things.

### Platform-scoped saved views: opt in

A person who used the [cross-tenant dashboard](/guide/dashboard) owns saved views
stored under `PLATFORM_SCOPE`, and `'*'` is not a tenant — so a tenant-scoped
`forget()` misses them by default and the erasure is incomplete.

```ts
const t = createTelemetry({ registry, connection: mongoose, globalSubjectRefs: true });
```

With the flag set, `forget(tenantId, ref)` searches both `tenantId` and `'*'` for
views owned by that ref, applying the same delete-private / redact-shared rule.
The `views` count in `ForgetResult` covers both scopes.

The flag is the **host asserting that a ref names one party in every tenant.** The
package cannot verify that claim. Where ids are minted per tenant, `user:u_1` is a
different person in each, and one tenant's erasure would delete another tenant's
views — which is why the default is the conservative one, not because reaching
those rows is wrong.

Note what the flag widens: **which scopes are searched, never whose views match.**
A second platform viewer's saved views are a bystander, untouched.

`globalSubjectRefs` has no other effect today.

### The one remaining hard bound

**TTL-expired rows are already gone.** Retention removes documents on Mongo's
schedule, before any erasure request arrives, so `forget()` cannot report on them
and cannot be asked to. This is a property of retention working, not of erasure
failing — but it means `ForgetResult` counts are counts of what *existed*, not of
everything the person ever generated.

## Testing it

Erasure is worth an assertion in the host's own suite, because the interesting
failures are silent: a row that should have been redacted and was deleted, or a
rollup that vanished and quietly moved a denominator.

```ts
await t.flush();                              // fire-and-forget writes must have landed
const r = await t.forget('tn_1', 'user:u_1');

expect(r.deleted).toBe(1);                    // the sole-party row
expect(r.redacted).toBe(2);                   // shared rows survive, linkage does not
expect(await t.scoped('tn_1').find({ subjectKeys: 'user:u_1' })).toHaveLength(0);
```

See [Testing](/guide/testing) for the harness.

## Where to go next

- [The registry](/guide/registry) — declaring `data`, and what that costs
- [Rollups](/guide/rollups) — why rekeying rather than deleting
- [Adapters](/guide/adapters) — `forget()` as the outbound adapter
- [createTelemetry](/reference/factory) — `pepper`, `globalSubjectRefs`
