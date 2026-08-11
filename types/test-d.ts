/**
 * Compile-only exercise of the public declarations. Never executed — `tsc
 * --noEmit` failing here means the .d.ts files drifted from the JS.
 *
 * Hand-written types rot within a day. On featureboard this file immediately
 * caught that `types/` was missing FOUR features added the same afternoon.
 * Every exported symbol must appear below. See standards/traps.md #9.
 */
import type {
  HttpError,
  Logger,
  PackageUser,
  PurgeSummary,
  ResolveUser,
  StorageAdapter,
  UiOptions,
  UserAdapter,
  createTelemetryConfig,
  TelemetryInstance,
} from './index.js';
import type {
  ClientOptions,
  ItemResponse,
  ListResponse,
  MeResponse,
  RequestFn,
  TelemetryAdminClient,
  TelemetryClient,
} from './client.js';

declare const pkg: TelemetryInstance;
declare const client: TelemetryClient;
declare const adminClient: TelemetryAdminClient;

// The adapter contract: both forms must typecheck.
const withFn: createTelemetryConfig = {
  resolveUser: () => ({ id: 'abc', email: 'a@b.c', displayName: null, isAdmin: false }),
};
const withAdapter: createTelemetryConfig = {
  userAdapter: { resolveUser: () => null },
};

// Signed-out is expressible — required for anything with a public path.
const anon: createTelemetryConfig = { resolveUser: () => null };

// Caps and the optional analytics peer.
const tuned: createTelemetryConfig = {
  listLimit: 50,
  adminListLimit: 100,
  track: (event) => void event,
  logger: {} satisfies Logger,
};

// Model overrides — the traps #2 escape hatch.
const named: createTelemetryConfig = { modelName: 'CustomTelemetryEvent', collection: 'custom', userRef: 'Account' };

// UI options, including the sign-in redirect.
const ui: UiOptions = {
  mountPath: '/telemetry',
  apiBase: '/api/telemetry',
  loginUrl: '/login',
  returnParam: 'next',
  title: 'Telemetry',
};
const uiRouter = pkg.ui(ui);
const adminRouter = pkg.adminUi({ mountPath: '/admin/telemetry' });
const routes = pkg.routes;
const adminRoutes = pkg.adminRoutes;

// Purge returns a summary, and takes a string or an ObjectId.
async function purge(): Promise<PurgeSummary> {
  return pkg.purgeUser('507f1f77bcf86cd799439011');
}

// Indexes are the host's to build — traps #3.
async function boot() {
  await pkg.model.createIndexes();
}

// Client surface.
async function exercise() {
  const { user }: MeResponse = await client.me();
  const isStaff: boolean = user.isAdmin;
  const name: string | null = user.displayName;

  const page: ListResponse = await client.list({ limit: 10 });
  const cap: number = page.limit;

  const one: ItemResponse = await client.get('abc');
  const total: number = (await adminClient.summary()).total;
  const raw = await client.call('GET', '/me');
}

// Custom transport is typed.
const transport: RequestFn = async (method, url, body) => ({ ok: true });
const opts: ClientOptions = { baseUrl: '/x', request: transport, onUnauthenticated: () => {} };

// A user accepts a string or ObjectId id; the adapter is a plain function.
const u: PackageUser = { id: 'abc', email: 'a@b.c' };
const r: ResolveUser = () => u;
const a: UserAdapter = { resolveUser: r };

// Storage, for packages that copy the adapter in. Delete with the adapter.
declare const storage: StorageAdapter;
async function bytes() {
  await storage.put('k', Buffer.from('v'), { contentType: 'text/plain' });
  const got: Buffer = await storage.get('k');
  const url: string = await storage.signUrl('k', { expiresIn: 60 });
  await storage.delete('k');
}

// Errors carry a status and a stable code.
declare const err: HttpError;
const status: number = err.status;
const code: string = err.code;
