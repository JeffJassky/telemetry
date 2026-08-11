/** Transport seam — swap in axios, a test double, anything. */
export type RequestFn = (
  method: string,
  url: string,
  body?: unknown,
) => Promise<any>;

export interface ClientOptions {
  baseUrl?: string;
  request?: RequestFn;
  /** Fires on 401 AND 403 — both strand an already-rendered page. */
  onUnauthenticated?: ((err: unknown) => void) | null;
}

export interface MeResponse {
  user: {
    email: string;
    displayName: string | null;
    isAdmin: boolean;
  };
}

export interface ListResponse<T = unknown> {
  items: T[];
  /** The cap actually applied — never assume the requested limit was honored. */
  limit: number;
}

export interface ItemResponse<T = unknown> {
  item: T;
}

export interface TelemetryClient {
  call: RequestFn;
  me(): Promise<MeResponse>;
  list(params?: Record<string, string | number | null | undefined>): Promise<ListResponse>;
  get(id: string): Promise<ItemResponse>;
}

export interface TelemetryAdminClient extends TelemetryClient {
  summary(): Promise<{ total: number }>;
}

export declare function createClient(opts?: ClientOptions): TelemetryClient;
export declare function createAdminClient(opts?: ClientOptions): TelemetryAdminClient;
