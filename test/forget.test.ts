import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

describe('forget — erasure, actually implemented', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  async function seed() {
    const t = buildTelemetry();
    await t.syncIndexes();
    const when = at('2026-07-01T00:00:00Z');

    // sole-party row → deletable
    await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u_gone' }], occurredAt: when,
    });
    // shared row → must be redacted, the other user's record survives
    await t.emit('report.shared', {
      tenantId: 'tn',
      subjects: [{ type: 'user', id: 'u_gone', role: 'sender' }, { type: 'user', id: 'u_stays', role: 'recipient' }],
      actor: 'user:u_gone',
      occurredAt: when,
    });
    // actor-only row → u_gone in otherPrincipals, not a subject
    await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u_stays' }], actor: 'user:u_gone', occurredAt: when,
    });
    // usage row → ALWAYS redacted, never deleted (statutory retention)
    await t.emit('billing.ai_tokens', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }, { type: 'user', id: 'u_gone' }],
      occurredAt: when,
      attrs: { gen_ai_request_model: 'm', feature: 'chat' }, metrics: { cost_usd: 0.05 },
      usage: { meter: 'ai_tokens', quantity: 1, unit: 'token', idempotencyKey: 'k_forget', billedTo: 'org:o1' },
    });
    // an alias row (written by identify() in the wire world)
    await t.collections.aliases().insertOne({
      _id: 'tn|anon:a_1' as any, tenantId: 'tn', anonRef: 'anon:a_1', userRef: 'user:u_gone',
    });
    await t.flush();
    return t;
  }

  it('deletes sole-party rows, redacts shared ones, rekeys rollups, drops aliases — and reports each count', async () => {
    const t = await seed();
    const before = await t.models.rollups.findOne({ as: 'report.shared', dims: 'user:u_gone' }).lean() as any;
    expect(before.count).toBe(2); // solo + shared (actor-only row is not a subject fan-out)

    const res = await t.forget('tn', 'user:u_gone');
    expect(res.deleted).toBe(1);   // the solo row
    expect(res.redacted).toBe(3);  // shared + actor-only + usage
    expect(res.rollups).toBe(1);   // report.shared subject rollup rekeyed
    expect(res.aliases).toBe(1);

    // no trace of the ref anywhere
    expect(await t.models.telemetry.countDocuments({
      $or: [{ subjectKeys: 'user:u_gone' }, { otherPrincipals: 'user:u_gone' }, { actor: 'user:u_gone' }],
    })).toBe(0);
    expect(await t.models.rollups.countDocuments({ dims: 'user:u_gone' })).toBe(0);
    expect(await t.collections.aliases().countDocuments({})).toBe(0);

    // the shared row SURVIVED, redacted: the recipient's record is intact
    const shared = await t.models.telemetry.findOne({ subjectKeys: 'user:u_stays', 'subjects.role': 'sender' }).lean() as any;
    expect(shared.redactedAt).toBeTruthy();
    const sender = shared.subjects.find((s: any) => s.role === 'sender');
    expect(sender.id).toMatch(/^redacted_/);
    expect(sender.type).toBe('user'); // type survives — subjectKeys stays re-derivable
    expect(shared.subjectKeys).toContain('user:u_stays');

    // usage row redacted, never deleted
    const usage = await t.models.telemetry.findOne({ kind: 'usage' }).lean() as any;
    expect(usage).toBeTruthy();
    expect(usage.redactedAt).toBeTruthy();
    expect(usage.subjectKeys.some((k: string) => k.startsWith('user:redacted_'))).toBe(true);

    // rollup rekeyed: aggregate survives, the person does not. (The family
    // also holds u_stays' own rollup — query the rekeyed doc specifically.)
    const rekeyed = await t.models.rollups.findOne({
      as: 'report.shared', dims: { $regex: '^user:redacted_' },
    }).lean() as any;
    expect(rekeyed.count).toBe(2); // cohort denominators unchanged
  });

  it('is idempotent — a second forget() finds nothing and changes nothing', async () => {
    const t = await seed();
    await t.forget('tn', 'user:u_gone');
    const res2 = await t.forget('tn', 'user:u_gone');
    expect(res2.deleted).toBe(0);
    expect(res2.rollups).toBe(0);
    expect(res2.aliases).toBe(0);
    // redacted may re-match rows already redacted (the $or matches nothing now)
    expect(res2.redacted).toBe(0);
  });

  it('erases quarantined raw payloads too — rejects are inside the erasure boundary', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    // an invalid emit lands the raw payload (with subjects) in quarantine
    await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u_gone' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { format: 'x'.repeat(999) } as any, // fails max(16)
    });
    await t.flush();
    expect(await t.collections.rejects().countDocuments({})).toBe(1);
    await t.forget('tn', 'user:u_gone');
    expect(await t.collections.rejects().countDocuments({})).toBe(0);
  });

  it('refuses to run without a pepper — pseudonyms must not be guessable defaults', async () => {
    const t = buildTelemetry({ pepper: undefined });
    delete process.env.TELEMETRY_PEPPER;
    await expect(t.forget('tn', 'user:u_1')).rejects.toThrow(/pepper/);
  });

  it('rejects a ref that is not type:id before touching anything', async () => {
    const t = buildTelemetry();
    await expect(t.forget('tn', 'not-a-ref' as any)).rejects.toThrow(/type:id/);
  });
});
