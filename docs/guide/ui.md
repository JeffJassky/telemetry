# The UI

A prebuilt React SPA served by an Express router at whatever path you mount it.
Your app's framework is irrelevant — a Vue host mounts this and never knows.

```js
app.use('/telemetry', requireAuth, pkg.ui({ mountPath: '/telemetry' }));
```

## One build, any mount path

Assets are referenced relatively and the server injects
`<base href="<mountPath>/">` plus a config blob per request. Remounting needs no
rebuild.

The catch: **`mountPath` must match where the router actually is.** Behind a
proxy that strips a prefix, it is the path the *browser* sees. Get it wrong and
the HTML loads while every asset 404s — a failure that looks like a broken build
and is a wrong string.

## Two UIs, two guards

`ui()` and `adminUi()` are separate mounts, not one page with a client-side
flag. A non-admin who guesses the admin URL is stopped by your middleware before
any HTML is served — there is nothing in devtools to flip.

```js
app.use('/admin/telemetry', requireAuth, requireAdmin,
        pkg.adminUi({ mountPath: '/admin/telemetry' }));
```

## Options

| Option | Default | |
|---|---|---|
| `mountPath` | `/telemetry` | Must match reality. See above. |
| `apiBase` | `/api/telemetry` | Where the browser calls the JSON API |
| `adminApiBase` | `/api/telemetry/admin` | Same, admin |
| `title` | `Telemetry` | Page title |
| `loginUrl` | `null` | Where to send an expired session. Null surfaces errors inline. |
| `returnParam` | `next` | Query param carrying the return URL |
| `spaDir` | the shipped bundle | Override the built SPA directory |

## 503 on a fresh checkout

If the bundle is missing, the router answers **503** with a line telling you to
run `npm run build`. That is the normal state of a fresh git clone, not a bug —
`dist/` is not committed.

## Theming

The SPA scopes its CSS to its own root element and reads
`prefers-color-scheme`. It does not inherit host styles and does not leak into
them.
