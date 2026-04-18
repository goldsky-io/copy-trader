---
name: Calling external APIs from Compose tasks (Polymarket CLOB case study)
description: Compose tasks run in a Deno runtime without --allow-net; SDK libraries that use their own HTTP fail. Use ctx.fetch for all outbound calls. For geo-blocked APIs, route through a proxy you control.
type: reference
tags:
  - compose
  - deno
  - polymarket
  - network
  - proxy
---

# Calling external APIs from Compose tasks

## Problem

Goldsky Compose task binaries (`compose-task`) are compiled **without `--allow-net`** in the Deno permission model. That means any library inside the task that uses Node's HTTP stack (axios, node-fetch, `fetch`, XHR, etc.) fails with:

```
Error: getaddrinfo EPERM <hostname>
```

`@polymarket/clob-client`, `@neondatabase/serverless`, most npm HTTP clients — anything that dials out directly — is blocked.

## What works

`ctx.fetch()` **is host-mediated** — it bridges IPC to the Compose host process, which does have full network access. Any URL is reachable through `ctx.fetch`. Use it for all outbound calls from task code.

## Pattern

If an SDK has:
- **Pure crypto utilities** (signing, hashing, address derivation) — import and use freely. No network.
- **HTTP client methods** — don't call them. Reimplement the HTTP call using `ctx.fetch` + the signing output.

Example (Polymarket CLOB):

```ts
// Pure: reuse the SDK's signing. All local crypto.
import { OrderBuilder } from "@polymarket/clob-client/dist/order-builder/builder.js";
import { createL1Headers, createL2Headers } from "@polymarket/clob-client/dist/headers/index.js";
import { orderToJson } from "@polymarket/clob-client/dist/utilities.js";

// Don't: `client.createAndPostMarketOrder(...)` — uses axios, blocked.

// Do: build the order locally, POST manually.
const signedOrder = await orderBuilder.buildMarketOrder({ ... });
const headers = await createL2Headers(wallet, creds, { method: "POST", requestPath: "/order", body });
await ctx.fetch(`${PROXY_URL}/order`, { method: "POST", headers, body });
```

## Geo-blocks

Compose runs only in `us-west`. Some APIs (Polymarket CLOB, many gambling/regulated services) geo-block the US. You can't relocate Compose, so deploy a tiny transparent proxy in an allowed region and route through it.

### Minimal Fly.io forwarder

```typescript
const TARGET = "https://clob.polymarket.com";

Deno.serve({ port: 8080 }, async (req) => {
  const url = new URL(req.url);
  const target = `${TARGET}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  for (const flyHeader of ["fly-forwarded-port", "fly-forwarded-proto", "fly-forwarded-ssl", "fly-region", "fly-request-id"]) {
    headers.delete(flyHeader);
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.body && req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  const upstream = await fetch(target, init);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
});
```

`fly.toml`:
```toml
app = "your-proxy"
primary_region = "ams"   # Amsterdam — typical Polymarket-allowed region

[http_service]
  internal_port = 8080
  force_https = true
  min_machines_running = 1
```

### Region selection for Polymarket

- **Germany (fra)** — blocked
- **Netherlands (ams)** — works ✓
- **Singapore (sin)** — varies
- Avoid anywhere in the US, UK, France, Italy

Always verify with a test call after deploying — `curl <proxy>/time` should return Polymarket server time, not a 403.

### Cost

One shared Fly proxy can serve the fleet of copy-trader deployments. The proxy is stateless — it doesn't hold private keys or credentials. Users' signed orders pass through unmodified.

## Verify before debugging SDK issues

If you see `getaddrinfo EPERM` and *also* geographic error messages, you're hitting two problems stacked. In order:

1. Swap the SDK's HTTP calls for `ctx.fetch` → fixes EPERM
2. Point `ctx.fetch` at a proxy in an allowed region → fixes geo-block

You'll get distinct, meaningful error messages at each step.

## Related

- [`fly-polymarket-proxy`](https://github.com/endlesssky/fly-polymarket-proxy) — the deployed proxy repo
- `src/lib/clob.ts` in this repo — full example of the ctx.fetch + signing pattern
