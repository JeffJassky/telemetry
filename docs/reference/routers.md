# Routers

```js
app.use('/api/telemetry',       requireAuth, pkg.routes);
app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes);
```

Both are plain `express.Router()` instances. Mount them anywhere; they do not
care about their own path.

## You mount the body parser

```js
app.use(express.json());
```

telemetry deliberately does not. A body parser mounted inside a library router
changes body parsing for everything mounted after it, and the symptom — every
POST looking like a validation failure — points nowhere near the cause.

## `adminRoutes` does not check `isAdmin`

It refuses nobody. Your middleware is the boundary. See
[The user adapter](/guide/user-adapter#isadmin-gates-nothing) and copy
`examples/admin-guard.test.js`.

## Errors are always JSON

Every handler is wrapped. A thrown error becomes:

```json
{ "error": "internal_error" }
```

with a 500 and a log line — never Express's default HTML page. An `HttpError`
is answered as itself:

```json
{ "error": "not_found" }
```

If headers were already sent, the error is forwarded to your error handler
instead.

## Route ordering

Literal paths are declared before parameter paths inside these routers, and a
test is named after the failure that happens when they aren't. If you fork the
route files, keep that order — `GET /:id` will happily swallow `/me`.

## Endpoints

- [Public API](/reference/http-public)
- [Admin API](/reference/http-admin)
