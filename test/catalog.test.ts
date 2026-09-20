import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRegistry } from '../src/server/index.js';
import { deriveCatalog, projectRegistry, type DimFacet } from '../src/server/catalog.js';
import { paperRegistry } from './helpers.js';

/**
 * The catalog is inference, so it is pinned the way validateRegistry and
 * summarizeStages are: pure, no Mongo, one case per rule. Every claim here is a
 * claim the UI and the MCP tools will make on a viewer's behalf — a wrong
 * `indexed` flag is a scan sold as a lookup, and a wrong `values` list is a
 * filter option that can never match.
 */

/** a one-event registry whose single attr is the schema under test */
const attrCatalog = (schema: z.ZodType) =>
  deriveCatalog(
    defineRegistry({
      probe: {
        kind: 'event', origin: 'server', subjects: [],
        attrs: z.object({ x: schema as any }),
        description: 'walker probe',
      },
    }) as any,
  );

const attrDim = (schema: z.ZodType): DimFacet => attrCatalog(schema).events.probe!.dims[0]!;

describe('the zod walk', () => {
  it('maps each leaf type', () => {
    expect(attrDim(z.string()).type).toBe('string');
    expect(attrDim(z.number()).type).toBe('number');
    expect(attrDim(z.number().int()).type).toBe('number');
    expect(attrDim(z.int()).type).toBe('number');
    expect(attrDim(z.bigint()).type).toBe('number');
    expect(attrDim(z.boolean()).type).toBe('boolean');
    expect(attrDim(z.date()).type).toBe('date');
  });

  it('reads the closed domain off an enum and a literal', () => {
    const e = attrDim(z.enum(['ads', 'organic']));
    expect(e.type).toBe('enum');
    expect(e.values).toEqual(['ads', 'organic']);

    const l = attrDim(z.literal('pdf'));
    expect(l.type).toBe('enum');
    expect(l.values).toEqual(['pdf']);

    // a multi-value literal is the same closed set, stringified — attrs are
    // strings after Mongoose casting either way
    expect(attrDim(z.literal(['a', 1, true])).values).toEqual(['a', '1', 'true']);
  });

  it('unwraps to the leaf and reports whether the value may be absent', () => {
    expect(attrDim(z.string())).toMatchObject({ type: 'string', optional: false });
    expect(attrDim(z.string().optional())).toMatchObject({ type: 'string', optional: true });
    expect(attrDim(z.number().nullable())).toMatchObject({ type: 'number', optional: true });
    expect(attrDim(z.boolean().default(true))).toMatchObject({ type: 'boolean', optional: true });
    // catch and readonly change how a value is produced, never whether it is there
    expect(attrDim(z.number().catch(0))).toMatchObject({ type: 'number', optional: false });
    expect(attrDim(z.string().readonly())).toMatchObject({ type: 'string', optional: false });
    // the domain survives the wrapper
    expect(attrDim(z.enum(['a', 'b']).optional())).toMatchObject({
      type: 'enum', values: ['a', 'b'], optional: true,
    });
  });

  it('takes the INPUT side of a pipe, because that is what a caller may send', () => {
    expect(attrDim(z.string().transform((v) => v.length)).type).toBe('string');
    expect(attrDim(z.pipe(z.number(), z.transform(String))).type).toBe('number');
  });

  it('treats z.coerce.* as its base type', () => {
    expect(attrDim(z.coerce.number()).type).toBe('number');
    expect(attrDim(z.coerce.boolean()).type).toBe('boolean');
    expect(attrDim(z.coerce.date()).type).toBe('date');
  });

  it('falls back to string on anything it does not recognise', () => {
    // attrs ARE strings after Mongoose casting, so 'string' is the honest
    // answer for a shape the walker has no case for
    expect(attrDim(z.unknown()).type).toBe('string');
    expect(attrDim(z.union([z.string(), z.number()])).type).toBe('string');
    expect(attrDim(z.array(z.string())).type).toBe('string');
  });
});

describe('envelope dims', () => {
  const catalog = deriveCatalog(paperRegistry() as any);

  it('is the fixed list, in DimSource form', () => {
    expect(catalog.envelope.map((d) => d.key)).toEqual([
      'field:kind', 'field:name', 'field:severity', 'field:env', 'field:service',
      'field:release', 'field:origin', 'field:client.platform', 'field:client.appVersion',
      'subjectType', 'actorType',
    ]);
    // the label is what rollups.ts writes before '='; the two pseudo-dims are
    // derived at query time and carry no `field:` prefix at all
    expect(catalog.envelope.map((d) => d.label)).toEqual([
      'kind', 'name', 'severity', 'env', 'service', 'release', 'origin',
      'client.platform', 'client.appVersion', 'subjectType', 'actorType',
    ]);
  });

  it('carries the envelope enums', () => {
    const by = Object.fromEntries(catalog.envelope.map((d) => [d.key, d]));
    expect(by['field:kind']!.values).toEqual(['event', 'error', 'span', 'state', 'usage']);
    expect(by['field:severity']!.values).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
    expect(by['field:env']!.values).toEqual(['prod', 'staging', 'dev']);
    expect(by['field:origin']!.values).toEqual(['server', 'client']);
    expect(by['field:client.platform']!.values).toEqual([
      'web', 'electron', 'ios', 'android', 'server', 'cli',
    ]);
    expect(by['field:client.platform']!.optional).toBe(true); // server records have no client
  });

  it('marks indexed only where model.ts builds a base index', () => {
    const indexed = catalog.envelope.filter((d) => d.indexed).map((d) => d.key);
    expect(indexed).toEqual(['field:kind', 'field:name', 'subjectType']);
  });

  it('opts.platforms EXTENDS the builtin list, never replaces it', () => {
    const extended = deriveCatalog(paperRegistry() as any, { platforms: ['watchos', 'web'] });
    const platform = extended.envelope.find((d) => d.key === 'field:client.platform')!;
    expect(platform.values).toEqual(['web', 'electron', 'ios', 'android', 'server', 'cli', 'watchos']);
  });
});

describe('the paper registry', () => {
  const catalog = deriveCatalog(paperRegistry() as any);

  it('namespaces on the prefix before the first dot', () => {
    expect(catalog.namespaces['account']).toEqual([
      'account.signed_up', 'account.converted', 'account.lifecycle',
    ]);
    expect(catalog.namespaces['billing']).toEqual(['billing.plan_selected', 'billing.ai_tokens']);
    expect(catalog.namespaces['data']).toEqual(['data.first_viewed']);
    expect(catalog.namespaces['error']).toEqual(['error.unhandled']);
    expect(catalog.namespaces['llm']).toEqual(['llm.completion']);
    expect(catalog.events['llm.completion']!.namespace).toBe('llm');
  });

  it('unions every subject type either a spec or a rollup names', () => {
    expect(catalog.subjectTypes).toEqual(['user', 'account', 'session', 'org']);
  });

  it('describes a family by its grain, its labels, and everything that feeds it', () => {
    const llm = catalog.families['llm_cost']!;
    expect(llm.by).toEqual(['attr:gen_ai_request_model', 'attr:feature']);
    // the `x=` prefixes rollups.ts writes into `dims`
    expect(llm.labels).toEqual(['gen_ai_request_model', 'feature']);
    expect(llm.bucket).toBe('day');
    expect(llm.lifetime).toBe(false);
    expect(llm.subjectTypes).toEqual([]); // no subject dim, so no subject restriction
    expect(llm.sums).toEqual(['cost_usd', 'tokens_in', 'tokens_out']);
    expect(llm.feeders).toEqual(['llm.completion']);
    expect(llm.retentionDays).toBe(null);

    const milestone = catalog.families['account.signed_up']!;
    expect(milestone.lifetime).toBe(true); // no bucket — firstAt IS the milestone
    expect(milestone.by).toEqual(['subject']);
    expect(milestone.labels).toEqual(['subject']);
    expect(milestone.subjectTypes).toEqual(['account']);
    expect(milestone.capture).toEqual(['source']);

    const issue = catalog.families['issue']!;
    expect(issue.capture).toEqual(['release', 'error.type', 'route']);
  });

  it('lists both feeders of a shared family, in registry order', () => {
    const activity = catalog.families['activity']!;
    expect(activity.feeders).toEqual(['account.signed_up', 'data.first_viewed']);
    expect(activity.bucket).toBe('day');
    expect(activity.lifetime).toBe(false);
    expect(activity.subjectTypes).toEqual(['account']);
    expect(activity.retentionDays).toBe(730);
  });

  it('names the family that answers a sum exactly, and only for sum measures', () => {
    const llm = catalog.events['llm.completion']!;
    expect(llm.measures.map((m) => m.key)).toEqual([
      'count',
      'sum:tokens_in', 'avg:tokens_in', 'p50:tokens_in', 'p95:tokens_in', 'p99:tokens_in',
      'sum:tokens_out', 'avg:tokens_out', 'p50:tokens_out', 'p95:tokens_out', 'p99:tokens_out',
      'sum:cost_usd', 'avg:cost_usd', 'p50:cost_usd', 'p95:cost_usd', 'p99:cost_usd',
      // durationMs is on the envelope for kind=span, so no registry declares it
      'avg:durationMs', 'p50:durationMs', 'p95:durationMs', 'p99:durationMs',
    ]);
    expect(llm.measures.find((m) => m.key === 'sum:cost_usd')!.exactVia).toEqual(['llm_cost']);
    expect(llm.measures.find((m) => m.key === 'avg:cost_usd')!.exactVia).toEqual([]);
    expect(llm.measures.find((m) => m.key === 'count')!.exactVia).toEqual([]);
    expect(llm.measures.find((m) => m.key === 'count')!.metric).toBeUndefined();

    // the same metric name on a usage event resolves to that event's OWN family
    expect(
      catalog.events['billing.ai_tokens']!.measures.find((m) => m.key === 'sum:cost_usd')!.exactVia,
    ).toEqual(['spend']);

    // a family that sums nothing answers nothing exactly
    expect(
      catalog.events['ledger.charge']!.measures.find((m) => m.key === 'sum:amount_usd')!.exactVia,
    ).toEqual([]);
  });

  it('types the declared attrs and marks the indexed ones', () => {
    const llm = catalog.events['llm.completion']!;
    expect(llm.dims).toEqual([
      { key: 'attr:gen_ai_system', label: 'gen_ai_system', type: 'string', optional: false, indexed: false },
      { key: 'attr:gen_ai_request_model', label: 'gen_ai_request_model', type: 'string', optional: false, indexed: true },
      { key: 'attr:feature', label: 'feature', type: 'string', optional: false, indexed: true },
    ]);
    expect(catalog.events['error.unhandled']!.dims[0]).toMatchObject({
      key: 'attr:route', optional: true, indexed: false,
    });
  });

  it('adds the discriminator fields of the event kind, after the attrs', () => {
    const usage = catalog.events['billing.ai_tokens']!;
    expect(usage.dims.map((d) => d.key)).toEqual([
      'attr:gen_ai_request_model', 'attr:feature',
      'field:usage.meter', 'field:usage.billedTo', 'field:usage.unit',
    ]);
    expect(usage.dims.find((d) => d.key === 'field:usage.meter')!.indexed).toBe(true);

    expect(catalog.events['account.lifecycle']!.dims.map((d) => d.key))
      .toEqual(['field:state.key', 'field:state.to']);

    const err = catalog.events['error.unhandled']!;
    expect(err.dims.map((d) => d.key)).toEqual([
      'attr:route', 'attr:url', 'attr:method', 'attr:status',
      'field:error.type', 'field:error.handled',
    ]);
    expect(err.dims.find((d) => d.key === 'field:error.handled')!.type).toBe('boolean');

    // a plain event kind adds nothing
    expect(catalog.events['page.view']!.dims).toEqual([]);
  });

  it('reports the EFFECTIVE retention, per spec then per kind', () => {
    expect(catalog.events['llm.completion']!.retentionDays).toBe(400); // spec override
    expect(catalog.events['page.view']!.retentionDays).toBe(730);      // RETENTION_DAYS.event
    expect(catalog.events['error.unhandled']!.retentionDays).toBe(90); // RETENTION_DAYS.error
    expect(catalog.events['billing.ai_tokens']!.retentionDays).toBe(null); // money is immortal
  });

  it('names every family an event feeds', () => {
    expect(catalog.events['account.signed_up']!.families).toEqual(['account.signed_up', 'activity']);
    expect(catalog.events['page.view']!.families).toEqual([]);
  });
});

/**
 * The pin. `registryProjection` lived twice — dashboard.ts and mcp.ts — and the
 * SPA boots on its exact shape, so the derivation is only allowed to ADD. This
 * is the deleted dashboard.ts function, verbatim; if the two ever disagree the
 * `registry` key of /api/registry has changed under a shipped client.
 */
function legacyRegistryProjection(registry: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(registry).map(([name, spec]: [string, any]) => [
      name,
      {
        kind: spec.kind,
        origin: spec.origin,
        subjects: spec.subjects,
        description: spec.description,
        attrKeys: spec.attrs ? Object.keys(spec.attrs.shape) : [],
        metricKeys: spec.metrics ? Object.keys(spec.metrics.shape) : [],
        indexedAttrs: spec.indexedAttrs ?? [],
        indexedMetrics: spec.indexedMetrics ?? [],
        rollups: (spec.rollups ?? []).map((r: any) => ({
          as: r.as ?? name,
          by: r.by,
          bucket: r.bucket ?? null,
          sum: r.sum ?? [],
          subjects: r.subjects ?? [],
        })),
      },
    ]),
  );
}

describe('projectRegistry', () => {
  it('reproduces the projection the SPA has always booted on', () => {
    const registry = paperRegistry();
    expect(projectRegistry(deriveCatalog(registry as any)))
      .toEqual(legacyRegistryProjection(registry as any));
  });

  it('keeps the keys and values a client reads by name', () => {
    const p = projectRegistry(deriveCatalog(paperRegistry() as any))['llm.completion']!;
    expect(p.kind).toBe('span');
    expect(p.origin).toBe('server');
    expect(p.attrKeys).toEqual(['gen_ai_system', 'gen_ai_request_model', 'feature']);
    expect(p.metricKeys).toEqual(['tokens_in', 'tokens_out', 'cost_usd']);
    expect(p.indexedMetrics).toEqual(['cost_usd']);
    expect(p.rollups).toEqual([{
      as: 'llm_cost',
      by: ['attr:gen_ai_request_model', 'attr:feature'],
      bucket: 'day',
      sum: ['cost_usd', 'tokens_in', 'tokens_out'],
      subjects: [],
    }]);
    expect(JSON.stringify(p)).not.toMatch(/_def|~standard/); // no zod guts on the wire
  });
});

describe('determinism', () => {
  it('is a pure function of the registry', () => {
    expect(deriveCatalog(paperRegistry() as any)).toEqual(deriveCatalog(paperRegistry() as any));
  });

  it('preserves registry order in namespaces and feeders', () => {
    const order = Object.keys(paperRegistry());
    const catalog = deriveCatalog(paperRegistry() as any);
    expect(Object.keys(catalog.events)).toEqual(order);
    // every namespace's names, concatenated, are that registry order filtered
    for (const [ns, names] of Object.entries(catalog.namespaces)) {
      expect(names).toEqual(order.filter((n) => (n.includes('.') ? n.split('.')[0] : n) === ns));
    }
    for (const family of Object.values(catalog.families)) {
      expect(family.feeders).toEqual(order.filter((n) => family.feeders.includes(n)));
    }
  });

  it('an undotted name namespaces to itself', () => {
    const catalog = deriveCatalog(
      defineRegistry({
        heartbeat: { kind: 'event', origin: 'server', subjects: [], description: 'no dot' },
      }) as any,
    );
    expect(catalog.namespaces).toEqual({ heartbeat: ['heartbeat'] });
    expect(catalog.events.heartbeat!.namespace).toBe('heartbeat');
  });
});
