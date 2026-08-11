# Introduction

Unified telemetry — product events, errors, traces, state transitions, and billable usage in one Mongo envelope, with typed SDKs and a mountable dashboard.

## What it is

A set of Express routers and a Mongoose model you mount inside an app you
already have. Not a service, not a server — telemetry never listens on a port and
never authenticates anyone.

## What it is not

- **Not an app.** It exports routers. You mount them, you guard them, you own
  the process.
- **Not an auth system.** It asks your app who is calling, through the
  [user adapter](/guide/user-adapter). Whatever your middleware already
  established is what it gets.
- **Not multi-tenant on its own.** It stores what you tell it to store, in your
  database, under your connection.

## Requirements

| | |
|---|---|
| Node | 20+ |
| Express | 4.18+ or 5 |
| Mongoose | 7, 8, or 9 — all three run the full suite in CI |

Both peers are **peer dependencies**, not dependencies. telemetry uses the copy
you already have, which is the only way the Mongoose model registry stays
coherent.

## Next

- [Quickstart](/guide/quickstart) — mounted and serving in about ten lines
- [The user adapter](/guide/user-adapter) — the one integration contract
