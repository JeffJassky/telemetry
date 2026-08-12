import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response, Router } from 'express';
import { INDEX_BUDGET } from './indexes.js';
import { isPlatformScope } from './types.js';
import { createQueries, type QueryLimits, type RecordFilter, type TimeRange } from './query.js';
import { buildViewModel, resolveViews, saveView, type ViewSpec } from './views.js';
import type { Telemetry } from './index.js';

/**
 * The read surface (dashboards §2–§8): one express router serving /api/* for
 * the six query primitives plus views/system, and the built React SPA with
 * hashed assets and SPA fallback. Never an app, never a server — the host
 * mounts it.
 *
 * Access control is the named inbound adapter: viewerAdapter.resolveViewer.
 * The router refuses to CONSTRUCT without it — an unauthenticated telemetry
 * dashboard is a data leak with charts.
 */

export interface Viewer {
  /**
   * The read scope: a tenantId, or PLATFORM_SCOPE (`'*'`) for a cross-tenant
   * read — a support console, a platform-wide cost page.
   *
   * `'*'` is an authorization decision, and it is the HOST's to make. The
   * package never infers platform admin from a role, a header, or a config
   * flag; it only makes the escape hatch expressible, so that a host needing a
   * cross-tenant read says so through this adapter instead of reaching around
   * `scoped()` with a raw model. Return `'*'` only for viewers you have already
   * authorized. `'*'` is reserved on the write side, so no stored row carries
   * it and no tenant can ever be named it.
   */
  tenantId: string;
  /** 'admin' unlocks System writes (key revoke); anything else is read-only there */
  role: string;
  /** who this person is — owns saved views; e.g. 'user:u_1' */
  viewerRef?: string;
}

export interface ViewerAdapter {
  resolveViewer(req: Request): Viewer | null | Promise<Viewer | null>;
}

export interface SubjectAdapter {
  /** pretty labels for subject refs; absent refs render raw */
  describe(refs: string[]): Promise<Record<string, { label: string; href?: string }>>;
}

export interface CreateDashboardOptions {
  telemetry: Telemetry;
  viewerAdapter: ViewerAdapter;
  subjectAdapter?: SubjectAdapter;
  /** configured views — versioned in host code (dashboards §3) */
  views?: ViewSpec[];
  queryLimits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  /** threshold onSlowQuery fires above, ms. Default 500. Forwarded to createQueries. */
  slowMs?: number;
  /** in-process query cache TTL, ms. Default 600_000. Forwarded to createQueries. */
  cacheTtlMs?: number;
  /** cached query results kept before eviction. Default 60. Forwarded to createQueries. */
  cacheSize?: number;
  /** where the browser sees this router mounted — MUST match (traps #8) */
  mountPath?: string;
  /** where the SPA calls /api — defaults to mountPath */
  apiBase?: string;
  title?: string;
  spaDir?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

// Published builds run from dist/index.js, so the UI bundle sits alongside at
// dist/ui; running from source it is two levels up. Pick whichever exists —
// a build flag gets one of the two cases wrong (traps #7).
const SPA_DIR_CANDIDATES = ['./ui', '../../dist/ui'];

export function defaultSpaDir(): string {
  for (const candidate of SPA_DIR_CANDIDATES) {
    const dir = path.resolve(here, candidate);
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return path.resolve(here, SPA_DIR_CANDIDATES[SPA_DIR_CANDIDATES.length - 1]!);
}

function escapeJson(value: unknown): string {
  // `</script>` inside injected JSON would close the tag early — escape at `<`
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const parseRange = (q: Record<string, unknown>): TimeRange => {
  const to = q.to ? new Date(String(q.to)) : new Date();
  const from = q.from
    ? new Date(String(q.from))
    : new Date(to.getTime() - 7 * 864e5);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw Object.assign(new Error('invalid time range'), { status: 400 });
  }
  return { from, to };
};

const parseFilter = (q: Record<string, unknown>): RecordFilter => {
  const f: RecordFilter = {};
  for (const k of ['kind', 'name', 'severity', 'env', 'service', 'release', 'subject', 'traceId'] as const) {
    if (typeof q[k] === 'string' && q[k]) (f as any)[k] = q[k];
  }
  if (typeof q.attrs === 'string' && q.attrs) {
    // attrs=format:pdf,route:/reports
    f.attrs = Object.fromEntries(
      String(q.attrs)
        .split(',')
        .map((p) => p.split(':'))
        .filter((p) => p.length >= 2)
        .map(([k, ...v]) => [k!, v.join(':')]),
    );
  }
  if (typeof q.metrics === 'string' && q.metrics) {
    // metrics=cost_usd>0.5,tokens_in<100
    f.metrics = {};
    for (const term of String(q.metrics).split(',')) {
      const m = /^([\w.]+)([<>])(-?[\d.]+)$/.exec(term);
      if (m) f.metrics[m[1]!] = m[2] === '>' ? { gte: Number(m[3]) } : { lte: Number(m[3]) };
    }
  }
  if (typeof q.excludeActors === 'string' && q.excludeActors) {
    f.excludeActorTypes = String(q.excludeActors).split(',').filter(Boolean);
  }
  return f;
};

/** the fields `rollups()` will range-filter on — an allowlist, not a passthrough */
const ROLLUP_ON = ['firstAt', 'lastAt', 'bucketAt'] as const;

/** the fields `rollups()` will ORDER by — an allowlist for the same reason */
const ROLLUP_SORT = ['count', 'lastAt', 'firstAt', 'bucketAt'] as const;

/** an `$in` from a URL is still a scan, so the repeated-param form is bounded */
const MAX_DIMS = 100;

/**
 * `?dims=user:u_1&dims=user:u_2` — the repeated-param form express already
 * parses into an array — is the multi-subject read. One value stays a string,
 * so the single-dim URLs that exist keep working unchanged.
 *
 * Validated rather than coerced: more than MAX_DIMS values, or a nested value
 * where a string belongs (`?dims[0][k]=v` under the extended parser), is a 400
 * rather than a silently narrowed `$in`. Silently dropping half a cohort is the
 * failure the array form exists to prevent, so it must not be reintroduced by
 * the parser that reads it.
 */
const parseDims = (v: unknown): string | string[] | undefined => {
  if (typeof v === 'string') return v || undefined;
  if (!Array.isArray(v)) return undefined;
  if (v.length > MAX_DIMS) {
    throw Object.assign(new Error(`at most ${MAX_DIMS} dims values`), { status: 400 });
  }
  if (!v.every((d) => typeof d === 'string' && d)) {
    throw Object.assign(new Error('dims must be non-empty strings'), { status: 400 });
  }
  return v.length ? (v as string[]) : undefined;
};

/** the registry, projected for the UI — names and shapes, never zod objects */
function registryProjection(t: Telemetry) {
  return Object.fromEntries(
    Object.entries(t.registry).map(([name, spec]) => [
      name,
      {
        kind: spec.kind,
        origin: spec.origin,
        subjects: spec.subjects,
        description: spec.description,
        attrKeys: spec.attrs ? Object.keys(spec.attrs.shape) : [],
        metricKeys: spec.metrics ? Object.keys(spec.metrics.shape) : [],
        indexedAttrs: spec.indexedAttrs ?? [],
        indexedMetrics: spec.indexedMetrics ?? [],
        rollups: (spec.rollups ?? []).map((r) => ({
          as: r.as ?? name,
          by: r.by,
          bucket: r.bucket ?? null,
          sum: r.sum ?? [],
          subjects: r.subjects ?? [],
        })),
      },
    ]),
  );
}

export function createDashboard(opts: CreateDashboardOptions): Router {
  const { telemetry: t, viewerAdapter, subjectAdapter, views: configured = [] } = opts;
  if (!viewerAdapter?.resolveViewer) {
    throw new Error(
      'telemetry: createDashboard requires a viewerAdapter — an unauthenticated telemetry dashboard is a data leak with charts',
    );
  }

  const mountPath = opts.mountPath ?? '/telemetry';
  const apiBase = opts.apiBase ?? mountPath;
  const title = opts.title ?? 'Telemetry';
  const spaDir = opts.spaDir ?? defaultSpaDir();

  const conn = t.models.telemetry.db!;
  const ViewModel = buildViewModel(
    conn as any,
    `${t.models.telemetry.modelName}View`,
    `${t.models.telemetry.collection.collectionName}_views`,
  );

  const q = createQueries({
    TelemetryModel: t.models.telemetry,
    RollupModel: t.models.rollups,
    registry: t.registry,
    limits: opts.queryLimits,
    onSlowQuery: opts.onSlowQuery,
    // forwarded, not re-defaulted — an onSlowQuery pinned at the 500ms default
    // is a callback the host cannot aim
    slowMs: opts.slowMs,
    cacheTtlMs: opts.cacheTtlMs,
    cacheSize: opts.cacheSize,
  });

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  // ── the gate ──
  api.use(async (req: Request & { viewer?: Viewer }, res, next) => {
    try {
      const viewer = await viewerAdapter.resolveViewer(req);
      if (!viewer?.tenantId) return res.status(401).json({ error: 'unauthenticated' });
      req.viewer = viewer;
      next();
    } catch (e) {
      next(e);
    }
  });

  const h =
    (fn: (req: Request & { viewer?: Viewer }, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      fn(req as any, res).then((body) => {
        if (!res.headersSent) res.json(body);
      }, next);
    };

  // the SPA's one boot call — it learns its scope here, because a cross-tenant
  // number that cannot say which tenant it came from is unusable
  api.get('/registry', h(async (req) => ({
    registry: registryProjection(t),
    kinds: ['event', 'error', 'span', 'state', 'usage'],
    role: req.viewer!.role,
    scope: req.viewer!.tenantId,
    platform: isPlatformScope(req.viewer!.tenantId),
  })));

  api.get('/records', h(async (req) =>
    q.records(req.viewer!.tenantId, parseRange(req.query), parseFilter(req.query), {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
    }),
  ));

  api.get('/series', h(async (req) =>
    q.series(req.viewer!.tenantId, parseRange(req.query), parseFilter(req.query), {
      measure: typeof req.query.measure === 'string' ? req.query.measure : undefined,
      interval: (req.query.interval as any) || undefined,
    }),
  ));

  api.get('/distribution', h(async (req) =>
    q.distribution(req.viewer!.tenantId, parseRange(req.query), parseFilter(req.query), {
      measure: typeof req.query.measure === 'string' ? req.query.measure : undefined,
    }),
  ));

  api.get('/rollups', h(async (req) => {
    if (typeof req.query.as !== 'string' || !req.query.as) {
      throw Object.assign(new Error('rollup family required'), { status: 400 });
    }
    // an unrecognised `on` would range-filter on a field that does not exist and
    // return an empty family — a 400 says so instead
    const on = req.query.on;
    if (on !== undefined && !ROLLUP_ON.includes(on as any)) {
      throw Object.assign(new Error(`on must be one of ${ROLLUP_ON.join(', ')}`), { status: 400 });
    }
    // `sort` reaches Mongo's .sort() — an unvalidated passthrough lets a caller
    // order by an unindexed field and turn a bounded read into a blocking
    // in-memory sort. Same hole `on` had, same allowlist.
    const sort = req.query.sort;
    if (sort !== undefined && !ROLLUP_SORT.includes(sort as any)) {
      throw Object.assign(new Error(`sort must be one of ${ROLLUP_SORT.join(', ')}`), { status: 400 });
    }
    return q.rollups(req.viewer!.tenantId, {
      as: req.query.as,
      dims: parseDims(req.query.dims),
      subjectType: typeof req.query.subjectType === 'string' ? req.query.subjectType : undefined,
      // cohort selection wants firstAt; the default is still bucketAt when
      // bucketed, lastAt otherwise — see query.ts
      on: on as (typeof ROLLUP_ON)[number] | undefined,
      range: req.query.from || req.query.to ? parseRange(req.query) : undefined,
      sort: sort as (typeof ROLLUP_SORT)[number] | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
  }));

  api.get('/trace/:traceId', h(async (req) => q.trace(req.viewer!.tenantId, String(req.params.traceId))));

  api.get('/journey/:ref', h(async (req) =>
    q.journey(req.viewer!.tenantId, String(req.params.ref), parseRange(req.query), {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }),
  ));

  /**
   * A cohort primitive throws when the named family cannot answer the question
   * asked of it — a registry mistake, which is a 400 with the explanation, not
   * a 500 that hides it. `status` already set (parseRange's 400) is respected.
   */
  const badRequest = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e: any) {
      throw Object.assign(e, { status: e?.status ?? 400 });
    }
  };

  // ── the two cohort primitives (cohort-math S6/S8) ──
  // Stages arrive as a comma-separated family list so a funnel stays a URL —
  // `?stages=signed_up,activated,converted`. A view is a named URL (dashboards
  // §11.6); a funnel that needed a POST body could not be one.
  api.get('/funnel', h(async (req) => {
    const parseStages = (v: unknown) =>
      String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((as) => ({ as }));
    const stages = parseStages(req.query.stages);
    if (!stages.length) {
      throw Object.assign(new Error('funnel needs `stages` — a comma-separated list of rollup families'), { status: 400 });
    }
    // a registry mistake is the caller's to fix, not a 500 — the validator's
    // message names the family and the change, so surface it verbatim
    return badRequest(() => q.funnel(req.viewer!.tenantId, {
      stages,
      exits: parseStages(req.query.exits),
      anchor: typeof req.query.anchor === 'string' ? req.query.anchor : undefined,
      // the cohort window is the shell's own range, half-open like everything else
      cohort: { ...parseRange(req.query), endInclusive: req.query.endInclusive === 'true' },
      subjectType: typeof req.query.subjectType === 'string' ? req.query.subjectType : undefined,
      interval: (req.query.interval as any) || undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  }));

  api.get('/distinct', h(async (req) => {
    if (typeof req.query.as !== 'string' || !req.query.as) {
      throw Object.assign(new Error('rollup family required'), { status: 400 });
    }
    return badRequest(() => q.distinctCount(req.viewer!.tenantId, {
      as: req.query.as as string,
      subjectType: typeof req.query.subjectType === 'string' ? req.query.subjectType : undefined,
      range: parseRange(req.query),
      interval: (req.query.interval as any) || undefined,
    }));
  }));

  api.get('/subjects/describe', h(async (req) => {
    const refs = String(req.query.refs ?? '').split(',').filter(Boolean).slice(0, 100);
    if (!subjectAdapter) return { refs: {} }; // refs render raw — the documented fallback
    return { refs: await subjectAdapter.describe(refs) };
  }));

  // ── views: one shape, three producers ──
  api.get('/views', h(async (req) => ({
    views: await resolveViews({
      ViewModel,
      registry: t.registry,
      configured,
      tenantId: req.viewer!.tenantId,
      viewerRef: req.viewer!.viewerRef,
    }),
  })));

  api.post('/views', h(async (req) => {
    const { spec, shared = false } = (req.body ?? {}) as { spec?: ViewSpec; shared?: boolean };
    if (!spec?.name || !spec?.page || typeof spec.query !== 'object') {
      throw Object.assign(new Error('view spec required'), { status: 400 });
    }
    return saveView({
      ViewModel,
      tenantId: req.viewer!.tenantId,
      viewerRef: req.viewer!.viewerRef,
      spec,
      shared: !!shared,
    });
  }));

  api.delete('/views/:id', h(async (req, res) => {
    // LITERAL scope match, '*' included — see views.ts. The platform scope
    // reads telemetry across tenants; it does not own other people's saved
    // views, and `role: 'admin'` below is admin OF this scope. A view outside
    // the caller's scope reports removed:0 rather than 403: whether that id
    // exists elsewhere is not this viewer's business either.
    const doc = await ViewModel.findOne({ _id: req.params.id, tenantId: req.viewer!.tenantId }).lean() as any;
    if (!doc) return { removed: 0 };
    const mine = doc.ownerRef && doc.ownerRef === req.viewer!.viewerRef;
    if (!mine && req.viewer!.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return undefined as never;
    }
    await ViewModel.deleteOne({ _id: doc._id });
    return { removed: 1 };
  }));

  // ── System — where "never drop silently" becomes visible. Not optional. ──
  api.get('/system', h(async (req) => {
    // Quarantined rejects hold RAW payloads — subjects, attrs, the lot. An
    // unfiltered find() here handed every tenant's failed writes to any
    // authenticated viewer, which is the same leak the query primitives are
    // scoped to prevent, reached by a route that never went through them.
    // Scoped like everything else; '*' still sees all, by authorization.
    const quarantine = await t.collections.rejects()
      .find(
        isPlatformScope(req.viewer!.tenantId) ? {} : { 'raw.tenantId': req.viewer!.tenantId },
        { sort: { at: -1 }, limit: 50 } as any,
      )
      .toArray()
      .catch(() => []);
    const indexes = await t.models.telemetry.collection.indexes().catch(() => []);
    const keys = req.viewer!.role === 'admin'
      ? await t.models.keys.find({}, { secretHash: 0 }).sort({ createdAt: -1 }).limit(100).lean()
      : [];
    return {
      counters: t.counters,
      quarantine,
      indexCount: indexes.length,
      indexBudget: INDEX_BUDGET,
      keys,
      role: req.viewer!.role,
    };
  }));

  api.post('/system/keys/:id/revoke', h(async (req, res) => {
    if (req.viewer!.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return undefined as never;
    }
    const r = await t.models.keys.updateOne(
      { _id: req.params.id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return { revoked: r.modifiedCount ?? 0 };
  }));

  // JSON errors, never an HTML stack page — the template's smoke contract
  api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err?.status ?? 500;
    if (status >= 500) t.logger.error('[telemetry:dashboard]', err);
    res.status(status).json({ error: status >= 500 ? 'internal_error' : String(err?.message ?? 'bad_request') });
  });

  // ── the router: /api/* + SPA with hashed assets + fallback ──
  const router = express.Router();
  router.use('/api', api);

  router.use('/_assets', express.static(path.join(spaDir, '_assets'), {
    maxAge: '1y',
    immutable: true,
    index: false,
  }));

  const base = `${mountPath.replace(/\/$/, '')}/`;
  router.get(/.*/, (_req, res) => {
    let html: string;
    try {
      html = fs.readFileSync(path.join(spaDir, 'index.html'), 'utf8');
    } catch {
      return res.status(503).type('text/plain').send(
        'telemetry: UI bundle not found. Run `npm run build` in the package, or pass an explicit `spaDir`.',
      );
    }
    const config = escapeJson({ apiBase: `${apiBase.replace(/\/$/, '')}/api`, mountPath, title });
    // the shell must never cache — a heuristically-cached index.html keeps
    // referencing dead hashed assets across deploys. Assets cache hard instead.
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      html.replace(
        '<!--telemetry-config-->',
        `<base href="${base}" />\n    <script>window.__TELEMETRY__=${config}</script>`,
      ),
    );
  });

  return router;
}
