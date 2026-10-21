# Annotations

A metric moves. The first question is always *what changed?* An annotation is
the answer written down when it happened: a deploy, a tracking tag removed, a
consent banner switched on, a landing page launched, a campaign started, an
outage. GA4, Search Console and the ad platforms all have them, for the same
reason.

The dashboard draws every annotation on every time-series chart whose window it
falls in. Agents read the same list through the
[`list_annotations`](/guide/mcp) tool.

```ts
await t.annotations.create({
  tenantId: 'site_42',
  at: '2026-10-03T14:00:00Z',
  title: 'Removed the Meta pixel from checkout',
  category: 'tracking',
  service: 'webapp',
  url: 'https://github.com/acme/site/pull/812',
});
```

## How it works

An annotation is a row in `<collection>_annotations`. It has a time, a title,
and a category. An end time makes it a span (a sale, an outage, an
experiment). Optional fields narrow it to one `service` and/or `env`, add
`tags` and a `url`, and record its `source` and `authorRef`.

On a chart, a point annotation is a dashed vertical line with a flag on top. A
span is a shaded band. Hover for the note; click to open it on the
**Annotations** page. The ⚑ button in the top bar hides or shows them on every
chart, remembered per browser.

Charts draw what overlaps their window: a point inside `[from, to)`, or a span
that starts before `to` and ends at or after `from`.

## What it can and cannot tell you

**It shows what happened when, not what caused what.** A line next to a jump
is the first place to look, never proof. Two changes on the same day, a
seasonal pattern, or a change nobody logged can all explain the same jump.

**It is only as complete as the habit.** Hand-written annotations always have
gaps. The ones a system writes for you are the ones you can count on, so wire
your deploy pipeline and any system that changes tracking (a tag manager, a
consent tool) to write them.

**Charts in this dashboard space buckets evenly by position, not by time.** A
chart over a series with empty buckets compresses the gap, and an annotation
inside the gap is placed proportionally between the two buckets around it.

## Scope

| `tenantId` | Who sees it |
|---|---|
| a tenant | that tenant |
| `'*'` (`PLATFORM_SCOPE`) | every tenant, plus the platform viewer |

`'*'` is for a change that touched every tenant at once, usually your own
deploy. Records can never be written with `'*'`, but annotations can: here it
means "all tenants", and no tenant can be named `'*'`, so the two cannot
collide.

A tenant viewer sees its own annotations plus the global ones. The platform
viewer sees the global ones only. A tenant's notes are not drawn over a
cross-tenant sum.

`service` and `env` narrow further. A chart filtered to `service=api` keeps
annotations for `api` plus those with no service. Leave them blank for "all".

## Writing from code

`create()` validates and throws an `Error` with `status: 400` on bad input:
a missing title, `endAt` before `at`, a category that is not a lowercase slug,
a `url` that is not http(s), more than 20 tags.

### Deploy hooks: use `key`

A deploy hook retries. Pass a `key` and `create()` becomes an upsert on
`(tenantId, key)`, so the second delivery updates the first instead of drawing
a second line:

```ts
await t.annotations.create({
  tenantId: '*',
  at: new Date(),
  title: `Deployed ${process.env.RELEASE}`,
  category: 'deploy',
  source: 'ci',
  key: `deploy:${process.env.RELEASE}`,
});
```

Concurrent first deliveries are safe: a unique index refuses the duplicate and
the retry updates the winner.

### Categories

Any lowercase slug (`[a-z0-9_.-]`, up to 64 characters). Default `change`. The
dashboard suggests `ANNOTATION_CATEGORIES` and colours them:

| category | for |
|---|---|
| `change` | anything else |
| `deploy` | a release of your code |
| `tracking` | a tag, pixel or SDK added, removed or reconfigured |
| `consent` | a consent banner or policy change |
| `content` | a page, template or copy change |
| `campaign` | a launch, sale or promotion |
| `incident` | an outage or degradation |
| `note` | context with no change behind it |

### The rest of the API

```ts
t.annotations.list(scope, { from, to, service?, env?, category?, tags?, limit? })
// → { items, truncated }   oldest first; default 500, max 2000

t.annotations.get(tenantId, id)
t.annotations.update(tenantId, id, patch)   // null when not in that scope
t.annotations.remove(tenantId, id)          // { removed: 0 | 1 }
```

`update` and `remove` match the scope literally: `'*'` reaches only the global
annotations, never a tenant's.

## Writing from the dashboard

The **Annotations** page lists the annotations in the range picker's window,
and has a form to add one. Any viewer can add one. Logging "I removed the
pixel" is the habit this exists to build, and a permission gate is how nobody
does it.

Each annotation is stamped from the viewer, never the request body: the
viewer's scope as `tenantId`, `viewerRef` as `authorRef`, and `source:
'dashboard'`. Editing and deleting follow saved views: your own, or any in
your scope with `role: 'admin'`. The routes are in the
[admin HTTP reference](/reference/http-admin#annotations).

## Erasure

An annotation is a fact about the product, not about the person who wrote it,
so [`forget()`](/guide/erasure) keeps it and rewrites only `authorRef` to the
pseudonym. Global annotations are reached under the same `globalSubjectRefs`
declaration as platform-scoped saved views.

## Not in this release

- **No ingest route.** A separate service writing annotations calls a route your
  host exposes around `t.annotations.create()`. The ingest router's keys do not
  cover annotations yet.
- **No MCP write tool.** The MCP suite stays read-only; `list_annotations` reads.
- **No retention.** Annotations never expire. They are small and rare, and an
  old one still explains an old chart.
