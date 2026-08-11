import React from 'react';
import {
  KIND_COLOR, KIND_PILL, SEVERITY_PILL,
  fmtClock, fmtMetric, fmtMs, fmtNumber, fmtTime,
} from './util.js';

/**
 * The ten atoms (dashboards §4) — kind-blind by law: data + specs in, pixels
 * out. None of them knows an event name; formatting is convention-driven.
 * Charts are hand-rolled SVG (mailery's sparkline lineage) — no chart library
 * until an atom proves it needs one.
 */

/* 1 ── StatTile */
export function StatTile({ label, value, delta, meta }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {(delta != null || meta) && (
        <div className="kpi-meta">
          {delta != null && (
            <span className={`kpi-delta ${delta >= 0 ? 'up' : 'down'}`}>
              {delta >= 0 ? '▲' : '▼'} {fmtNumber(Math.abs(delta))}
            </span>
          )}
          {meta}
        </div>
      )}
    </div>
  );
}

/* 2 ── TimeSeries — line + area over buckets */
export function TimeSeries({ buckets, height = 160, color = 'var(--accent)', format = fmtNumber }) {
  const W = 720;
  const H = height;
  const pad = { l: 8, r: 8, t: 10, b: 20 };
  if (!buckets?.length) return <div className="empty">No data in range</div>;
  const max = Math.max(...buckets.map((b) => b.value), 1);
  const x = (i) => pad.l + (i / Math.max(buckets.length - 1, 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const line = buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.value).toFixed(1)}`).join('');
  const area = `${line}L${x(buckets.length - 1)},${H - pad.b}L${x(0)},${H - pad.b}Z`;
  const ticks = [0, Math.floor(buckets.length / 2), buckets.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img">
      <g className="chart-grid">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} />
        ))}
      </g>
      <path d={area} fill={color} className="chart-area" />
      <path d={line} stroke={color} className="chart-line" />
      {/* dash markers keep series legible without color (a11y open item) */}
      <g className="chart-axis">
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle">
            {new Date(buckets[i].at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </text>
        ))}
        <text x={pad.l} y={y(max) - 2}>{format(max)}</text>
      </g>
    </svg>
  );
}

/* 3 ── BreakdownTable — the "top N" workhorse */
export function BreakdownTable({ rows, columns, onRow, empty = 'Nothing to group' }) {
  if (!rows?.length) return <div className="empty">{empty}</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={c.num ? 'num' : ''}>{c.label ?? c.key}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined}>
            {columns.map((c) => (
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
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img">
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
  if (!items?.length) return <div className="empty">{empty}</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>when</th><th>kind</th><th>name</th><th>subjects</th><th>summary</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r._id} onClick={() => onSelect?.(r)}>
            <td className="mono" title={fmtClock(r.occurredAt)}>{fmtTime(r.occurredAt)}</td>
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
      {frames.map((f, i) => (
        <div key={i} className={`frame ${f.inApp ? 'in-app' : ''}`}>
          <span className="fn">{f.fn ?? '<anonymous>'}</span>{' '}
          <span className="loc">{f.filename}:{f.lineno}:{f.colno}</span>
        </div>
      ))}
    </div>
  );
}

/* 6 ── RecordDetail — drawer: envelope, payload, kind panel slot */
export function RecordDetail({ record, onClose, onTrace, onSubject }) {
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
            <span className="stream-name">{e.record.name}</span>
            <span className="stream-meta">{recordSummary(e.record)}</span>
          </div>
        ),
      )}
    </div>
  );
}

/* 8 ── FunnelSteps */
export function FunnelSteps({ steps }) {
  if (!steps?.length) return <div className="empty">No funnel data</div>;
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <div>
      {steps.map((s, i) => (
        <div key={s.label} className="funnel-step">
          <span className="f500">{s.label}</span>
          <div className="funnel-bar" style={{ width: `${(s.count / max) * 100}%` }} title={String(s.count)} />
          <span className="funnel-conv">
            {fmtNumber(s.count)}
            {i > 0 && steps[i - 1].count > 0 && ` · ${Math.round((s.count / steps[i - 1].count) * 100)}%`}
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
