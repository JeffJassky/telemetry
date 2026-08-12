import { Schema, type Connection, type Model } from 'mongoose';
import type { Registry } from './registry.js';
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
 * Stated bound: forget(tenantId, ref) is tenant-scoped and '*' is not a tenant,
 * so a person's PLATFORM-scoped saved views are not erased by a forget() call
 * against their home tenant. Widening forget() to reach '*' rows would give a
 * tenant-scoped call cross-tenant write reach, which is the trade we refused.
 */

export interface ViewSpec {
  name: string;
  icon?: string;
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview' | 'system';
  query: {
    range?: string;
    filters?: Record<string, unknown>;
    groupBy?: string;
    sort?: string;
    display?: 'table' | 'series' | 'breakdown' | 'stream';
  };
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
 * Derived views — generated from the registry at load, zero config. One per
 * event name (a pre-filtered page), one per rollup family (a RollupExplorer
 * preset). They exist because the registry already knows enough to write them.
 */
export function deriveViews(registry: Registry): Array<ViewSpec & { origin: 'derived' }> {
  const views: Array<ViewSpec & { origin: 'derived' }> = [];
  const families = new Set<string>();
  for (const [name, spec] of Object.entries(registry)) {
    views.push({
      origin: 'derived',
      name,
      page: KIND_PAGE[spec.kind] ?? 'events',
      query: { range: '7d', filters: { name }, display: spec.kind === 'event' ? 'series' : 'table' },
    });
    for (const r of spec.rollups ?? []) families.add(r.as ?? name);
  }
  for (const as of families) {
    views.push({
      origin: 'derived',
      name: `rollup: ${as}`,
      page: 'journeys',
      query: { range: '30d', filters: { rollup: as }, display: 'breakdown' },
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
  configured: ViewSpec[];
  /** the viewer's scope — a tenantId, or PLATFORM_SCOPE. Matched literally. */
  tenantId: string;
  viewerRef?: string;
}): Promise<ResolvedView[]> {
  const byName = new Map<string, ResolvedView>();
  for (const v of deriveViews(opts.registry)) byName.set(v.name, v);
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
