import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import { TelemetryKind, RESERVED_TENANT_MESSAGE, isPlatformScope, plain } from './types.js';
import { KeyKind, TenantMode, parseKeyString, verifySecret } from './keys.js';
import { recordRollup } from './rollups.js';
import type { Telemetry } from './index.js';

/**
 * The wire ingest surface (instrumentation §3–4). One endpoint, batch-only.
 *
 * Trust in one line: a claim is not a fact. The handler's job is converting
 * key-derived facts and payload claims into one honest envelope — a browser
 * record claiming tenantId is not an attack to reject, it is a field to ignore.
 *
 * Error surface splits on key kind (traps §19): `pk_` NEVER 4xxes — telemetry
 * errors surfacing in browser consoles read as a broken page — so unknown
 * names, oversize, rate limits, revoked keys all drop, quarantine what's
 * parseable, count, and answer 202. `sk_` callers are programmers and get
 * honest 400/401/413/429.
 *
 * Delivery is at-least-once, so the plane order INVERTS from emit():
 * insert first (client-generated `_id`; duplicate ⇒ drop, NO rollup), then
 * aggregate. The plane order follows the delivery semantics (schema §4.6).
 */

export interface IngestContext {
  tenantId: string;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  actor?: string;
}

export interface ContextAdapter {
  /** INBOUND: who is making this request? Only consulted for tenantMode=session. */
  resolveContext(req: Request): IngestContext | null | Promise<IngestContext | null>;
}

export interface CreateIngestOptions {
  telemetry: Telemetry;
  contextAdapter?: ContextAdapter;
  /** batch caps — the defaults are the wire contract */
  maxRecords?: number;
  bodyLimit?: string;
  /** key cache TTL ms (60s). Tests turn it down. */
  keyCacheMs?: number;
}

const BATCH_MAX = 100;

interface CachedKey {
  doc: any | null;
  at: number;
}

export function createIngest(opts: CreateIngestOptions): Router {
  const { telemetry: t, contextAdapter, maxRecords = BATCH_MAX, bodyLimit = '512kb', keyCacheMs = 60_000 } = opts;
  const KeyModel = t.models.keys;
  const registry = t.registry;
  const logger = t.logger;

  const keyCache = new Map<string, CachedKey>();
  const buckets = new Map<string, { n: number; resetAt: number }>();

  const takeRecords = (keyId: string, maxPerMinute: number, n: number): number => {
    const now = Date.now();
    let b = buckets.get(keyId);
    if (!b || now >= b.resetAt) {
      b = { n: 0, resetAt: now + 60_000 };
      buckets.set(keyId, b);
    }
    const room = Math.max(0, maxPerMinute - b.n);
    const taken = Math.min(room, n);
    b.n += taken;
    return taken;
  };

  const loadKey = async (id: string): Promise<any | null> => {
    const hit = keyCache.get(id);
    if (hit && Date.now() - hit.at < keyCacheMs) return hit.doc;
    const doc = await KeyModel.findById(id).lean();
    keyCache.set(id, { doc: doc ?? null, at: Date.now() }); // negative-cache junk ids too
    return doc ?? null;
  };

  const quarantine = (name: string, reason: string, raw: unknown) => {
    t.counters.rejected++;
    void t.collections.rejects()
      .insertOne({ at: new Date(), name, reason, raw: plain(raw) })
      .catch(() => {});
  };

  const router = express.Router();

  // Preflight cannot be key-scoped (the browser has not sent Authorization
  // yet) — reflect the origin and let the POST enforce the per-key allowlist.
  router.options('/', (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.status(204).end();
  });

  // Auth resolves BEFORE the body parser so the error middleware knows which
  // error surface (pk drop / sk honest) applies to parse failures.
  router.post(
    '/',
    async (req: Request & { telemetryKey?: any }, res, next) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      // sendBeacon cannot set headers — pk_ may ride the query string. sk_ may not.
      const fromQuery = typeof req.query.key === 'string' ? req.query.key : undefined;
      const parsed = parseKeyString(bearer) ?? (fromQuery?.startsWith('pk_') ? parseKeyString(fromQuery) : null);

      const drop = () => res.status(202).json({ accepted: 0, rejected: 0 });

      if (!parsed) {
        // no attributable caller: an sk_-shaped credential gets honesty, all
        // else is noise — 202 and gone
        if (bearer?.startsWith('sk_') || fromQuery?.startsWith('sk_')) {
          return res.status(401).json({ error: 'invalid_key' });
        }
        return drop();
      }

      const doc = await loadKey(parsed.id);
      const skFail = (status: number, error: string) => res.status(status).json({ error });
      if (!doc || doc.revokedAt) {
        return parsed.kind === KeyKind.Secret ? skFail(401, doc ? 'revoked_key' : 'invalid_key') : drop();
      }
      if (doc.kind !== parsed.kind) {
        return parsed.kind === KeyKind.Secret ? skFail(401, 'invalid_key') : drop();
      }
      if (parsed.kind === KeyKind.Secret && !verifySecret(parsed.secret!, doc.secretHash)) {
        return skFail(401, 'invalid_key');
      }

      // browser origin allowlist — pk_ only; no ACAO header means the browser
      // never lets the page read the response, and we drop the write too
      const origin = req.headers.origin;
      if (parsed.kind === KeyKind.Publishable && origin) {
        if (!doc.origins?.includes(origin)) return drop();
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }

      if (!doc.lastUsedAt || Date.now() - new Date(doc.lastUsedAt).getTime() > 60_000) {
        doc.lastUsedAt = new Date();
        void KeyModel.updateOne({ _id: doc._id }, { $set: { lastUsedAt: doc.lastUsedAt } }).catch(() => {});
      }

      req.telemetryKey = doc;
      next();
    },
    express.json({ limit: bodyLimit }),
    async (req: Request & { telemetryKey?: any }, res) => {
      const key = req.telemetryKey!;
      const pk = key.kind === KeyKind.Publishable;
      const receivedAt = new Date();
      const body = (req.body ?? {}) as Record<string, any>;

      let accepted = 0;
      let rejected = 0;
      const respond = () => res.status(202).json({ accepted, rejected });

      let records: any[] = Array.isArray(body.records) ? body.records : [];
      if (records.length > maxRecords) {
        if (!pk) return res.status(413).json({ error: 'batch_too_large', max: maxRecords });
        rejected += records.length - maxRecords;
        records = records.slice(0, maxRecords);
      }

      // per-key rate limit, counted in records — pk drops the overflow, sk is told
      const granted = takeRecords(key._id, key.maxPerMinute, records.length);
      if (granted < records.length) {
        if (!pk) return res.status(429).json({ error: 'rate_limited' });
        t.counters.capped += records.length - granted;
        rejected += records.length - granted;
        records = records.slice(0, granted);
      }

      // ── tenant resolution: the key's, the host's, or the payload's. No fourth path. ──
      let ctx: IngestContext | null = null;
      if (key.tenantMode === TenantMode.Fixed) {
        ctx = { tenantId: key.tenantId };
      } else if (key.tenantMode === TenantMode.Session) {
        if (!contextAdapter) {
          logger.warn('[telemetry] session-mode key but no contextAdapter configured');
          return pk ? respond() : res.status(500).json({ error: 'no_context_adapter' });
        }
        ctx = await contextAdapter.resolveContext(req);
        if (!ctx) {
          // pk: an unauthenticated browser is normal traffic, not an error
          rejected += records.length;
          return pk ? respond() : res.status(401).json({ error: 'no_session' });
        }
      } else {
        // claimed — sk_ only, asserted at key creation
        const claimed = body.context?.tenantId;
        if (typeof claimed !== 'string' || !claimed) {
          return res.status(400).json({ error: 'tenant_required' });
        }
        ctx = { tenantId: claimed };
      }
      const tenantId = ctx.tenantId;

      // ── the reserved token, checked ONCE, after resolution ──
      // Deliberately here and not in the `claimed` branch: all three paths mint
      // a tenantId from outside the package. `claimed` is the payload asserting
      // one, `session` is a host adapter that could compute one, and `fixed`
      // reads a key doc that may predate createKey()'s guard. A claim is not a
      // fact — and '*' is not even a tenant. pk_ never 4xxes (traps §19), so it
      // drops and counts; sk_ callers are programmers and are told why.
      if (isPlatformScope(tenantId)) {
        logger.warn(`[telemetry] ingest refused a batch: ${RESERVED_TENANT_MESSAGE}`);
        t.counters.rejected += records.length;
        rejected += records.length;
        return pk ? respond() : res.status(400).json({ error: 'reserved_tenant' });
      }

      // server computes the skew; client timestamps lie (schema §9 fix)
      const sentAt = body.sentAt ? Date.parse(body.sentAt) : NaN;
      const clockSkewMs = Number.isFinite(sentAt) ? sentAt - receivedAt.getTime() : 0;

      // defaults merge UNDER the claim — a batch that omits context details is
      // normal traffic, and platform/appVersion are envelope-required
      const batchClient = {
        platform: 'web',
        appVersion: String(body.release ?? 'unknown'),
        ...(body.client && typeof body.client === 'object' ? body.client : {}),
        clockSkewMs,
      };

      const subjectsOf = (raw: unknown): Array<{ type: string; id: string; role?: string }> =>
        Array.isArray(raw)
          ? raw
              .filter((s: any) => s && typeof s.type === 'string' && typeof s.id === 'string')
              .map((s: any) => ({ type: s.type, id: String(s.id), ...(s.role ? { role: String(s.role) } : {}) }))
          : [];

      // merge order, lowest to highest: batch claims < record subjects < host
      // context — the session cookie outranks the JS claim (instrumentation §4)
      const claimSubjects = subjectsOf(body.context?.subjects);
      const hostSubjects = subjectsOf(ctx.subjects);
      const mergeSubjects = (recordSubjects: unknown) => {
        const byType = new Map<string, Array<{ type: string; id: string; role?: string }>>();
        for (const layer of [claimSubjects, subjectsOf(recordSubjects), hostSubjects]) {
          const grouped = new Map<string, Array<{ type: string; id: string; role?: string }>>();
          for (const s of layer) {
            grouped.set(s.type, [...(grouped.get(s.type) ?? []), s]);
          }
          for (const [type, entries] of grouped) byType.set(type, entries);
        }
        return [...byType.values()].flat();
      };
      const batchActor = typeof body.context?.actor === 'string' ? body.context.actor : undefined;

      for (const rec of records) {
        const name = typeof rec?.name === 'string' ? rec.name : '';
        const fail = (reason: string) => {
          rejected++;
          quarantine(name || '(unnamed)', reason, rec);
        };

        // ── the identify control record: pure linkage, never stored as telemetry ──
        if (name === '$identify') {
          const anonRef = String(rec.anonRef ?? '');
          const userRef = String(rec.userRef ?? '');
          if (!/^.+:.+$/.test(anonRef) || !/^.+:.+$/.test(userRef)) {
            fail('malformed $identify');
            continue;
          }
          await t.collections.aliases().updateOne(
            { _id: `${tenantId}|${anonRef}` } as any,
            { $set: { tenantId, anonRef, userRef, linkedAt: receivedAt } },
            { upsert: true },
          );
          accepted++;
          continue;
        }

        const spec = registry[name];
        if (!spec) {
          fail('unregistered event');
          continue;
        }
        if (!key.allowedKinds.includes(spec.kind)) {
          fail(`kind ${spec.kind} not allowed for this key`);
          continue;
        }
        if (spec.origin === 'server' && pk) {
          // the CLIENT_MILESTONES guarantee: a browser may assert
          // wizard_started, never converted — server-origin names need sk_
          fail('server-origin name over a publishable key');
          continue;
        }
        if (key.allowedNames?.length && !key.allowedNames.includes(name)) {
          fail('name not allowed for this key');
          continue;
        }
        const id = typeof rec._id === 'string' && rec._id.length >= 16 && rec._id.length <= 64 ? rec._id : null;
        if (!id) {
          // without a client id there is no idempotency — the §3 contract
          fail('missing client _id');
          continue;
        }

        const occurredRaw = rec.occurredAt ? Date.parse(rec.occurredAt) : NaN;
        const occurredAt = Number.isFinite(occurredRaw)
          ? new Date(occurredRaw - clockSkewMs) // §3.3: corrected BEFORE rollups run
          : receivedAt;

        const safeMap = (o: unknown) =>
          o && typeof o === 'object'
            ? new Map(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k.replace(/\./g, '_'), v]))
            : new Map();

        const Model = t.models.byKind[spec.kind as TelemetryKind];
        const d = new Model({
          // facts the wire may not assert: tenant, service, env, origin, plane
          // fields (forced/sampleRate stripped by construction — only the
          // allowlisted fields below ever reach the document)
          _id: id,
          name,
          tenantId,
          occurredAt,
          severity: typeof rec.severity === 'string' ? rec.severity : undefined,
          subjects: mergeSubjects(rec.subjects),
          actor: ctx.actor ?? (typeof rec.actor === 'string' ? rec.actor : batchActor),
          onBehalfOf: typeof rec.onBehalfOf === 'string' ? rec.onBehalfOf : undefined,
          service: key.service,
          env: key.env,
          release: typeof body.release === 'string' ? body.release : undefined,
          origin: 'client',
          client: batchClient,
          traceId: typeof rec.traceId === 'string' ? rec.traceId : undefined,
          spanId: typeof rec.spanId === 'string' ? rec.spanId : undefined,
          parentId: typeof rec.parentId === 'string' ? rec.parentId : undefined,
          durationMs: typeof rec.durationMs === 'number' ? rec.durationMs : undefined,
          attrs: safeMap(rec.attrs),
          metrics: safeMap(rec.metrics),
          data: rec.data,
          body: typeof rec.body === 'string' ? rec.body : undefined,
          error: rec.error,
          state: rec.state,
          usage: rec.usage,
        });

        try {
          await d.validate();
        } catch (e) {
          fail(String(e));
          continue;
        }

        // ── insert-gated rollups: at-least-once transport, so the insert IS the dedupe ──
        try {
          await d.save({
            validateBeforeSave: false,
            ...(spec.kind === TelemetryKind.Usage ? { writeConcern: { w: 'majority', j: true } } : {}),
          } as any);
        } catch (e: any) {
          if (e?.code === 11000 || e?.cause?.code === 11000) {
            accepted++; // a retry of a record we already have — the contract working
            continue;
          }
          fail(String(e));
          continue;
        }
        for (const r of spec.rollups ?? []) {
          await recordRollup(t.models.rollups, d, name, r, t.counters).catch((e) =>
            quarantine(name, `rollup: ${e}`, rec),
          );
        }
        accepted++;
      }

      respond();
    },
  );

  // body-parser failures (bad JSON, over 512KB): pk_ swallows, sk_ hears the truth
  router.use((err: any, req: Request & { telemetryKey?: any }, res: Response, _next: NextFunction) => {
    if (req.telemetryKey?.kind === KeyKind.Secret) {
      const status = err?.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: err?.type ?? 'bad_request' });
    }
    t.counters.rejected++;
    res.status(202).json({ accepted: 0, rejected: 1 });
  });

  return router;
}
