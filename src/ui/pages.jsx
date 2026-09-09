import React from 'react';
import {
  BreakdownTable, RecordDetail, RecordTable, ReportView, StatTile, StreamList,
  SuggestionList, TimeSeries, TransitionMatrix, TruncationNote, Waterfall, reportScalar,
} from './atoms.jsx';
import { FilterBar } from './shell.jsx';
import {
  filtersFromParams, fmtMetric, fmtNumber, fmtTime, intervalFor, navigate,
  rangeToDates, reportToQuery, resolveReport, sourceEvents, sourceFromParam, sourceParam,
} from './util.js';

/**
 * Pages build REPORTS (reports §8). None of them names a metric, an attr or a
 * family — every control is populated from the catalog and every option is
 * checked by the resolver before it is offered (§11.1, §11.2). The atoms they
 * compose stay kind-blind, and one renderer draws every answer.
 *
 * One bespoke component per kind, already spent: StackTrace (error, inside
 * RecordDetail), Waterfall (span), TransitionMatrix (state). event and usage
 * still prove zero is achievable.
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

/** the RecordFilter terms a `filter=` dim maps onto — equality only, as query.ts builds it */
const FIELD_TERM = {
  'field:kind': 'kind',
  'field:name': 'name',
  'field:severity': 'severity',
  'field:env': 'env',
  'field:service': 'service',
  'field:release': 'release',
  'field:subject': 'subject',
  'field:traceId': 'traceId',
};

/**
 * The flat params the raw routes (`/records`, `/journey`) still take, built from
 * the URL's own `filter=` terms. The FilterBar writes ONE vocabulary; this is
 * where the two routes that predate Reports read it. Terms those routes cannot
 * express (a set, a bound) are dropped rather than approximated.
 */
const filterParams = (p, extra = {}) => {
  const out = {
    ...rangeToDates(p.range ?? '7d'),
    name: p.name,
    env: p.env,
    service: p.service,
    severity: p.severity,
    subject: p.subject,
    metrics: p.metrics,
    excludeActors: p.excludeActors,
  };
  const attrs = [];
  for (const f of filtersFromParams(p)) {
    if (f.op !== 'eq') continue;
    if (f.dim.startsWith('attr:')) attrs.push(`${f.dim.slice(5)}:${f.value}`);
    else if (FIELD_TERM[f.dim]) out[FIELD_TERM[f.dim]] = f.value;
  }
  return { ...out, ...(attrs.length ? { attrs: attrs.join(',') } : {}), ...extra };
};

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

/* ── what the catalog offers ────────────────────────────────────────────────
 *
 * Everything below reads the catalog and nothing below writes a name. The
 * closest any of it comes is a SUFFIX (`_usd`) and a PREFIX (`field:error.`),
 * and both are rules about a kind of thing rather than the name of one: `*_usd`
 * is the money formatting convention (dashboards §4), and a family keyed by an
 * error field is an issue family whatever its host chose to call it.
 */

/** every source a picker may offer, grouped the way a reader thinks about them */
function sourceGroups(catalog) {
  const kinds = [];
  for (const e of Object.values(catalog.events)) if (!kinds.includes(e.kind)) kinds.push(e.kind);
  return [
    ['kinds', kinds.map((k) => ({ term: `kind:${k}`, label: k }))],
    ['namespaces', Object.keys(catalog.namespaces).map((ns) => ({ term: `namespace:${ns}`, label: `${ns}.*` }))],
    ['events', Object.keys(catalog.events).map((n) => ({ term: `event:${n}`, label: n }))],
    ['rollup families', Object.keys(catalog.families).map((as) => ({ term: `family:${as}`, label: as }))],
  ];
}

/** count, exact distincts, then whatever the source's events declare — plus funnel where it applies */
function measureOptions(catalog, source) {
  const out = [{ key: 'count', label: 'count' }];
  for (const t of catalog.subjectTypes) out.push({ key: `distinct:${t}`, label: `distinct ${t}` });
  const seen = new Set(['count']);
  for (const n of sourceEvents(catalog, source)) {
    for (const m of catalog.events[n]?.measures ?? []) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      out.push({ key: m.key, label: m.exactVia.length ? `${m.key} · exact` : m.key });
    }
  }
  if (isMilestone(catalog.families[source?.family])) out.push({ key: 'funnel', label: 'funnel' });
  return out;
}

/** the dims a source can group or filter by: its events' own, then the envelope */
function dimOptions(catalog, source) {
  const map = new Map();
  for (const n of sourceEvents(catalog, source)) {
    for (const d of catalog.events[n]?.dims ?? []) {
      const seen = map.get(d.key);
      map.set(d.key, seen ? { ...seen, indexed: seen.indexed && d.indexed } : d);
    }
  }
  for (const d of catalog.envelope) if (!map.has(d.key)) map.set(d.key, d);
  return [...map.values()];
}

/**
 * Changing the measure to `funnel` brings its stages with it, because a funnel
 * with none is refused for want of stages rather than because the question is
 * unanswerable — and an option greyed for the wrong reason is worse than one
 * greyed for the right one. Leaving `funnel` drops them again.
 */
function measurePatch(catalog, report, measure) {
  if (measure !== 'funnel') return { measure, stages: undefined, anchor: undefined, exits: undefined, subjectType: undefined };
  if (report?.stages?.length) return { measure };
  const subjectType = report?.subjectType ?? funnelSubjectTypes(catalog)[0];
  const stages = milestonesOf(catalog, subjectType);
  return { measure, stages, anchor: stages[0], subjectType };
}

/** a lifetime `by: ['subject']` family — the only thing a funnel stage may be (funnel.ts) */
const isMilestone = (f) => !!f && f.lifetime && f.by.length === 1 && f.by[0] === 'subject';

const milestonesOf = (catalog, subjectType) =>
  Object.values(catalog.families)
    .filter((f) => isMilestone(f) && (!subjectType || f.subjectTypes.includes(subjectType)))
    .map((f) => f.as);

/** subject types with at least one milestone family — the funnel picker's populations */
const funnelSubjectTypes = (catalog) =>
  catalog.subjectTypes.filter((t) => milestonesOf(catalog, t).length > 0);

/**
 * The money measure this instance meters, if it meters one: the first `sum:`
 * whose metric ends `_usd` across usage events, preferring one a rollup family
 * answers exactly. Reading a suffix is the formatting convention; naming the key
 * would be the over-fit (reports §11.1).
 */
function moneyMeasure(catalog) {
  const found = [];
  for (const [name, e] of Object.entries(catalog.events)) {
    if (e.kind !== 'usage') continue;
    for (const m of e.measures) {
      if (m.key.startsWith('sum:') && m.key.endsWith('_usd')) {
        found.push({ name, key: m.key, exact: m.exactVia.length > 0 });
      }
    }
  }
  return found.find((m) => m.exact) ?? found[0] ?? null;
}

/** the issue family: keyed by an error field. A kind rule, not a name. */
const issueFamilyOf = (catalog) =>
  Object.values(catalog.families).find((f) => String(f.by[0] ?? '').startsWith('field:error.'))?.as ?? null;

/** a dim key the catalog declares for a kind, e.g. the usage meter — found, never typed */
const kindDim = (catalog, kind, suffix) => {
  for (const e of Object.values(catalog.events)) {
    if (e.kind !== kind) continue;
    const d = e.dims.find((x) => x.key.startsWith('field:') && x.key.endsWith(suffix));
    if (d) return d;
  }
  return null;
};

/* ── running a Report ──────────────────────────────────────────────────────── */

/** resolve without throwing: an unknown range shorthand is a refusal, not a crash */
function planOf(report, catalog, now) {
  if (!report) return { unavailable: true, why: 'no report yet' };
  try {
    return resolveReport(report, catalog, { now });
  } catch (e) {
    return { unavailable: true, why: String(e?.message ?? e) };
  }
}

/** the `why` when the resolver refuses, null when it plans */
const refusalOf = (report, catalog, now) => {
  const plan = planOf(report, catalog, now);
  return 'unavailable' in plan ? plan.why : null;
};

function useReport(api, report) {
  const key = report ? JSON.stringify(reportToQuery(report)) : null;
  return useQuery(() => (report ? api.report(reportToQuery(report)) : Promise.resolve(null)), [key]);
}

/**
 * One card, one Report, one renderer. The card never learns what it drew — a
 * page hands it a question, `resolveReport` decides how it is answered, and
 * `ReportView` decides how the answer looks.
 */
function ReportCard({ api, report, title, sub, actions, height, onSelect, catalog, now }) {
  const refusal = catalog ? refusalOf(report, catalog, now) : null;
  const q = useReport(api, refusal ? null : report);
  return (
    <div className="card chart-card">
      <div className="hstack" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <span className="card-title">{title}</span>
        {sub && <span className="card-sub">{sub}</span>}
        <div className="topbar-spacer" />
        {actions}
      </div>
      {refusal ? (
        <div className="empty">{refusal}</div>
      ) : q.loading ? (
        <Loading />
      ) : q.error ? (
        <Failed error={q.error} />
      ) : (
        <ReportView data={q.data} onSelect={onSelect} height={height} />
      )}
    </div>
  );
}

/* ── Explore — the report builder (reports §8) ─────────────────────────────── */

/** every param that belongs to the Report, cleared before the next one is written */
const REPORT_PARAMS = [
  'source', 'range', 'from', 'to', 'interval', 'measure', 'groupBy', 'filter',
  'excludeActors', 'sort', 'limit', 'compare', 'stages', 'anchor', 'exits', 'subjectType',
];

/**
 * The builder, and the surface Events reuses. Source → measure → groupBy →
 * filters → interval → compare, every control populated from the catalog and
 * every option PRE-CHECKED by the resolver: an unanswerable combination is
 * greyed with the reason it cannot be answered, never submitted (reports §11.2).
 *
 * `fixedSource` pins the source for a page that already knows it (Events is
 * `kind: 'event'`), in which case `source=` is kept out of the URL so the
 * topbar's name picker stays the one thing that moves it.
 */
export function ExploreSurface({ api, catalog, route, page, fixedSource, title, sub, defaults }) {
  const p = route.params;
  const source = fixedSource ?? sourceFromParam(p.source);
  const now = React.useMemo(() => new Date(), [p.range, p.from, p.to]);
  const report = React.useMemo(
    () => (source ? buildReport(p, source, defaults) : null),
    [JSON.stringify(p), JSON.stringify(source), JSON.stringify(defaults)],
  );

  const apply = (next) => {
    const rest = { ...p };
    for (const k of REPORT_PARAMS) delete rest[k];
    const q = reportToQuery(next);
    if (fixedSource) delete q.source;
    navigate(page, { ...rest, ...q }, route.arg);
  };

  const measures = source ? measureOptions(catalog, source) : [];
  const dims = source ? dimOptions(catalog, source) : [];
  const groupBy = report?.groupBy ?? [];
  // an option is offered only if the resolver would plan the report it makes
  const badIf = (patch) => (report ? refusalOf({ ...report, ...patch }, catalog, now) : null);

  const setGroup = (slot, key) => {
    const next = [...groupBy];
    if (key) next[slot] = key;
    else next.splice(slot, 1);
    apply({ ...report, groupBy: next.filter(Boolean) });
  };

  if (!source) {
    return (
      <>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Explore</span>
            <span className="card-sub">pick something to read — the rest of the builder follows from it</span>
          </div>
          <div className="card-body hstack">
            <select
              className="select"
              value=""
              onChange={(e) => e.target.value && navigate(page, { range: p.range ?? '7d', source: e.target.value })}
            >
              <option value="">choose a source…</option>
              {sourceGroups(catalog).map(([label, options]) => (
                <optgroup key={label} label={label}>
                  {options.map((o) => <option key={o.term} value={o.term}>{o.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        <div className="empty">
          <h3>Nothing asked yet</h3>
          A report is a URL: pick a source and this page becomes a link you can save, share or pin to the sidebar.
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <span className="card-title">{title ?? 'Report'}</span>
          {sub && <span className="card-sub">{sub}</span>}
        </div>
        <div className="card-body">
          <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
            {!fixedSource && (
              <label className="hstack text-xs">
                <span className="subtle">source</span>
                <select
                  className="select"
                  value={sourceParam(source)}
                  onChange={(e) =>
                    // a new source keeps the window and drops the question: its
                    // measures, dims and filters are a different vocabulary
                    apply({ source: sourceFromParam(e.target.value), range: report.range, ...(report.interval ? { interval: report.interval } : {}) })
                  }
                >
                  {sourceGroups(catalog).map(([label, options]) => (
                    <optgroup key={label} label={label}>
                      {options.map((o) => <option key={o.term} value={o.term}>{o.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
            )}

            <label className="hstack text-xs">
              <span className="subtle">measure</span>
              <select
                className="select"
                value={report?.measure ?? 'count'}
                onChange={(e) => apply({ ...report, ...measurePatch(catalog, report, e.target.value) })}
              >
                {measures.map((m) => {
                  // a funnel with no stages is refused for want of stages, not
                  // because it cannot be answered — check the one it would build
                  const bad = badIf(measurePatch(catalog, report, m.key));
                  return (
                    <option key={m.key} value={m.key} disabled={!!bad} title={bad ?? ''}>
                      {m.label}{bad ? ' — unavailable' : ''}
                    </option>
                  );
                })}
              </select>
            </label>

            {[0, 1].map((slot) => (
              <label key={slot} className="hstack text-xs">
                <span className="subtle">{slot ? 'then by' : 'group by'}</span>
                <select className="select" value={groupBy[slot] ?? ''} onChange={(e) => setGroup(slot, e.target.value || null)}>
                  <option value="">—</option>
                  {dims.map((d) => {
                    const next = [...groupBy];
                    next[slot] = d.key;
                    const bad = badIf({ groupBy: next.filter(Boolean) });
                    return (
                      <option key={d.key} value={d.key} disabled={!!bad} title={bad ?? ''}>
                        {d.label}{d.indexed ? '' : ' (scan)'}{bad ? ' — unavailable' : ''}
                      </option>
                    );
                  })}
                </select>
              </label>
            ))}

            <label className="hstack text-xs">
              <span className="subtle">interval</span>
              <select className="select" value={report?.interval ?? ''} onChange={(e) => apply({ ...report, interval: e.target.value || undefined })}>
                <option value="">auto · {intervalFor(p.range ?? '7d')}</option>
                {['hour', 'day', 'week', 'month'].map((i) => {
                  const bad = badIf({ interval: i });
                  return (
                    <option key={i} value={i} disabled={!!bad} title={bad ?? ''}>
                      {i}{bad ? ' — unavailable' : ''}
                    </option>
                  );
                })}
              </select>
            </label>

            <button
              className={`filter-chip ${report?.compare ? 'active' : ''}`}
              disabled={!!badIf({ compare: 'previous' })}
              title={badIf({ compare: 'previous' }) ?? 'the window of the same length immediately before'}
              onClick={() => apply({ ...report, compare: report?.compare ? undefined : 'previous' })}
            >
              compare previous
            </button>
          </div>

          {report?.measure === 'funnel' && (
            <>
              <div className="divider" />
              <FunnelControls api={api} catalog={catalog} report={report} apply={apply} />
            </>
          )}
        </div>
      </div>

      <FilterBar api={api} route={route} catalog={catalog} source={source} />

      <ReportCard
        api={api}
        catalog={catalog}
        now={now}
        report={report}
        title={sourceParam(source)}
        sub={report?.measure && report.measure !== 'count' ? report.measure : undefined}
      />
    </>
  );
}

/**
 * URL params + a source → the Report they describe, defaults filled the way the
 * shell does. `defaults` is how a page whose surface is a CHART says so: with
 * no measure and no interval the resolver reads "show me the rows" and plans
 * `records`, which is the right answer on Explore and the wrong one under a
 * card titled Volume.
 */
function buildReport(p, source, defaults = {}) {
  const range = p.from && p.to ? { from: p.from, to: p.to } : (p.range ?? '7d');
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const interval = p.interval ?? defaults.interval;
  const measure = p.measure ?? defaults.measure;
  return {
    source,
    range,
    ...(interval ? { interval } : {}),
    ...(measure ? { measure } : {}),
    ...(list(p.groupBy).length ? { groupBy: list(p.groupBy) } : {}),
    ...(filtersFromParams(p).length ? { filters: filtersFromParams(p) } : {}),
    ...(list(p.excludeActors).length ? { excludeActorTypes: list(p.excludeActors) } : {}),
    ...(p.sort ? { sort: p.sort } : {}),
    ...(p.compare ? { compare: 'previous' } : {}),
    ...(list(p.stages).length ? { stages: list(p.stages) } : {}),
    ...(p.anchor ? { anchor: p.anchor } : {}),
    ...(list(p.exits).length ? { exits: list(p.exits) } : {}),
    ...(p.subjectType ? { subjectType: p.subjectType } : {}),
  };
}

export function Explore({ api, route, catalog }) {
  return <ExploreSurface api={api} catalog={catalog} route={route} page="explore" />;
}

/* ── the funnel picker (reports §7) ────────────────────────────────────────── */

/**
 * Stage order is inferred from DATA, not from the registry. One
 * `rollups({ as, subjectType, sort: 'firstAt' })` read per candidate family
 * gives its subjects' first arrivals in ascending order; the median of those
 * orders the stages, and a family nobody has reached sorts last.
 *
 * Registry order stays on offer beside it because it is what the host typed,
 * but it was never a claim about sequence. Sort-by-COUNT is deliberately not
 * offered at all: a funnel that reads as monotonic because its stages were
 * sorted by size hides exactly the anomaly worth seeing.
 *
 * The read is capped, and `sort: 'firstAt'` is ascending — so this is the median
 * of the EARLIEST subjects per family. Every family is sampled the same way, so
 * the relative order holds; the absolute dates are not the point.
 */
async function observedOrder(api, families, subjectType) {
  const mid = (sorted) =>
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const stats = await Promise.all(
    families.map(async (as) => {
      try {
        const res = await api.rollups({ as, subjectType, sort: 'firstAt', limit: 500 });
        const times = (res.rows ?? [])
          .map((r) => new Date(r.firstAt).getTime())
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
        return { as, median: times.length ? mid(times) : null };
      } catch {
        return { as, median: null };
      }
    }),
  );
  return stats
    .sort(
      (a, b) =>
        (a.median == null) - (b.median == null) ||
        (a.median ?? 0) - (b.median ?? 0) ||
        a.as.localeCompare(b.as),
    )
    .map((s) => s.as);
}

function FunnelControls({ api, catalog, report, apply }) {
  const types = funnelSubjectTypes(catalog);
  const subjectType = report.subjectType ?? types[0];
  const families = milestonesOf(catalog, subjectType);
  const stages = (report.stages ?? []).filter((s) => families.includes(s));
  const exits = (report.exits ?? []).filter((s) => families.includes(s) && !stages.includes(s));
  const [busy, setBusy] = React.useState(false);

  // the anchor is the first stage: the cohort is "subjects who reached step 1
  // in this window", which is the only reading that makes the later steps
  // conversions rather than totals
  const setStages = (next, patch = {}) =>
    apply({
      ...report,
      subjectType,
      stages: next,
      anchor: next[0],
      exits: exits.filter((e) => !next.includes(e)),
      ...patch,
    });

  const toggle = (as) =>
    setStages(stages.includes(as) ? stages.filter((s) => s !== as) : [...stages, as]);

  const move = (i, by) => {
    const next = [...stages];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setStages(next);
  };

  const order = async (kind) => {
    if (kind === 'registry') return setStages(families.filter((f) => stages.includes(f)));
    setBusy(true);
    const observed = await observedOrder(api, stages.length ? stages : families, subjectType);
    setBusy(false);
    setStages(observed.filter((as) => (stages.length ? stages.includes(as) : true)));
  };

  return (
    <div className="vstack" style={{ gap: 10 }}>
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <label className="hstack text-xs">
          <span className="subtle">subject type</span>
          <select
            className="select"
            value={subjectType ?? ''}
            onChange={(e) => {
              const t = e.target.value;
              apply({ ...report, subjectType: t, stages: milestonesOf(catalog, t), anchor: milestonesOf(catalog, t)[0], exits: undefined });
            }}
          >
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <div className="topbar-spacer" />
        <span className="subtle text-xs">order</span>
        <button className="btn btn-sm" onClick={() => order('registry')}>registry</button>
        <button className="btn btn-sm" onClick={() => order('observed')} disabled={busy}
                title="median first arrival per stage, read from the rollups">
          {busy ? 'reading…' : 'observed'}
        </button>
      </div>

      <div className="vstack" style={{ gap: 4 }}>
        {stages.map((as, i) => (
          <div key={as} className="hstack">
            <span className="tag">{i + 1}</span>
            <span className="grow mono text-xs">{as}</span>
            <button className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} title="earlier">↑</button>
            <button className="icon-btn" onClick={() => move(i, 1)} disabled={i === stages.length - 1} title="later">↓</button>
            <button className="icon-btn" onClick={() => toggle(as)} title="remove">✕</button>
          </div>
        ))}
        {!stages.length && <div className="subtle text-xs">no stages — pick at least one below</div>}
      </div>

      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <span className="subtle text-xs">stages</span>
        {families.map((as) => (
          <button key={as} className={`filter-chip ${stages.includes(as) ? 'active' : ''}`} onClick={() => toggle(as)}>
            {as}
          </button>
        ))}
      </div>
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <span className="subtle text-xs">exits</span>
        {families.filter((as) => !stages.includes(as)).map((as) => (
          <button
            key={as}
            className={`filter-chip ${exits.includes(as) ? 'active' : ''}`}
            onClick={() => apply({
              ...report,
              subjectType,
              exits: exits.includes(as) ? exits.filter((e) => e !== as) : [...exits, as],
            })}
          >
            {as}
          </button>
        ))}
        {families.length === stages.length && <span className="subtle text-xs">every family is a stage</span>}
      </div>
    </div>
  );
}

/* ── Overview ── */

/**
 * Five tiles, each a Report, each dropped when the resolver says this registry
 * cannot answer it. A missing precondition means NO tile rather than a wrong
 * one (dashboards §8) — an instance with no bucketed subject family genuinely
 * has no "active subjects" number, and inventing one from a raw scan would be a
 * different quantity wearing the same label.
 */
function overviewTiles(catalog, range, now) {
  const money = moneyMeasure(catalog);
  // the counting tiles ask for an INTERVAL they never draw. Without one the
  // resolver may answer them from a LIFETIME family — exactly, and with a
  // different number: "issues first seen in this window" is not "errors in this
  // window", and a tile labelled `in range` must be the second. An interval
  // rules those families out (they have no bucket) and leaves the ones that can
  // roll the window up correctly.
  const grain = intervalFor(range);
  const candidates = [
    ['Errors', { source: { kind: 'error' }, range, measure: 'count', interval: grain }],
    ['Events', { source: { kind: 'event' }, range, measure: 'count', interval: grain }],
    ['p95 span', { source: { kind: 'span' }, range, measure: 'p95:durationMs' }],
    // Sourced from the FAMILY, not the kind: `distinct:` needs a bucketed
    // by:['subject'] family whose feeders cover every source event, and an
    // activity family covers the two or three events a host chose — never a
    // whole kind. Naming the family as the source makes it cover itself. The
    // pick is by SHAPE (bucketed, single subject dim), never by name.
    ...Object.values(catalog.families)
      .filter((f) => f.bucket && f.by.length === 1 && f.by[0] === 'subject' && f.subjectTypes.length)
      .map((f) => [
        `Active ${f.subjectTypes[0]}`,
        { source: { family: f.as }, range, measure: `distinct:${f.subjectTypes[0]}` },
      ]),
    ...(money ? [['Spend', { source: { kind: 'usage' }, range, measure: money.key, interval: grain }]] : []),
  ];
  const out = [];
  let actives = 0;
  for (const [label, report] of candidates) {
    if (refusalOf(report, catalog, now)) continue;
    // one actives tile: the first subject type a bucketed family can count
    if (label.startsWith('Active ') && actives++) continue;
    out.push({ label, report });
  }
  return out;
}

function Tile({ api, catalog, now, label, report }) {
  const q = useReport(api, report);
  const scalar = q.data ? reportScalar(q.data) : null;
  return (
    <StatTile
      label={label}
      value={q.loading ? '…' : scalar?.value != null ? scalar.format(scalar.value) : '—'}
      meta={q.error ? 'unavailable' : scalar?.meta}
    />
  );
}

export function Overview({ api, route, catalog }) {
  const p = route.params;
  const range = p.range ?? '7d';
  const now = React.useMemo(() => new Date(), [range]);
  const tiles = React.useMemo(() => overviewTiles(catalog, range, now), [catalog, range, now]);
  const issueFamily = issueFamilyOf(catalog);
  const detail = useDetail();

  const q = useQuery(async () => {
    const [issues, recent] = await Promise.all([
      issueFamily ? api.rollups({ as: issueFamily, sort: 'lastAt', limit: 8 }) : null,
      api.records(filterParams(p, { limit: 12 })),
    ]);
    return { issues, recent };
  }, [JSON.stringify(p), issueFamily]);

  const chart = (kind) => ({ source: { kind }, range, measure: 'count', interval: intervalFor(range) });

  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: `repeat(${Math.max(tiles.length, 1)}, 1fr)` }}>
        {tiles.map((t) => <Tile key={t.label} api={api} catalog={catalog} now={now} {...t} />)}
      </div>
      <div className="split split-2">
        <ReportCard api={api} catalog={catalog} now={now} title="Events" report={chart('event')} />
        <ReportCard api={api} catalog={catalog} now={now} title="Errors" report={chart('error')} />
      </div>
      {q.loading && <Loading />}
      {q.error && <Failed error={q.error} />}
      {q.data?.issues && (
        <div className="card card-pad-0" style={{ marginTop: 16 }}>
          <div className="card-head"><span className="card-title">Recent issues</span></div>
          <div className="card-body">
            <IssueTable rows={q.data.issues.rows} onRow={() => navigate('errors', p)} />
          </div>
        </div>
      )}
      {q.data && (
        <div className="card card-pad-0" style={{ marginTop: 16 }}>
          <div className="card-head"><span className="card-title">Latest records</span></div>
          <div className="card-body"><RecordTable items={q.data.recent.items} onSelect={detail.open} /></div>
        </div>
      )}
      {detail.drawer}
    </>
  );
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
export function Errors({ api, route, catalog }) {
  const p = route.params;
  const range = p.range ?? '7d';
  const now = React.useMemo(() => new Date(), [range]);
  const detail = useDetail();
  const issueFamily = issueFamilyOf(catalog);
  const q = useQuery(async () => {
    const [issues, recent] = await Promise.all([
      issueFamily ? api.rollups({ as: issueFamily, sort: p.sort ?? 'lastAt', limit: 50 }) : null,
      api.records(filterParams(p, { kind: 'error', limit: 25 })),
    ]);
    return { issues, recent };
  }, [JSON.stringify(p), issueFamily]);

  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  return (
    <>
      <FilterBar api={api} route={route} catalog={catalog} source={{ kind: 'error' }} />
      <ReportCard
        api={api}
        catalog={catalog}
        now={now}
        title="Error volume"
        report={{ source: { kind: 'error' }, range, measure: 'count', interval: intervalFor(range) }}
      />
      {q.data.issues && (
        <div className="card card-pad-0">
          <div className="card-head">
            <span className="card-title">Issues</span>
            <span className="card-sub">first seen · last seen · exact counts (rollup, burst-proof)</span>
          </div>
          <div className="card-body">
            <TruncationNote result={q.data.issues} />
            <IssueTable rows={q.data.issues.rows} onRow={() => {}} />
          </div>
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

function TracesList({ api, route, catalog }) {
  const p = route.params;
  const range = p.range ?? '7d';
  const now = React.useMemo(() => new Date(), [range]);
  const detail = useDetail();
  const q = useQuery(() => api.records(filterParams(p, { kind: 'span', limit: 50 })), [JSON.stringify(p)]);
  if (q.loading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  return (
    <>
      <FilterBar api={api} route={route} catalog={catalog} source={{ kind: 'span' }} />
      <ReportCard
        api={api}
        catalog={catalog}
        now={now}
        title="Duration distribution"
        report={{ source: { kind: 'span' }, range, measure: 'p95:durationMs' }}
      />
      <div className="card card-pad-0">
        <div className="card-head"><span className="card-title">Recent spans</span><span className="card-sub">click a row → its whole trace</span></div>
        <div className="card-body">
          <RecordTable
            items={q.data.items}
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

/* ── Events: the explore surface, pre-sourced ── */
export function Events({ api, route, catalog }) {
  const p = route.params;
  const detail = useDetail();
  const q = useQuery(
    () => api.records(filterParams(p, { kind: p.name ? undefined : 'event', limit: 50 })),
    [JSON.stringify(p)],
  );
  return (
    <>
      <ExploreSurface
        api={api}
        catalog={catalog}
        route={route}
        page="events"
        // the topbar's name picker is the source here, so `source=` stays out of
        // the URL and the two controls cannot disagree about what is on screen
        fixedSource={p.name ? { event: p.name } : { kind: 'event' }}
        defaults={{ measure: 'count' }}
        title="Volume"
        sub="every control below comes from the catalog"
      />
      <div className="card card-pad-0">
        <div className="card-head"><span className="card-title">Records</span><span className="card-sub">newest first</span></div>
        <div className="card-body">
          {q.loading ? <Loading /> : q.error ? <Failed error={q.error} /> : (
            <RecordTable items={q.data.items} onSelect={detail.open} />
          )}
        </div>
      </div>
      {detail.drawer}
    </>
  );
}

/* ── Journeys: funnel picker + RollupExplorer + subject lookup ── */
export function Journeys(props) {
  return props.route.arg
    ? <JourneyView api={props.api} subjectRef={props.route.arg} route={props.route} />
    : <JourneysHome {...props} />;
}

function JourneysHome({ api, route, catalog }) {
  const p = route.params;
  const range = p.range ?? '30d';
  const now = React.useMemo(() => new Date(), [range]);
  const families = Object.keys(catalog.families);
  const fam = p.rollup ?? families[0];
  const [lookup, setLookup] = React.useState('');

  const types = funnelSubjectTypes(catalog);
  const subjectType = p.subjectType ?? types[0];
  const stages = String(p.stages ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const funnelReport = stages.length
    ? {
        source: { family: stages[0] },
        range,
        interval: p.interval ?? 'week',
        measure: 'funnel',
        stages,
        anchor: p.anchor ?? stages[0],
        ...(String(p.exits ?? '') ? { exits: String(p.exits).split(',').filter(Boolean) } : {}),
        ...(subjectType ? { subjectType } : {}),
      }
    : null;

  /**
   * With no funnel in the URL, the default is every milestone family of the
   * first subject type in OBSERVED order — and it is written to the URL rather
   * than held in state, because a funnel nobody can link to is not a view
   * (dashboards law 6). Once, per mount: `seeded` keeps a re-render from
   * re-reading the rollups behind the reader's back.
   */
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || stages.length || !subjectType) return;
    const all = milestonesOf(catalog, subjectType);
    if (all.length < 2) return;
    seeded.current = true;
    observedOrder(api, all, subjectType).then((order) => {
      navigate('journeys', {
        ...p,
        ...reportToQuery({
          source: { family: order[0] }, range, interval: 'week', measure: 'funnel',
          stages: order, anchor: order[0], subjectType,
        }),
      });
    }, () => {});
  }, [api, catalog, subjectType, stages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (next) => {
    const rest = { ...p };
    for (const k of REPORT_PARAMS) delete rest[k];
    navigate('journeys', { ...rest, ...reportToQuery(next) });
  };

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

      {types.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="card-title">Cohort funnel</span>
            <span className="card-sub">stages are lifetime milestone families — the picker is the Report</span>
          </div>
          <div className="card-body">
            <FunnelControls
              api={api}
              catalog={catalog}
              report={funnelReport ?? { source: { family: milestonesOf(catalog, subjectType)[0] }, range, measure: 'funnel', subjectType }}
              apply={apply}
            />
          </div>
        </div>
      )}
      {funnelReport && (
        <ReportCard
          api={api}
          catalog={catalog}
          now={now}
          title={`Funnel · ${subjectType}`}
          sub={`anchored on ${funnelReport.anchor}`}
          report={funnelReport}
        />
      )}

      {fam && <RollupExplorer api={api} route={route} family={fam} families={families} />}
    </>
  );
}

/* RollupExplorer — free dashboards (§7): families are self-describing */
function RollupExplorer({ api, route, family, families }) {
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
        <TruncationNote result={q.data} />
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
      </div>
    </div>
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
export function Usage({ api, route, catalog }) {
  const p = route.params;
  const range = p.range ?? '30d';
  const now = React.useMemo(() => new Date(), [range]);
  const detail = useDetail();
  const money = moneyMeasure(catalog);
  const meterDim = kindDim(catalog, 'usage', '.meter');
  const billedDim = kindDim(catalog, 'usage', '.billedTo');
  const usageNames = sourceEvents(catalog, { kind: 'usage' });

  const q = useQuery(async () => {
    const [meters, recent] = await Promise.all([
      meterDim
        ? api.values({ dim: meterDim.key, names: usageNames.join(','), ...rangeToDates(range) })
        : Promise.resolve({ values: [], source: 'none' }),
      api.records(filterParams(p, { kind: 'usage', limit: 50 })),
    ]);
    return { meters, recent };
  }, [JSON.stringify(p), meterDim?.key]);

  if (!usageNames.length) {
    return <div className="empty"><h3>No usage events</h3>Nothing in this registry declares `kind: 'usage'`.</div>;
  }

  const meterFilter = filtersFromParams(p).find((f) => f.dim === meterDim?.key);
  const base = {
    source: { kind: 'usage' },
    range,
    ...(money ? { measure: money.key } : { measure: 'count' }),
    ...(filtersFromParams(p).length ? { filters: filtersFromParams(p) } : {}),
  };

  return (
    <>
      {q.loading && <Loading />}
      {q.error && <Failed error={q.error} />}
      {q.data && (
        <>
          {/* the meters this instance actually bills, straight off /values — the
              page never learns their names, it asks for them */}
          <div className="filter-bar">
            <span className="subtle text-xs">meters</span>
            {q.data.meters.values.map((m, i) => (
              <button
                key={m}
                className={`filter-chip ${meterFilter?.value === m ? 'active' : ''}`}
                onClick={() => {
                  const rest = filtersFromParams(p).filter((f) => f.dim !== meterDim.key);
                  const next = meterFilter?.value === m ? rest : [...rest, { dim: meterDim.key, op: 'eq', value: m }];
                  navigate('usage', {
                    ...p,
                    filter: next.map((f) => `${f.dim}:${f.op}:${f.value}`),
                  });
                }}
              >
                {m}{q.data.meters.counts ? ` · ${fmtNumber(q.data.meters.counts[i])}` : ''}
              </button>
            ))}
            {!q.data.meters.values.length && <span className="subtle text-xs">none recorded in range</span>}
            <span className="tag">{q.data.meters.source}</span>
          </div>

          <ReportCard
            api={api}
            catalog={catalog}
            now={now}
            title={money ? 'Spend by meter' : 'Usage by meter'}
            sub={money ? money.key : 'count — no `*_usd` metric is declared'}
            report={{ ...base, ...(meterDim ? { groupBy: [meterDim.key] } : {}), interval: intervalFor(range) }}
          />

          {billedDim && (
            <ReportCard
              api={api}
              catalog={catalog}
              now={now}
              title="By billed-to"
              report={{ ...base, groupBy: [billedDim.key] }}
            />
          )}

          <div className="card card-pad-0">
            <div className="card-head"><span className="card-title">Rows</span><span className="card-sub">reversals render linked</span></div>
            <div className="card-body"><RecordTable items={q.data.recent.items} onSelect={detail.open} /></div>
          </div>
        </>
      )}
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
  const { counters, quarantine, indexCount, indexBudget, keys, role, suggestions } = q.data;
  const link = (k) => counters[k] ?? 0;
  // Only a host that configured a `subjectLinker` has any of these, so the row
  // appears when linking has actually happened rather than sitting at six
  // permanent zeros for everyone else. For a host that did configure one, the
  // five failure counters are the whole difference between "nothing links" and
  // "the link is broken and every desktop row is landing anonymous".
  const linking =
    link('subjectsLinked') + link('subjectLinkMisses') + link('subjectLinkErrors') +
    link('subjectLinkTimeouts') + link('subjectLinkUndeclared') + link('subjectLinkCapped');
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

      {linking > 0 && (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
          <StatTile label="linked" value={fmtNumber(link('subjectsLinked'))} meta="subjects added on write" />
          <StatTile label="link misses" value={fmtNumber(link('subjectLinkMisses'))} meta="host knew of no link" />
          <StatTile label="link errors" value={fmtNumber(link('subjectLinkErrors'))} meta="threw or answered garbage" />
          <StatTile label="link timeouts" value={fmtNumber(link('subjectLinkTimeouts'))} meta="written unlinked" />
          <StatTile label="link undeclared" value={fmtNumber(link('subjectLinkUndeclared'))} meta="type not in the registry" />
          <StatTile label="link capped" value={fmtNumber(link('subjectLinkCapped'))} meta="over the subject cap" />
        </div>
      )}

      {/* the loop closed the other way: what the DATA says the registry is
          missing, each with the line that would fix it (reports §9) */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Suggestions</span>
          <span className="card-sub">the registry change each one needs — nothing here is applied for you</span>
        </div>
        <div className="card-body"><SuggestionList suggestions={suggestions} /></div>
      </div>

      <div className="split split-2">
        <CounterMap
          title="Rollups skipped"
          sub="a dim was missing, so no aggregate was written"
          map={counters.rollupSkippedBy}
          columns={['family', 'dim']}
        />
        <CounterMap
          title="Undeclared attrs"
          sub="sent, not declared — the key was stripped and the record kept"
          map={counters.undeclaredAttrs}
          columns={['event', 'attr']}
        />
        <CounterMap
          title="Dropped attrs"
          sub="removed so the record could be written — undeclared, or a value outside the schema"
          map={counters.attrsDropped}
          columns={['event', 'attr']}
        />
        <CounterMap
          title="Dropped metrics"
          sub="same, for metrics — a non-zero row here is the registry drifting behind a client"
          map={counters.metricsDropped}
          columns={['event', 'metric']}
        />
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

/**
 * An attributed counter map. Both are keyed `${target}|${key}` and both are
 * bounded, folding into `(other)|(other)` past the cap — so the split is on the
 * FIRST '|' and the overflow row renders like any other.
 */
function CounterMap({ title, sub, map, columns }) {
  const rows = Object.entries(map ?? {})
    .map(([k, count]) => {
      const i = k.indexOf('|');
      return { id: k, a: i === -1 ? k : k.slice(0, i), b: i === -1 ? '' : k.slice(i + 1), count };
    })
    .sort((x, y) => y.count - x.count);
  return (
    <div className="card card-pad-0">
      <div className="card-head"><span className="card-title">{title}</span><span className="card-sub">{sub}</span></div>
      <div className="card-body">
        <BreakdownTable
          rows={rows}
          columns={[
            { key: 'a', label: columns[0], mono: true },
            { key: 'b', label: columns[1], mono: true },
            { key: 'count', num: true },
          ]}
          empty="Nothing skipped"
        />
      </div>
    </div>
  );
}
