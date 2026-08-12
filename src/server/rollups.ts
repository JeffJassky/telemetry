import { Schema, type Connection, type Model } from 'mongoose';
import type { DimSource, Registry, RollupSpec } from './registry.js';
import type { TelemetryCounters } from './types.js';

/**
 * One derived-aggregate primitive (schema §4.5). Group a stream of records by
 * a declared tuple and keep first / last / count / sums. The registry declares
 * the tuple; this file is agnostic — the same operation is a milestone, an
 * issue group, windowed spend, and an activity/retention stream.
 */

export function buildRollupModel(connection: Connection, modelName: string, collection: string): Model<any> {
  const existing = connection.models?.[modelName];
  if (existing) return existing;

  const schema = new Schema(
    {
      /** `${tenantId}|${as}|${dims.join('|')}|${bucketKey}` — deterministic, upsert-safe */
      _id: { type: String, required: true },
      tenantId: { type: String, required: true },
      /** rollup family. Several event names may feed one. */
      as: { type: String, required: true },
      /**
       * Dimension values in spec order. Subject dims keep their native
       * `type:id` form ('user:u_1') so erasure can match them directly;
       * everything else is `key=value`. Flattened strings for the same reason
       * subjectKeys is — never compound-index two fields of one subdoc array.
       */
      dims: { type: [String], required: true },
      /** denormalized prefix of the subject dim, when there is one — §5.4 hazard */
      subjectType: String,
      /** UTC-truncated bucket start; absent on lifetime rollups */
      bucketAt: Date,

      firstAt: { type: Date, required: true },
      lastAt: { type: Date, required: true },
      count: { type: Number, required: true, default: 0 },
      /** registry `sum` keys accumulated across every contributing record */
      sums: { type: Map, of: Number, default: {} },
      /** registry `capture` snapshot at FIRST occurrence — cohort dimensions */
      firstCapture: { type: Map, of: String, default: {} },
      firstTraceId: String,
      expiresAt: Date,
    },
    { collection, versionKey: false },
  );

  // cohort scan within one family, ordered by first occurrence
  schema.index({ tenantId: 1, as: 1, subjectType: 1, firstAt: 1 });
  // slice a family by dimension value, newest bucket first
  schema.index({ tenantId: 1, as: 1, dims: 1, bucketAt: -1 });
  // erasure + per-subject journey across ALL families — no `as` prefix on purpose
  schema.index({ tenantId: 1, dims: 1 });
  schema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } },
  );

  return connection.model(modelName, schema);
}

// ── dimension resolution ────────────────────────────────────────────────────

const path = (o: any, p: string): unknown =>
  typeof o?.get === 'function' ? o.get(p) : p.split('.').reduce((a: any, k) => a?.[k], o);

/** `subject` is handled by fan-out, so it resolves to undefined here.
 *  Exported: emit()'s burst cap keys on the same sources. */
export const resolveDim = (src: DimSource, doc: any): unknown =>
  src.startsWith('attr:') ? doc.attrs?.get(src.slice(5))
  : src.startsWith('field:') ? path(doc, src.slice(6))
  : undefined;

const label = (src: DimSource) => src.slice(src.indexOf(':') + 1);

/** UTC. Weeks start Monday. */
export const truncate = (d: Date, b?: RollupSpec['bucket']): Date | undefined => {
  if (!b) return undefined;
  if (b === 'hour') return new Date(Math.floor(d.getTime() / 36e5) * 36e5);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (b === 'month') return new Date(Date.UTC(y, m, 1));
  const day = new Date(Date.UTC(y, m, d.getUTCDate()));
  if (b === 'day') return day;
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 864e5);
};

/**
 * Update-pipeline upsert so late/backfilled events correct EVERYTHING, not
 * just the boundaries. `$setOnInsert` for firstCapture/firstTraceId would pin
 * the cohort dimensions to whichever record LANDED first rather than whichever
 * OCCURRED first — silently wrong for offline clients, backfills, and retries.
 */
export async function recordRollup(
  RollupModel: Model<any>,
  doc: any,
  name: string,
  spec: RollupSpec,
  counters: TelemetryCounters,
): Promise<void> {
  // aggregate-plane actor gate: admin support browsing must never move a
  // customer aggregate; the raw row is untouched (RollupSpec.actors)
  if (spec.actors && doc.actor) {
    const actorType = String(doc.actor).split(':')[0];
    if (!spec.actors.includes(actorType)) return;
  }

  const as = spec.as ?? name;
  const at: Date = doc.occurredAt;
  const bucketAt = truncate(at, spec.bucket);
  const bucketKey = bucketAt ? bucketAt.toISOString() : '';

  // Non-subject dims resolved once. Absent a declared fallback, a missing dim
  // means the record cannot be keyed at all — an implicit 'null' bucket would
  // silently corrupt every group. `dimDefault` makes that bucket EXPLICIT: the
  // host names it, so "no value" is a group you can query rather than a drop
  // you have to notice in a counter.
  const fixed = new Map<DimSource, string>();
  for (const src of spec.by) {
    if (src === 'subject') continue;
    let v = resolveDim(src, doc);
    if (v == null || v === '') {
      if (spec.dimDefault === undefined) {
        counters.rollupSkipped++;
        return;
      }
      v = spec.dimDefault;
    }
    fixed.set(src, `${label(src)}=${String(v)}`);
  }

  // At most one `subject` dim per spec (asserted in validateRegistry).
  // dimDefault deliberately does NOT apply here: a non-subject dim that is
  // missing is a record we can still attribute to someone, while a record with
  // no matching subject cannot be attributed at all. Bucketing it under a
  // placeholder subject would invent a party that does not exist — and erasure
  // matches subject dims by their native `type:id` form, so the placeholder
  // would be unreachable by forget().
  const fansOut = spec.by.includes('subject');
  const refs: (string | null)[] = fansOut
    ? (doc.subjectKeys ?? []).filter(
        (r: string) => !spec.subjects || spec.subjects.includes(r.split(':')[0]!),
      )
    : [null];
  if (!refs.length) return;

  const firstCapture = Object.fromEntries(
    (spec.capture ?? [])
      .map((src) => [label(src), resolveDim(src, doc)] as const)
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k, String(v)]),
  );

  const expiresAt =
    spec.retentionDays != null ? new Date(at.getTime() + spec.retentionDays * 864e5) : undefined;

  await RollupModel.bulkWrite(
    refs.map((ref) => {
      const dims = spec.by.map((src) => (src === 'subject' ? ref! : fixed.get(src)!));
      /** true when this record becomes the new earliest occurrence */
      const isNewFirst = {
        $or: [{ $eq: [{ $type: '$firstAt' }, 'missing'] }, { $lt: [at, '$firstAt'] }],
      };
      const sums = Object.fromEntries(
        (spec.sum ?? [])
          .map((k) => [k, doc.metrics?.get(k)] as const)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => [`sums.${k}`, { $add: [{ $ifNull: [`$sums.${k}`, 0] }, v] }]),
      );
      return {
        updateOne: {
          filter: { _id: `${doc.tenantId}|${as}|${dims.join('|')}|${bucketKey}` },
          update: [
            {
              $set: {
                tenantId: doc.tenantId,
                as,
                dims,
                ...(ref ? { subjectType: ref.split(':')[0] } : {}),
                ...(bucketAt ? { bucketAt } : {}),
                ...(expiresAt ? { expiresAt } : {}),
                // aggregation $min/$max ignore missing, so correct on insert too
                firstAt: { $min: ['$firstAt', at] },
                lastAt: { $max: ['$lastAt', at] },
                count: { $add: [{ $ifNull: ['$count', 0] }, 1] },
                ...sums,
                firstTraceId: { $cond: [isNewFirst, doc.traceId ?? null, '$firstTraceId'] },
                firstCapture: { $cond: [isNewFirst, { $literal: firstCapture }, '$firstCapture'] },
              },
            },
          ],
          upsert: true,
        },
      };
    }),
    { ordered: false },
  );
}
