---
name: Compose + Turbo webhook integration + Polymarket-specific gotchas
description: Wire a Turbo pipeline's webhook sink to a Compose HTTP task. Covers the auth secret format, the webhook URL pattern, OrderFilled ABI indexed-params pitfall, and Polymarket geo-block region map.
type: reference
tags:
  - compose
  - turbo
  - webhook
  - polymarket
  - integration
category: integration-issues
date: 2026-04-18
---

# Compose + Turbo webhook integration

## Problem

Wiring a Turbo pipeline's webhook sink to a Compose HTTP task — one POST per matching event, authenticated, from pipeline to Compose runtime. The "obvious" config fails in several non-obvious ways, each with a vague error. This doc is the assembled recipe.

## Root cause (x3)

1. **Auth secret format** isn't documented clearly — `goldsky secret create` needs a JSON value with a specific schema for `type: "httpauth"`
2. **OrderFilled (and many other CTF events)** have multiple *indexed* parameters — an ABI that claims they're non-indexed makes the Turbo decoder silently drop every matching event
3. **Polymarket geo-blocks** most regions. Even the "EU" ones aren't uniformly allowed. Frankfurt is blocked; Amsterdam works.

## Solution

### 1. Webhook sink → Compose HTTP task

**Pipeline YAML:**

```yaml
sinks:
  copy_trade_webhook:
    type: webhook
    from: watched_fills                               # your filtered transform
    url: https://api.goldsky.com/api/admin/compose/v1/<app-name>/tasks/<task-name>
    secret_name: COMPOSE_WEBHOOK_AUTH
    one_row_per_request: true                         # one HTTP call per event
```

**URL pattern for Compose admin endpoints:**
```
https://api.goldsky.com/api/admin/compose/v1/<app-name>/tasks/<task-name>
```

**Auth secret** — `goldsky secret create` expects an httpauth-typed value in this exact shape:

```bash
goldsky secret create --name COMPOSE_WEBHOOK_AUTH \
  --value '{"type": "httpauth", "secretKey": "Authorization", "secretValue": "Bearer <your-compose-api-token>"}'
```

Common mistakes:
- Using `--type httpauth` flag → CLI rejects it; type goes in the JSON value
- Using `"header"` / `"value"` as keys → rejected; must be `secretKey` / `secretValue`
- Missing `Bearer ` prefix on the token → Compose rejects with 401

**On the Compose side**, declare the task with the matching trigger:

```yaml
tasks:
  - name: "copy_trade"
    path: "./src/tasks/copy_trade.ts"
    triggers:
      - type: "http"
        authentication: "auth_token"
```

The webhook POST body is delivered as the `params` argument to `main(ctx, params)`. With `one_row_per_request: true`, it's a single decoded row as JSON.

### 2. OrderFilled ABI — maker and taker are indexed

The Polymarket CTF Exchange emits:

```solidity
event OrderFilled(
    bytes32 indexed orderHash,
    address indexed maker,
    address indexed taker,
    uint256 makerAssetId,
    uint256 takerAssetId,
    uint256 makerAmountFilled,
    uint256 takerAmountFilled,
    uint256 fee
);
```

**3 indexed params** (orderHash, maker, taker) — not 1. The correct ABI JSON for `evm_log_decode`:

```json
[{
  "anonymous": false,
  "type": "event",
  "name": "OrderFilled",
  "inputs": [
    {"indexed": true,  "name": "orderHash",         "type": "bytes32"},
    {"indexed": true,  "name": "maker",             "type": "address"},
    {"indexed": true,  "name": "taker",             "type": "address"},
    {"indexed": false, "name": "makerAssetId",      "type": "uint256"},
    {"indexed": false, "name": "takerAssetId",      "type": "uint256"},
    {"indexed": false, "name": "makerAmountFilled", "type": "uint256"},
    {"indexed": false, "name": "takerAmountFilled", "type": "uint256"},
    {"indexed": false, "name": "fee",               "type": "uint256"}
  ]
}]
```

Symptom of a wrong ABI: Turbo logs show a stream of `Error decoding log: InvalidData` and no OrderFilled rows reach your downstream transform. The pipeline is "healthy" (checkpoints flowing) but your webhook never fires.

Note that the *positional* event_params order is unchanged whether a param is indexed or not. So `event_params[2]` is `maker` in either case. But the decoder needs to know where to find each param in the raw log (indexed → topics; non-indexed → data) — that's what the `indexed: true/false` flag controls.

### 3. Polymarket geo-block region map

Polymarket's CLOB API geo-blocks certain regions. If your traffic originates in a blocked region you get:

```
403 Forbidden: {"error": "Trading restricted in your region, please refer to available regions - https://docs.polymarket.com/developers/CLOB/geoblock"}
```

Observed Fly.io regions:

| Region | Code | Status |
|--------|------|--------|
| Ashburn (US East) | `iad` | ❌ Blocked |
| Frankfurt (Germany) | `fra` | ❌ Blocked |
| Amsterdam (Netherlands) | `ams` | ✅ Works |

To test a region's status, SSH into the machine and curl Polymarket server time:
```bash
fly ssh console -C 'deno eval "const r = await fetch(\"https://clob.polymarket.com/time\"); console.log(r.status, await r.text())"'
```

A 200 + unix timestamp = good; anything else = blocked.

### Compose-specific fixes applied along the way

- **`ctx.collection()` returns a Promise** — needs `await`. Destructuring or chaining method calls without awaiting throws `TypeError: findMany is not a function`.
- **Image cache on preview tag** — after a deploy, `goldsky compose pause` + `resume` to force a fresh image pull. Without it, the running pod stays on the previous image.
- **On-chain balance checks are cheaper than local counters** — if your task decrements a local budget collection, it WILL drift out of sync with reality. Just `eth_call` the USDC balance each time.
- **`setup_approvals` idempotency** — MAX_UINT256 on top of MAX_UINT256 is a no-op write but still a real tx. Cheap with gas sponsorship, safe to re-run.

## Prevention / checklist

Before deploying a Compose + Turbo integration:

- [ ] Validate pipeline with `goldsky turbo validate <pipeline>.yaml` before apply
- [ ] Check event ABIs against the actual contract on a block explorer — especially `indexed` flags on each param
- [ ] Confirm target API's geo-block list and deploy any proxy in a known-allowed region (test the proxy's outbound IP, don't trust the Fly region name alone — Fly may use upstream CDN routing)
- [ ] Pause/resume the Compose app after deploys to force fresh image pulls
- [ ] `await` every `ctx.collection()` call
- [ ] Prefer on-chain / external-API state checks over local collection counters as source of truth

## Related

- `docs/solutions/integration-issues/compose-tasks-calling-external-apis.md` — the `ctx.fetch` + proxy pattern for SDK-heavy integrations
- `docs/solutions/integration-issues/finding-profitable-polymarket-traders.md` — using the PnL Kafka pipeline to find wallets
- `pipeline/polymarket-ctf-events.yaml` — reference implementation of the wiring
