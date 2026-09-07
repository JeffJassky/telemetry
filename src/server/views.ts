import { Schema, type Connection, type Model } from 'mongoose';
import { deriveCatalog, type Catalog } from './catalog.js';
import type { Registry } from './registry.js';
import { intervalForRange, type LegacyQuery, type Report } from './report.js';
import { newId } from './types.js';

/**
 * Views — one shape, three producers (dashboards §3). A view is nothing but
 * named query state; derived views come from the registry for free, configured
 * ones ship in host code, saved ones live in `<collection>_views`. Name
 * collisions shadow saved → configured → derived, so a user can override a
 * default without editing anything.
 *
 * Tenancy: views scope on the LITERAL viewer scope, including PLATFORM_SCOPE.
 * '*' is an escape hatch for reading telemetry, not a master key to other
 * people's saved state, so it does NOT fan out here the way it does in the
 * query primitives. A platform viewer's views live in their own '*' namespace:
 * invisible to every tenant, and every tenant's views invisible to them. Both
 * directions fall out of the same literal match — in resolveViews below and in
 * the router's delete/ownership lookup, which must stay literal for the same
 * reason (a platform admin's `role: 'admin'` is admin OF the platform scope).
 *
 * Erasure across that boundary is opt-in. forget(tenantId, ref) is
 * tenant-scoped and '*' is not a tenant, so a person's PLATFORM-scoped views
 * are missed by default — set `globalSubjectRefs` on createTelemetry() and
 * forget() reaches them too. The flag is the host asserting that a ref names
 * one party globally; without that, `user:u_1` is a different person in every
 * tenant and one tenant's erasure would delete another's views. Bounded by the
 * named ref either way — never by the tenant, which is the escape hatch this
 * namespace exists to deny.
 */

export interface ViewSpec {
  name: string;
  icon?: string;
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview' | 'system' | 'explore';
  /**
   * A Report (reports §4) — or the pre-Report shape, which every stored view
   * still carries and `normalizeQuery()` lifts. `spec` is a Mixed document, so
   * nothing has to migrate: a query with no `source` is read as legacy and a
   * query with one is read as a Report.
   */
  query: Report | LegacyQuery;
}

export function buildViewModel(connection: Connection, modelName: string, collection: string): Model<any> {
  const existing = connection.models?.[modelName];
  if (existing) return existing;
  const schema = new Schema(
    {
      _id: { type: String, required: true },
      tenantId: { type: String, required: true },
      /** a person — forget() deletes private views, redacts this on shared ones */
      ownerRef: String,
      shared: { type: Boolean, default: false },
      spec: { type: Schema.Types.Mixed, required: true },
      createdAt: { type: Date, required: true },
    },
    { collection, versionKey: false },
  );
  schema.index({ tenantId: 1, shared: 1 });
  schema.index({ tenantId: 1, ownerRef: 1 });
  return connection.model(modelName, schema);
}

const KIND_PAGE: Record<string, ViewSpec['page']> = {
  error: 'errors',
  span: 'traces',
  event: 'events',
  state: 'journeys',
  usage: 'usage',
};

/**
 * Derived views — generated from the registry at load, zero config, and every
 * one of them a {@link Report} (reports §8). They exist because the registry
 * already knows enough to write them, so five shapes fall out of it:
 *
 * | shape | name | what it answers |
 * |---|---|---|
 * | per event | `<name>` | that one name over a week |
 * | per family | `rollup: <as>` | the family's own docs — the cheapest read there is |
 * | per namespace | `namespace: <ns>` | `library.*` split by name over a month |
 * | per usage event | `spend: <name>` | its `*_usd` sum per day |
 * | per subject type | `funnel: <type>` | its lifetime milestones as a cohort funnel |
 *
 * The catalog is what makes the last three writable, and it is PURE — so this
 * function keeps its one-argument signature and derives one when a caller
 * (resolveViews, off a request) has none to hand. `createDashboard` and
 * `createTelemetryMcp` both built theirs at boot and pass it through.
 *
 * Determinism matters more than it looks: these names are the sidebar, and a
 * list that reshuffles between requests is one nobody can link into. Every loop
 * below walks the catalog in registry order.
 */
export function deriveViews(
  registry: Registry,
  catalog: Catalog = deriveCatalog(registry),
): Array<ViewSpec & { origin: 'derived' }> {
  const views: Array<ViewSpec & { origin: 'derived' }> = [];
  const derived = (name: string, page: ViewSpec['page'], query: Report) =>
    views.push({ origin: 'derived', name, page, query });

  // ── one per event: the name, charted over a week ──
  for (const [name, e] of Object.entries(catalog.events)) {
    derived(name, KIND_PAGE[e.kind] ?? 'events', {
      source: { event: name },
      range: '7d',
      interval: intervalForRange('7d'),
    });
  }

  // ── one per rollup family: read the family itself, which is always exact ──
  for (const as of Object.keys(catalog.families)) {
    derived(`rollup: ${as}`, 'journeys', { source: { family: as }, range: '30d' });
  }

  // ── one per namespace: `library.*` broken out by name ──
  // A namespace of one event is that event's own view under a second name, so
  // it is skipped rather than duplicated into the sidebar.
  for (const [ns, names] of Object.entries(catalog.namespaces)) {
    if (names.length < 2) continue;
    derived(`namespace: ${ns}`, 'explore', {
      source: { namespace: ns },
      range: '30d',
      interval: 'day',
      groupBy: ['field:name'],
    });
  }

  // ── one per usage event that meters money ──
  // `*_usd` is a formatting CONVENTION (dashboards §4), which makes it the one
  // thing about a metric this file may read off a key. It never names one.
  for (const [name, e] of Object.entries(catalog.events)) {
    if (e.kind !== 'usage') continue;
    const money = e.measures.find((m) => m.key.startsWith('sum:') && m.key.endsWith('_usd'));
    if (!money) continue;
    derived(`spend: ${name}`, 'usage', {
      source: { event: name },
      range: '30d',
      interval: 'day',
      measure: money.key,
    });
  }

  // ── one funnel per subject type ──
  // Stages are the lifetime single-subject families of that type, in registry
  // order — the order the host typed them in, which is the only sequence a
  // registry can claim. The UI re-orders them by observed median `firstAt`
  // (reports §7); this default has no data to read.
  for (const subjectType of catalog.subjectTypes) {
    const stages = Object.values(catalog.families)
      .filter((f) => f.lifetime && f.by.length === 1 && f.by[0] === 'subject' && f.subjectTypes.includes(subjectType))
      .map((f) => f.as);
    // one stage is not a funnel — it is a count, and there is already a view for it
    if (stages.length < 2) continue;
    derived(`funnel: ${subjectType}`, 'journeys', {
      // any source expands; the family the funnel is anchored on is the honest one
      source: { family: stages[0]! },
      range: '30d',
      interval: 'week',
      measure: 'funnel',
      stages,
      anchor: stages[0]!,
      subjectType,
    });
  }

  return views;
}

export interface ResolvedView extends ViewSpec {
  origin: 'derived' | 'configured' | 'saved';
  id?: string;
  ownerRef?: string;
  shared?: boolean;
}

/** merge the three producers; name collisions resolve saved → configured → derived */
export async function resolveViews(opts: {
  ViewModel: Model<any>;
  registry: Registry;
  /** the caller's boot-time catalog, so a request does not re-derive one */
  catalog?: Catalog;
  configured: ViewSpec[];
  /** the viewer's scope — a tenantId, or PLATFORM_SCOPE. Matched literally. */
  tenantId: string;
  viewerRef?: string;
}): Promise<ResolvedView[]> {
  const byName = new Map<string, ResolvedView>();
  for (const v of deriveViews(opts.registry, opts.catalog)) byName.set(v.name, v);
  for (const v of opts.configured) byName.set(v.name, { ...v, origin: 'configured' });
  const saved = await opts.ViewModel.find({
    tenantId: opts.tenantId,
    $or: [{ shared: true }, ...(opts.viewerRef ? [{ ownerRef: opts.viewerRef }] : [])],
  })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();
  for (const doc of saved as any[]) {
    byName.set(doc.spec.name, {
      ...doc.spec,
      origin: 'saved',
      id: doc._id,
      ownerRef: doc.ownerRef,
      shared: doc.shared,
    });
  }
  return [...byName.values()];
}

export async function saveView(opts: {
  ViewModel: Model<any>;
  tenantId: string;
  viewerRef?: string;
  spec: ViewSpec;
  shared: boolean;
}): Promise<{ id: string }> {
  // a viewer without an identity cannot own a private view — share or nothing
  if (!opts.shared && !opts.viewerRef) {
    throw Object.assign(new Error('private views need a viewer identity'), { status: 400 });
  }
  const id = newId();
  await opts.ViewModel.create({
    _id: id,
    tenantId: opts.tenantId,
    ownerRef: opts.viewerRef,
    shared: opts.shared,
    spec: opts.spec,
    createdAt: new Date(),
  });
  return { id };
}
