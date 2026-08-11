import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Schema, type Connection, type Model } from 'mongoose';
import { TelemetryKind } from './types.js';

/**
 * Keys — the key IS the configuration (instrumentation §2). Client init is
 * { key, url, release } and nothing else: service, env, tenant resolution,
 * kind allowlist, CORS, and rate limits all hang off the key server-side.
 *
 * Format:
 *   pk_<label>_tk_<24hex>              publishable — the id is the whole credential
 *   sk_<label>_tk_<24hex>_<48hex>      secret — id + secret half; only a hash is stored
 *
 * <label> is cosmetic ('live', 'test', …); the tk_ id is the lookup key.
 */

export const KeyKind = { Publishable: 'publishable', Secret: 'secret' } as const;
export type KeyKind = (typeof KeyKind)[keyof typeof KeyKind];

/**
 * How tenantId resolves for records written with this key:
 *  - fixed:   the key carries it. Single-tenant apps, internal tools, CLI builds.
 *  - session: the host resolves it from the request (contextAdapter).
 *  - claimed: the payload asserts it. Secret keys only — enforced here.
 */
export const TenantMode = { Fixed: 'fixed', Session: 'session', Claimed: 'claimed' } as const;
export type TenantMode = (typeof TenantMode)[keyof typeof TenantMode];

const KEY_RE = /^(pk|sk)_([a-z0-9]+)_(tk_[a-f0-9]{24})(?:_([a-f0-9]{48}))?$/;

export interface ParsedKey {
  kind: KeyKind;
  label: string;
  id: string;
  secret?: string;
}

export function parseKeyString(raw: string | undefined): ParsedKey | null {
  if (!raw) return null;
  const m = KEY_RE.exec(raw.trim());
  if (!m) return null;
  const [, prefix, label, id, secret] = m;
  if (prefix === 'sk' && !secret) return null;
  if (prefix === 'pk' && secret) return null;
  return { kind: prefix === 'pk' ? KeyKind.Publishable : KeyKind.Secret, label: label!, id: id!, secret };
}

// scrypt params picked once and versioned IN the hash string (open item §10
// closed): a future param change bumps the prefix, old hashes keep verifying.
const SCRYPT_VERSION = 'scrypt1';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `${SCRYPT_VERSION}$${salt}$${hash}`;
}

/** constant-time — a key check must not leak how much of the secret matched */
export function verifySecret(secret: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [version, salt, hex] = stored.split('$');
  if (version !== SCRYPT_VERSION || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(secret, salt, SCRYPT.keylen, SCRYPT);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function buildKeyModel(connection: Connection, modelName: string, collection: string): Model<any> {
  const existing = connection.models?.[modelName];
  if (existing) return existing;
  const schema = new Schema(
    {
      /** the tk_ id embedded in the key string — lookup is a point read */
      _id: { type: String, required: true },
      kind: { type: String, required: true, enum: Object.values(KeyKind) },
      /** sk_ only — versioned scrypt hash of the secret half */
      secretHash: String,

      tenantMode: { type: String, required: true, enum: Object.values(TenantMode) },
      /** required iff tenantMode = fixed */
      tenantId: String,

      /** stamped onto every record — the client cannot lie about where it runs */
      service: { type: String, required: true },
      env: { type: String, required: true },

      /** CORS allowlist. pk_ only; empty = no browser origins accepted. */
      origins: { type: [String], default: [] },
      /** pk_ defaults to event/error/span; sk_ to all five */
      allowedKinds: { type: [String], required: true },
      /** optional narrowing to a subset of registry names */
      allowedNames: { type: [String], default: undefined },

      /** records/min across the key. Distinct from EventSpec.burst (per-group). */
      maxPerMinute: { type: Number, required: true, default: 600 },

      createdAt: { type: Date, required: true },
      revokedAt: Date,
      /** touched at most once/min, not per request */
      lastUsedAt: Date,
    },
    { collection, versionKey: false },
  );
  schema.index({ revokedAt: 1 });
  return connection.model(modelName, schema);
}

export interface CreateKeyInput {
  kind: KeyKind;
  tenantMode: TenantMode;
  tenantId?: string;
  service: string;
  env: string;
  label?: string;
  origins?: string[];
  allowedKinds?: string[];
  allowedNames?: string[];
  maxPerMinute?: number;
}

/**
 * Mint a key. The full key string is returned ONCE and never reconstructable —
 * only the hash of an sk_ secret is stored. Boot-time trust assertions live
 * here so a misconfigured key cannot exist (instrumentation §2):
 *   claimed ⇒ secret · fixed ⇒ tenantId · publishable ⇒ no usage, no claimed
 */
export async function createKey(KeyModel: Model<any>, input: CreateKeyInput): Promise<{ key: string; id: string }> {
  const {
    kind, tenantMode, tenantId, service, env,
    label = 'live', origins = [], allowedNames, maxPerMinute = 600,
  } = input;

  if (tenantMode === TenantMode.Claimed && kind !== KeyKind.Secret) {
    throw new Error('telemetry: tenantMode "claimed" requires a secret key');
  }
  if (tenantMode === TenantMode.Fixed && !tenantId) {
    throw new Error('telemetry: tenantMode "fixed" requires tenantId');
  }
  const allowedKinds =
    input.allowedKinds ??
    (kind === KeyKind.Publishable
      ? [TelemetryKind.Event, TelemetryKind.Error, TelemetryKind.Span]
      : Object.values(TelemetryKind));
  if (kind === KeyKind.Publishable && allowedKinds.includes(TelemetryKind.Usage)) {
    throw new Error('telemetry: a publishable key may never write usage');
  }

  const id = `tk_${randomBytes(12).toString('hex')}`;
  const secret = kind === KeyKind.Secret ? randomBytes(24).toString('hex') : undefined;

  await KeyModel.create({
    _id: id,
    kind,
    secretHash: secret ? hashSecret(secret) : undefined,
    tenantMode,
    tenantId,
    service,
    env,
    origins,
    allowedKinds,
    allowedNames,
    maxPerMinute,
    createdAt: new Date(),
  });

  const prefix = kind === KeyKind.Publishable ? 'pk' : 'sk';
  return { key: secret ? `${prefix}_${label}_${id}_${secret}` : `${prefix}_${label}_${id}`, id };
}
