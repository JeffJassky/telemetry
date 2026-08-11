import type { Router, Request } from 'express';
import type { Connection, Model, Mongoose, Schema, Types } from 'mongoose';

/** The identity the package needs. Never an auth result — the host authed already. */
export interface PackageUser {
  id: Types.ObjectId | string;
  email: string;
  displayName?: string | null;
  /** Drives badges and which UI renders. Gates nothing — the host guards. */
  isAdmin?: boolean;
}

export interface Logger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

/** Inbound direction of the user adapter. Returns null for a signed-out caller. */
export type ResolveUser = (req: Request) => PackageUser | null;

export interface UserAdapter {
  resolveUser: ResolveUser;
}

export declare function defaultResolveUser(req: Request): PackageUser | null;
export declare function createUserAdapter(opts?: { resolveUser?: ResolveUser }): UserAdapter;

export interface StorageAdapter {
  put(key: string, body: Buffer | Uint8Array | string, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  signUrl(key: string, opts?: { expiresIn?: number }): Promise<string>;
}

export interface UiOptions {
  /** Path the router is mounted at — used for `<base href>` and asset URLs. */
  mountPath?: string;
  /** Where the browser should call the public JSON API. */
  apiBase?: string;
  /** Where the browser should call the admin JSON API. */
  adminApiBase?: string;
  /** Document/page title. */
  title?: string;
  /** Override the built SPA directory. Defaults to the bundle in `dist/ui`. */
  spaDir?: string;
  /**
   * Where to send a user whose session ends while the page is open. Null (the
   * default) surfaces API errors inline instead of redirecting.
   */
  loginUrl?: string | null;
  /** Query param carrying the return URL. Defaults to `next`. */
  returnParam?: string;
  /** Set by `ui()` / `adminUi()`; only meaningful on the low-level factory. */
  admin?: boolean;
}

export interface createTelemetryConfig {
  /** Supply a compiled model to bypass the factory entirely. */
  model?: Model<any>;
  /** Mongoose connection. Defaults to the global mongoose instance. */
  connection?: Mongoose | Connection;
  /** Override when a collision with a host model is plausible — traps #2. */
  modelName?: string;
  collection?: string;
  /** Model name the stored user references point at. Defaults to `User`. */
  userRef?: string;

  /** The user adapter, object form. Mutually exclusive with `resolveUser`. */
  userAdapter?: UserAdapter;
  /** The user adapter, shorthand form. Mutually exclusive with `userAdapter`. */
  resolveUser?: ResolveUser;

  logger?: Logger;
  /** Hard cap on public list reads. Defaults to 200 — traps #18. */
  listLimit?: number;
  /** Hard cap on admin list reads. Defaults to 500. */
  adminListLimit?: number;
  /** Optional peer seam for analytics. No-op by default; never a hard dep. */
  track?: (event: unknown) => void;
}

export interface PurgeSummary {
  removed: number;
}

export interface TelemetryInstance {
  /** The Mongoose model. `await model.createIndexes()` once at boot — traps #3. */
  model: Model<any>;
  routes: Router;
  /** The host guards this router. This package does not. */
  adminRoutes: Router;
  ui(opts?: UiOptions): Router;
  adminUi(opts?: UiOptions): Router;
  /** Outbound adapter direction. Idempotent — it will be called twice. */
  purgeUser(userId: Types.ObjectId | string): Promise<PurgeSummary>;
}

export declare function createTelemetry(config?: createTelemetryConfig): TelemetryInstance;

export declare function buildTelemetryEventSchema(opts?: { userRef?: string }): Schema;
export declare function createTelemetryEventModel(opts?: {
  connection?: Mongoose | Connection;
  modelName?: string;
  collection?: string;
  userRef?: string;
}): Model<any>;

export declare function defaultSpaDir(): string;

export declare class HttpError extends Error {
  constructor(status: number, code: string, details?: Record<string, unknown>);
  status: number;
  code: string;
  details?: Record<string, unknown>;
}
