import { z } from 'zod';
import { createQueries, type QueryLimits, type RecordFilter, type TimeRange } from './query.js';
import { buildViewModel, resolveViews, type ResolvedView, type ViewSpec } from './views.js';
import { isPlatformScope } from './types.js';
import { deriveCatalog, projectRegistry } from './catalog.js';
import { deriveSuggestions } from './suggest.js';
import { createValues } from './values.js';
import { normalizeQuery, resolveReport, type Report } from './report.js';
import { executeReport } from './execute.js';
import type { Telemetry } from './index.js';
// type-only — never pulls express/mongoose into the mcp bundle
import type { SubjectAdapter, Viewer } from './dashboard.js';

/**
 * MCP tools — a suite of read-only tool descriptors over the same query
 * primitives the dashboard serves (dashboards §2), packaged so a host with an
 * existing MCP server can hand an agent telemetry access without writing query
 * code. See plans/mcp-tools.md.
 *
 * This is NOT a server: no transport, no MCP SDK runtime dependency. The
 * factory returns descriptors; the host maps them onto whatever server it runs.
 * The one seam to the official SDK lives in `./mcp-sdk.ts`, behind a structural
 * type, so the core here imports nothing framework-specific.
 *
 * The auth boundary is the dashboard's, reused: a `viewerAdapter.resolveViewer`
 * runs on EVERY tool call — the scope is never an argument, and an agent is the
 * exact confused-deputy this closes. The one scope-adjacent argument, `tenant`,
 * can only NARROW inside an already-granted platform scope (§ pickScope).
 */

// ── the adapter (inbound; mirrors ViewerAdapter, ctx-generic) ────────────────

export interface McpViewerAdapter {
  /**
   * Resolve the agent's session/request context to a Viewer, exactly as the
   * dashboard resolves an express Request. `ctx` is whatever the host's MCP
   * server hands the tool — this package forwards it untouched and inspects
   * nothing but the returned Viewer. Return `'*'` (PLATFORM_SCOPE) only for a
   * viewer you have authorized to read across tenants.
   */
  resolveViewer(ctx: unknown): Viewer | null | Promise<Viewer | null>;
}

// ── the descriptor (outbound; what the host registers) ───────────────────────

export interface ToolDescriptor<A = any> {
  /** the MCP tool name — snake_case, stable */
  name: string;
  /** short human title */
  title: string;
  /** written for an LLM: what it answers, when to reach for it */
  description: string;
  /** zod object; args ONLY — never a scope/tenant-widening field */
  inputSchema: z.ZodObject<any>;
  /** returns JSON-serialisable data; the SDK seam wraps it as MCP content */
  handler: (args: A, ctx: unknown) => Promise<unknown>;
}

export interface CreateTelemetryMcpOptions {
  /** the createTelemetry() handle — models + registry. Nothing new is built. */
  telemetry: Telemetry;
  /** REQUIRED. An unauthenticated telemetry tool is a data leak an agent will find. */
  viewerAdapter: McpViewerAdapter;
  /** optional; labels subject refs in journey/error results (user:u_1 → Ada). */
  subjectAdapter?: SubjectAdapter;
  /** host-configured reports, merged into list_reports (mirrors the dashboard). */
  configured?: ViewSpec[];
  /** forwarded to createQueries. */
  limits?: Partial<QueryLimits>;
  /**
   * Redact raw envelopes before they leave a tool. Default strips the `data`
   * payload — records carry declared bodies (PII). Pass a custom function to
   * opt back in, or `false` to disable (you accept the exposure).
   */
  redact?: ((record: any) => any) | false;
}

// ── shared arg fragments ─────────────────────────────────────────────────────

const tenantArg = {
  tenant: z
    .string()
    .optional()
    .describe(
      "platform operators only: restrict the read to one tenant id. Permitted ONLY when your viewer is scoped to '*'; a hard error otherwise.",
    ),
};

const rangeArg = {
  from: z.string().optional().describe('ISO 8601 start, inclusive. Default: 7 days before `to`.'),
  to: z.string().optional().describe('ISO 8601 end, exclusive. Default: now.'),
};

const filterArg = {
  kind: z.enum(['event', 'error', 'span', 'state', 'usage']).optional(),
  name: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'exact event name, e.g. "user.signed_up" — or several as an array, read as one $in. See describe_telemetry',
    ),
  severity: z.string().optional(),
  env: z.string().optional().describe('prod | staging | dev'),
  service: z.string().optional(),
  release: z.string().optional(),
  subject: z.string().optional().describe('pin to one subject, e.g. "user:u_1"'),
  traceId: z.string().optional(),
  attrs: z.record(z.string(), z.string()).optional().describe('equality on declared indexed attrs'),
  excludeActorTypes: z
    .array(z.string())
    .optional()
    .describe('drop typed actors, e.g. ["admin","system"] for a customer-only view'),
};

type FilterArgs = {
  kind?: string;
  /** one name, or a set of them — a namespace or a family is several */
  name?: string | string[];
  severity?: string;
  env?: string;
  service?: string;
  release?: string;
  subject?: string;
  traceId?: string;
  attrs?: Record<string, string>;
  excludeActorTypes?: string[];
};

function toFilter(a: FilterArgs): RecordFilter {
  const f: RecordFilter = {};
  for (const k of ['kind', 'name', 'severity', 'env', 'service', 'release', 'subject', 'traceId'] as const) {
    if (a[k] != null) (f as any)[k] = a[k];
  }
  if (a.attrs) f.attrs = a.attrs;
  if (a.excludeActorTypes?.length) f.excludeActorTypes = a.excludeActorTypes;
  return f;
}

function parseRange(from?: string, to?: string): TimeRange {
  const toD = to ? new Date(to) : new Date();
  const fromD = from ? new Date(from) : new Date(toD.getTime() - 7 * 864e5);
  if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || fromD >= toD) {
    throw new Error('invalid time range: `from` must be a valid ISO time strictly before `to`');
  }
  return { from: fromD, to: toD };
}

const INTERVAL = z.enum(['hour', 'day', 'week', 'month']);

/**
 * The inline Report an agent composes — the same shape `ViewSpec.query` stores
 * and `GET /api/report` parses, said in zod so the tool call is checked before
 * it reaches the planner. Every field is described in the vocabulary
 * describe_telemetry hands back, because this is the one tool input a model
 * fills in from scratch rather than copying out of a previous result.
 */
const REPORT_ARG = z.object({
  source: z
    .union([
      z.object({ event: z.string() }),
      z.object({ namespace: z.string() }),
      z.object({ kind: z.enum(['event', 'error', 'span', 'state', 'usage']) }),
      z.object({ family: z.string() }),
    ])
    .describe(
      'what is being counted: { event: "llm.completion" } one registered name, { namespace: "billing" } every name under it, { kind: "error" }, or { family: "llm_cost" } to read a rollup family directly',
    ),
  range: z
    .union([z.string(), z.object({ from: z.string(), to: z.string() })])
    .describe('"7d" / "24h" / "90d", or an explicit half-open { from, to } ISO pair'),
  interval: INTERVAL.optional().describe('bucket the answer over time'),
  measure: z
    .string()
    .optional()
    .describe(
      'a measure key from the catalog: "count" (default), "sum:<metric>", "avg:<metric>", "p50|p90|p95|p99:<metric>", "distinct:<subjectType>" for exact actives, or "funnel"',
    ),
  groupBy: z
    .array(z.string())
    .max(2)
    .optional()
    .describe('at most two dims — "attr:<key>", "field:<path>", "subjectType", "actorType"'),
  filters: z
    .array(
      z.object({
        dim: z.string().describe('a dim key, e.g. "attr:gen_ai_request_model" or "field:env"'),
        op: z.enum(['eq', 'in', 'gte', 'lte']).describe('gte/lte bound a declared metric only'),
        value: z.union([z.string(), z.array(z.string()), z.number()]),
      }),
    )
    .optional(),
  excludeActorTypes: z
    .array(z.string())
    .optional()
    .describe('the customer toggle, e.g. ["admin","system"] — a record with no actor always survives'),
  sort: z.enum(['value', 'label', 'time']).optional(),
  limit: z.number().int().positive().optional(),
  compare: z.literal('previous').optional().describe('also run the window immediately before, same length'),
  // ── funnel only (`measure: "funnel"`) ──
  stages: z.array(z.string()).optional().describe("lifetime by:['subject'] rollup families, in order"),
  anchor: z.string().optional().describe('the milestone that assigns cohort membership. Default: stages[0]'),
  exits: z.array(z.string()).optional().describe('families counted but never staged'),
  subjectType: z.string().optional(),
});

// ── the factory ───────────────────────────────────────────────────────────────

export function createTelemetryMcp(opts: CreateTelemetryMcpOptions): ToolDescriptor[] {
  const { telemetry: t, viewerAdapter, subjectAdapter, configured = [] } = opts;
  if (!viewerAdapter?.resolveViewer) {
    throw new Error(
      'telemetry: createTelemetryMcp requires a viewerAdapter — an unauthenticated telemetry tool is a data leak an agent will find',
    );
  }

  const redact =
    opts.redact === false
      ? (r: any) => r
      : opts.redact ??
        ((r: any) => {
          // records carry a declared `data` payload — bodies, PII. Strip by default.
          if (!r || typeof r !== 'object' || r.data === undefined) return r;
          const { data, ...rest } = r;
          return { ...rest, data: '[redacted]' };
        });
  const redactAll = (items: any[]) => items.map(redact);

  // queries built HERE, behind the auth boundary — same as createDashboard
  const q = createQueries({
    TelemetryModel: t.models.telemetry,
    RollupModel: t.models.rollups,
    registry: t.registry,
    limits: opts.limits,
  });

  // one derivation per instance, exactly as createDashboard does it — pure and
  // boot-time, so a describe_telemetry call is a lookup rather than a walk.
  // The `client.platform` enum is per instance and the Telemetry handle does
  // not carry it, so it is read back off the compiled schema.
  const catalog = deriveCatalog(t.registry, {
    platforms: (t.models.telemetry.schema.path('client') as any)?.schema?.path('platform')?.enumValues,
  });
  const registry = projectRegistry(catalog);

  // the observed domain of a dimension (reports §5) — catalog-aware, so it sits
  // beside the primitives rather than inside them
  const values = createValues({
    catalog,
    TelemetryModel: t.models.telemetry,
    RollupModel: t.models.rollups,
    limits: opts.limits,
  });

  const ViewModel = buildViewModel(
    t.models.telemetry.db! as any,
    `${t.models.telemetry.modelName}View`,
    `${t.models.telemetry.collection.collectionName}_views`,
  );

  // resolve the viewer, then choose the scope. `tenant` may only NARROW inside
  // a platform grant — never widen. A mismatch is a hard error, not a silent
  // fallback: an agent that asked for tenant X must not be handed its own.
  async function resolve(ctx: unknown): Promise<Viewer> {
    const viewer = await viewerAdapter.resolveViewer(ctx);
    if (!viewer?.tenantId) throw new Error('unauthorized: viewerAdapter returned no viewer');
    return viewer;
  }
  function pickScope(viewer: Viewer, tenant?: string): string {
    if (tenant == null || tenant === '') return viewer.tenantId;
    if (!isPlatformScope(viewer.tenantId)) {
      throw new Error("the `tenant` argument is permitted only for platform-scope ('*') viewers");
    }
    return tenant;
  }

  // pretty-label the subject refs found across a batch of records
  async function labelSubjects(items: any[]): Promise<Record<string, { label: string; href?: string }> | undefined> {
    if (!subjectAdapter) return undefined;
    const refs = new Set<string>();
    for (const it of items) for (const r of it?.subjectKeys ?? []) refs.add(r);
    if (!refs.size) return {};
    return subjectAdapter.describe([...refs].slice(0, 100));
  }

  /**
   * One input, two doors: a NAMED report off the view menu, or an INLINE one
   * the agent composed. Both land on the same Report, so run_report and
   * plan_report cannot drift — plan_report's whole value is that it plans the
   * thing run_report would actually run.
   *
   * The third outcome is a stored view that predates Reports and names no
   * source. That is not a Report and normalizeQuery says so by returning null;
   * rather than refusing a view that has worked since 0.1, the caller runs it
   * the way the SPA always did.
   */
  type PickedReport =
    | { name?: string; report: Report }
    | { legacy: true; name: string; range: TimeRange; filters: FilterArgs };

  async function pickReport(scope: string, viewer: Viewer, a: any): Promise<PickedReport> {
    // an explicit tool range wins over the report's own, as it always has
    const override = a.from || a.to ? parseRange(a.from, a.to) : null;
    const withRange = (r: Report): Report =>
      override
        ? { ...r, range: { from: override.from.toISOString(), to: override.to.toISOString() } }
        : r;

    if (a.report) return { report: withRange(a.report as Report) };
    if (!a.name) {
      throw new Error('needs either `name` (a report from list_reports) or an inline `report` object');
    }
    const views = await resolveViews({
      ViewModel,
      registry: t.registry,
      catalog,
      configured,
      tenantId: scope,
      viewerRef: viewer.viewerRef,
    });
    const view = views.find((v) => v.name === a.name);
    if (!view) throw new Error(`no report named "${a.name}" — call list_reports for the menu`);
    const report = normalizeQuery(view.query);
    if (report) return { name: view.name, report: withRange(report) };
    const query = (view.query ?? {}) as any;
    return {
      legacy: true,
      name: view.name,
      range: override ?? rangeFromView(query.range),
      filters: (query.filters ?? {}) as FilterArgs,
    };
  }

  const planShaped = (report: Report) => resolveReport(report, catalog);

  const tool = <A>(d: ToolDescriptor<A>): ToolDescriptor<A> => d;

  const tools: ToolDescriptor[] = [
    // ── vocabulary ──────────────────────────────────────────────────────────
    tool({
      name: 'describe_telemetry',
      title: 'Describe telemetry schema',
      description:
        'The vocabulary of this telemetry instance: every event name with its kind, declared attributes, metrics, indexed filters, and rollup families. CALL THIS FIRST — every other tool speaks the names it returns. Prefer the `catalog` half of the answer over `registry`: it types every dimension, gives the closed value domain of the ones that have one, marks which are indexed (cheap) rather than a scan, lists the measures each event can be aggregated by, and says which rollup family answers a sum exactly.',
      inputSchema: z.object({}),
      async handler(_args, ctx) {
        await resolve(ctx); // gate even the schema — an unauthorized agent learns nothing
        return { registry, catalog, kinds: ['event', 'error', 'span', 'state', 'usage'] };
      },
    }),

    // ── events ──────────────────────────────────────────────────────────────
    tool({
      name: 'search_events',
      title: 'Search events',
      description:
        'Raw telemetry records matching a filter, newest first, cursor-paged. The general list/table/tail tool across every kind. `data` payloads are redacted by default.',
      inputSchema: z.object({
        ...filterArg,
        ...rangeArg,
        ...tenantArg,
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional().describe('opaque nextCursor from a previous call'),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const res = await q.records(scope, parseRange(a.from, a.to), toFilter(a), {
          limit: a.limit,
          cursor: a.cursor,
        });
        return { ...res, items: redactAll(res.items as any[]), subjects: await labelSubjects(res.items as any[]) };
      },
    }),

    tool({
      name: 'list_errors',
      title: 'List errors',
      description:
        'Recent error records, newest first — the focused feed for "what is breaking?". A convenience over search_events with kind pinned to "error"; still accepts name/service/env/severity filters.',
      inputSchema: z.object({
        name: z.string().optional(),
        severity: z.string().optional(),
        service: z.string().optional(),
        env: z.string().optional(),
        release: z.string().optional(),
        subject: z.string().optional(),
        excludeActorTypes: filterArg.excludeActorTypes,
        ...rangeArg,
        ...tenantArg,
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional(),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const res = await q.records(scope, parseRange(a.from, a.to), { ...toFilter(a), kind: 'error' }, {
          limit: a.limit,
          cursor: a.cursor,
        });
        return { ...res, items: redactAll(res.items as any[]), subjects: await labelSubjects(res.items as any[]) };
      },
    }),

    tool({
      name: 'event_trends',
      title: 'Event trends over time',
      description:
        'A time series of a measure, bucketed by interval — counts by default, or sum:/avg: of a declared metric (e.g. "avg:durationMs"). Use for "is this rising?" questions.',
      inputSchema: z.object({
        ...filterArg,
        ...rangeArg,
        ...tenantArg,
        measure: z
          .string()
          .optional()
          .describe('"count" (default), or "sum:<metric>" / "avg:<metric>", e.g. "sum:tokens"'),
        interval: INTERVAL.optional(),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        return q.series(scope, parseRange(a.from, a.to), toFilter(a), {
          measure: a.measure,
          interval: a.interval,
        });
      },
    }),

    tool({
      name: 'event_breakdown',
      title: 'Breakdown by dimension',
      description:
        "Top groups of a measure by one or two dimensions — 'which models cost the most', 'errors by release', 'events by platform per week'. groupBy takes attr:<key>, field:<path>, subjectType, actorType; see describe_telemetry for the keys. Reports `truncated` when more groups existed than were returned.",
      inputSchema: z.object({
        ...filterArg,
        ...rangeArg,
        ...tenantArg,
        groupBy: z
          .array(z.string())
          .min(1)
          .max(2)
          .describe('one or two dimensions, e.g. ["attr:gen_ai_request_model"] or ["attr:feature","field:env"]'),
        measure: z
          .string()
          .optional()
          .describe('"count" (default), or "sum:<metric>" / "avg:<metric>", e.g. "sum:cost_usd"'),
        interval: INTERVAL.optional().describe('also split each group by time bucket; rows then carry `at`'),
        limit: z.number().int().positive().optional().describe('groups returned, not rows scanned'),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        return q.breakdown(scope, parseRange(a.from, a.to), toFilter(a), {
          groupBy: a.groupBy,
          measure: a.measure,
          interval: a.interval,
          limit: a.limit,
        });
      },
    }),

    tool({
      name: 'metric_distribution',
      title: 'Metric distribution (percentiles)',
      description:
        'Percentiles (p50/p90/p95/p99), min/max/avg, and a 20-bucket histogram of a numeric metric over the matched records — e.g. "what is p95 latency for the checkout span?". Defaults to durationMs.',
      inputSchema: z.object({
        ...filterArg,
        ...rangeArg,
        ...tenantArg,
        measure: z
          .string()
          .optional()
          .describe('"durationMs" (default) or a declared metric key, e.g. "metric:tokens"'),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        return q.distribution(scope, parseRange(a.from, a.to), toFilter(a), { measure: a.measure });
      },
    }),

    // ── aggregates ────────────────────────────────────────────────────────────
    tool({
      name: 'rollup_breakdown',
      title: 'Rollup breakdown',
      description:
        'Top rows of a pre-aggregated rollup family — top issues, top spenders, most-active accounts, whatever the registry declares. Name the family (`as`) from describe_telemetry; optionally slice by dimension values.',
      inputSchema: z.object({
        as: z.string().describe('the rollup family, e.g. "spend_by_account" — see describe_telemetry'),
        dims: z.array(z.string()).optional().describe('restrict to these dimension values'),
        subjectType: z.string().optional(),
        on: z.enum(['firstAt', 'lastAt', 'bucketAt']).optional(),
        sort: z.enum(['count', 'lastAt', 'firstAt', 'bucketAt']).optional(),
        ...rangeArg,
        ...tenantArg,
        limit: z.number().int().positive().optional(),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        return q.rollups(scope, {
          as: a.as,
          dims: a.dims,
          subjectType: a.subjectType,
          on: a.on,
          sort: a.sort,
          range: a.from || a.to ? parseRange(a.from, a.to) : undefined,
          limit: a.limit,
        });
      },
    }),

    tool({
      name: 'dimension_values',
      title: 'Dimension values',
      description:
        "The values a dimension actually takes — from the registry's enum when it has one, else from what the rollups have seen, else from a raw scan over a range. Use before filtering or grouping so you name a value that exists. `source` says where the answer came from.",
      inputSchema: z.object({
        dim: z
          .string()
          .describe('a dimension key from describe_telemetry: "attr:<key>", "field:<path>", "subjectType" or "actorType"'),
        names: z
          .array(z.string())
          .optional()
          .describe('restrict to these event names — required for the raw scan, a narrowing hint otherwise'),
        ...rangeArg,
        ...tenantArg,
        limit: z.number().int().positive().optional(),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        return values(scope, {
          dim: a.dim,
          names: a.names,
          // no range is not an error here: it just means the raw step is off
          // the table, and `source: 'none'` says so
          range: a.from || a.to ? parseRange(a.from, a.to) : undefined,
          limit: a.limit,
        });
      },
    }),

    tool({
      name: 'active_users',
      title: 'Active users (DAU/WAU/MAU)',
      description:
        'Exact distinct-subject counts per interval and across the whole range — daily/weekly/monthly actives — from a bucketed subject rollup family. Errors if the named family has no subject dimension or bucket.',
      inputSchema: z.object({
        as: z.string().describe('a bucketed subject family, e.g. "active_accounts"'),
        subjectType: z.string().optional(),
        interval: INTERVAL.optional(),
        ...rangeArg,
        ...tenantArg,
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        return q.distinctCount(scope, {
          as: a.as,
          subjectType: a.subjectType,
          interval: a.interval,
          range: parseRange(a.from, a.to),
        });
      },
    }),

    tool({
      name: 'funnel_analysis',
      title: 'Cohort funnel',
      description:
        'A cohort funnel over lifetime milestone families: stage counts, conversion %, drop-off, and median time-to-step. Pass ordered stage families; the cohort window is the time range.',
      inputSchema: z.object({
        stages: z
          .array(z.string())
          .min(1)
          .describe('ordered rollup families, e.g. ["signed_up","activated","converted"]'),
        anchor: z.string().optional().describe('family assigning cohort membership. Default: stages[0].'),
        exits: z.array(z.string()).optional().describe('families counted but not staged'),
        subjectType: z.string().optional(),
        interval: z.enum(['day', 'week', 'month']).optional().describe('also slice the cohort by anchor date'),
        endInclusive: z.boolean().optional(),
        ...rangeArg,
        ...tenantArg,
        limit: z.number().int().positive().optional(),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const range = parseRange(a.from, a.to);
        return q.funnel(scope, {
          stages: (a.stages as string[]).map((as) => ({ as })),
          anchor: a.anchor,
          exits: (a.exits as string[] | undefined)?.map((as) => ({ as })),
          subjectType: a.subjectType,
          interval: a.interval,
          cohort: { ...range, endInclusive: a.endInclusive === true },
          limit: a.limit,
        });
      },
    }),

    // ── deep-dive ─────────────────────────────────────────────────────────────
    tool({
      name: 'inspect_trace',
      title: 'Inspect a trace',
      description:
        'Every record sharing one traceId, on a single time axis — the correlated view of one request across services. Get a traceId from search_events or list_errors.',
      inputSchema: z.object({ traceId: z.string(), ...tenantArg }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const res = await q.trace(scope, a.traceId);
        return { ...res, items: redactAll(res.items as any[]) };
      },
    }),

    tool({
      name: 'user_journey',
      title: 'User journey',
      description:
        "One subject's whole story over a range — records interleaved with lifetime milestones. Pass a subject ref like \"user:u_1\".",
      inputSchema: z.object({
        subject: z.string().describe('subject ref, e.g. "user:u_1"'),
        ...rangeArg,
        ...tenantArg,
        limit: z.number().int().positive().optional(),
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const res = await q.journey(scope, a.subject, parseRange(a.from, a.to), { limit: a.limit });
        return {
          ...res,
          records: redactAll(res.records as any[]),
          subjects: await labelSubjects(res.records as any[]),
        };
      },
    }),

    // ── reports ───────────────────────────────────────────────────────────────
    tool({
      name: 'list_reports',
      title: 'List saved reports',
      description:
        'The menu of reports available in this instance: saved (built by people), configured (wired by the host), and registry-derived. Each has a name and a stored query you can run with run_report.',
      inputSchema: z.object({ ...tenantArg }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const views = await resolveViews({
          ViewModel,
          registry: t.registry,
          catalog,
          configured,
          tenantId: scope,
          viewerRef: viewer.viewerRef,
        });
        return { reports: views.map(reportSummary) };
      },
    }),

    tool({
      name: 'run_report',
      title: 'Run a report',
      description:
        'Execute a report and return its answer. Two ways in: `name`, one of the reports list_reports offers, or `report`, an inline Report you compose yourself — the general "ask telemetry a question" tool. A Report says WHAT is counted (`source`), over what range, sliced by which dimensions (`groupBy`) and by what measure; the planner then picks the primitive that answers it, preferring a pre-aggregated rollup family (exact, one indexed read) over a raw scan. The answer carries the `plan` it ran, including `exactness` (exact / raw / scan) and a `why` sentence — read them, and prefer an `exact` plan when one exists. If you are unsure a report is answerable or affordable, call plan_report first: it returns the same plan without doing the read. Names and dimensions come from describe_telemetry; `from`/`to` override the report\'s own range. Raw records are redacted like search_events.',
      inputSchema: z.object({
        name: z.string().optional().describe('a report name from list_reports — or pass `report` instead'),
        report: REPORT_ARG.optional().describe('an inline Report, composed from describe_telemetry\'s catalog'),
        ...rangeArg,
        ...tenantArg,
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const picked = await pickReport(scope, viewer, a);
        if ('legacy' in picked) {
          // a stored view that names no source is not a Report — it is a page's
          // default. Run it the way the SPA always has rather than refusing a
          // view that has worked for a year.
          const res = await q.records(scope, picked.range, toFilter(picked.filters), { limit: 200 });
          return {
            name: picked.name,
            legacy: true,
            result: { ...res, items: redactAll(res.items as any[]) },
            dataSource: 'raw' as const,
          };
        }
        const out = await executeReport(q, scope, picked.report, catalog, { redact: redactAll });
        return picked.name ? { name: picked.name, ...out } : out;
      },
    }),

    tool({
      name: 'plan_report',
      title: 'Plan a report (dry run)',
      description:
        'Ask what a report WOULD cost before you spend the read. Same input as run_report, no query: it returns the plan — which primitive answers it, with what arguments, and `exactness` (`exact` = maintained rollup docs, `raw` = an indexed scan of records, `scan` = a dimension with no index behind it) — or `{ unavailable: true, why }` when nothing can answer it. A refusal is an answer, not an error: the `why` names the offending key and the registry change that would make the question answerable, so use it to pick a different measure or dimension rather than retrying the same one.',
      inputSchema: z.object({
        name: z.string().optional().describe('a report name from list_reports — or pass `report` instead'),
        report: REPORT_ARG.optional().describe('an inline Report, composed from describe_telemetry\'s catalog'),
        ...rangeArg,
        ...tenantArg,
      }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const picked = await pickReport(scope, viewer, a);
        if ('legacy' in picked) {
          return {
            unavailable: true,
            why:
              `the stored report "${picked.name}" is a pre-Report view whose query names no source, so there ` +
              'is nothing to plan — run_report reads its records directly. Compose an inline `report` to plan one',
          };
        }
        return picked.name
          ? { name: picked.name, ...planShaped(picked.report) }
          : planShaped(picked.report);
      },
    }),

    // ── platform ────────────────────────────────────────────────────────────
    tool({
      name: 'list_tenants',
      title: 'List tenants',
      description:
        'The tenant roster with recent activity — tenants that emitted anything in the range, each with a rollup-doc count, family count, event total, and last-activity time. Cross-tenant under a platform ("*") viewer; a single row otherwise.',
      inputSchema: z.object({ ...rangeArg, limit: z.number().int().positive().optional() }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const { from, to } = parseRange(a.from, a.to);
        const limit = Math.min(Math.max(1, a.limit ?? 200), 1000);
        const match: Record<string, unknown> = { lastAt: { $gte: from, $lt: to } };
        if (!isPlatformScope(viewer.tenantId)) match.tenantId = viewer.tenantId;
        const rows = await t.models.rollups.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$tenantId',
              rollupDocs: { $sum: 1 },
              families: { $addToSet: '$as' },
              events: { $sum: '$count' },
              lastActivity: { $max: '$lastAt' },
            },
          },
          { $sort: { lastActivity: -1 } },
          { $limit: limit + 1 },
        ] as any[]);
        const truncated = rows.length > limit;
        if (truncated) rows.pop();
        return {
          tenants: rows.map((r: any) => ({
            tenantId: r._id,
            rollupDocs: r.rollupDocs,
            families: r.families.length,
            events: r.events,
            lastActivity: r.lastActivity,
          })),
          truncated,
          dataSource: 'rollups' as const,
        };
      },
    }),

    // ── ops ─────────────────────────────────────────────────────────────────
    tool({
      name: 'telemetry_health',
      title: 'Telemetry health',
      description:
        'The health of the telemetry pipeline itself: drop/default/cap counters, quarantined failed writes, and the index budget. Answers "are we silently dropping events?" — and what the data says the registry is missing.',
      inputSchema: z.object({ ...tenantArg }),
      async handler(a: any, ctx) {
        const viewer = await resolve(ctx);
        const scope = pickScope(viewer, a.tenant);
        const quarantine = await t.collections
          .rejects()
          .find(isPlatformScope(scope) ? {} : { 'raw.tenantId': scope }, { sort: { at: -1 }, limit: 50 } as any)
          .toArray()
          .catch(() => []);
        const indexes = await t.models.telemetry.collection.indexes().catch(() => []);
        // `counters` carries the two attributed maps (rollupSkippedBy,
        // undeclaredAttrs); `suggestions` is those plus the quarantine read
        // back as registry lines, so an agent can propose the edit rather than
        // describe the symptom. Derived, never written (reports §9).
        return {
          counters: t.counters,
          quarantine,
          indexCount: indexes.length,
          suggestions: deriveSuggestions({ counters: t.counters, catalog, quarantine }),
        };
      },
    }),
  ];

  return tools;
}

/** re-export so non-SDK hosts can derive JSON Schema (zod v4 native) */
export const toJsonSchema = (tool: ToolDescriptor) => z.toJSONSchema(tool.inputSchema);

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * A menu entry. `source` is the Report's own source when the stored query lifts
 * to one — which is what tells an agent what a name actually reads before it
 * spends a call on it. `display` is gone: it was a rendering hint for a
 * renderer, and nothing on the server branches on it any more.
 */
function reportSummary(v: ResolvedView) {
  const report = normalizeQuery(v.query);
  return {
    name: v.name,
    origin: v.origin,
    page: v.page,
    shared: v.shared,
    ...(report ? { source: report.source } : {}),
  };
}

/** '7d' / '30d' / '24h' → a half-open range ending now. Default 7 days. */
function rangeFromView(range: unknown): TimeRange {
  const to = new Date();
  const m = /^(\d+)([dh])$/.exec(String(range ?? '7d'));
  const n = m ? Number(m[1]) : 7;
  const unit = m?.[2] === 'h' ? 36e5 : 864e5;
  return { from: new Date(to.getTime() - n * unit), to };
}
