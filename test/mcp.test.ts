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
        'active_users', 'describe_telemetry', 'event_trends', 'funnel_analysis',
        'inspect_trace', 'list_errors', 'list_reports', 'list_tenants',
        'metric_distribution', 'rollup_breakdown', 'run_report', 'search_events',
        'telemetry_health', 'user_journey',
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
  it('list_reports returns a runnable menu; run_report executes one', async () => {
    const tools = build();
    const menu: any = await run(tools, 'list_reports', {});
    expect(menu.reports.length).toBeGreaterThan(0);
    const report = menu.reports.find((r: any) => r.name === 'account.signed_up');
    expect(report).toBeTruthy();
    const out: any = await run(tools, 'run_report', { name: report.name, ...RANGE });
    expect(out.report).toBe('account.signed_up');
    await expect(run(tools, 'run_report', { name: 'nope' })).rejects.toThrow(/no report/);
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
