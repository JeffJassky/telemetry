import React from 'react';
import {
  BreakdownTable, DistributionChart, FunnelSteps, KindPill, RecordDetail,
  RecordTable, StatTile, StreamList, TimeSeries, TransitionMatrix, Waterfall,
} from './atoms.jsx';
import { FilterBar } from './shell.jsx';
import {
  fmtMetric, fmtMs, fmtNumber, fmtTime, fmtUsd,
  intervalFor, navigate, rangeToDates,
} from './util.js';

/**
 * Pages speak only the six query primitives (dashboards law 2); the atoms
 * they compose are kind-blind. One bespoke component per kind, already spent:
 * StackTrace (error, inside RecordDetail), Waterfall (span),
 * TransitionMatrix (state). event and usage prove zero is achievable.
 */

export function useQuery(fn, deps) {
  const [state, setState] = React.useState({ loading: true });
  React.useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ loading: false, data }),
      (error) => live && setState({ loading: false, error }),
    );
    return () => { live = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const filterParams = (p, extra = {}) => ({
  ...rangeToDates(p.range ?? '7d'),
  name: p.name,
  env: p.env,
  service: p.service,
  severity: p.severity,
  subject: p.subject,
  attrs: p.attrs,
  metrics: p.metrics,
  excludeActors: p.excludeActors,
  ...extra,
});

function Loading() {
  return <div className="empty">Loading…</div>;
}

function Failed({ error }) {
  return (
    <div className="empty">
      <h3>{error.status === 401 ? 'Session expired' : 'Query failed'}</h3>
      {String(error.message)}
    </div>
  );
}

function useDetail() {
  const [record, setRecord] = React.useState(null);
  const drawer = record && (
    <RecordDetail
      record={record}
      onClose={() => setRecord(null)}
      onTrace={(id) => { setRecord(null); navigate('traces', {}, id); }}
      onSubject={(ref) => { setRecord(null); navigate('journeys', {}, ref); }}
    />
  );
  return { open: setRecord, drawer };
}

/* ── Overview ── */
export function Overview({ api, route, registry }) {
  const p = route.params;
  const hasUsage = Object.values(registry ?? {}).some((s) => s.kind === 'usage');
  const q = useQuery(async () => {
    const [errors, events, dist, spend] = await Promise.all([
      api.series(filterParams(p, { kind: 'error', interval: intervalFor(p.range ?? '7d') })),
      api.series(filterParams(p, { kind: 'event', interval: intervalFor(p.range ?? '7d') })),
      api.distribution(filterParams(p, { kind: 'span' })),
      hasUsage ? api.series(filterParams(p, { kind: 'usage', measure: 'sum:cost_usd' })) : null,
    ]);
    const issueFamilies = familiesBy(registry, (r) => r.by[0]?.startsWith('field:error.'));
    const issues = issueFamilies.length
      ? await api.rollups({ as: issueFamilies[0], sort: 'lastAt', limit: 8 })
      : null;
    // DAU/MAU off the first bucketed subject family — exact, not a sketch: such
    // a family writes one doc per (subject, bucket), so distinct IS the count.
    // No family declared that way means no tile, rather than a wrong tile.
    const activity = familiesBy(registry, (r) => r.bucket && r.by.length === 1 && r.by[0] === 'subject')[0];
    const active = activity
      ? await api.distinct({ as: activity, ...rangeToDates(p.range ?? '7d') }).catch(() => null)
      : null;
    const recent = await api.records(filterParams(p, { limit: 12 }));
    return { errors, events, dist, spend, issues, recent, active, activity };
  }, [JSON.stringify(p)]);
  const detail = useDetail();

  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  const sum = (s) => s?.buckets.reduce((a, b) => a + b.value, 0) ?? 0;

  return (
    <>
      <div className="kpis">
        <StatTile label="Errors" value={fmtNumber(sum(q.data.errors))} meta="in range" />
        <StatTile label="Events" value={fmtNumber(sum(q.data.events))} meta="in range" />
        <StatTile label="p95 span" value={q.data.dist.n ? fmtMs(q.data.dist.p95) : '—'} meta={`${fmtNumber(q.data.dist.n ?? 0)} spans`} />
        {/* the range total, NOT the sum of the buckets — a subject active on
            five days is one active subject */}
        <StatTile
          label="Active subjects"
          value={q.data.active ? fmtNumber(q.data.active.distinct) : '—'}
          meta={q.data.active
            ? `distinct in range · peak ${fmtNumber(Math.max(0, ...q.data.active.buckets.map((b) => b.value)))}/${q.data.active.interval}`
            : 'no bucketed subject family'}
        />
        <StatTile label="Spend" value={q.data.spend ? fmtUsd(sum(q.data.spend)) : '—'} meta="usage cost" />
      </div>
      <div className="split split-2">
        <div className="card chart-card">
          <div className="card-title" style={{ marginBottom: 8 }}>Events</div>
          <TimeSeries buckets={q.data.events.buckets} color="var(--blue)" />
        </div>
        <div className="card chart-card">
          <div className="card-title" style={{ marginBottom: 8 }}>Errors</div>
          <TimeSeries buckets={q.data.errors.buckets} color="var(--red)" />
        </div>
      </div>
      {q.data.issues && (
        <div className="card card-pad-0" style={{ marginTop: 16 }}>
          <div className="card-head"><span className="card-title">Recent issues</span></div>
          <div className="card-body">
            <IssueTable rows={q.data.issues.rows} onRow={(r) => navigate('errors', { ...p, fingerprint: r.dims[0] })} />
          </div>
        </div>
      )}
      <div className="card card-pad-0" style={{ marginTop: 16 }}>
        <div className="card-head"><span className="card-title">Latest records</span></div>
        <div className="card-body"><RecordTable items={q.data.recent.items} onSelect={detail.open} /></div>
      </div>
      {detail.drawer}
    </>
  );
}

function familiesBy(registry, pred) {
  const out = new Set();
  for (const [name, s] of Object.entries(registry ?? {})) {
    for (const r of s.rollups ?? []) if (pred(r)) out.add(r.as ?? name);
  }
  return [...out];
}

function IssueTable({ rows, onRow }) {
  return (
    <BreakdownTable
      rows={rows.map((r) => ({
        id: r._id,
        // carried, not rendered — BreakdownTable shows it only under '*'
        tenantId: r.tenantId,
        fingerprint: r.dims[0]?.replace(/^.*=/, ''),
        type: r.firstCapture?.['error.type'] ?? '',
        firstRelease: r.firstCapture?.release ?? '',
        count: r.count,
        lastAt: r.lastAt,
        dims: r.dims,
      }))}
      columns={[
        { key: 'fingerprint', label: 'issue', mono: true },
        { key: 'type', label: 'type' },
        { key: 'firstRelease', label: 'first release' },
        { key: 'count', label: 'count', num: true },
        { key: 'lastAt', label: 'last seen', render: (r) => fmtTime(r.lastAt) },
      ]}
      onRow={onRow}
      empty="No issues — a rare and beautiful state"
    />
  );
}

/* ── Errors: issue list off the rollup family, detail off raw ── */
export function Errors({ api, route, registry }) {
  const p = route.params;
  const detail = useDetail();
  const issueFamilies = familiesBy(registry, (r) => r.by[0]?.startsWith('field:error.'));
  const q = useQuery(async () => {
    const [series, issues, recent] = await Promise.all([
      api.series(filterParams(p, { kind: 'error', interval: intervalFor(p.range ?? '7d') })),
      issueFamilies.length ? api.rollups({ as: issueFamilies[0], sort: p.sort ?? 'lastAt', limit: 50 }) : null,
      api.records(filterParams(p, {
        kind: 'error',
        limit: 25,
        ...(p.fingerprint ? { attrs: undefined } : {}),
      })),
    ]);
    return { series, issues, recent };
  }, [JSON.stringify(p)]);

  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  return (
    <>
      <FilterBar route={route} registry={registry} />
      <div className="card chart-card">
        <div className="card-title" style={{ marginBottom: 8 }}>Error volume</div>
        <TimeSeries buckets={q.data.series.buckets} color="var(--red)" />
      </div>
      {q.data.issues && (
        <div className="card card-pad-0">
          <div className="card-head">
            <span className="card-title">Issues</span>
            <span className="card-sub">first seen · last seen · exact counts (rollup, burst-proof)</span>
          </div>
          <div className="card-body"><IssueTable rows={q.data.issues.rows} onRow={() => {}} /></div>
        </div>
      )}
      <div className="card card-pad-0">
        <div className="card-head"><span className="card-title">Recent raw errors</span><span className="card-sub">evidence, 90d retention</span></div>
        <div className="card-body"><RecordTable items={q.data.recent.items} onSelect={detail.open} /></div>
      </div>
      {detail.drawer}
    </>
  );
}

/* ── Traces: recent spans → Waterfall ── */
export function Traces(props) {
  // hook-free fork: list and detail have different hook shapes, and React
  // error #300 is what happens when one component tries to be both
  return props.route.arg
    ? <TraceView api={props.api} traceId={props.route.arg} />
    : <TracesList {...props} />;
}

function TracesList({ api, route, registry }) {
  const p = route.params;
  const detail = useDetail();
  const q = useQuery(async () => {
    const [recent, dist] = await Promise.all([
      api.records(filterParams(p, { kind: 'span', limit: 50 })),
      api.distribution(filterParams(p, { kind: 'span' })),
    ]);
    return { recent, dist };
  }, [JSON.stringify(p)]);
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  return (
    <>
      <FilterBar route={route} registry={registry} />
      <div className="card chart-card">
        <div className="card-title" style={{ marginBottom: 8 }}>Duration distribution</div>
        {/* never a silent cap: if the scan hit the ceiling, the chart says so */}
        {q.data.dist.truncated && (
          <div className="card-sub" style={{ marginBottom: 8, color: 'var(--amber)' }}>
            scan truncated at the query cap — these percentiles cover the first{' '}
            {fmtNumber(q.data.dist.n)} spans in range, not all of them
          </div>
        )}
        <DistributionChart {...q.data.dist} />
      </div>
      <div className="card card-pad-0">
        <div className="card-head"><span className="card-title">Recent spans</span><span className="card-sub">click a row → its whole trace</span></div>
        <div className="card-body">
          <RecordTable
            items={q.data.recent.items}
            onSelect={(r) => (r.traceId ? navigate('traces', {}, r.traceId) : detail.open(r))}
          />
        </div>
      </div>
      {detail.drawer}
    </>
  );
}

function TraceView({ api, traceId }) {
  const detail = useDetail();
  const q = useQuery(() => api.trace(traceId), [traceId]);
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  const spans = q.data.items.filter((r) => r.kind === 'span');
  const rest = q.data.items.filter((r) => r.kind !== 'span');
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono text-sm">{traceId}</h1>
          <div className="page-desc">{q.data.items.length} records — every kind, one time axis</div>
        </div>
        <div className="right"><button className="btn btn-sm" onClick={() => navigate('traces')}>← all traces</button></div>
      </div>
      <div className="card chart-card">
        <Waterfall items={q.data.items} onSelect={detail.open} />
      </div>
      {rest.length > 0 && (
        <div className="card card-pad-0">
          <div className="card-head"><span className="card-title">Non-span records in this trace</span></div>
          <div className="card-body"><StreamList items={rest} onSelect={detail.open} /></div>
        </div>
      )}
      {spans.length === 0 && <div className="empty">No spans — this trace is events/errors only</div>}
      {detail.drawer}
    </>
  );
}

/* ── Events: series + breakdown + table ── */
export function Events({ api, route, registry }) {
  const p = route.params;
  const detail = useDetail();
  const q = useQuery(async () => {
    const [series, recent] = await Promise.all([
      api.series(filterParams(p, { kind: p.name ? undefined : 'event', interval: intervalFor(p.range ?? '7d') })),
      api.records(filterParams(p, { kind: p.name ? undefined : 'event', limit: 50 })),
    ]);
    return { series, recent };
  }, [JSON.stringify(p)]);
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;

  // client-side breakdown over the visible page — grouped by the chosen dim
  const groupBy = p.groupBy ?? 'name';
  const groups = {};
  for (const r of q.data.recent.items) {
    const key = groupBy === 'name' ? r.name : r.attrs?.[groupBy] ?? '∅';
    groups[key] = (groups[key] ?? 0) + 1;
  }
  const spec = p.name ? registry?.[p.name] : null;
  const dims = ['name', ...(spec?.attrKeys ?? [])];

  return (
    <>
      <FilterBar route={route} registry={registry} />
      <div className="card chart-card">
        <div className="hstack" style={{ marginBottom: 8 }}>
          <span className="card-title">Volume</span>
          <div className="topbar-spacer" />
          <div className="seg">
            {dims.map((d) => (
              <button key={d} className={`seg-item ${groupBy === d ? 'active' : ''}`} onClick={() => navigate('events', { ...p, groupBy: d })}>
                {d}
              </button>
            ))}
          </div>
        </div>
        <TimeSeries buckets={q.data.series.buckets} color="var(--blue)" />
      </div>
      <div className="split split-asym">
        <div className="card card-pad-0">
          <div className="card-head"><span className="card-title">Records</span></div>
          <div className="card-body"><RecordTable items={q.data.recent.items} onSelect={detail.open} /></div>
        </div>
        <div className="card card-pad-0">
          <div className="card-head"><span className="card-title">By {groupBy}</span><span className="card-sub">this page</span></div>
          <div className="card-body">
            <BreakdownTable
              rows={Object.entries(groups).map(([k, n]) => ({ id: k, [groupBy]: k, count: n })).sort((a, b) => b.count - a.count)}
              columns={[{ key: groupBy }, { key: 'count', num: true }]}
            />
          </div>
        </div>
      </div>
      {detail.drawer}
    </>
  );
}

/* ── Journeys: RollupExplorer + subject lookup + per-subject stream ── */
export function Journeys(props) {
  return props.route.arg
    ? <JourneyView api={props.api} subjectRef={props.route.arg} route={props.route} />
    : <JourneysHome {...props} />;
}

function JourneysHome({ api, route, registry }) {
  const p = route.params;
  const families = Object.entries(
    Object.entries(registry ?? {}).reduce((acc, [name, s]) => {
      for (const r of s.rollups ?? []) acc[r.as ?? name] = r;
      return acc;
    }, {}),
  );
  const fam = p.rollup ?? families[0]?.[0];
  const [lookup, setLookup] = React.useState('');
  return (
    <>
      <div className="card">
        <div className="card-head">
          <span className="card-title">Subject lookup</span>
          <span className="card-sub">every kind, one story — 'user:u_1', 'account:a_9'</span>
        </div>
        <div className="card-body hstack">
          <input className="input" style={{ maxWidth: 340 }} placeholder="type:id" value={lookup}
                 onChange={(e) => setLookup(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && lookup.includes(':') && navigate('journeys', p, lookup)} />
          <button className="btn btn-primary btn-sm" disabled={!lookup.includes(':')} onClick={() => navigate('journeys', p, lookup)}>
            open journey
          </button>
        </div>
      </div>
      {fam && <RollupExplorer api={api} route={route} family={fam} families={families.map(([f]) => f)} registry={registry} />}
    </>
  );
}

/* RollupExplorer — free dashboards (§7): families are self-describing */
function RollupExplorer({ api, route, family, families, registry }) {
  const p = route.params;
  const q = useQuery(
    () => api.rollups({ as: family, ...rangeToDates(p.range ?? '30d'), limit: 200 }),
    [family, p.range],
  );
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  const rows = q.data.rows;
  const sumKeys = [...new Set(rows.flatMap((r) => Object.keys(r.sums ?? {})))];
  const bucketed = q.data.bucketed;

  // bucketed → series per bucket; lifetime → first/last/count table
  const buckets = bucketed
    ? [...rows.reduce((m, r) => {
        const k = new Date(r.bucketAt).toISOString();
        const cur = m.get(k) ?? { at: r.bucketAt, value: 0 };
        cur.value += sumKeys.length ? (r.sums?.[sumKeys[0]] ?? 0) : r.count;
        return m.set(k, cur);
      }, new Map()).values()].sort((a, b) => new Date(a.at) - new Date(b.at))
    : null;

  return (
    <div className="card card-pad-0">
      <div className="card-head">
        <span className="card-title">Rollups</span>
        <div className="card-actions">
          <select className="select" value={family} onChange={(e) => navigate('journeys', { ...p, rollup: e.target.value })}>
            {families.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>
      <div className="card-body">
        {bucketed && <TimeSeries buckets={buckets} color="var(--accent)" format={(v) => fmtMetric(sumKeys[0] ?? 'count', v)} />}
        <BreakdownTable
          rows={rows.slice(0, 50).map((r) => ({
            id: r._id,
            tenantId: r.tenantId,
            dims: r.dims.join(' · '),
            count: r.count,
            ...(Object.fromEntries(sumKeys.map((k) => [k, r.sums?.[k]]))),
            firstAt: r.firstAt,
            lastAt: r.lastAt,
            _dims: r.dims,
          }))}
          columns={[
            { key: 'dims', mono: true },
            { key: 'count', num: true },
            ...sumKeys.map((k) => ({ key: k, num: true })),
            { key: 'firstAt', label: 'first', render: (r) => fmtTime(r.firstAt) },
            { key: 'lastAt', label: 'last', render: (r) => fmtTime(r.lastAt) },
          ]}
          onRow={(r) => {
            const subject = r._dims.find((d) => /^[\w-]+:[\w-]+$/.test(d) && !d.includes('='));
            if (subject) navigate('journeys', p, subject);
          }}
        />
        {!bucketed && rows.length > 1 && (
          <CohortFunnel api={api} registry={registry} route={route} />
        )}
      </div>
    </div>
  );
}

/** milestone families in registry order — the funnel's stage list, for free */
const milestoneFamilies = (registry) =>
  familiesBy(registry, (r) => !r.bucket && r.by.length === 1 && r.by[0] === 'subject');

/**
 * Milestone families in registry order become a cohort funnel for free.
 *
 * This used to count `rows.length` per family with `limit: 1_000` — capped, so
 * a large tenant silently under-reported; cohort-blind, so it answered "who ever
 * reached this step" rather than "of the people who joined in this window, who
 * reached it"; and with no time-to-step at all. It is now one `funnel()` call,
 * and the numbers are the server's (cohort-math G4).
 */
function CohortFunnel({ api, registry, route }) {
  const p = route.params;
  const families = milestoneFamilies(registry);
  const q = useQuery(
    () => (families.length
      ? api.funnel({ ...rangeToDates(p.range ?? '30d'), stages: families.join(','), interval: 'week' })
      : Promise.resolve(null)),
    [JSON.stringify(families), p.range],
  );
  if (q.loading || q.error || !q.data) return null;
  const f = q.data;
  return (
    <>
      <div className="divider" />
      <div className="card-title" style={{ marginBottom: 8 }}>
        Cohort funnel — {fmtNumber(f.cohortSubjects)} subjects anchored on <span className="mono">{f.cohort.anchor}</span>
      </div>
      {/* never a silent cap: if the cohort read was cut off, the chart says so */}
      {f.truncated && (
        <div className="card-sub" style={{ marginBottom: 8, color: 'var(--amber)' }}>
          cohort truncated at the query cap — these counts are a lower bound
        </div>
      )}
      <FunnelSteps steps={f.stages} />
    </>
  );
}

function JourneyView({ api, subjectRef, route }) {
  const detail = useDetail();
  const p = route.params;
  const q = useQuery(
    () => api.journey(subjectRef, { ...rangeToDates(p.range ?? '30d'), limit: 200 }),
    [subjectRef, p.range],
  );
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  const markers = q.data.milestones.map((m) => ({ at: m.firstAt, label: `${m.as} · first` }));
  const states = q.data.records.filter((r) => r.kind === 'state');
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono text-sm">{subjectRef}</h1>
          <div className="page-desc">
            {q.data.records.length} records · {q.data.milestones.length} milestones
          </div>
        </div>
        <div className="right"><button className="btn btn-sm" onClick={() => navigate('journeys', p)}>← journeys</button></div>
      </div>
      {states.length > 0 && (
        <div className="card chart-card">
          <div className="card-title" style={{ marginBottom: 8 }}>State transitions</div>
          <TransitionMatrix
            transitions={Object.values(states.reduce((acc, r) => {
              const k = `${r.state.from ?? '∅'}→${r.state.to}`;
              acc[k] ??= { from: r.state.from, to: r.state.to, n: 0, avgMs: r.state.previousSinceMs };
              acc[k].n++;
              return acc;
            }, {}))}
          />
        </div>
      )}
      <div className="card card-pad-0">
        <div className="card-head"><span className="card-title">Timeline</span><span className="card-sub">milestones as chapter markers</span></div>
        <div className="card-body">
          <StreamList items={q.data.records} markers={markers} onSelect={detail.open} />
        </div>
      </div>
      {detail.drawer}
    </>
  );
}

/* ── Usage ── */
export function Usage({ api, route, registry }) {
  const p = route.params;
  const detail = useDetail();
  const q = useQuery(async () => {
    const [spend, recent] = await Promise.all([
      api.series(filterParams(p, { kind: 'usage', measure: 'sum:cost_usd', interval: intervalFor(p.range ?? '30d') })),
      api.records(filterParams(p, { kind: 'usage', limit: 50 })),
    ]);
    return { spend, recent };
  }, [JSON.stringify(p)]);
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  const total = q.data.spend.buckets.reduce((a, b) => a + b.value, 0);
  const byBilled = {};
  const byMeter = {};
  for (const r of q.data.recent.items) {
    byBilled[r.usage.billedTo] = (byBilled[r.usage.billedTo] ?? 0) + (r.metrics?.cost_usd ?? 0);
    byMeter[r.usage.meter] = (byMeter[r.usage.meter] ?? 0) + (r.metrics?.cost_usd ?? 0);
  }
  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <StatTile label="Spend in range" value={fmtUsd(total)} meta="metrics.cost_usd — Decimal128 stays authoritative" />
        <StatTile label="Usage rows" value={fmtNumber(q.data.recent.items.length)} meta="latest page" />
        <StatTile label="Meters" value={fmtNumber(Object.keys(byMeter).length)} />
      </div>
      <div className="card chart-card">
        <div className="card-title" style={{ marginBottom: 8 }}>Spend</div>
        <TimeSeries buckets={q.data.spend.buckets} color="var(--green)" format={fmtUsd} />
      </div>
      <div className="split split-2">
        <div className="card card-pad-0">
          <div className="card-head"><span className="card-title">By billed-to</span></div>
          <div className="card-body">
            <BreakdownTable
              rows={Object.entries(byBilled).map(([k, v]) => ({ id: k, billedTo: k, cost_usd: v })).sort((a, b) => b.cost_usd - a.cost_usd)}
              columns={[{ key: 'billedTo', mono: true }, { key: 'cost_usd', num: true }]}
            />
          </div>
        </div>
        <div className="card card-pad-0">
          <div className="card-head"><span className="card-title">Rows</span><span className="card-sub">reversals render linked</span></div>
          <div className="card-body"><RecordTable items={q.data.recent.items} onSelect={detail.open} /></div>
        </div>
      </div>
      {detail.drawer}
    </>
  );
}

/* ── System — never drop silently, made visible ── */
export function System({ api }) {
  const [nonce, setNonce] = React.useState(0);
  const q = useQuery(() => api.system(), [nonce]);
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  const { counters, quarantine, indexCount, indexBudget, keys, role } = q.data;
  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
        <StatTile label="rejected" value={fmtNumber(counters.rejected)} meta="quarantined" />
        <StatTile label="sampled" value={fmtNumber(counters.sampled)} meta="dropped by rate" />
        <StatTile label="capped" value={fmtNumber(counters.capped)} meta="burst/rate caps" />
        <StatTile label="deduped" value={fmtNumber(counters.deduped)} meta="idempotent replays" />
        <StatTile label="truncated" value={fmtNumber(counters.truncated)} meta="body over cap" />
        <StatTile label="defaulted" value={fmtNumber(counters.defaulted)} meta="missing service/release" />
        <StatTile label="indexes" value={`${indexCount}`} meta={`payload budget ${indexBudget}`} />
      </div>

      {role === 'admin' && (
        <div className="card card-pad-0">
          <div className="card-head"><span className="card-title">Ingest keys</span></div>
          <div className="card-body">
            <BreakdownTable
              rows={keys.map((k) => ({ ...k, id: k._id }))}
              columns={[
                { key: '_id', label: 'key id', mono: true },
                { key: 'kind' },
                { key: 'tenantMode', label: 'tenant' },
                { key: 'service' },
                { key: 'env' },
                { key: 'maxPerMinute', label: 'rate', num: true },
                {
                  key: 'revokedAt', label: 'status',
                  render: (k) => k.revokedAt
                    ? <span className="pill red">revoked</span>
                    : (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Revoke ${k._id}? Writers using it start dropping within 60s.`)) {
                            api.revokeKey(k._id).then(() => setNonce((n) => n + 1));
                          }
                        }}
                      >revoke</button>
                    ),
                },
              ]}
              empty="No keys minted yet"
            />
          </div>
        </div>
      )}

      <div className="card card-pad-0">
        <div className="card-head">
          <span className="card-title">Quarantine</span>
          <span className="card-sub">latest 50 — every one of these was a write someone attempted</span>
        </div>
        <div className="card-body">
          <BreakdownTable
            rows={quarantine.map((r, i) => ({ id: i, at: r.at, name: r.name, reason: r.reason }))}
            columns={[
              { key: 'at', label: 'when', render: (r) => fmtTime(r.at) },
              { key: 'name', mono: true },
              { key: 'reason' },
            ]}
            empty="Quarantine is empty"
          />
        </div>
      </div>
    </>
  );
}
