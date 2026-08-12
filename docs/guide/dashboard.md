# The dashboard

`createDashboard()` returns one Express router that serves two things: a JSON API
under `/api`, and a prebuilt React SPA at everything else. You mount it. It is
never an app and never a server.

```js
import { createDashboard } from '@jeffjassky/telemetry';

app.use('/telemetry', createDashboard({
  telemetry: t,
  mountPath: '/telemetry',
  viewerAdapter: {
    resolveViewer: (req) => req.session
      ? { tenantId: req.session.accountId, role: req.session.role, viewerRef: `user:${req.session.userId}` }
      : null,
  },
}));
```

## It throws without a `viewerAdapter`

Not a warning. Not a permissive default. `createDashboard()` refuses to
construct:

```
telemetry: createDashboard requires a viewerAdapter — an unauthenticated
telemetry dashboard is a data leak with charts
```

The reasoning is short. This router serves error messages, stack frames, request
traces, per-subject journeys, and billable usage for every tenant in the
database. A default that let it boot without auth would be a footgun that fires
in production and looks fine in development, which is the worst possible shape
for a security default. Making it a constructor error means the failure happens
at boot, on your machine, before anything is mounted.

The adapter answers one question, inbound: **who is looking, and how widely?**

```ts
interface Viewer {
  tenantId: string;      // the read scope — a tenantId, or '*'
  role: string;          // 'admin' unlocks System writes, within this scope
  viewerRef?: string;    // who this person is; owns saved views. e.g. 'user:u_1'
}
```

Return `null` and every `/api` route answers `401 {"error":"unauthenticated"}` —
JSON, never a list, never a redirect. Your own middleware is still welcome in
front of the mount; the adapter is what the *package* uses to scope reads, and
it is not a substitute for your session layer.

## The SPA is React and your framework does not matter

The dashboard is a React application, built by Vite into `dist/ui` and served by
this router with hashed assets and an SPA fallback. It is **not** exported into
your component tree. A Vue app mounts a React dashboard at `/telemetry` and never
knows — no shared runtime, no framework negotiation, no `.vue` files shipped from
a package.

Assets are referenced relatively; the server injects `<base href="<mountPath>/">`
and a config blob per request. One build, any mount path, no rebuild to remount.

**The catch: `mountPath` must match where the browser actually sees the router.**
Behind a proxy that strips a prefix, that is the *external* path, not the
internal one. Get it wrong and the HTML loads while every asset 404s — a failure
that looks like a broken build and is a wrong string.

The shell is served with `Cache-Control: no-store` while `_assets` are cached for
a year as `immutable`. A heuristically-cached `index.html` would keep referencing
dead hashed assets across deploys; the hard-cached assets are the ones with
content hashes in their names, so caching them hard is free.

On a fresh clone with no build, the shell route answers **503** with a plain-text
line telling you to run `npm run build`. `dist/` is not committed, so that is the
normal state of a checkout, not a bug.

## Views: one shape, three producers

A view is nothing but **named query state** — a page, a range, some filters, a
display mode. That is the whole model, and it is why three very different things
can produce one:

| Origin | Comes from | Lives in |
|---|---|---|
| `derived` | the registry, automatically | nowhere — generated per request |
| `configured` | `views: [...]` in your `createDashboard()` call | your code, versioned in git |
| `saved` | a user pressing save in the UI | `<collection>_views` |

**Derived views exist because the registry already knows enough to write them.**
Every event name gets a pre-filtered page (routed by kind: errors → Errors,
spans → Traces, states → Journeys, usage → Usage, events → Events). Every rollup
family gets a `rollup: <family>` preset. Zero configuration, and they stay
correct as the registry changes, because they *are* the registry.

Configured views are the ones you want in git — the four charts your ops team
opens every morning, reviewed like code.

Saved views are the ones a user made for themselves. Private by default; pass
`shared: true` and they become tenant-wide. A viewer with no `viewerRef` cannot
own a private view (there is no owner to attach), so saving one without sharing
is a 400.

**Collisions resolve by name: saved shadows configured shadows derived.** A user
who saves a view named `error.unhandled` replaces the derived one in their own
sidebar without editing anything and without anyone deploying. The response
carries exactly one view per name, with its `origin` on it, so the UI can mark
where it came from (★ saved, ◆ configured, · derived).

Deleting is ownership-checked: your own view always; someone else's only with
`role: 'admin'`. A view outside your scope reports `removed: 0` rather than 403 —
whether that id exists somewhere else is not your business either.

## The platform scope

Set `Viewer.tenantId` to `'*'` (exported as `PLATFORM_SCOPE`) and the query
primitives drop the tenant term. That is a support console, a platform-wide cost
page, an ops overview across every customer.

**Returning `'*'` IS the authorization decision, and it is yours.** The package
never infers platform admin from a role, a header, or a config flag. It only
makes the escape hatch *expressible* — so a host that genuinely needs a
cross-tenant read declares it here, inside the boundary, instead of reaching
around `scoped()` with a raw model in some admin controller nobody reviews.

Three things stay true under `'*'`:

1. **Nothing else is relaxed.** The time range is still mandatory. The caps still
   apply. Every filter term still applies. It drops the tenant and nothing else.
2. **Every row still carries its own `tenantId`.** Records, rollups, traces,
   journeys — the stored tenant is on the row, never projected away. The SPA
   marks cross-tenant rows for this reason: a spliced number that cannot say
   which tenant it came from is not a number you can act on. `GET /api/registry`
   reports `scope` and `platform: true` so the UI knows to render those markers
   at all.
3. **`series` and `distribution` aggregate ACROSS tenants.** One bucket per
   interval with every tenant summed into it. That is the platform-wide chart, by
   design — it is the number a platform operator came for. A per-tenant breakdown
   is a different question; ask it with `rollups()` or by scoping to a tenant.

And two things that are *not* true, which is where the design earns its keep:

**`'*'` is reserved on the write side.** No stored row can carry it: `emit()`
quarantines it, `forget()` and `createKey()` (fixed mode) throw, and ingest
refuses the batch whichever way the tenant resolved. A tenant literally named
`'*'` would otherwise be a privilege escalation via a string. So when a read
"drops the tenant term", there is no ambiguity about what it matches.

**`scoped()` does not know about `'*'` and never will.** `t.scoped('*')` scopes
to the literal string `'*'` and therefore matches nothing. That primitive's
isolation guarantee is worth more unconditional: whatever string goes in, only
rows carrying that string come out. The cross-tenant path lives one layer up, in
the query primitives, behind the adapter where an authorization decision was
actually made about who is asking.

**Saved views do not fan out under `'*'`.** They scope on the viewer string
*literally*, `'*'` included. A platform viewer's views live in their own
namespace: invisible to every tenant, and every tenant's views invisible to them.
Neither can delete the other's — a platform admin's `role: 'admin'` is admin *of
the platform scope*. `'*'` reads telemetry across tenants; it is not a master key
to other people's saved state.

One consequence worth knowing before you need it: because `forget(tenantId, ref)`
is tenant-scoped and `'*'` is not a tenant, a person's platform-scoped saved
views are missed by a default erasure call. Set `globalSubjectRefs: true` on
`createTelemetry()` — an assertion that a subject ref names the same party in
every tenant — and `forget()` reaches them. Leave it off when ids are minted per
tenant, where `user:u_1` is a different person in each and one tenant's erasure
would reach another's. See [Erasure](/guide/erasure).

## The System page

Where "never drop silently" stops being a slogan and becomes a screen. It is not
optional and it is not behind a flag, because a package that counts its drops and
never shows them has not solved anything.

**Counters** — the seven numbers from `t.counters`, tiled:

| | |
|---|---|
| `rejected` | quarantined writes — unregistered names, failed validation, reserved tenants |
| `sampled` | evidence dropped by rate (dormant while every rate is 1) |
| `capped` | burst caps and per-key ingest rate limits |
| `deduped` | idempotent replays that correctly wrote nothing |
| `truncated` | `body` values clipped to the cap — the row survived, marked |
| `defaulted` | records missing `service`/`release`, filled with `unknown` |
| `rollupSkipped` | records skipped by a rollup for an unresolvable dimension |

These are per-process, in-memory counters. Scrape them onto your own `/metrics`
too — the page is for a human noticing, not for alerting.

**Quarantine** — the latest 50 rejects, with timestamp, event name, and reason.
Every row is a write someone attempted and the package refused. This is the first
place to look after a deploy: a wave of `unregistered event` means a client is
ahead of (or behind) the server's registry.

**Index budget** — the live index count on the telemetry collection against
`INDEX_BUDGET` (24 payload indexes). Mongo caps a collection at 64; the base
schema and discriminators use about ten. `syncIndexes()` throws at boot rather
than degrade if the registry's `indexedAttrs`/`indexedMetrics` exceed the budget,
so this tile is the early warning for that.

**Keys** — visible to `role: 'admin'` only, and served with `secretHash`
projected away. Id, kind, tenant mode, service, env, rate, and revoke. Revocation
is gated on *our* admin check rather than assumed from the mount's middleware,
because your guard may be coarser than ours. A revoked key starts dropping
writers within the ingest key-cache TTL (60s by default), which the confirm
dialog says out loud.

## Errors are JSON

Every `/api` failure answers JSON, never an HTML stack page. A handler that
throws with a `status` reports that status and its message verbatim — the cohort
primitives use this to surface registry mistakes as a 400 with the fix in the
message, rather than a 500 that hides it. Anything without a `status` is logged
server-side and answered as `500 {"error":"internal_error"}`, so an exception's
text never leaks to a browser.

## Adapters

| Adapter | Direction | Required |
|---|---|---|
| `viewerAdapter.resolveViewer(req)` | inbound — who is looking | **yes** |
| `subjectAdapter.describe(refs)` | outbound — pretty labels for subject refs | no |

Without a `subjectAdapter`, `GET /api/subjects/describe` returns `{ refs: {} }`
and the UI renders raw refs like `user:u_1`. That is the documented fallback, not
a degraded mode — refs are always meaningful, just not friendly.

```js
subjectAdapter: {
  describe: async (refs) => {
    const users = await User.find({ _id: { $in: refs.filter(r => r.startsWith('user:')).map(r => r.slice(5)) } });
    return Object.fromEntries(users.map(u => [`user:${u.id}`, { label: u.email, href: `/admin/users/${u.id}` }]));
  },
}
```

At most 100 refs per call.

## Caps and slow queries

Every read primitive carries its `$limit` inside the pipeline — an unbounded read
is unreachable by construction, not by convention. Most also require a time
range; the two exceptions are stated in
[Queries](/guide/queries#the-eight-primitives) rather than glossed over.
Override the caps with `queryLimits`, and get told when a read is slow:

```js
createDashboard({
  telemetry: t,
  viewerAdapter,
  queryLimits: { records: 100, funnel: 20_000 },
  onSlowQuery: ({ op, ms, params }) => log.warn({ op, ms, params }, 'slow telemetry read'),
});
```

A caller asking for more than the cap gets the cap, silently — the ask is a
preference, the cap is the contract. Where truncation would change the *meaning*
of a number — rollup reads, distributions, distinct counts, funnel cohorts — the
response carries `truncated: true` instead, because a quietly short answer to
"how many" is worse than no answer. The UI renders that: the cohort funnel and
the duration distribution both say so above the chart rather than drawing a
lower bound as though it were the number.

## See also

- [Admin HTTP API](/reference/http-admin) — every route, parameter, and status code
- [`createDashboard`](/reference/routers#createdashboardoptions) — every option
- [Queries & funnels](/guide/queries) — what the primitives actually compute
- [Adapters](/guide/adapters) — the inbound/outbound convention
