# Whale Copy-Trading Bot — Brainstorm

**Date:** 2026-04-16
**Status:** Done

## What We're Building

A Compose-powered bot that watches specified Polymarket wallets and automatically mirrors their trades. User brings their own wallet and a list of wallets to copy. That's it.

**Core loop:**
1. Goldsky pipeline indexes Polymarket CTF Exchange events on Polygon, filtered to watched wallets
2. Compose task detects position changes (buys, sells) → places matching trades via Polymarket CLOB API
3. Compose task watches for market resolutions → auto-redeems winning shares
4. Compose collections track watched wallets, mirrored positions, trade history

## Key Decisions

- **Trade sizing:** Fixed dollar amount per trade (e.g. $50), not proportional to whale
- **Exits:** Full mirror — copy entries AND exits
- **Redemptions:** Auto-redeem winning shares on market resolution
- **Notifications:** Logs only (no Telegram for v1)
- **Safety:** Max budget cap — stop copying when exhausted
- **Tenancy:** Single-user. One Compose app = one user's setup
- **Whale identification:** None. User picks the wallets they want to follow

## Why This Approach

- **Simple** — no scoring engine, no leaderboard, no multi-tenancy
- **Shows off the stack** — Goldsky pipeline (indexing) + Compose (logic/execution) working together
- **Real utility** — copy-trading is a proven product category
- **Doesn't need low latency** — whale positions are held hours/days, not milliseconds

## Architecture (High Level)

Two independent, composable pieces:

### 1. Standalone Turbo Pipeline (published separately)
Indexes Polymarket CTF Exchange events on Polygon. Deployable by anyone — not coupled to the Compose app.

- Source: Polygon chain data
- Events: `OrderFilled`, `TransferSingle`/`TransferBatch`, `ConditionResolution`
- Sink: configurable (Postgres, Kafka, etc.)

### 2. Compose App
Consumes pipeline output, executes copy trades.

```
Turbo Pipeline (Polygon CTF events)
  │
  ▼
Compose App
  ├─ Task: watch_wallets (cron) — detect new positions/exits from pipeline sink
  ├─ Task: copy_trade (triggered) — look up market via Polymarket API, sign order with viem, execute via CLOB
  ├─ Task: redeem (cron) — auto-redeem resolved winning positions
  │
  ├─ Collection: positions — mirrored positions and their status
  └─ Collection: trades — execution history and P&L
```

### Key Implementation Details
- **EIP-712 signing** via viem in task code (Compose wallet management is for on-chain txs)
- **Market lookup** via Polymarket API on each trade (no cache — keep it simple)
- **Template-friendly** — anyone can deploy their own pipeline + Compose app with their own config

## User Config

```yaml
# compose.yaml (or env vars)
my_wallet: "0xMyWallet..."
copy_wallets:
  - "0xWhale1..."
  - "0xWhale2..."
trade_amount_usd: 50
max_budget_usd: 1000
```

## Resolved Questions

1. **Latency** — Pipeline delay is acceptable. Whale positions are held hours/days. As soon as pipeline picks up the event, we fire.
2. **CLOB auth** — Use viem for EIP-712 signing in task code. Compose wallet management is for on-chain txs, not CLOB signing.
3. **Market mapping** — Look up token ID → market via Polymarket API on each trade. No cache for v1.
4. **Architecture** — Standalone Turbo pipeline + Compose app as two independent pieces. Template-friendly.

## Open Questions

None — ready for planning.
