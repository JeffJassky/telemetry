import React from 'react';
import {
  KIND_COLOR, KIND_PILL, SEVERITY_PILL,
  fmtClock, fmtDays, fmtMeasure, fmtMetric, fmtMs, fmtNumber, fmtPct, fmtTime,
  metricOf, rangeOf,
} from './util.js';

/**
 * The ten atoms (dashboards §4) — kind-blind by law: data + specs in, pixels
 * out. None of them knows an event name; formatting is convention-driven.
 * Charts are hand-rolled SVG (mailery's sparkline lineage) — no chart library
 * until an atom proves it needs one.
 */

/**
 * The viewer's scope, by context rather than a prop threaded through every
 * page. Whether rows can mix tenants is a fact about WHO IS LOOKING, not about
 * any one table's caller — and the atoms stay kind-blind either way, since
 * `tenantId` is an envelope field like every other column they render.
 */
export const ScopeContext = React.createContext({ platform: false, scope: null });

/* 1 ── StatTile */
export function StatTile({ label, value, delta, meta, deltaFormat = fmtNumber }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {(delta != null || meta) && (
        <div className="kpi-meta">
          {delta != null && (
            <span className={`kpi-delta ${delta >= 0 ? 'up' : 'down'}`}>
              {/* the delta of a money measure is money — the formatter comes from
                  the measure key, the same convention the value used */}
              {delta >= 0 ? '▲' : '▼'} {deltaFormat(Math.abs(delta))}
            </span>
          )}
          {meta}
        </div>
      )}
    </div>
  );
}

/* 2 ── TimeSeries — line + area over buckets, or N lines over one y-scale
 *
 * Takes EITHER `buckets` (one line, area filled — the shape every page has
 * always passed) or `series: [{ label, buckets, color?, dashed? }]`. The two are
 * one component because a grouped breakdown and a compare window are the same
 * picture with a different number of lines, and a second chart atom would drift
 * from this one's scale, axis and truncation behaviour within a release.
 *
 * The x axis is the UNION of every series' bucket starts, so a group with a gap
 * renders as a gap rather than as a compressed line that lies about when things
 * happened. A caller comparing two windows must therefore align them itself —
 * ReportView shifts the previous window forward by its own length, which is
 * exact because both windows are the same length by construction.
 *
 * Colour is never the only channel (dashboards §12): each series also gets its
 * own dash pattern, and `dashed` pins the compare series to one regardless.
 */
const SERIES_COLORS = [
  'var(--blue)', 'var(--violet)', 'var(--green)', 'var(--amber)', 'var(--red)', 'var(--fg-subtle)',
];

/** distinguishable without colour — index 0 is solid, so one series looks unchanged */
const SERIES_DASHES = ['', '5 3', '2 2', '8 3 2 3', '1 3', '6 2 1 2'];

/** past this many points, per-point hover targets cost more than they are worth */
const MARKER_MAX = 120;

export function TimeSeries({ buckets, series, height = 160, color = 'var(--accent)', format = fmtNumber }) {
  const W = 720;
  const H = height;
  const pad = { l: 8, r: 8, t: 10, b: 20 };
  const lines = (series?.length ? series : [{ buckets, color }]).filter((s) => s?.buckets?.length);
  if (!lines.length) return <div className="empty">No data in range</div>;

  const domain = [...new Set(lines.flatMap((s) => s.buckets.map((b) => new Date(b.at).getTime())))]
    .sort((a, b) => a - b);
  const index = new Map(domain.map((t, i) => [t, i]));
  const max = Math.max(...lines.flatMap((s) => s.buckets.map((b) => b.value)), 1);
  const x = (i) => pad.l + (i / Math.max(domain.length - 1, 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const solo = lines.length === 1 && !lines[0].label;
  const ticks = [0, Math.floor((domain.length - 1) / 2), domain.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i && v >= 0,
  );
  const shade = (s, i) => s.color ?? (solo ? color : SERIES_COLORS[i % SERIES_COLORS.length]);

  return (
    <>
      {!solo && (
        <div className="hstack" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {lines.map((s, i) => (
            <span key={s.label ?? i} className="pill" style={{ color: shade(s, i) }} title={s.label}>
              <span className="dot" />{s.label ?? '—'}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
        <g className="chart-grid">
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} />
          ))}
        </g>
        {lines.map((s, i) => {
          const pts = s.buckets.map((b) => ({
            i: index.get(new Date(b.at).getTime()) ?? 0, b,
          })).sort((a, b) => a.i - b.i);
          const d = pts.map((p, n) => `${n ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.b.value).toFixed(1)}`).join('');
          const stroke = shade(s, i);
          const dash = s.dashed ? '5 3' : SERIES_DASHES[i % SERIES_DASHES.length];
          return (
            <g key={s.label ?? i}>
              {/* the area belongs to the single-line case: N overlapping washes
                  read as a stack, which is a different (and untrue) chart */}
              {solo && (
                <path
                  className="chart-area"
                  fill={stroke}
                  d={`${d}L${x(pts[pts.length - 1].i)},${H - pad.b}L${x(pts[0].i)},${H - pad.b}Z`}
                />
              )}
              <path d={d} stroke={stroke} className="chart-line" {...(dash ? { strokeDasharray: dash } : {})} />
              {domain.length <= MARKER_MAX && pts.map((p) => (
                <circle key={p.i} cx={x(p.i)} cy={y(p.b.value)} r="2.5" fill={stroke}>
                  <title>
                    {`${s.label ? `${s.label} · ` : ''}${fmtClock(p.b.at).slice(0, 16)} · ${format(p.b.value)}`}
                  </title>
                </circle>
              ))}
            </g>
          );
        })}
        <g className="chart-axis">
          {ticks.map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle">
              {new Date(domain[i]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </text>
          ))}
          <text x={pad.l} y={y(max) - 2}>{format(max)}</text>
        </g>
      </svg>
    </>
  );
}

/* ── Exactness and truncation: rendered, never inferred (reports §11.3) ──
 *
 * Every chart says which store answered it and whether a cap cut the answer.
 * Both were open-coded in three places before this; a component that reads a
 * Plan and a result is the only way the rule holds for the fourth chart.
 */
export function ExactnessBadge({ plan }) {
  if (!plan?.exactness) return null;
  const tone = { exact: 'green', raw: 'blue', scan: 'amber' }[plan.exactness] ?? '';
  // the resolver's `why` names the offending dim in quotes; showing it on the
  // badge is the difference between "this is slow" and "this is slow BECAUSE"
  const dim = plan.exactness === 'scan' ? /"([^"]+)" has no index/.exec(plan.why ?? '')?.[1] : null;
  const text =
    plan.exactness === 'exact'
      ? `exact — from rollups${plan.via ? ` · ${plan.via}` : ''}`
      : plan.exactness === 'raw'
        ? 'raw scan, indexed'
        : `unindexed dim${dim ? `: ${dim}` : ''}`;
  return <span className={`pill ${tone}`} title={plan.why}>{text}</span>;
}

export function TruncationNote({ result }) {
  if (!result?.truncated && !result?.bucketsTruncated) return null;
  return (
    <div className="card-sub" style={{ margin: '8px 0', color: 'var(--amber)' }}>
      {result.truncated && (
        <div>
          cut off at a query cap — the top groups are kept, so every number here is a lower bound and the
          tail is missing
        </div>
      )}
      {result.bucketsTruncated && (
        <div>
          some groups lost their later buckets at the per-group bucket cap — narrow the range or the groups
          rather than reading the ends of these lines
        </div>
      )}
    </div>
  );
}

/**
 * The registry's own to-do list (reports §9), read off the data. `fix` is a
 * registry LINE — rendered as text in a `pre.code`, never evaluated and never
 * dangerouslySetInnerHTML'd: it is built from event names and attr keys a
 * client controls.
 */
export function SuggestionList({ suggestions }) {
  if (!suggestions?.length) {
    return <div className="empty">Nothing to suggest — the registry and the data agree</div>;
  }
  return (
    <div className="vstack" style={{ gap: 14 }}>
      {suggestions.map((s, i) => (
        <div key={`${s.kind}:${s.target}:${s.key ?? i}`}>
          <div className="hstack" style={{ marginBottom: 6, flexWrap: 'wrap' }}>
            <span className="tag">{s.kind}</span>
            <span className="grow">{s.message}</span>
            <span className="pill">{fmtNumber(s.count)}</span>
          </div>
          <pre className="code">{s.fix}</pre>
        </div>
      ))}
    </div>
  );
}

/* 3 ── BreakdownTable — the "top N" workhorse */
export function BreakdownTable({ rows, columns, onRow, empty = 'Nothing to group' }) {
  const { platform } = React.useContext(ScopeContext);
  if (!rows?.length) return <div className="empty">{empty}</div>;
  // A cross-tenant row that carries its tenant says so, first column. Rows that
  // do not (quarantine, keys, client-side groupings) are left alone — the
  // column appears exactly where it would mean something.
  const cols = platform && rows.some((r) => r.tenantId != null)
    ? [{ key: 'tenantId', label: 'tenant', mono: true }, ...columns]
    : columns;
  return (
    <table className="table">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} className={c.num ? 'num' : ''}>{c.label ?? c.key}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined}>
            {cols.map((c) => (
              <td key={c.key} className={`${c.num ? 'num' : ''} ${c.mono ? 'mono' : ''}`}>
                {c.render ? c.render(r) : c.num ? fmtMetric(c.key, r[c.key]) : String(r[c.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* 4 ── DistributionChart — histogram + percentile markers */
export function DistributionChart({ histogram, p50, p95, p99, format = fmtMs }) {
  if (!histogram?.length) return <div className="empty">No distribution in range</div>;
  const W = 720;
  const H = 140;
  const max = Math.max(...histogram.map((h) => h.n), 1);
  const lo = histogram[0].min;
  const hi = histogram[histogram.length - 1].max || lo + 1;
  const px = (v) => ((v - lo) / (hi - lo)) * W;
  const bw = W / histogram.length - 2;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
        {histogram.map((h, i) => (
          <rect
            key={i}
            className="chart-bar"
            x={(i * W) / histogram.length + 1}
            width={Math.max(bw, 1)}
            y={(1 - h.n / max) * (H - 18)}
            height={(h.n / max) * (H - 18)}
            rx="2"
            fill="var(--violet)"
            opacity="0.7"
          />
        ))}
        {[['p50', p50, 'var(--fg-subtle)'], ['p95', p95, 'var(--amber)'], ['p99', p99, 'var(--red)']]
          .filter(([, v]) => v != null)
          .map(([label, v, color]) => (
            <g key={label}>
              <line x1={px(v)} x2={px(v)} y1={0} y2={H - 18} stroke={color} strokeDasharray="3 2" />
              <text x={px(v) + 3} y={12} fontSize="10" fill={color}>{label} {format(v)}</text>
            </g>
          ))}
      </svg>
    </div>
  );
}

/* shared bits */
export function KindPill({ kind }) {
  return <span className={`pill ${KIND_PILL[kind] ?? ''}`}><span className="dot" />{kind}</span>;
}

function subjectsOf(r) {
  return (r.subjectKeys ?? []).join(' ');
}

/* 5 ── RecordTable — envelope columns + kind extras, cursor-paged by the caller */
export function RecordTable({ items, onSelect, empty = 'No records in range' }) {
  // under the platform scope these rows can mix tenants, and a row that cannot
  // say whose it is is not evidence of anything
  const { platform } = React.useContext(ScopeContext);
  if (!items?.length) return <div className="empty">{empty}</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>when</th>{platform && <th>tenant</th>}<th>kind</th><th>name</th><th>subjects</th><th>summary</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r._id} onClick={() => onSelect?.(r)}>
            <td className="mono" title={fmtClock(r.occurredAt)}>{fmtTime(r.occurredAt)}</td>
            {platform && <td className="mono f500">{r.tenantId}</td>}
            <td><KindPill kind={r.kind} /></td>
            <td className="f500">{r.name}</td>
            <td className="mono subtle">{subjectsOf(r)}</td>
            <td className="subtle">{recordSummary(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function recordSummary(r) {
  if (r.error) return `${r.error.type}: ${r.error.message}`.slice(0, 80);
  if (r.state) return `${r.state.key}: ${r.state.from ?? '∅'} → ${r.state.to}`;
  if (r.usage) return `${r.usage.meter} × ${fmtNumber(r.usage.quantity)} ${r.usage.unit}`;
  if (r.durationMs != null) return fmtMs(r.durationMs);
  const attrs = Object.entries(r.attrs ?? {}).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ');
  return attrs || '';
}

/* the one bespoke error component (dashboards §5) */
export function StackTrace({ frames }) {
  if (!frames?.length) return <div className="subtle text-xs">no frames captured</div>;
  return (
    <div className="frames">
      {frames.map((f, i) => {
        // `original` is set server-side when a sourcemap is registered for the
        // record's release; the minified location stays visible underneath
        const o = f.original;
        return (
          <div key={i} className={`frame ${f.inApp || (o && !o.source.includes('node_modules')) ? 'in-app' : ''}`}>
            <span className="fn">{o?.name ?? f.fn ?? '<anonymous>'}</span>{' '}
            {o ? (
              <>
                <span className="loc">{o.source}:{o.line}:{o.column}</span>
                {o.context && <div className="mono text-xs">{o.context}</div>}
                <div className="subtle text-xs">{f.filename}:{f.lineno}:{f.colno}</div>
              </>
            ) : (
              <span className="loc">{f.filename}:{f.lineno}:{f.colno}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* 6 ── RecordDetail — drawer: envelope, payload, kind panel slot */
export function RecordDetail({ record, onClose, onTrace, onSubject }) {
  const { platform } = React.useContext(ScopeContext);
  if (!record) return null;
  const kv = (obj) =>
    Object.entries(obj ?? {}).map(([k, v]) => (
      <React.Fragment key={k}>
        <dt>{k}</dt>
        <dd>{typeof v === 'number' ? fmtMetric(k, v) : String(v)}</dd>
      </React.Fragment>
    ));
  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <aside className="drawer">
        <div className="hstack" style={{ marginBottom: 12 }}>
          <KindPill kind={record.kind} />
          <h2 className="grow">{record.name}</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {record.severity && SEVERITY_PILL[record.severity] !== undefined && (
          <span className={`pill ${SEVERITY_PILL[record.severity]}`}>{record.severity}</span>
        )}

        <div className="divider" />
        <dl className="kv">
          {platform && (<><dt>tenant</dt><dd className="mono">{record.tenantId}</dd></>)}
          <dt>occurred</dt><dd>{fmtClock(record.occurredAt)}</dd>
          <dt>received</dt><dd>{record.receivedAt ? fmtClock(record.receivedAt) : '—'}</dd>
          <dt>service / env</dt><dd>{record.service} · {record.env}</dd>
          <dt>release</dt><dd>{record.release}</dd>
          <dt>origin</dt><dd>{record.origin}</dd>
          {record.actor && (<><dt>actor</dt><dd>{record.actor}</dd></>)}
          {record.traceId && (
            <>
              <dt>trace</dt>
              <dd>
                <a onClick={() => onTrace?.(record.traceId)} style={{ color: 'var(--accent)', cursor: 'pointer' }}>
                  {record.traceId}
                </a>
              </dd>
            </>
          )}
          {record.durationMs != null && (<><dt>duration</dt><dd>{fmtMs(record.durationMs)}</dd></>)}
          <dt>id</dt><dd>{record._id}</dd>
        </dl>

        {(record.subjectKeys ?? []).length > 0 && (
          <>
            <div className="divider" />
            <div className="hstack" style={{ flexWrap: 'wrap' }}>
              {record.subjectKeys.map((s) => (
                <button key={s} className="filter-chip" onClick={() => onSubject?.(s)}>{s}</button>
              ))}
            </div>
          </>
        )}

        {Object.keys(record.attrs ?? {}).length > 0 && (
          <><div className="divider" /><div className="f600 text-xs" style={{ marginBottom: 6 }}>attrs</div><dl className="kv">{kv(record.attrs)}</dl></>
        )}
        {Object.keys(record.metrics ?? {}).length > 0 && (
          <><div className="divider" /><div className="f600 text-xs" style={{ marginBottom: 6 }}>metrics</div><dl className="kv">{kv(record.metrics)}</dl></>
        )}

        {/* kind panel slot — the ONLY place kind-awareness is allowed to render */}
        {record.error && (
          <>
            <div className="divider" />
            <div className="f600 text-xs" style={{ marginBottom: 6 }}>
              {record.error.type}: {record.error.message}{' '}
              <span className="tag">{record.error.handled ? 'handled' : 'unhandled'}</span>{' '}
              <span className="tag">{record.error.fingerprint}</span>
            </div>
            <StackTrace frames={record.error.frames} />
          </>
        )}
        {record.state && (
          <><div className="divider" /><dl className="kv">
            <dt>state key</dt><dd>{record.state.key}</dd>
            <dt>transition</dt><dd>{record.state.from ?? '∅'} → {record.state.to}</dd>
            {record.state.previousSinceMs != null && (<><dt>dwelled</dt><dd>{fmtMs(record.state.previousSinceMs)}</dd></>)}
          </dl></>
        )}
        {record.usage && (
          <><div className="divider" /><dl className="kv">
            <dt>meter</dt><dd>{record.usage.meter}</dd>
            <dt>quantity</dt><dd>{fmtNumber(record.usage.quantity)} {record.usage.unit}</dd>
            <dt>billed to</dt><dd>{record.usage.billedTo}</dd>
            <dt>idempotency</dt><dd>{record.usage.idempotencyKey}</dd>
            {record.usage.reverses && (<><dt>reverses</dt><dd>{record.usage.reverses}</dd></>)}
          </dl></>
        )}

        {record.data && (
          <><div className="divider" /><pre className="code">{JSON.stringify(record.data, null, 2)}</pre></>
        )}
      </aside>
    </>
  );
}

/* 7 ── StreamList — chronological, kind-iconed; markers interleave */
export function StreamList({ items, markers = [], onSelect }) {
  // a subject ref is unique only within a tenant, so a '*' journey can braid
  // two tenants' 'user:u_1' into one timeline — label each entry
  const { platform } = React.useContext(ScopeContext);
  const merged = [
    ...items.map((r) => ({ at: r.occurredAt, record: r })),
    ...markers.map((m) => ({ at: m.at, marker: m })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!merged.length) return <div className="empty">Nothing here in range</div>;
  return (
    <div className="stream">
      {merged.map((e, i) =>
        e.marker ? (
          <div key={`m${i}`} className="stream-marker">⛳ {e.marker.label} · {fmtTime(e.at)}</div>
        ) : (
          <div key={e.record._id} className="stream-item" onClick={() => onSelect?.(e.record)}>
            <span className="stream-time">{fmtClock(e.at).slice(5)}</span>
            <span className="stream-kind status-dot" style={{ background: KIND_COLOR[e.record.kind] }} />
            {platform && <span className="tag">{e.record.tenantId}</span>}
            <span className="stream-name">{e.record.name}</span>
            <span className="stream-meta">{recordSummary(e.record)}</span>
          </div>
        ),
      )}
    </div>
  );
}

/* 8 ── FunnelSteps
 *
 * Renders the server's funnel rows verbatim. It does NOT recompute conversion:
 * `pctOfPrevious` is null when the previous step is empty and may exceed 100%
 * when a step is skipped, and both facts are load-bearing (cohort-math R3/R4).
 * The old client-side version rounded the percentage and omitted it rather than
 * showing null — two quiet disagreements with the number the API now returns.
 *
 * `count` is accepted as an alias for `subjects` so a host feeding plain
 * {label, count} rows still gets bars. */
/**
 * A stage subjects reach before the stage above it. Either signal alone is
 * enough: a rate over 100% means more subjects arrived here than at the step
 * it is divided by, and a negative median says outright that they arrived
 * earlier. Never true of the anchor, which has nothing above it.
 */
function isOutOfOrder(s, i) {
  if (i === 0) return false;
  return (s.pctOfPrevious != null && s.pctOfPrevious > 100)
    || (s.medianDaysFromPrevious != null && s.medianDaysFromPrevious < 0);
}

export function FunnelSteps({ steps }) {
  if (!steps?.length) return <div className="empty">No funnel data</div>;
  const n = (s) => s.subjects ?? s.count ?? 0;
  const max = Math.max(...steps.map(n), 1);
  return (
    <div>
      {steps.map((s, i) => (
        <div key={s.key ?? s.label ?? i} className="funnel-step">
          <span className="f500" title={s.description ?? ''}>{s.label ?? s.key}</span>
          <div className="funnel-bar" style={{ width: `${(n(s) / max) * 100}%` }} title={String(n(s))} />
          <span className="funnel-conv">
            {fmtNumber(n(s))}
            {/* null means "undefined", not zero — say so rather than hide the step */}
            {i > 0 && s.pctOfPrevious != null && ` · ${fmtPct(s.pctOfPrevious)}`}
            {i > 0 && 'pctOfPrevious' in s && s.pctOfPrevious == null && (
              <span className="dwell" title="the previous step has no subjects, so conversion is undefined">n/a</span>
            )}
            {s.medianDaysFromPrevious != null && (
              <span className="dwell">{fmtDays(s.medianDaysFromPrevious)} median</span>
            )}
            {/*
             * A rate over 100% or a NEGATIVE median both say the same thing:
             * subjects reached this stage BEFORE the one above it, so the
             * stages are in the wrong order and every rate below here is
             * measured against the wrong denominator.
             *
             * The numbers stay on screen — they are arithmetic, not errors,
             * and cohort-math R3/R4 depends on this component not recomputing
             * them. What was missing is that nothing said the order was
             * wrong, so "411%" read as a broken funnel rather than as
             * "account.converted belongs above account.paid". The median is
             * the crisper of the two signals: people convert ~14 days before
             * they first pay, and it says so with a minus sign.
             */}
            {isOutOfOrder(s, i) && (
              <span
                className="pill amber"
                title="This stage happens BEFORE the one above it, so its rate is measured against the wrong previous step. Reorder the stages."
              >out of order</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/* 9 ── Waterfall — spans on a shared time axis, non-spans as dots */
export function Waterfall({ items, onSelect }) {
  if (!items?.length) return <div className="empty">Empty trace</div>;
  const t0 = Math.min(...items.map((r) => new Date(r.occurredAt).getTime()));
  const t1 = Math.max(...items.map((r) => new Date(r.occurredAt).getTime() + (r.durationMs ?? 0)));
  const span = Math.max(t1 - t0, 1);
  const left = (r) => ((new Date(r.occurredAt).getTime() - t0) / span) * 100;
  return (
    <div>
      {items.map((r) => (
        <div key={r._id} className="wf-row">
          <span className="wf-label" onClick={() => onSelect?.(r)} title={r.name}>
            <span className="status-dot" style={{ background: KIND_COLOR[r.kind], marginRight: 6 }} />
            {r.name}
          </span>
          <div className="wf-track">
            {r.durationMs != null ? (
              <div
                className="wf-bar"
                style={{ left: `${left(r)}%`, width: `${Math.max((r.durationMs / span) * 100, 0.4)}%`, background: KIND_COLOR[r.kind] }}
              />
            ) : (
              <div className="wf-dot" style={{ left: `calc(${left(r)}% - 5px)`, background: KIND_COLOR[r.kind] }} />
            )}
            <span className="wf-dur">{r.durationMs != null ? fmtMs(r.durationMs) : ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* 10 ── TransitionMatrix — from→to counts with dwell */
export function TransitionMatrix({ transitions }) {
  if (!transitions?.length) return <div className="empty">No transitions in range</div>;
  const froms = [...new Set(transitions.map((t) => t.from ?? '∅'))];
  const tos = [...new Set(transitions.map((t) => t.to))];
  const cell = (f, t) => transitions.find((x) => (x.from ?? '∅') === f && x.to === t);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="matrix">
        <thead>
          <tr><th>from \ to</th>{tos.map((t) => <th key={t}>{t}</th>)}</tr>
        </thead>
        <tbody>
          {froms.map((f) => (
            <tr key={f}>
              <th>{f}</th>
              {tos.map((t) => {
                const c = cell(f, t);
                return (
                  <td key={t} style={c ? { background: 'color-mix(in oklab, var(--amber) 12%, transparent)' } : {}}>
                    {c ? (
                      <>
                        {fmtNumber(c.n)}
                        {c.avgMs != null && <span className="dwell">{fmtMs(c.avgMs)} avg</span>}
                      </>
                    ) : '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── ReportView — the ONE renderer over a ReportResult (reports §8) ──
 *
 * ViewSpec's old rendering hint is gone, and this is why it could go: the Plan
 * and the Report together decide the picture. `groupBy` + `interval` is N lines,
 * `groupBy` alone is a table, `interval` alone is one line, neither is a tile,
 * and `funnel` is steps. Nothing upstream chooses a renderer, so nothing
 * upstream can choose a wrong one — and a page that wanted its own branch here
 * would be a page that knows what it is looking at, which is the over-fit this
 * whole layer exists to prevent.
 *
 * Every branch shows exactness and truncation, because both are facts about the
 * number and not decoration on it (reports §11.3).
 */

/** groups beyond this fold into one 'other' line — six is what a legend can hold */
const TOP_SERIES = 6;

/** 'attr:model' → 'model'. A dim's own label, never a name this file knows. */
const shortDim = (key) => String(key).replace(/^(attr|field):/, '');

/** the column heads of a breakdown: the family's labels when it answered, else the dims asked for */
function dimLabels(data) {
  const labels = data.plan?.shape?.labels;
  if (labels?.length) return labels;
  return (data.report?.groupBy ?? []).map(shortDim);
}

/**
 * Breakdown rows carrying a time axis → one series per group, biggest six kept
 * and the rest summed into 'other'. Dropping the tail silently would make a
 * chart of the top six look like a chart of everything.
 */
function rowsToSeries(rows) {
  const byGroup = new Map();
  for (const r of rows) {
    const label = (r.dims ?? []).map((d) => d ?? '∅').join(' · ');
    const g = byGroup.get(label) ?? { label, buckets: [], total: 0 };
    g.buckets.push({ at: r.at, value: r.value });
    g.total += r.value;
    byGroup.set(label, g);
  }
  const all = [...byGroup.values()].sort((a, b) => b.total - a.total);
  if (all.length <= TOP_SERIES) return all;
  const rest = all.slice(TOP_SERIES);
  const folded = new Map();
  for (const g of rest) {
    for (const b of g.buckets) {
      const k = new Date(b.at).getTime();
      folded.set(k, (folded.get(k) ?? 0) + b.value);
    }
  }
  return [
    ...all.slice(0, TOP_SERIES),
    {
      label: `other (${rest.length})`,
      total: rest.reduce((a, g) => a + g.total, 0),
      buckets: [...folded.entries()].sort((a, b) => a[0] - b[0]).map(([at, value]) => ({ at, value })),
    },
  ];
}

/** the length of the Report's own window, so a compare series can be laid over it */
function windowMs(range) {
  try {
    const { from, to } = rangeOf(range);
    return to.getTime() - from.getTime();
  } catch {
    return 0;
  }
}

const sumOf = (buckets) => (buckets ?? []).reduce((a, b) => a + b.value, 0);

/**
 * One number out of a ReportResult, for the pages that want a tile rather than
 * a chart. It lives beside ReportView so that "which field holds the answer"
 * is known in exactly one file — a page reading `result.p95` itself would be a
 * page that knows which primitive ran.
 */
export function reportScalar(data) {
  if (!data) return { value: null, format: fmtNumber, meta: null };
  const { plan = {}, result = {}, report = {} } = data;
  const measure = report.measure ?? 'count';
  const format = (v) => fmtMeasure(measure, v);
  switch (plan.primitive) {
    case 'funnel':
      return { value: result.cohortSubjects ?? null, format: fmtNumber, meta: 'in cohort' };
    case 'distribution':
      return {
        value: result.n ? result.p95 : null,
        format: (v) => fmtMetric(metricOf(measure), v),
        meta: `${fmtNumber(result.n ?? 0)} sampled`,
      };
    case 'distinctCount':
      return { value: result.distinct ?? null, format: fmtNumber, meta: 'distinct in range' };
    case 'records':
      return { value: (result.items ?? []).length, format: fmtNumber, meta: 'latest page' };
    case 'series':
      return { value: sumOf(result.buckets), format, meta: 'in range' };
    default: {
      const rows = result.rows ?? [];
      // an average does not sum; saying so beats printing a number that means
      // nothing, and the chart below still shows every group
      const summable = measure === 'count' || measure.startsWith('sum:');
      return {
        value: summable ? rows.reduce((a, r) => a + r.value, 0) : null,
        format,
        meta: summable ? `${fmtNumber(result.groups ?? rows.length)} groups` : 'per group — see below',
      };
    }
  }
}

/**
 * The comparison, as two numbers. `compare: 'previous'` is the same plan with
 * its range shifted back by its own length, so the pair is directly comparable
 * — EXCEPT off an exact plan, where the previous window may not land on the
 * family's bucket starts and a partial bucket would be measured against a whole
 * one (reports §13). That is said rather than silently averaged away.
 */
function CompareTiles({ now, before, fmt, plan }) {
  if (before == null) return null;
  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <StatTile
          label="This window"
          value={fmt(now)}
          delta={now - before}
          deltaFormat={fmt}
          meta={before ? `${fmtPct(((now - before) / before) * 100)} vs previous` : 'no previous data'}
        />
        <StatTile label="Previous window" value={fmt(before)} meta="same length, immediately before" />
      </div>
      {plan?.exactness === 'exact' && (
        <div className="card-sub" style={{ marginBottom: 8, color: 'var(--amber)' }}>
          this is an exact read off pre-aggregated buckets — if the previous window does not start on one, its
          first bucket is partial and the comparison is off by that much
        </div>
      )}
    </>
  );
}

export function ReportView({ data, onSelect, height }) {
  if (!data) return null;
  const { plan = {}, result = {}, previous, report = {} } = data;
  const measure = report.measure ?? 'count';
  const fmt = (v) => fmtMeasure(measure, v);

  const frame = (body, aside = null) => (
    <>
      <div className="hstack" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <ExactnessBadge plan={plan} />
        {aside}
      </div>
      <TruncationNote result={result} />
      {body}
    </>
  );

  if (plan.primitive === 'funnel') {
    const slices = result.slices ?? [];
    // one line per stage across cohort dates — the same picture small multiples
    // would draw, in one chart that shares a scale so the drop-offs line up
    const overTime = slices.length > 1
      ? (result.stages ?? []).map((st) => ({
          label: st.label ?? st.key,
          buckets: slices.map((s) => ({
            at: s.at, value: s.stages?.find((x) => x.key === st.key)?.subjects ?? 0,
          })),
        }))
      : null;
    return frame(
      <>
        <div className="card-sub" style={{ marginBottom: 8 }}>
          {fmtNumber(result.cohortSubjects ?? 0)} subjects anchored on{' '}
          <span className="mono">{result.cohort?.anchor}</span>
        </div>
        <FunnelSteps steps={result.stages} />
        {(result.exits ?? []).length > 0 && (
          <>
            <div className="divider" />
            <div className="f600 text-xs" style={{ marginBottom: 6 }}>Exits</div>
            <BreakdownTable
              rows={result.exits.map((e) => ({ id: e.key, exit: e.label ?? e.key, subjects: e.subjects }))}
              columns={[{ key: 'exit' }, { key: 'subjects', num: true }]}
            />
          </>
        )}
        {overTime && (
          <>
            <div className="divider" />
            <div className="f600 text-xs" style={{ marginBottom: 6 }}>Cohorts over time</div>
            <TimeSeries series={overTime} height={height ?? 140} format={fmtNumber} />
          </>
        )}
      </>,
    );
  }

  if (plan.primitive === 'distribution') {
    const metric = metricOf(measure);
    return frame(
      <DistributionChart {...result} format={(v) => fmtMetric(metric, v)} />,
      <span className="tag">{fmtNumber(result.n ?? 0)} sampled</span>,
    );
  }

  if (plan.primitive === 'records') {
    return frame(<RecordTable items={result.items} onSelect={onSelect} />);
  }

  if (plan.primitive === 'distinctCount') {
    return frame(
      <>
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          {/* the range total, NEVER the sum of the buckets — a subject active on
              five days is one active subject */}
          <StatTile
            label={`Distinct ${metricOf(measure)}`}
            value={fmtNumber(result.distinct ?? 0)}
            meta="distinct in range"
          />
          <StatTile
            label={`Peak per ${result.interval ?? 'bucket'}`}
            value={fmtNumber(Math.max(0, ...(result.buckets ?? []).map((b) => b.value)))}
          />
        </div>
        <TimeSeries buckets={result.buckets} height={height} format={fmtNumber} />
      </>,
    );
  }

  if (plan.primitive === 'series') {
    const current = result.buckets ?? [];
    const prior = previous?.buckets ?? null;
    const shift = prior ? windowMs(report.range) : 0;
    const series = [
      { label: prior ? 'this window' : null, buckets: current, color: 'var(--accent)' },
      ...(prior
        ? [{
            label: 'previous window',
            // laid over the current window by its own length: both windows are
            // the same length by construction, so this alignment is exact
            buckets: prior.map((b) => ({ at: new Date(b.at).getTime() + shift, value: b.value })),
            color: 'var(--fg-subtle)',
            dashed: true,
          }]
        : []),
    ];
    return frame(
      <>
        <CompareTiles now={sumOf(current)} before={prior ? sumOf(prior) : null} fmt={fmt} plan={plan} />
        <TimeSeries series={series} height={height} format={fmt} />
      </>,
    );
  }

  // breakdown, and a rollups plan folded into the same rows (execute.ts)
  const rows = result.rows ?? [];
  const labels = dimLabels(data);
  const summable = measure === 'count' || measure.startsWith('sum:');
  const total = (r) => (r?.rows ?? []).reduce((a, x) => a + x.value, 0);
  if (rows.some((r) => r.at)) {
    return frame(
      <>
        {/* N groups × 2 windows is not a readable chart, so the comparison is
            the pair of totals and the chart stays this window's */}
        {previous && summable && <CompareTiles now={total(result)} before={total(previous)} fmt={fmt} plan={plan} />}
        <TimeSeries series={rowsToSeries(rows)} height={height} format={fmt} />
      </>,
    );
  }
  const scalar = reportScalar(data);
  return frame(
    <>
      {scalar.value != null && (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <StatTile label="Total" value={scalar.format(scalar.value)} meta={scalar.meta} />
          <StatTile label="Groups" value={fmtNumber(result.groups ?? rows.length)} />
        </div>
      )}
      <BreakdownTable
        rows={rows.map((r, i) => ({
          id: i,
          ...Object.fromEntries((r.dims ?? []).map((d, n) => [`d${n}`, d ?? '∅'])),
          value: r.value,
        }))}
        columns={[
          ...(labels.length ? labels : ['group']).map((l, n) => ({ key: `d${n}`, label: l, mono: true })),
          { key: 'value', label: measure, num: true, render: (r) => fmt(r.value) },
        ]}
        onRow={onSelect}
        empty="No groups in range"
      />
    </>,
  );
}
