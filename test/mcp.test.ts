import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_SCOPE } from '../src/server/index.js';
import { createTelemetryMcp, toJsonSchema, type ToolDescriptor } from '../src/server/mcp.js';
import { registerTelemetryTools } from '../src/server/mcp-sdk.js';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * The MCP tool suite. The rules that matter are security ones: scope is never a
 * widening argument, tenant isolation holds through every tool, raw payloads
 * are redacted, and an unresolved viewer gets nothing. The rest is a thin
 * façade the query suite already tests, so it is exercised, not re-proven.
 */

async function seed(t: Awaited<ReturnType<typeof buildTelemetry>>) {
  await t.syncIndexes();
  const acc = (id: string) => [{ type: 'account', id }];
  for (let i = 0; i < 3; i++) {
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: acc(`a${i}`), occurredAt: at(`2026-07-0${i + 1}T10:00:00Z`),
      attrs: { source: 'organic' },
    });
  }
  // an error, and a record carrying a `data` payload (must be redacted)
  await t.emit('error.unhandled', {
    tenantId: 'tn', traceId: 'tr_0000abcd', occurredAt: at('2026-07-03T09:00:01Z'),
    error: { type: 'E', message: 'boom', handled: false, fingerprint: 'fp1' },
  });
  await t.emit('page.view', {
    tenantId: 'tn',
    subjects: [{ type: 'user', id: 'u_0' }, { type: 'account', id: 'a0' }, { type: 'session', id: 's0' }],
    actor: 'user:u_0', client: { ...CLIENT },
    occurredAt: at('2026-07-02T11:00:00Z'), data: { secret: 'do-not-leak' },
  });
  // a second tenant — must never surface under 'tn'
  await t.emit('account.signed_up', {
    tenantId: 'other', subjects: acc('ax'), occurredAt: at('2026-07-01T10:00:00Z'),
    attrs: { source: 'ads' },
  });
  await t.flush();
}

const RANGE = { from: '2026-06-30T00:00:00Z', to: '2026-07-10T00:00:00Z' };

let t: Awaited<ReturnType<typeof buildTelemetry>>;
const state: { viewer: any } = { viewer: { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' } };

function build() {
  return createTelemetryMcp({
    telemetry: t,
    viewerAdapter: { resolveViewer: () => state.viewer },
    subjectAdapter: { describe: async (refs) => Object.fromEntries(refs.map((r) => [r, { label: r.toUpperCase() }])) },
  });
}
const byName = (tools: ToolDescriptor[], name: string) => tools.find((x) => x.name === name)!;
const run = (tools: ToolDescriptor[], name: string, args: any) => byName(tools, name).handler(args, { session: 'x' });

beforeAll(async () => {
  await startDb();
  t = buildTelemetry();
  await seed(t);
});
afterAll(stopDb);

describe('mcp tools', () => {
  it('emits the whole suite, all-or-none', () => {
    const names = build().map((x) => x.name).sort();
    expect(names).toEqual(
      [
        'active_users', 'describe_telemetry', 'dimension_values', 'event_breakdown',
        'event_trends', 'funnel_analysis', 'inspect_trace', 'list_errors',
        'list_reports', 'list_tenants', 'metric_distribution', 'plan_report',
        'rollup_breakdown', 'run_report', 'search_events', 'telemetry_health',
        'user_journey',
      ].sort(),
    );
  });

  it('requires a viewerAdapter', () => {
    expect(() => createTelemetryMcp({ telemetry: t, viewerAdapter: undefined as any })).toThrow(/viewerAdapter/);
  });

  // ── the security contract ──
  it('no tool exposes a scope-widening argument', () => {
    for (const tool of build()) {
      const keys = Object.keys(tool.inputSchema.shape);
      expect(keys).not.toContain('scope');
      expect(keys).not.toContain('tenantId');
    }
  });

  it('an unresolved viewer gets nothing — even the schema', async () => {
    state.viewer = null;
    await expect(run(build(), 'describe_telemetry', {})).rejects.toThrow(/unauthorized/);
    state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' };
  });

  it('holds tenant isolation — tn never sees other', async () => {
    const res: any = await run(build(), 'search_events', { ...RANGE });
    expect(res.items.length).toBeGreaterThan(0);
    for (const it of res.items) expect(it.tenantId).toBe('tn');
  });

  it('the `tenant` argument is a hard error for a non-platform viewer', async () => {
    await expect(run(build(), 'search_events', { ...RANGE, tenant: 'other' })).rejects.toThrow(/platform-scope/);
  });

  it('a platform viewer may narrow to one tenant', async () => {
    state.viewer = { tenantId: PLATFORM_SCOPE, role: 'admin', viewerRef: 'user:ops' };
    const res: any = await run(build(), 'search_events', { ...RANGE, tenant: 'other' });
    for (const it of res.items) expect(it.tenantId).toBe('other');
    state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' };
  });

  it('redacts raw `data` payloads by default', async () => {
    const res: any = await run(build(), 'search_events', { ...RANGE, name: 'page.view' });
    const pv = res.items.find((r: any) => r.name === 'page.view');
    expect(pv).toBeTruthy();
    expect(pv.data).toBe('[redacted]');
    expect(JSON.stringify(res)).not.toContain('do-not-leak');
  });

  it('redact:false surrenders the payload (host opts in)', async () => {
    const tools = createTelemetryMcp({
      telemetry: t,
      viewerAdapter: { resolveViewer: () => ({ tenantId: 'tn', role: 'member' }) },
      redact: false,
    });
    const res: any = await run(tools, 'search_events', { ...RANGE, name: 'page.view' });
    const pv = res.items.find((r: any) => r.name === 'page.view');
    expect(pv.data).toMatchObject({ secret: 'do-not-leak' });
  });

  // ── the façades resolve to the primitives ──
  it('describe_telemetry returns the registry vocabulary', async () => {
    const res: any = await run(build(), 'describe_telemetry', {});
    expect(res.registry['account.signed_up'].kind).toBe('event');
    expect(res.registry['account.signed_up'].rollups.map((r: any) => r.as)).toContain('activity');
  });

  it('describe_telemetry hands the agent the catalog, not just the key lists', async () => {
    const res: any = await run(build(), 'describe_telemetry', {});
    const facet = res.catalog.events['account.signed_up'];
    expect(facet.namespace).toBe('account');
    // the typed dim, its closed-or-open domain, and whether it is indexed —
    // everything an agent needs to know a filter is a lookup and not a scan
    expect(facet.dims).toContainEqual(
      expect.objectContaining({ key: 'attr:source', type: 'string', indexed: false }),
    );
    expect(res.catalog.families['activity'].lifetime).toBe(false);
    expect(res.catalog.families['account.signed_up'].lifetime).toBe(true);
    expect(res.catalog.subjectTypes).toContain('account');
  });

  it('list_errors pins kind and labels subjects', async () => {
    const res: any = await run(build(), 'list_errors', { ...RANGE });
    expect(res.items.length).toBe(1);
    expect(res.items[0].kind).toBe('error');
  });

  it('active_users counts distinct subjects', async () => {
    const res: any = await run(build(), 'active_users', { as: 'activity', ...RANGE, interval: 'day' });
    expect(res.distinct).toBe(3);
  });

  it('inspect_trace correlates a request', async () => {
    const res: any = await run(build(), 'inspect_trace', { traceId: 'tr_0000abcd' });
    expect(res.items.length).toBeGreaterThan(0);
  });

  it('event_breakdown groups a measure, and is gated like every other tool', async () => {
    const res: any = await run(build(), 'event_breakdown', {
      ...RANGE, name: 'account.signed_up', groupBy: ['attr:source'],
    });
    expect(res.rows).toEqual([{ dims: ['organic'], value: 3 }]); // not 4 — 'other' stays out
    expect(res.groups).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.dataSource).toBe('raw');

    // two dims and a time axis, the shape the dashboard route returns
    const byDay: any = await run(build(), 'event_breakdown', {
      ...RANGE, kind: 'event', groupBy: ['field:name', 'actorType'], interval: 'day',
    });
    expect(byDay.rows.every((r: any) => r.at)).toBe(true);

    state.viewer = null;
    await expect(
      run(build(), 'event_breakdown', { ...RANGE, groupBy: ['attr:source'] }),
    ).rejects.toThrow(/unauthorized/);
    state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' };
  });

  it('dimension_values names its source, scopes to the tenant, and is gated like the rest', async () => {
    const tools = build();

    // the registry declared this domain — answered without a read or a range
    const kinds: any = await run(tools, 'dimension_values', { dim: 'field:kind' });
    expect(kinds).toMatchObject({ source: 'catalog', truncated: false });
    expect(kinds.values).toEqual(['event', 'error', 'span', 'state', 'usage']);

    // a family answers it, and the `label=` prefix rollups.ts writes is stripped
    const issues: any = await run(tools, 'dimension_values', { dim: 'field:error.fingerprint' });
    expect(issues).toMatchObject({ source: 'rollups', via: 'issue' });
    expect(issues.values).toEqual(['fp1']);

    // tenant isolation holds through the subject family — 'ax' belongs to other.
    // `names` picks among the families a subject dim appears in; without it the
    // tie-break is alphabetical and would answer about a family with no rows.
    const subjects: any = await run(tools, 'dimension_values', {
      dim: 'subject', names: ['account.signed_up'],
    });
    expect(subjects.values).toEqual(expect.arrayContaining(['account:a0']));
    expect(subjects.values).not.toContain('account:ax');

    // nothing cheap can answer it, and that is an answer, not an error
    const free: any = await run(tools, 'dimension_values', {
      ...RANGE, dim: 'attr:source', names: ['account.signed_up'],
    });
    expect(free).toMatchObject({ source: 'none', values: [] });

    state.viewer = null;
    await expect(run(build(), 'dimension_values', { dim: 'field:kind' })).rejects.toThrow(/unauthorized/);
    state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' };
  });

  // ── platform: list_tenants ──
  it('list_tenants is cross-tenant under platform, single under a tenant', async () => {
    state.viewer = { tenantId: PLATFORM_SCOPE, role: 'admin', viewerRef: 'user:ops' };
    const all: any = await run(build(), 'list_tenants', { ...RANGE });
    expect(all.tenants.map((x: any) => x.tenantId).sort()).toEqual(['other', 'tn']);

    state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' };
    const one: any = await run(build(), 'list_tenants', { ...RANGE });
    expect(one.tenants.map((x: any) => x.tenantId)).toEqual(['tn']);
  });

  // ── reports ──
  it('list_reports returns a runnable menu that says what each name reads', async () => {
    const tools = build();
    const menu: any = await run(tools, 'list_reports', {});
    expect(menu.reports.length).toBeGreaterThan(0);
    const report = menu.reports.find((r: any) => r.name === 'account.signed_up');
    // the Report's own source, so an agent knows what a name reads before
    // spending a call on it. `display` is gone — it was a renderer's hint
    expect(report).toMatchObject({ origin: 'derived', source: { event: 'account.signed_up' } });
    expect(report.display).toBeUndefined();
  });

  it('run_report runs a NAMED report through the planner, exact read and all', async () => {
    const tools = build();
    // the per-EVENT derived view charts the name over its range, so it is a
    // raw series: an interval rules out the lifetime family, which has no
    // buckets to roll up (and whose `firstAt` answers a different question)
    const chart: any = await run(tools, 'run_report', { name: 'account.signed_up', ...RANGE });
    expect(chart.name).toBe('account.signed_up');
    expect(chart.report.source).toEqual({ event: 'account.signed_up' });
    expect(chart.plan).toMatchObject({ primitive: 'series', exactness: 'raw' });

    // the per-FAMILY one reads the family itself, which is the exact plan — no
    // raw scan, and the number is the aggregate's own
    const exact: any = await run(tools, 'run_report', { name: 'rollup: account.signed_up', ...RANGE });
    expect(exact.report.source).toEqual({ family: 'account.signed_up' });
    expect(exact.plan).toMatchObject({ primitive: 'rollups', exactness: 'exact', via: 'account.signed_up' });
    expect(exact.result.rows).toEqual([{ dims: [], value: 3 }]);
    expect(exact.dataSource).toBe('rollups');

    await expect(run(tools, 'run_report', { name: 'nope' })).rejects.toThrow(/no report/);
    await expect(run(tools, 'run_report', {})).rejects.toThrow(/either `name`/);
  });

  it('run_report runs an INLINE report — the general "ask telemetry a question" door', async () => {
    const tools = build();
    const out: any = await run(tools, 'run_report', {
      report: {
        source: { event: 'account.signed_up' },
        range: { from: RANGE.from, to: RANGE.to },
        measure: 'count',
        groupBy: ['attr:source'],
      },
    });
    expect(out.plan.primitive).toBe('breakdown');
    expect(out.result.rows).toEqual([{ dims: ['organic'], value: 3 }]); // not 4 — 'other' stays out
    expect(out.name).toBeUndefined();

    // and a records answer is redacted exactly as search_events is
    const rows: any = await run(tools, 'run_report', {
      report: { source: { event: 'page.view' }, range: { from: RANGE.from, to: RANGE.to } },
    });
    expect(rows.plan.primitive).toBe('records');
    expect(rows.result.items[0].data).toBe('[redacted]');
    expect(JSON.stringify(rows)).not.toContain('do-not-leak');
  });

  it('run_report still runs a pre-Report view, so no saved report stops working', async () => {
    // a view whose stored query names no source is not a Report — normalizeQuery
    // says so by returning null, and the old records behaviour answers it
    const tools = createTelemetryMcp({
      telemetry: t,
      viewerAdapter: { resolveViewer: () => state.viewer },
      configured: [{ name: 'legacy tail', page: 'events', query: { range: '7d' } }],
    });
    const out: any = await run(tools, 'run_report', { name: 'legacy tail', ...RANGE });
    expect(out).toMatchObject({ name: 'legacy tail', legacy: true, dataSource: 'raw' });
    expect(out.result.items.length).toBeGreaterThan(0);
    expect(out.result.items.every((r: any) => r.tenantId === 'tn')).toBe(true);
  });

  it('plan_report answers what a report WOULD cost, and refuses with the fix', async () => {
    const tools = build();
    const plan: any = await run(tools, 'plan_report', {
      report: {
        source: { event: 'llm.completion' },
        range: '7d',
        measure: 'sum:cost_usd',
        groupBy: ['attr:gen_ai_request_model'],
        interval: 'day',
      },
    });
    expect(plan).toMatchObject({ primitive: 'rollups', exactness: 'exact', via: 'llm_cost' });
    expect(plan.why).toMatch(/maintained on write/);

    // a refusal is an answer: it names the offending key and the registry change
    const no: any = await run(tools, 'plan_report', {
      report: { source: { event: 'page.view' }, range: '7d', measure: 'sum:cost_usd' },
    });
    expect(no.unavailable).toBe(true);
    expect(no.why).toMatch(/names a metric no source event declares/);

    // and planning is a DRY run — nothing was read
    expect(no.result).toBeUndefined();
    const named: any = await run(tools, 'plan_report', { name: 'rollup: account.signed_up' });
    expect(named).toMatchObject({ name: 'rollup: account.signed_up', primitive: 'rollups' });
  });

  // ── health, and the loop closed the other way ──
  it('telemetry_health carries the attributed counters and what the data says the registry is missing', async () => {
    // an attr the registry does not declare: rejected, counted, and now named
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: [{ type: 'account', id: 'a9' }],
      occurredAt: at('2026-07-04T10:00:00Z'), attrs: { source: 'ads', codec: 'h264' } as any,
    });
    await t.flush();

    const res: any = await run(build(), 'telemetry_health', {});
    expect(res.counters.undeclaredAttrs['account.signed_up|codec']).toBe(1);
    expect(res.counters.rollupSkippedBy).toBeDefined();
    const s = res.suggestions.find((x: any) => x.kind === 'undeclared_attr');
    expect(s).toMatchObject({ target: 'account.signed_up', key: 'codec' });
    expect(s.fix).toBe('codec: z.string().max(64),'); // an agent can propose the edit
  });

  // ── the two seams to the outside ──
  it('toJsonSchema derives a JSON Schema from a descriptor', () => {
    const schema: any = toJsonSchema(byName(build(), 'search_events'));
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeTruthy();
  });

  it('registerTelemetryTools registers every tool on an MCP-shaped server', async () => {
    const registered: string[] = [];
    let captured: any;
    const server = {
      registerTool: (name: string, _cfg: any, handler: any) => {
        registered.push(name);
        captured = handler;
      },
    };
    const tools = build();
    registerTelemetryTools(server, tools);
    expect(registered.sort()).toEqual(tools.map((x) => x.name).sort());
    // a registered handler wraps its result as MCP text content
    const wrapped = await captured({}, { session: 'x' });
    expect(wrapped.content[0].type).toBe('text');
  });
});
