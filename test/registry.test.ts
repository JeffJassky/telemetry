import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedMeta, defineRegistry, validateRegistry } from '../src/server/index.js';

/**
 * Boot-time contract checks. Every one of these is a misconfiguration that
 * must fail DEPLOY, not dashboards (build-plan §7).
 */
describe('registry validation', () => {
  const base = { kind: 'event', origin: 'server', subjects: [], description: 'x' } as const;

  it('rejects a rollup family declared with two shapes — the silently-unqueryable dims trap', () => {
    expect(() =>
      validateRegistry({
        a: { ...base, rollups: [{ as: 'fam', by: ['attr:x'] }] },
        b: { ...base, rollups: [{ as: 'fam', by: ['attr:y'] }] },
      }),
    ).toThrow(/two shapes/);
  });

  it('rejects a family whose subject classes differ — the §5.4 null-join inflation', () => {
    expect(() =>
      validateRegistry({
        a: { ...base, rollups: [{ as: 'fam', by: ['subject'], subjects: ['user'] }] },
        b: { ...base, rollups: [{ as: 'fam', by: ['subject'], subjects: ['org'] }] },
      }),
    ).toThrow(/two shapes/);
  });

  it('rejects a subject dim without a subjects restriction', () => {
    expect(() =>
      validateRegistry({ a: { ...base, rollups: [{ by: ['subject'] }] } }),
    ).toThrow(/subject without/);
  });

  it('rejects more than one subject dim', () => {
    expect(() =>
      validateRegistry({
        a: { ...base, rollups: [{ by: ['subject', 'subject'], subjects: ['user'] }] },
      }),
    ).toThrow(/more than one subject/);
  });

  it('rejects indexedAttrs naming an undeclared attr — the index would never match a row', () => {
    expect(() =>
      validateRegistry({
        a: { ...base, attrs: z.object({ real: z.string() }), indexedAttrs: ['ghost'] },
      }),
    ).toThrow(/ghost/);
  });

  it('rejects a dimDefault containing "|" or "=" — either character corrupts the rollup _id itself', () => {
    // dims are `label=value` and the _id joins them on `|`
    expect(() =>
      validateRegistry({ a: { ...base, rollups: [{ by: ['attr:x'], dimDefault: 'a|b' }] } }),
    ).toThrow(/dimDefault/);
    expect(() =>
      validateRegistry({ a: { ...base, rollups: [{ by: ['attr:x'], dimDefault: 'k=v' }] } }),
    ).toThrow(/dimDefault/);
  });

  it('rejects an empty dimDefault — an unnamed bucket is the null bucket it exists to replace', () => {
    expect(() =>
      validateRegistry({ a: { ...base, rollups: [{ by: ['attr:x'], dimDefault: '' }] } }),
    ).toThrow(/dimDefault/);
  });

  it('dimDefault does not split a rollup family — it changes the bucket, never what a position means', () => {
    expect(() =>
      validateRegistry({
        a: { ...base, rollups: [{ as: 'fam', by: ['attr:x'], dimDefault: 'none' }] },
        b: { ...base, rollups: [{ as: 'fam', by: ['attr:x'] }] },
      }),
    ).not.toThrow();
  });

  it('rejects a sampleRate outside (0, 1]', () => {
    expect(() => validateRegistry({ a: { ...base, sampleRate: 0 } })).toThrow(/sampleRate/);
    expect(() => validateRegistry({ a: { ...base, sampleRate: 1.5 } })).toThrow(/sampleRate/);
  });

  it('rejects an unknown kind and an unknown origin', () => {
    expect(() => validateRegistry({ a: { ...base, kind: 'metric' as never } })).toThrow(/kind/);
    expect(() => validateRegistry({ a: { ...base, origin: 'edge' as never } })).toThrow(/origin/);
  });

  it('defineRegistry is identity — config in, config out', () => {
    const r = defineRegistry({ a: { ...base } });
    expect(r.a.kind).toBe('event');
  });
});

describe('boundedMeta — maxed shape guard, drop-never-truncate', () => {
  const parse = (v: unknown) => boundedMeta().safeParse(v);

  it('passes a bounded flat object through intact', () => {
    const meta = { route: '/reports', count: 3, ok: true, nested: { a: 'b' } };
    const r = parse(meta);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(meta);
  });

  it('drops the WHOLE object when any string exceeds 200 chars — never truncates', () => {
    const r = parse({ fine: 'ok', long: 'x'.repeat(201) });
    expect(r.success).toBe(true);
    expect(r.data).toBeUndefined();
  });

  it('drops on more than 12 keys', () => {
    const wide = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 1]));
    expect(parse(wide).data).toBeUndefined();
  });

  it('drops on two levels of nesting', () => {
    expect(parse({ a: { b: { c: 1 } } }).data).toBeUndefined();
  });

  it('drops on a 4KB+ serialization even when every individual bound passes', () => {
    // 12 keys × nested 12 × 199-char strings ≈ 29KB — each piece legal, the whole too big
    const nested = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, 'y'.repeat(199)]));
    const big = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, { ...nested }]));
    expect(parse(big).data).toBeUndefined();
  });

  it('drops non-objects and circular structures instead of throwing', () => {
    expect(parse('string').data).toBeUndefined();
    expect(parse([1, 2]).data).toBeUndefined();
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(parse(c).data).toBeUndefined();
  });
});
