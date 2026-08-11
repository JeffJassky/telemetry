# UI routers

```js
pkg.ui(opts)       // public SPA
pkg.adminUi(opts)  // admin SPA — you guard the mount
```

Options and behavior: [The UI](/guide/ui).

## What a request gets

1. `GET <mount>/_assets/*` → hashed static files, `max-age=1y, immutable`
2. Anything else → `index.html` with two things injected:
   - `<base href="<mountPath>/" />`
   - `<script>window.__TELEMETRY__= { … }</script>`

The config blob is JSON with every `<` rewritten to the `<` escape, so a
title or a login URL containing `</script>` cannot break out of the tag.
`<!--` is covered by the same rule.

## `defaultSpaDir()`

```js
import { defaultSpaDir } from '@jeffjassky/telemetry';
```

Resolves the shipped bundle. From a published build it is `dist/ui` alongside
`dist/index.js`; running from source it is two levels up. It probes for
`index.html` rather than inferring from a build flag, because the two cases
resolve differently and an inference gets one of them wrong.

Pass `spaDir` to override.

## 503

Missing bundle → `503` and a plain-text line naming the fix. `dist/` is not
committed, so this is what a fresh clone does before `npm run build`.
