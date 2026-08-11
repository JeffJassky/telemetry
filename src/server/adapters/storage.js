/**
 * The storage adapter interface.
 *
 * Cross-cutting: it shows up in chat (file uploads), mailery (attachments), and
 * knowledgebase. It is defined HERE, in the template, and copied into each
 * package that needs it — deliberately not published as a package of its own.
 * A shared runtime "core" that feature packages import is how a library becomes
 * a framework. See standards/adapters.md and standards/house-style.md.
 *
 * Copy this file only into packages that actually store bytes. Delete it
 * otherwise — an unused adapter in the docs is a promise nobody kept.
 *
 * Shape:
 *
 *   {
 *     put(key, body, { contentType }) => Promise<void>
 *     get(key)                        => Promise<Buffer | ReadableStream>
 *     delete(key)                     => Promise<void>
 *     signUrl(key, { expiresIn })     => Promise<string>
 *   }
 *
 * Directions:
 *   inbound   put / get / signUrl  — the package asks the host to hold bytes
 *   outbound  delete               — the host's deletion path reaches back in
 *
 * `signUrl` is the one worth arguing about: it exists so a browser can fetch a
 * private object without proxying megabytes through the host's Node process.
 * A local-disk adapter that cannot sign has to route through an authed route
 * instead — which is why `signUrl` may return a package-relative URL, not
 * necessarily an absolute one at the storage provider.
 */

/** Every method throws — a package that needs storage must be given one. */
export function createNullStorage() {
  const fail = (method) => () => {
    throw new Error(
      `telemetry: no storage adapter configured — pass \`storage\` to use ${method}()`,
    );
  };
  return {
    put: fail('put'),
    get: fail('get'),
    delete: fail('delete'),
    signUrl: fail('signUrl'),
  };
}

/**
 * In-memory storage. For tests and the runnable example — never for a host.
 * Bytes vanish on restart and the process grows without bound.
 */
export function createMemoryStorage() {
  const bytes = new Map();
  return {
    async put(key, body, { contentType = 'application/octet-stream' } = {}) {
      bytes.set(key, { body: Buffer.from(body), contentType });
    },
    async get(key) {
      const hit = bytes.get(key);
      if (!hit) throw new Error(`telemetry: no object at ${key}`);
      return hit.body;
    },
    async delete(key) {
      bytes.delete(key);
    },
    async signUrl(key) {
      return `data:application/octet-stream;base64,${(bytes.get(key)?.body ?? Buffer.alloc(0)).toString('base64')}`;
    },
  };
}

export function assertStorageAdapter(storage) {
  for (const method of ['put', 'get', 'delete', 'signUrl']) {
    if (typeof storage?.[method] !== 'function') {
      throw new TypeError(`telemetry: storage adapter is missing \`${method}\``);
    }
  }
  return storage;
}
