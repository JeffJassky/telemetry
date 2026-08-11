import { createTelemetryEventModel } from './model-factory.js';

/**
 * Config normalization — the single place raw host config becomes the shape the
 * routers consume. Every adapter has a working default so the source app drops
 * in with zero config; the only thing without one is the Mongo connection.
 *
 * If you name this file anything, note that it is called `config.js` on purpose
 * and that a bare `config.js` in a global gitignore silently deletes it. Run
 * `npm run check-tracked` before the first push. See standards/traps.md #1.
 */

const NOOP_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Default user resolution.
 *
 * Reads the conventional spots an upstream auth middleware leaves things:
 * `req.authUserId` (ObjectId) plus `req.user` ({ email, displayName, isAdmin }).
 * Hosts using a different convention pass their own `resolveUser`.
 *
 * Pure read. Never verify a token in here — it runs on every request, and a
 * throw becomes a 500 where the host wanted a clean 401.
 */
export function defaultResolveUser(req) {
  const id = req.authUserId ?? req.user?._id ?? req.user?.id;
  if (!id) return null;
  return {
    id,
    email: req.user?.email ?? '',
    displayName: req.user?.displayName ?? null,
    isAdmin: Boolean(req.user?.isAdmin),
  };
}

/**
 * The user adapter: the seam between the host's user system and telemetry.
 *
 * telemetry stores references into a user system it does not own. The adapter is
 * how those references are created and retired, and it has exactly two
 * directions:
 *
 *   inbound   resolveUser(req)   — "who is making this request?"
 *   outbound  purgeUser(id)      — "this user is gone, drop their data"
 *
 * That is the whole contract. telemetry never queries the user collection, never
 * joins against it, and never writes to it.
 *
 * `isAdmin` drives badges and which UI renders. It does NOT gate anything —
 * the package cannot know what "admin" means here. The host wraps the admin
 * router in its own guard, and the host writes the test that proves it.
 */
export function createUserAdapter({ resolveUser = defaultResolveUser } = {}) {
  if (typeof resolveUser !== 'function') {
    throw new TypeError('telemetry: user adapter `resolveUser` must be a function');
  }
  return { resolveUser };
}

export function resolveConfig(config = {}) {
  const {
    model,
    connection,
    modelName,
    collection,
    userRef,
    userAdapter,
    resolveUser,
    logger = NOOP_LOGGER,
    // Every query route is capped. An unbounded read against a collection the
    // host controls the size of is an outage waiting for a busy customer.
    // See standards/traps.md #18.
    listLimit = 200,
    adminListLimit = 500,
    // Optional peer seam: hosts wire their own analytics in, or don't.
    // Never a hard dependency — see standards/house-style.md.
    track = () => {},
  } = config;

  const Model = model
    || createTelemetryEventModel({ connection, modelName, collection, userRef });

  if (userAdapter && resolveUser) {
    throw new TypeError(
      'telemetry: pass either `userAdapter` or `resolveUser`, not both',
    );
  }

  // `resolveUser` is shorthand for a one-method adapter — the common case,
  // since that method is the only one the adapter has. The object form exists
  // so the concept has a home in the docs and room to grow a second method.
  const adapter = userAdapter
    ? createUserAdapter(userAdapter)
    : createUserAdapter({ resolveUser });

  if (typeof track !== 'function') {
    throw new TypeError('telemetry: `track` must be a function');
  }

  return {
    Model,
    userAdapter: adapter,
    resolveUser: adapter.resolveUser,
    logger,
    listLimit,
    adminListLimit,
    track,
  };
}
