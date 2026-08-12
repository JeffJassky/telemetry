import { createHash } from 'node:crypto';
import type { Collection, Model } from 'mongoose';
import {
  TelemetryKind, PLATFORM_SCOPE, RESERVED_TENANT_MESSAGE, isPlatformScope, type EntityRef,
} from './types.js';

/**
 * Erasure, actually implemented (schema §4.7). Covers subjects, actor,
 * onBehalfOf, and client — every place an id can appear, because `data` is
 * registry-declared-or-unstored.
 *
 * DELETE only when the ref is the sole party on the row. Any row with
 * surviving subjects is REDACTED instead: forgetting a user must not destroy
 * the org's business record. Usage rows are always redacted (statutory
 * retention).
 */

export interface ForgetCtx {
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  rejects: () => Collection;
  aliases: () => Collection;
  views: () => Collection;
  pepper: () => string;
  /**
   * The host asserting that a subject ref names the same party in every tenant.
   * The package cannot verify it, so it is declared rather than detected — and
   * it is what lets step 6 reach platform-scoped saved views. See the comment
   * there for why the default has to be off.
   */
  globalSubjectRefs: () => boolean;
}

export interface ForgetResult {
  deleted: number;
  redacted: number;
  rollups: number;
  aliases: number;
  views: number;
}

export function createForget(ctx: ForgetCtx) {
  /** keeps the `type:` prefix so subjectKeys stays re-derivable on any later save */
  const pseudoId = (ref: string) =>
    'redacted_' + createHash('sha256').update(ref + ctx.pepper()).digest('hex').slice(0, 16);

  return async function forget(tenantId: string, ref: EntityRef): Promise<ForgetResult> {
    const { TelemetryModel, RollupModel } = ctx;
    // No '*' here, and deliberately NOT as "erase across every tenant": erasure
    // deletes and rewrites rows, so a scope that matched everything would make
    // one typo unbounded. A platform-wide erasure is N tenant-scoped calls, and
    // the caller has to name each one. Throws — forget() is always awaited.
    if (isPlatformScope(tenantId)) throw new Error(RESERVED_TENANT_MESSAGE);
    const [type, rawId] = ref.split(':') as [string, string];
    if (!type || !rawId) throw new Error(`telemetry: forget ref "${ref}" is not "type:id"`);
    const newId = pseudoId(ref);
    const newRef = `${type}:${newId}`;

    const match = { tenantId, $or: [{ subjectKeys: ref }, { otherPrincipals: ref }] };

    // 1. sole-party, non-financial rows: delete outright
    const del = await TelemetryModel.deleteMany({
      ...match,
      kind: { $ne: TelemetryKind.Usage },
      subjectKeys: { $eq: ref, $size: 1 }, // ref is the ONLY subject
      otherPrincipals: { $in: [[], null] },
    });

    // 2. everything else: keep the row, destroy the linkage.
    // Driver-level updateMany: mongoose 9 gates pipeline updates behind an
    // option that mongoose 7/8 don't know — the driver accepts them everywhere.
    const red = await TelemetryModel.collection.updateMany(match, [
      {
        $set: {
          subjects: {
            $map: {
              input: '$subjects',
              as: 's',
              in: {
                $cond: [
                  { $eq: [{ $concat: ['$$s.type', ':', '$$s.id'] }, ref] },
                  { $mergeObjects: ['$$s', { id: newId }] },
                  '$$s',
                ],
              },
            },
          },
          subjectKeys: {
            $map: {
              input: '$subjectKeys',
              as: 'k',
              in: { $cond: [{ $eq: ['$$k', ref] }, newRef, '$$k'] },
            },
          },
          otherPrincipals: {
            $map: {
              input: { $ifNull: ['$otherPrincipals', []] },
              as: 'k',
              in: { $cond: [{ $eq: ['$$k', ref] }, newRef, '$$k'] },
            },
          },
          actor: { $cond: [{ $eq: ['$actor', ref] }, newRef, '$actor'] },
          onBehalfOf: { $cond: [{ $eq: ['$onBehalfOf', ref] }, newRef, '$onBehalfOf'] },
          client: '$$REMOVE',
          redactedAt: '$$NOW',
        },
      },
    ]);

    // 3. derived rollups — REKEY, never delete. Deleting a person's rollups
    //    retroactively shrinks every cohort they were counted in, so funnel
    //    denominators change under you. Aggregates survive; the person does
    //    not. _id is immutable in Mongo, so insert-then-delete rather than $set.
    //
    //    Only rollups carrying the ref as a DIMENSION are touched. A rollup
    //    grouped on something else — an issue keyed on error.fingerprint —
    //    never held the id, which is exactly why non-subject rollups are safe
    //    to keep forever.
    const rolls = await RollupModel.find({ tenantId, dims: ref }).lean();
    let rollups = 0;
    if (rolls.length) {
      await RollupModel.bulkWrite(
        (rolls as any[]).map((r) => {
          const dims = r.dims.map((d: string) => (d === ref ? newRef : d));
          const bucketKey = r.bucketAt ? new Date(r.bucketAt).toISOString() : '';
          return {
            insertOne: {
              document: { ...r, _id: `${tenantId}|${r.as}|${dims.join('|')}|${bucketKey}`, dims },
            },
          };
        }),
        { ordered: false },
      ).catch((e: any) => {
        // re-running forget() for the same ref collides on _id — already erased, no-op
        const errs = e?.writeErrors ?? [];
        if (e?.code !== 11000 && !(errs.length && errs.every((w: any) => w.code === 11000))) throw e;
      });
      rollups = (await RollupModel.deleteMany({ tenantId, dims: ref })).deletedCount;
    }

    // 4. quarantine holds raw payloads — in scope for erasure too
    await ctx.rejects().deleteMany({
      'raw.tenantId': tenantId,
      $or: [
        { 'raw.subjects': { $elemMatch: { type, id: rawId } } },
        { 'raw.actor': ref },
        { 'raw.onBehalfOf': ref },
      ],
    });

    // 5. aliases are pure linkage — anon→user. Either side matching is enough;
    //    there is nothing to redact, only to delete.
    const aliases = (
      await ctx.aliases().deleteMany({ tenantId, $or: [{ anonRef: ref }, { userRef: ref }] })
    ).deletedCount;

    // 6. saved dashboard views: ownerRef is a person. Private views die with
    //    them; shared ones stay useful to the tenant, so only the owner link
    //    is redacted (dashboards §3 — same delete-vs-redact rule as rows).
    //
    //    A person who used the cross-tenant dashboard owns views stored under
    //    PLATFORM_SCOPE, which is not a tenant — so a tenant-scoped forget()
    //    misses them and erasure is incomplete. Reaching them is only SAFE when
    //    a ref names one party globally; if ids are per-tenant, 'user:u_1' is a
    //    different person in each and one tenant's erasure would delete
    //    another's views. The package cannot tell which world it is in, so the
    //    host declares it and the default is the conservative one.
    //
    //    Note the asymmetry with the guard at the top: that refuses '*' as the
    //    ERASURE SCOPE (unbounded rewrite of every tenant's rows). This reaches
    //    '*' rows owned by one named person. Bounded by the ref, not the tenant.
    const viewScope = ctx.globalSubjectRefs()
      ? { $in: [tenantId, PLATFORM_SCOPE] }
      : tenantId;
    const views =
      (await ctx.views().deleteMany({ tenantId: viewScope, ownerRef: ref, shared: { $ne: true } })).deletedCount +
      (await ctx.views().updateMany(
        { tenantId: viewScope, ownerRef: ref, shared: true },
        { $set: { ownerRef: newRef } },
      )).modifiedCount;

    return { deleted: del.deletedCount ?? 0, redacted: red.modifiedCount ?? 0, rollups, aliases, views };
  };
}
