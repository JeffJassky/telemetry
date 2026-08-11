# The user adapter

The seam between your user system and telemetry. It is the only integration
contract, and it has **two directions** — documenting one and not the other is
what makes the other look arbitrary.

## Inbound — who is calling?

```js
resolveUser: (req) => ({ id, email, displayName, isAdmin }) | null
```

A **pure read**. Your middleware already authenticated the request; this reads
what it left behind. Never verify a token in here — it runs on every request,
and a throw becomes a 500 where you wanted a clean 401.

Return `null` for a signed-out caller. That is a supported state, not an error.

### Object form

The bare function is shorthand. The object form exists so the concept has a
home:

```js
import { createUserAdapter } from '@jeffjassky/telemetry';

createTelemetry({ userAdapter: createUserAdapter({ resolveUser }) });
```

Passing **both** `userAdapter` and `resolveUser` throws. It does not silently
pick one.

### The default

Omit it entirely and telemetry reads the conventional spots — `req.authUserId`,
then `req.user._id` / `req.user.id`, plus `email`, `displayName`, `isAdmin` off
`req.user`. Enough for the app this was extracted from to drop in with no
config.

## Outbound — this user is gone

```js
await pkg.purgeUser(userId);
```

telemetry stores references into a user system it does not own, and nothing else
will ever clean them up. Call this in your account-deletion path. It is
idempotent — it will be called twice.

See [Account deletion](/guide/account-deletion).

## `isAdmin` gates nothing

Read this twice. telemetry cannot know what "admin" means in your app, so it
never refuses anyone on that basis. `isAdmin` drives:

- badges in the UI
- which UI bundle renders

It does **not** protect `adminRoutes` or `adminUi()`. Your middleware does. See
[Quickstart](/guide/quickstart#add-the-admin-surface), and copy the test.

## The browser cannot run your adapter

It runs server-side against your session. The SPA gets the *result* from
`GET /api/telemetry/me`, and that payload deliberately omits internal ids — the UI
renders a name, never a key.

## When the session expires mid-page

Two situations, only one is ours:

| | Whose |
|---|---|
| Signed out on arrival | Yours — your middleware redirects before we render |
| Session expires while the page is open | Ours |

For the second, set `loginUrl` and `returnParam` on `ui()`. The client redirects
carrying the full current URL, hash route included, so a login flow that honors
the param returns the user to the exact view. It fires on **403** as well as
401 — a revoked admin role strands someone as completely as an expired session.
