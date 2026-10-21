import type { Connection } from 'mongoose';
import { PLATFORM_SCOPE, isPlatformScope, newId, type Logger } from './types.js';

/**
 * Annotations — the change log a chart is read against.
 *
 * A metric moves; the first question is "what changed?". An annotation is the
 * answer written down at the time: a deploy, a tracking tag removed, a consent
 * banner switched on, a campaign launched, an outage. The dashboard draws each
 * one on every time-series chart whose window it falls in, and agents read the
 * same list (`list_annotations`), so a jump and its likely cause sit side by
 * side instead of in two people's memories.
 *
 * WHAT IT IS NOT. Correlation in time, never causation — the package draws the
 * line next to the jump and claims nothing about the two. And it is not a
 * record kind: records are immutable observations; an annotation is an edited,
 * human-owned note, so it lives in its own collection (`<collection>_annotations`)
 * with no retention fuse.
 *
 * SCOPE. `tenantId` is a tenant, or PLATFORM_SCOPE (`'*'`) for a change that
 * touched every tenant at once — the host's own deploy. Unlike a record, `'*'`
 * IS writable here: it names "all tenants", and a tenant can never be called
 * `'*'`, so the two cannot collide. A tenant reads its own annotations plus the
 * global ones; the platform viewer reads the global ones (a tenant's private
 * notes are not drawn over a cross-tenant sum). `service` and `env` narrow an
 * annotation further; absent means "all of them".
 *
 * IDEMPOTENCY. A deploy hook retries. `key` makes `create()` an upsert on
 * (tenantId, key), so the second delivery rewrites the first instead of drawing
 * two lines.
 */

export const ANNOTATION_TITLE_MAX = 200;
export const ANNOTATION_BODY_MAX = 4000;
export const ANNOTATION_TAGS_MAX = 20;
/** what list() returns by default, and the most it will ever return */
export const ANNOTATION_LIST_DEFAULT = 500;
export const ANNOTATION_LIST_MAX = 2000;

const SHORT_MAX = 64;
const URL_MAX = 2048;
const CATEGORY_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** the default vocabulary — a suggestion for pickers, not a closed enum */
export const ANNOTATION_CATEGORIES = [
  'change', 'deploy', 'tracking', 'consent', 'content', 'campaign', 'incident', 'note',
] as const;

export interface AnnotationInput {
  /** a tenant, or PLATFORM_SCOPE ('*') for a change that touched every tenant */
  tenantId: string;
  /** when the change happened (or began) */
  at: Date | string;
  /** set for a span — a sale, an outage, an experiment. Must not precede `at`. */
  endAt?: Date | string | null;
  title: string;
  body?: string | null;
  /** lowercase slug. Default 'change'. ANNOTATION_CATEGORIES is the suggested set. */
  category?: string;
  /** narrow to one service; absent = every service */
  service?: string | null;
  /** narrow to one env; absent = every env */
  env?: string | null;
  tags?: string[];
  /** a link to the PR, ticket, or change request — http(s) only */
  url?: string | null;
  /** who wrote it: 'dashboard', 'deploy', 'complykit', … Default 'api'. */
  source?: string;
  /** the person, e.g. 'user:u_1' — erased by forget() */
  authorRef?: string | null;
  /** idempotency: a second create() with the same (tenantId, key) updates the first */
  key?: string | null;
}

export type AnnotationPatch = Partial<
  Pick<AnnotationInput, 'at' | 'endAt' | 'title' | 'body' | 'category' | 'service' | 'env' | 'tags' | 'url'>
>;

export interface Annotation {
  id: string;
  tenantId: string;
  at: Date;
  endAt: Date | null;
  title: string;
  body: string | null;
  category: string;
  service: string | null;
  env: string | null;
  tags: string[];
  url: string | null;
  source: string;
  authorRef: string | null;
  key: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnnotationQuery {
  from: Date;
  to: Date;
  /** keep annotations for this service or for every service */
  service?: string;
  env?: string;
  category?: string | string[];
  /** any-of */
  tags?: string[];
  limit?: number;
}

export interface AnnotationList {
  items: Annotation[];
  /** more annotations overlapped the window than `limit` allowed */
  truncated: boolean;
}

const bad = (message: string) => Object.assign(new Error(`telemetry: ${message}`), { status: 400 });

function toDate(v: unknown, field: string): Date {
  const d = v instanceof Date ? v : new Date(String(v));
  if (v == null || v === '' || Number.isNaN(d.getTime())) throw bad(`annotation \`${field}\` is not a valid date`);
  return d;
}

function shortString(v: unknown, field: string, { required = false } = {}): string | null {
  if (v == null || v === '') {
    if (required) throw bad(`annotation \`${field}\` is required`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`annotation \`${field}\` must be a string`);
  const s = v.trim();
  if (!s && required) throw bad(`annotation \`${field}\` is required`);
  if (s.length > SHORT_MAX) throw bad(`annotation \`${field}\` is over ${SHORT_MAX} characters`);
  return s || null;
}

function text(v: unknown, field: string, max: number, { required = false } = {}): string | null {
  if (v == null || v === '') {
    if (required) throw bad(`annotation \`${field}\` is required`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`annotation \`${field}\` must be a string`);
  const s = v.trim();
  if (!s) {
    if (required) throw bad(`annotation \`${field}\` is required`);
    return null;
  }
  if (s.length > max) throw bad(`annotation \`${field}\` is over ${max} characters`);
  return s;
}

function category(v: unknown): string {
  if (v == null || v === '') return 'change';
  if (typeof v !== 'string' || v.length > SHORT_MAX || !CATEGORY_RE.test(v)) {
    throw bad('annotation `category` must be a lowercase slug ([a-z0-9_.-], up to 64 characters)');
  }
  return v;
}

function tags(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad('annotation `tags` must be an array of strings');
  if (v.length > ANNOTATION_TAGS_MAX) throw bad(`annotation \`tags\` holds at most ${ANNOTATION_TAGS_MAX}`);
  const out = new Set<string>();
  for (const t of v) {
    const s = shortString(t, 'tags[]');
    if (s) out.add(s);
  }
  return [...out];
}

function url(v: unknown): string | null {
  const s = text(v, 'url', URL_MAX);
  if (!s) return null;
  // http(s) only — the dashboard renders this as a link, and a `javascript:`
  // href in a shared note is a stored XSS with someone else's name on it
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw bad('annotation `url` is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad('annotation `url` must be http or https');
  }
  return s;
}

function span(at: Date, endAt: Date | null) {
  if (endAt && endAt < at) throw bad('annotation `endAt` is before `at`');
}

const fromDoc = (d: any): Annotation => ({
  id: d._id,
  tenantId: d.tenantId,
  at: d.at,
  endAt: d.endAt ?? null,
  title: d.title,
  body: d.body ?? null,
  category: d.category,
  service: d.service ?? null,
  env: d.env ?? null,
  tags: d.tags ?? [],
  url: d.url ?? null,
  source: d.source,
  authorRef: d.authorRef ?? null,
  key: d.key ?? null,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

export function createAnnotations(opts: { connection: Connection; collection: string; logger: Logger }) {
  const coll = () => opts.connection.db!.collection(opts.collection);

  async function ensureIndexes() {
    await coll().createIndexes([
      { key: { tenantId: 1, at: 1 }, name: 'tenant_at' },
      {
        key: { tenantId: 1, key: 1 },
        name: 'tenant_key_unique',
        unique: true,
        // only annotations that carry a key are deduplicated
        partialFilterExpression: { key: { $type: 'string' } },
      },
      // forget() looks annotations up by author
      { key: { authorRef: 1 }, name: 'author', partialFilterExpression: { authorRef: { $type: 'string' } } },
    ]);
  }

  async function create(input: AnnotationInput): Promise<Annotation> {
    if (!input || typeof input !== 'object') throw bad('annotation input required');
    const tenantId = shortString(input.tenantId, 'tenantId', { required: true })!;
    const at = toDate(input.at, 'at');
    const endAt = input.endAt == null || input.endAt === '' ? null : toDate(input.endAt, 'endAt');
    span(at, endAt);
    const key = text(input.key, 'key', 256);
    const fields = {
      at,
      endAt,
      title: text(input.title, 'title', ANNOTATION_TITLE_MAX, { required: true }),
      body: text(input.body, 'body', ANNOTATION_BODY_MAX),
      category: category(input.category),
      service: shortString(input.service, 'service'),
      env: shortString(input.env, 'env'),
      tags: tags(input.tags),
      url: url(input.url),
      source: shortString(input.source, 'source') ?? 'api',
      authorRef: text(input.authorRef, 'authorRef', 256),
    };
    const now = new Date();

    if (!key) {
      const doc = { _id: newId(), tenantId, ...fields, key: null, createdAt: now, updatedAt: now };
      await coll().insertOne(doc as any);
      return fromDoc(doc);
    }

    // Upsert on (tenantId, key). Two concurrent first deliveries can both miss
    // and both insert; the unique index refuses the second, and the retry then
    // finds the first and updates it.
    const upsert = () =>
      coll().updateOne(
        { tenantId, key },
        {
          $set: { ...fields, updatedAt: now },
          $setOnInsert: { _id: newId(), tenantId, key, createdAt: now },
        } as any,
        { upsert: true },
      );
    try {
      await upsert();
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      await upsert();
    }
    // read back rather than trust findOneAndUpdate's return shape, which
    // differs across the driver majors mongoose 7/8/9 bring in
    return fromDoc(await coll().findOne({ tenantId, key }));
  }

  /** literal scope match — `'*'` edits only global annotations, never a tenant's */
  async function update(tenantId: string, id: string, patch: AnnotationPatch): Promise<Annotation | null> {
    const current: any = await coll().findOne({ _id: id as any, tenantId });
    if (!current) return null;
    const p = (patch ?? {}) as Record<string, unknown>;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
    const set: Record<string, unknown> = {};
    if (has('at')) set.at = toDate(p.at, 'at');
    if (has('endAt')) set.endAt = p.endAt == null || p.endAt === '' ? null : toDate(p.endAt, 'endAt');
    if (has('title')) set.title = text(p.title, 'title', ANNOTATION_TITLE_MAX, { required: true });
    if (has('body')) set.body = text(p.body, 'body', ANNOTATION_BODY_MAX);
    if (has('category')) set.category = category(p.category);
    if (has('service')) set.service = shortString(p.service, 'service');
    if (has('env')) set.env = shortString(p.env, 'env');
    if (has('tags')) set.tags = tags(p.tags);
    if (has('url')) set.url = url(p.url);
    span((set.at as Date) ?? current.at, has('endAt') ? (set.endAt as Date | null) : current.endAt ?? null);
    set.updatedAt = new Date();
    await coll().updateOne({ _id: id as any, tenantId }, { $set: set });
    return fromDoc({ ...current, ...set });
  }

  async function remove(tenantId: string, id: string): Promise<{ removed: number }> {
    const r = await coll().deleteOne({ _id: id as any, tenantId });
    return { removed: r.deletedCount ?? 0 };
  }

  async function get(tenantId: string, id: string): Promise<Annotation | null> {
    const d = await coll().findOne({ _id: id as any, tenantId });
    return d ? fromDoc(d) : null;
  }

  /**
   * Annotations overlapping [from, to), oldest first. A tenant scope reads its
   * own plus the global ones; PLATFORM_SCOPE reads the global ones.
   */
  async function list(scope: string, q: AnnotationQuery): Promise<AnnotationList> {
    const from = toDate(q.from, 'from');
    const to = toDate(q.to, 'to');
    if (from >= to) throw bad('annotation range: `from` must be before `to`');
    // a non-number (`?limit=abc`, a repeated param) is the default, never
    // NaN — the driver reads `.limit(NaN)` as no limit at all
    const n = Number(q.limit);
    const limit = Number.isFinite(n)
      ? Math.min(Math.max(1, Math.floor(n)), ANNOTATION_LIST_MAX)
      : ANNOTATION_LIST_DEFAULT;
    const and: Record<string, unknown>[] = [
      { tenantId: isPlatformScope(scope) ? PLATFORM_SCOPE : { $in: [scope, PLATFORM_SCOPE] } },
      { at: { $lt: to } },
      // a point annotation overlaps when it is inside the window; a span when
      // it ends at or after the window opens
      { $or: [{ endAt: { $gte: from } }, { endAt: null, at: { $gte: from } }] },
    ];
    if (q.service) and.push({ service: { $in: [q.service, null] } });
    if (q.env) and.push({ env: { $in: [q.env, null] } });
    if (q.category) {
      const cats = Array.isArray(q.category) ? q.category : [q.category];
      if (cats.length) and.push({ category: { $in: cats } });
    }
    if (q.tags?.length) and.push({ tags: { $in: q.tags } });
    const docs = await coll()
      .find({ $and: and })
      .sort({ at: 1, _id: 1 })
      .limit(limit + 1)
      .toArray();
    const truncated = docs.length > limit;
    if (truncated) docs.pop();
    return { items: docs.map(fromDoc), truncated };
  }

  /**
   * forget(): an annotation is a fact about the product, not about its author,
   * so it survives and only the author link is rekeyed — the same rule shared
   * saved views follow.
   */
  async function rekeyAuthor(scope: unknown, ref: string, newRef: string): Promise<number> {
    const r = await coll().updateMany({ tenantId: scope as any, authorRef: ref }, { $set: { authorRef: newRef } });
    return r.modifiedCount ?? 0;
  }

  return { ensureIndexes, create, update, remove, get, list, rekeyAuthor };
}

export type Annotations = ReturnType<typeof createAnnotations>;
