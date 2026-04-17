---
title: "Polymarket Whale Copy-Trading Bot"
type: feat
status: active
date: 2026-04-16
origin: docs/brainstorms/2026-04-16-whale-copy-trading-brainstorm.md
deepened: 2026-04-16
---

# Polymarket Whale Copy-Trading Bot

## Enhancement Summary

**Sections enhanced:** Pipeline config, cursor logic, CLOB integration, safety, architecture
**Key improvements:**
1. Concrete pipeline YAML with proper `evm_log_decode` syntax and both contracts in one pipeline
2. Cursor-based polling using `(block_number, log_index)` composite key with gap handling
3. Use `@polymarket/clob-client` SDK (not raw viem signing) — it's the only maintained EIP-712 implementation
4. Security hardening: parameterized SQL, contract address validation, never log private key

## Overview

A self-contained template: Turbo pipeline + Compose app that copies trades from specified Polymarket wallets. User brings their wallet, picks wallets to follow, deploys, done.

(see brainstorm: docs/brainstorms/2026-04-16-whale-copy-trading-brainstorm.md)

## Implementation Phases

### Phase 1: Turbo Pipeline

Single pipeline indexing both contracts (CTF Exchange + ConditionalTokens) on Polygon.

**File:** `pipeline/polymarket-ctf-events.yaml`

```yaml
name: polymarket-ctf-events
resource_size: s
description: "Index Polymarket CTF Exchange fills and condition resolutions on Polygon"

sources:
  poly_logs:
    type: dataset
    dataset_name: matic.raw_logs
    version: 1.0.0
    start_at: latest
    filter: >-
      address IN (
        '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
        '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'
      )

transforms:
  decoded_events:
    type: sql
    primary_key: id
    sql: |
      SELECT
        id,
        block_number,
        log_index,
        transaction_hash,
        address AS contract_address,
        to_timestamp(block_timestamp) AS block_timestamp,
        evm_log_decode(
          '[{"anonymous":false,"inputs":[{"indexed":true,"name":"orderHash","type":"bytes32"},{"indexed":false,"name":"maker","type":"address"},{"indexed":false,"name":"taker","type":"address"},{"indexed":false,"name":"makerAssetId","type":"uint256"},{"indexed":false,"name":"takerAssetId","type":"uint256"},{"indexed":false,"name":"makerAmountFilled","type":"uint256"},{"indexed":false,"name":"takerAmountFilled","type":"uint256"},{"indexed":false,"name":"fee","type":"uint256"}],"name":"OrderFilled","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"conditionId","type":"bytes32"},{"indexed":true,"name":"oracle","type":"address"},{"indexed":true,"name":"questionId","type":"bytes32"},{"indexed":false,"name":"outcomeSlotCount","type":"uint256"},{"indexed":false,"name":"payoutNumerators","type":"uint256[]"}],"name":"ConditionResolution","type":"event"}]',
          topics,
          `data`
        ) AS `decoded`
      FROM poly_logs

  order_fills:
    type: sql
    primary_key: id
    sql: |
      SELECT
        id, block_number, log_index, transaction_hash, block_timestamp,
        `decoded`.event_params[2] AS maker,
        `decoded`.event_params[3] AS taker,
        `decoded`.event_params[4] AS maker_asset_id,
        `decoded`.event_params[5] AS taker_asset_id,
        CAST(`decoded`.event_params[6] AS DOUBLE) / 1e6 AS maker_amount,
        CAST(`decoded`.event_params[7] AS DOUBLE) / 1e6 AS taker_amount,
        CAST(`decoded`.event_params[8] AS DOUBLE) / 1e6 AS fee
      FROM decoded_events
      WHERE `decoded`.event_signature = 'OrderFilled'

  resolutions:
    type: sql
    primary_key: id
    sql: |
      SELECT
        id, block_number, log_index, transaction_hash, block_timestamp,
        `decoded`.event_params[1] AS condition_id
      FROM decoded_events
      WHERE `decoded`.event_signature = 'ConditionResolution'

sinks:
  order_fills_sink:
    type: postgres
    from: order_fills
    table: order_fills
    secret_name: POSTGRES_SECRET
    primary_key: id
  resolutions_sink:
    type: postgres
    from: resolutions
    table: resolutions
    secret_name: POSTGRES_SECRET
    primary_key: id
```

**Key details:**
- Both contracts in one source with `IN` filter
- `evm_log_decode` handles both event ABIs in one call, split downstream by `event_signature`
- Amounts divided by 1e6 (USDC decimals) at the transform layer
- Two separate sink tables for clean separation
- Backtick-escape `data` and `decoded` (reserved words in Turbo SQL)

**Deliverables:**
- [ ] `pipeline/polymarket-ctf-events.yaml`
- [ ] `pipeline/README.md` — deploy instructions
- [ ] Validate with `goldsky turbo validate pipeline/polymarket-ctf-events.yaml`
- [ ] Test with `goldsky turbo apply pipeline/polymarket-ctf-events.yaml`

### Phase 2: Compose App — Core

**File structure:**
```
compose.yaml
package.json
src/
  tasks/
    watch_wallets.ts    # cron — poll pipeline sink for new events
    copy_trade.ts       # called by watch_wallets — execute CLOB order
    redeem.ts           # cron — auto-redeem resolved positions
  lib/
    clob.ts             # @polymarket/clob-client wrapper
    gamma.ts            # Gamma API — token ID → market lookup
    types.ts            # shared types
```

**compose.yaml:**
```yaml
name: "bot-composer"
api_version: "stable"
secrets:
  - PRIVATE_KEY
  - POSTGRES_URL
env:
  cloud:
    COPY_WALLETS: "0xWhale1,0xWhale2"
    TRADE_AMOUNT_USD: "50"
    MAX_BUDGET_USD: "1000"
    CLOB_HOST: "https://clob.polymarket.com"
    GAMMA_HOST: "https://gamma-api.polymarket.com"
tasks:
  - name: "watch_wallets"
    path: "./src/tasks/watch_wallets.ts"
    triggers:
      - type: "cron"
        expression: "*/5 * * * * *"
  - name: "copy_trade"
    path: "./src/tasks/copy_trade.ts"
  - name: "redeem"
    path: "./src/tasks/redeem.ts"
    triggers:
      - type: "cron"
        expression: "0 */5 * * * *"
```

**CLOB Auth — Use the SDK, not raw viem:**

The `@polymarket/clob-client` SDK is the only maintained implementation of Polymarket's EIP-712 signing (order struct hashing, salt generation, nonce management). Rolling our own with viem is error-prone. The SDK uses ethers.js internally — that's fine.

```ts
// src/lib/clob.ts
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

export async function createClobClient(privateKey: string, host: string) {
  const wallet = new Wallet(privateKey);
  const tempClient = new ClobClient(host, 137, wallet);
  const creds = await tempClient.createOrDeriveApiKey();
  return new ClobClient(host, 137, wallet, creds);
}
```

No separate CLOB_API_KEY/SECRET/PASSPHRASE secrets needed — the SDK derives them from the private key.

**Task: watch_wallets.ts**

Cursor: composite `(block_number, log_index)` — not auto-increment ID, because Turbo can insert out of order during reorgs.

```ts
export async function main(ctx: TaskContext) {
  const cursor = await ctx.collection("cursor").findOne({ key: "order_fills" });
  const lastBlock = cursor?.block_number ?? 0;
  const lastLog = cursor?.log_index ?? 0;
  const wallets = process.env.COPY_WALLETS.split(",").map(w => w.toLowerCase());

  // Parameterized query — never interpolate wallet addresses into SQL
  const rows = await queryPostgres(
    `SELECT * FROM order_fills
     WHERE (block_number, log_index) > ($1, $2)
       AND (LOWER(maker) = ANY($3) OR LOWER(taker) = ANY($3))
     ORDER BY block_number, log_index
     LIMIT 50`,
    [lastBlock, lastLog, wallets]
  );

  for (const row of rows) {
    const side = determineSide(row, wallets); // buy or sell
    const tokenId = side === "BUY" ? row.maker_asset_id : row.taker_asset_id;

    await ctx.callTask("copy_trade", { tokenId, side, whalePrice: row.taker_amount / row.maker_amount });

    // Advance cursor after each successful trade
    await ctx.collection("cursor").setById("order_fills", {
      key: "order_fills",
      block_number: row.block_number,
      log_index: row.log_index
    });
  }
}
```

**Task: copy_trade.ts**

```ts
export async function main(ctx: TaskContext, params: CopyTradeParams) {
  const budget = await ctx.collection("budget").findOne({ key: "global" });
  if (budget && budget.remaining <= 0) {
    ctx.logEvent({ code: "BUDGET_EXHAUSTED", message: "Skipping trade" });
    return;
  }

  // 1. Gamma lookup
  const market = await lookupMarket(params.tokenId);
  if (!market || !market.enableOrderBook) return;

  // 2. Place order via CLOB SDK
  const client = await createClobClient(process.env.PRIVATE_KEY, process.env.CLOB_HOST);
  const tradeAmount = parseFloat(process.env.TRADE_AMOUNT_USD);

  if (params.side === "BUY") {
    await client.createAndPostMarketOrder(
      { tokenID: params.tokenId, price: market.price, amount: tradeAmount, side: Side.BUY },
      { tickSize: market.orderPriceMinTickSize, negRisk: market.negRiskOther },
      OrderType.FAK
    );
  } else {
    // Sell: sell our full position in this market
    const position = await ctx.collection("positions").findOne({ tokenId: params.tokenId });
    if (!position || position.size <= 0) return;
    await client.createAndPostMarketOrder(
      { tokenID: params.tokenId, price: market.price, amount: position.size, side: Side.SELL },
      { tickSize: market.orderPriceMinTickSize, negRisk: market.negRiskOther },
      OrderType.FAK
    );
  }

  // 3. Update collections
  await updatePositions(ctx, params);
  await recordTrade(ctx, params, market);
  await decrementBudget(ctx, tradeAmount);
}
```

**Task: redeem.ts**

```ts
export async function main(ctx: TaskContext) {
  const positions = await ctx.collection("positions").findMany({ status: "open" });

  for (const pos of positions) {
    // Check Gamma for resolution
    const market = await lookupMarket(pos.tokenId);
    if (!market?.closed) continue;

    // Redeem on-chain via Compose wallet (ConditionalTokens.redeemPositions)
    await ctx.wallet.callContract({
      address: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
      abi: conditionalTokensAbi,
      functionName: "redeemPositions",
      args: [USDC_ADDRESS, pos.conditionId, pos.indexSets]
    });

    await ctx.collection("positions").setById(pos.id, { ...pos, status: "redeemed" });
  }
}
```

**Deliverables:**
- [ ] `compose.yaml`
- [ ] `package.json` — deps: `@polymarket/clob-client`, `@ethersproject/wallet`, `viem`, `pg`
- [ ] `src/tasks/watch_wallets.ts`
- [ ] `src/tasks/copy_trade.ts`
- [ ] `src/tasks/redeem.ts`
- [ ] `src/lib/clob.ts`
- [ ] `src/lib/gamma.ts`
- [ ] `src/lib/types.ts`

### Phase 3: Safety & Edge Cases

- [ ] **Budget tracking** — global, decremented on fill confirmation. Skip when exhausted.
- [ ] **Sell-side logic** — sell our full position (not fixed amount)
- [ ] **Slippage guard** — skip if best ask is >5% worse than whale's fill price
- [ ] **USDC approval** — README instructions for one-time `approve()` on CTF Exchange + ConditionalTokens. The proxy wallet pattern means the proxy must have the approval, not the EOA.
- [ ] **Dedup across wallets** — if two watched wallets buy same market in same poll cycle, trade once
- [ ] **Gamma API failure** — skip trade, log warning, move on
- [ ] **CLOB order rejection** — log and move on (no retry)
- [ ] **Contract address validation** — validate `order_fills` rows come from expected contract
- [ ] **Parameterized SQL everywhere** — never interpolate wallet addresses into queries
- [ ] **Never log PRIVATE_KEY** — isolate signing in `clob.ts`, never stringify or log the key
- [ ] **Min order size** — enforce $1 minimum (CLOB rejects below this). If `TRADE_AMOUNT_USD * price < 1`, round up.
- [ ] **negRisk flag** — must come from Gamma's `negRiskOther` field per market. Wrong value = order rejection.
- [ ] **Checksum wallet addresses** — validate `COPY_WALLETS` at startup

### Phase 4: Template & Docs

- [ ] `README.md` — end-to-end setup:
  1. Deploy Turbo pipeline
  2. Set up Postgres (or use Goldsky-managed)
  3. Approve USDC for CTF Exchange + ConditionalTokens
  4. Configure secrets + env vars
  5. Deploy Compose app
- [ ] `.env.example`
- [ ] How to find whale wallet addresses (Polygonscan, Polymarket leaderboard)

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pipeline sink | Postgres | Simple OLTP reads from Compose tasks |
| Pipeline structure | One pipeline, two sinks | Decode once, filter by event_signature, separate tables |
| Event detection | Cursor `(block_number, log_index)` | Chain-canonical ordering; handles out-of-order inserts |
| CLOB signing | `@polymarket/clob-client` SDK | Only maintained EIP-712 impl; derives creds from private key |
| Market lookup | Gamma API per-trade | No cache for v1 |
| Order type | FAK (Fill-and-Kill) | Immediate market order execution |
| Budget scope | Global | Single pool across all watched wallets |
| Task separation | Detect (watch) vs Execute (copy_trade) | Signing failure shouldn't break polling loop |
| Redeem frequency | Every 5 min | Resolutions are infrequent; don't over-poll |

## Acceptance Criteria

- [ ] Turbo pipeline indexes OrderFilled + ConditionResolution from both Polymarket contracts
- [ ] Compose app detects watched wallet trades within one poll cycle (~5s)
- [ ] Places matching CLOB order with correct market/side/amount/negRisk
- [ ] Copies both entries and exits
- [ ] Auto-redeems winning shares on resolution
- [ ] Stops copying when max budget exhausted
- [ ] Cursor-based dedup — never double-trades on same event
- [ ] Handles out-of-order pipeline inserts (no gap-jumping)
- [ ] Deployable by anyone with a Goldsky account + Polymarket wallet

## Dependencies

- `@polymarket/clob-client` — CLOB SDK (includes EIP-712 signing)
- `@ethersproject/wallet` — wallet for CLOB SDK
- `viem` — on-chain redemption calls
- `pg` — Postgres client for pipeline sink queries
- Goldsky Turbo — pipeline deployment
- Goldsky Compose — app runtime

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-04-16-whale-copy-trading-brainstorm.md](../brainstorms/2026-04-16-whale-copy-trading-brainstorm.md)
- Existing Compose arbor bot: `~/Developer/endlesssky/arbor/`
- Existing standalone Arbor: `~/Developer/Other/arbor/`
- Polymarket CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- ConditionalTokens: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- NegRisk Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- USDC (Polygon): `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- Gamma API: `https://gamma-api.polymarket.com`
- CLOB API: `https://clob.polymarket.com`
