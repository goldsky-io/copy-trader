# copy-trader

Polymarket whale copy-trading bot powered by **Goldsky Compose + Turbo**. Watch any set of Polymarket wallets; when they buy or sell, your bot mirrors the trade automatically. Redemption of winning shares is automatic too.

The whole stack — on-chain indexing, event fan-out, trade signing, order placement, redemption — runs on Goldsky. No separate server to operate.

---

## Architecture

```
Polygon (on-chain)
  │
  └─ CTF Exchange: OrderFilled events
       │
       ▼
Goldsky Turbo Pipeline
  │  decode + filter to watched wallets
  │  → webhook per fill
       │
       ▼
Goldsky Compose App (copy-trader)
  ├─ copy_trade (HTTP)      → parse fill → Gamma API lookup → sign EIP-712 order → POST to CLOB via proxy
  ├─ redeem (cron 5 min)    → poll data API for redeemable positions → redeemPositions() on-chain
  ├─ setup_approvals (HTTP) → one-time: approve CTF Exchange + NegRisk + ConditionalTokens
  └─ status (HTTP)          → JSON snapshot: balance, trades, pnl, watched wallets
```

### Why the Fly.io proxy?

Polymarket's CLOB API is geo-blocked to the US. Goldsky Compose tasks currently run from `us-west`. The included Fly.io proxy (`fly-polymarket-proxy.fly.dev`, deployed in Amsterdam) forwards CLOB requests through an EU IP. The proxy URL is hardcoded into the template — no setup required. See [`../fly-polymarket-proxy/`](https://github.com/endlesssky/fly-polymarket-proxy) for the proxy source.

### Why `ctx.fetch` instead of the CLOB SDK?

Compose's task runtime (Deno) doesn't grant `--allow-net` to task binaries — SDK internal HTTP calls (axios) fail with `getaddrinfo EPERM`. The pure signing utilities from `@polymarket/clob-client` work fine (local crypto only). So this template reuses those utilities for EIP-712 signing + HMAC L2 auth, and routes every HTTP call through `ctx.fetch` (which is host-mediated and has network access).

---

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/get-started) authenticated against your project
- An EOA private key for the bot's wallet
- USDC.e (native bridged USDC) on Polygon, sent to the EOA address

No Polymarket account or proxy wallet needed — the bot signs as EOA.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

**`compose.yaml`** — edit `env.cloud`:

```yaml
env:
  cloud:
    TRADE_AMOUNT_USD: "1"            # trade size per webhook (min $1 notional)
    WATCHED_WALLETS: "0xwhale1,0xwhale2,..."
    CLOB_HOST: "https://fly-polymarket-proxy.fly.dev"
    GAMMA_HOST: "https://gamma-api.polymarket.com"
```

**`pipeline/polymarket-ctf-events.yaml`** — set the same wallet list in the `watched_fills` transform (the pipeline pre-filters on-chain events, so the same list must appear here too).

### 3. Set the private key secret

```bash
goldsky compose secret set PRIVATE_KEY --value "0x..."
```

### 4. Deploy

```bash
# Compose app
goldsky compose deploy

# Webhook auth secret (so Turbo can call the Compose HTTP endpoint)
goldsky secret create --name COMPOSE_WEBHOOK_AUTH \
  --value '{"type": "httpauth", "secretKey": "Authorization", "secretValue": "Bearer YOUR_COMPOSE_API_TOKEN"}'

# Turbo pipeline (update the webhook URL in the YAML first to match your app name)
goldsky turbo apply pipeline/polymarket-ctf-events.yaml
```

### 5. Fund the wallet

Send USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) on Polygon to the EOA. No MATIC needed — Compose sponsors gas for all on-chain calls.

### 6. Grant approvals (one time)

```bash
curl -X POST -H "Authorization: Bearer $COMPOSE_TOKEN" \
  https://api.goldsky.com/api/admin/compose/v1/copy-trader/tasks/setup_approvals
```

This grants MAX_UINT256 USDC allowance to the CTF Exchange + NegRisk Exchange, and `setApprovalForAll` on ConditionalTokens for both exchanges. Four sponsored on-chain transactions.

---

## Operating

### Get a status snapshot

```bash
curl -sS -X POST -H "Authorization: Bearer $COMPOSE_TOKEN" \
  https://api.goldsky.com/api/admin/compose/v1/copy-trader/tasks/status | jq
```

Returns JSON with wallet address, USDC balance, watched wallets, latest trade, trade counts, open/resolved positions, PnL.

### Logs

```bash
goldsky compose logs -n copy-trader
goldsky turbo logs polymarket-ctf-events
```

### Stream of meaningful events

```bash
goldsky compose logs -n copy-trader | \
  grep -E "TRADE_EXECUTED|TRADE_FAILED|NO_POSITION|BALANCE_LOW|REDEEMED|REDEEMING"
```

---

## Configuration reference

| Env Var           | Description                                                   | Default |
|-------------------|---------------------------------------------------------------|---------|
| `PRIVATE_KEY`     | Wallet private key (secret, not env)                          | —       |
| `WATCHED_WALLETS` | Comma-separated wallets to copy                               | —       |
| `TRADE_AMOUNT_USD`| Per-trade USD amount (min \$1)                                | `1`     |
| `CLOB_HOST`       | Polymarket CLOB proxy URL                                     | Fly proxy |
| `GAMMA_HOST`      | Polymarket Gamma API                                          | mainnet |

---

## How each task works

### `copy_trade` — HTTP, called by the Turbo webhook

1. Receives an `OrderFilled` row from the pipeline
2. Determines if the watched wallet is buying or selling (by matching against `WATCHED_WALLETS`)
3. Looks up the market via Gamma API (tickSize, negRisk flag, feeRateBps)
4. For BUY: checks on-chain USDC.e balance ≥ \$1.10
5. For SELL: queries Polymarket data API to confirm we hold shares; uses actual on-chain size
6. Builds + signs a FAK (Fill-and-Kill) market order locally using `@polymarket/clob-client` signing utilities
7. Derives L1/L2 API creds and POSTs the order via `ctx.fetch` → Fly proxy → CLOB

### `redeem` — cron, every 5 minutes

1. Queries `data-api.polymarket.com/positions` for the wallet's redeemable positions
2. For each unique conditionId, calls `redeemPositions(collateral, parentCollectionId, conditionId, [1, 2])` on ConditionalTokens
3. Index sets `[1, 2]` burns both YES and NO holdings for that condition in one tx
4. Gas is sponsored

### `setup_approvals` — HTTP, one time

Grants USDC approval to both exchange contracts and `setApprovalForAll` on ConditionalTokens. Re-runnable, idempotent.

### `status` — HTTP

Returns a JSON snapshot of bot state — designed for dashboards or `curl | jq`.

---

## Key contracts (Polygon)

| Contract             | Address                                      |
|----------------------|----------------------------------------------|
| CTF Exchange         | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| NegRisk Exchange     | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| ConditionalTokens    | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e (collateral)  | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

---

## Finding wallets to copy

The `docs/solutions/integration-issues/finding-profitable-polymarket-traders.md` doc walks through the methodology: deploy a Turbo pipeline that sinks the `polymarket.pnl.user_positions` Kafka topic to ClickHouse, then query for profitable, active traders.

Good heuristics:
- Win rate ≥ 85%
- Active in the last 7 days
- Avg position size ≤ $500 (so you can copy at \$1 without diverging wildly)
- Primarily BUYS (so you get entry signals, not just exit signals on positions you don't hold)

---

## Safety

- **On-chain balance check** — BUY skipped if USDC < \$1.10
- **Position check** — SELL skipped if we don't actually hold the shares on-chain
- **FAK orders only** — unfilled orders don't sit on the book
- **Tiny position size** — default is Polymarket's \$1 minimum, so a run-away whale won't drain the wallet
- **Auto-redeem** — winning shares auto-redeem within 5 minutes of resolution

---

## Limitations

- Polymarket geo-block means the Fly proxy is load-bearing. If it goes down, trading halts.
- CLOB API rate limits aren't handled with backoff; very active whales (>10 trades/min) could hit them.
- No P&L tracking in this app — positions clear from the data API after redemption. Use a separate indexer for historical PnL.
