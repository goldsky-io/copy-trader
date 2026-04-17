---
title: "Discovering profitable Polymarket traders on specific market types via Goldsky PnL pipeline"
category: integration-issues
date: 2026-04-17
tags: [polymarket, clickhouse, turbo-pipeline, compose, research]
problem_type: research-methodology
component: polymarket-pnl-pipeline
symptom: "Gamma API rate limits and 200-row trades cap prevent accurate trader discovery; naive PnL-sorted queries surface sports bettors instead of crypto traders on BTC 5m markets"
root_cause: "Polymarket's public APIs lack bulk trader-level aggregation, and the Kafka PnL topic (polymarket.pnl.user_positions) exposes only token_id and user with no market metadata, requiring a join step that collects BTC 5m token IDs from Gamma (via btc-updown-5m-{timestamp} slug pattern) and filters ClickHouse PnL data against them to isolate market-type-specific traders"
---

## Problem

Finding a profitable, active trader on Polymarket's 5-minute BTC up/down markets for copy-trading. The straightforward approach — brute-forcing Polymarket's Gamma/data API — fails because:

- The public API is aggressively rate-limited
- The `/trades` endpoint caps at 200 trades per market, so high-volume markets return incomplete data
- Iterating across hundreds of 5-minute markets and thousands of wallets would take hours and still produce gaps

## Root Cause

Polymarket's public REST APIs are designed for UI consumption, not analytical workloads. Per-market pagination caps and per-IP rate limits make it impossible to reconstruct an accurate leaderboard of per-user PnL across a narrow slice of markets (like "all BTC 5m markets in the last 24h") from the outside.

Goldsky already ingests Polymarket position/PnL state into a Kafka topic (`polymarket.pnl.user_positions`), which is the same data that backs Polymarket's own leaderboards. Routing that topic into ClickHouse lets you answer the question with a single SQL query instead of thousands of HTTP calls.

## Solution

Sink the `polymarket.pnl.user_positions` Kafka topic into ClickHouse via a Goldsky Turbo pipeline, collect the CTF token IDs for the target markets (BTC 5m) via a small one-shot script against the Gamma API, then query ClickHouse for top PnL wallets filtered to those tokens. Finally, cross-check the top candidates against the Polymarket data API to reject false positives (e.g., sports bettors whose headline PnL comes from unrelated markets).

### Step 1: Deploy the PnL pipeline

Deploy this Turbo pipeline to the Goldsky "community" project. It reads the existing Polymarket PnL Kafka topic, normalizes the `user_addr` column to `user`, maps soft-deletes to ClickHouse `_gs_op`, and writes to `polymarket_user_positions_pnl` in the blockchain warehouse.

```yaml
name: polymarket-pnl-community
resource_size: s
job: false
sources:
  user_positions:
    type: kafka
    topic: polymarket.pnl.user_positions
transforms:
  user_positions_transform:
    type: sql
    primary_key: user,token_id
    sql: >-
      SELECT * EXCEPT (_sm_version, _sm_deleted, _gs_op, user_addr), user_addr
      AS user, CASE WHEN _sm_deleted = false THEN 'i' ELSE 'd' END AS _gs_op
      FROM user_positions
sinks:
  clickhouse_sink:
    type: clickhouse
    from: user_positions_transform
    table: polymarket_user_positions_pnl
    secret_name: GS_BLOCKCHAIN_WAREHOUSEV2_CH
    primary_key: user,token_id
    batch_size: 10000
    batch_flush_interval: 10s
    parallelism: 4
```

Resulting ClickHouse table shape:

| Column | Type | Notes |
| --- | --- | --- |
| `token_id` | `String` | CTF position token ID |
| `user` | `String` | Wallet address (lowercased) |
| `amount` | `Nullable(String)` | Raw USDC units — divide by `1e6` |
| `avg_price` | `Nullable(String)` | Raw units — divide by `1e6` |
| `realized_pnl` | `Nullable(String)` | Raw USDC units — divide by `1e6` |
| `total_bought` | `Nullable(String)` | Raw USDC units — divide by `1e6` |
| `last_updated_block` | `Nullable(Int64)` | |
| `is_deleted` | `UInt8` | Filter to `0` for active positions |

### Step 2: Collect target-market token IDs

BTC 5m markets have predictable slugs of the form `btc-updown-5m-<unix_ts>` where `<unix_ts>` increments by 300 seconds. Walk backward from a known-recent timestamp to enumerate the last 24 hours (288 markets) and collect every `clobTokenIds` entry.

```python
import json, urllib.request, time

base_ts = 1776395400  # a known recent btc-updown-5m timestamp (increments of 300s)
tokens = []
for i in range(288):  # 24h = 288 5-min markets
    ts = base_ts - (i * 300)
    url = f"https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, timeout=10)
    events = json.loads(resp.read())
    if events and events[0].get('markets'):
        for m in events[0]['markets']:
            tokens.extend(json.loads(m.get('clobTokenIds', '[]')))
    time.sleep(0.3)  # rate limit
```

This is the only place you touch the public API, and it's fast (~90s) because you're hitting one event per request, not paginating trades.

### Step 3: Query ClickHouse for candidates

Aggregate PnL per wallet, scoped to the collected token IDs and active positions only. Require at least 10 unique markets to filter out one-off punters.

```sql
SELECT
  user,
  count() as num_positions,
  countDistinct(token_id) as unique_markets,
  sum(toFloat64OrZero(realized_pnl))/1e6 as total_pnl_usd,
  sum(toFloat64OrZero(total_bought))/1e6 as total_volume_usd,
  total_pnl_usd / total_volume_usd as pnl_ratio
FROM polymarket_user_positions_pnl
WHERE token_id IN (<collected_tokens>)
  AND is_deleted = 0
GROUP BY user
HAVING unique_markets >= 10
ORDER BY total_pnl_usd DESC
LIMIT 30
```

### Step 4: Verify candidates

If you sort the full PnL table without the `token_id IN (...)` filter, the top wallets are sports bettors (tennis, NBA, etc.) with huge PnL from unrelated markets. The `token_id` filter in Step 3 handles this, but before committing to a copy-trade target also spot-check each candidate against the data API to confirm their current positions really are in BTC 5m markets:

```bash
curl -s "https://data-api.polymarket.com/positions?user=${WALLET}&limit=5&sortBy=CURRENT&sortOrder=DESC"
```

A legitimate candidate's top current positions should be BTC 5m (or at least crypto prediction) markets, not sports.

## Example Result

Wallet `0x21d0a97aac03917e752857a551bbe5103a00e8d7`:

- 135 unique BTC 5m markets traded
- $8.1K realized PnL
- ~17% return ratio on total volume
- High-frequency, consistently active across the full 24h window

End-to-end runtime: one pipeline deploy, ~90 seconds of Gamma API scraping, one ClickHouse query. No rate-limit pain, no 200-trade caps.

## Prevention & Best Practices

### Key gotchas

- **Don't hammer the Polymarket Gamma/data API in tight loops.** It rate-limits aggressively and returns HTTP 403 once you trip the threshold. Add backoff, cache responses locally, and batch lookups — or better, use a warehoused copy of the data.
- **Remember that `data-api.polymarket.com/trades` caps responses at 200 rows per market.** Heavy-volume traders who place many small orders will be silently undercounted. Don't rank traders on trade counts or filled volume from this endpoint — paginate via timestamp cursors or pull from an indexed source.
- **Don't sort the global PnL table by total PnL and assume the top is your target cohort.** The PnL view has no market-type metadata, so sports bettors and election whales dominate. Always filter to the specific market set (by condition_id, slug pattern, or resolved token ID list) *before* ranking.
- **Don't rely on Gamma's `slug_contains` for bulk discovery.** It doesn't behave as a substring filter for mass queries. Use exact-slug lookups or, for pattern matching, query a warehoused `markets` table with SQL `LIKE` / regex.
- **Remember that resolved/closed markets are excluded from Gamma by default.** Looking up token IDs from historical positions will return empty for anything past its resolution date. Pass `closed=true` / `active=false` explicitly, or query the on-chain/warehoused history instead of the live API.

### Generalizable principles

- **When an API has pagination limits, rate limits, or missing filter semantics, pre-materialize the full dataset in a queryable warehouse (ClickHouse, DuckDB, Postgres) before doing analysis.** Ad-hoc API loops are a trap: every new slice of the question triggers another rate-limit dance, and caps like "200 rows per market" silently corrupt results. One ingestion pass, then unlimited SQL, beats N fragile loops.
- **Push filtering to the most metadata-rich layer available.** If the goal is "profitable traders on BTC 5m up/down markets," the filter must happen where both (a) trader-level PnL and (b) market-type metadata coexist. If those live in different systems, join them first — don't rank in one and hope the top-K happens to match the cohort.

### Verification

Any PnL-based leaderboard must be cross-referenced against market metadata before it can be trusted. A wallet's aggregate PnL is meaningless without knowing *which markets* produced it — a $50k profit from a single Super Bowl parlay is not evidence of crypto-trading skill. Before quoting a trader as a target, verify:

1. Their PnL on the specific market type (not global PnL).
2. Their trade count on that market type is non-trivial (not one lucky fill).
3. The activity is recent enough to indicate they're still active, not a dormant wallet.

Skipping this step is how you end up pitching a crypto product to a sports bettor.

## Related

### Internal docs
- Brainstorm: [`docs/brainstorms/2026-04-16-whale-copy-trading-brainstorm.md`](../../brainstorms/2026-04-16-whale-copy-trading-brainstorm.md) — upstream thinking on why PnL ranking matters
- Plan: [`docs/plans/2026-04-16-001-feat-polymarket-whale-copy-trader-plan.md`](../../plans/2026-04-16-001-feat-polymarket-whale-copy-trader-plan.md) — downstream plan that consumes the trader list

### Pipeline artifacts
- Pipeline config: [`pipeline/polymarket-pnl-community.yaml`](../../../pipeline/polymarket-pnl-community.yaml) — Turbo pipeline sinking Polymarket PnL to ClickHouse

### Related issues
- Linear STRM-5841 — Turbo webhook sink `skip_on_error` bug that blocked the main copy-trade pipeline deploy; relevant if reproducing this work alongside the copy-trade webhook flow

### External references
- [Polymarket CTF Exchange](https://polygonscan.com/address/0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E) — source of `OrderFilled` events
- [Polymarket ConditionalTokens](https://polygonscan.com/address/0x4D97DCd97eC945f40cF65F87097ACe5EA0476045) — position token contract
- [Polymarket Gamma API](https://gamma-api.polymarket.com) — market metadata
- [Polymarket data API](https://data-api.polymarket.com) — leaderboards and per-user positions for verification
