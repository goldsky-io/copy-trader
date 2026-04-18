# CLAUDE.md

Instructions for AI assistants (Claude Code, Copilot, etc.) working on this repo.

## What this is

An example Goldsky Compose + Turbo app that copy-trades wallets on Polymarket. Intended as a reference template for new Compose users. See `README.md` for the user-facing overview.

## Key conventions

- **Task HTTP calls:** always use `ctx.fetch`, never raw `fetch` or SDK-internal HTTP. See `docs/solutions/integration-issues/compose-tasks-calling-external-apis.md`.
- **Collections:** `ctx.collection()` returns a `Promise<Collection<T>>` — always `await` it. Extract the handle once at the top of each task.
- **On-chain state > local state:** USDC balance, position holdings, market resolution all queried from chain / Polymarket data API rather than tracked in local Compose collections (local counters drift; chain is truth).
- **Signing:** reuse pure signing utilities from `@polymarket/clob-client/dist/signing/*` and `@polymarket/clob-client/dist/order-builder/builder.js`. Never construct the `ClobClient` class — its methods use axios which Deno blocks.

## Finding new wallets to copy

The full methodology is in [`docs/solutions/integration-issues/finding-profitable-polymarket-traders.md`](./docs/solutions/integration-issues/finding-profitable-polymarket-traders.md). TL;DR for an LLM:

### Prerequisites

- `goldsky` CLI authenticated
- Access to the Goldsky `community` project (API key on the Goldsky team's internal tools)
- The `polymarket-pnl-community` Turbo pipeline deployed on the community project (yaml is in `pipeline/polymarket-pnl-community.yaml`, sinks to the `polymarket_user_positions_pnl` ClickHouse table in blockchain-warehouse-v2)

### Get ClickHouse credentials

The credentials live in a Goldsky secret. Do NOT hardcode them.

```bash
# Switch to community project
goldsky login --token <community-project-token>

# Reveal the ClickHouse connection
goldsky secret reveal GS_BLOCKCHAIN_WAREHOUSEV2_CH
```

The reveal returns JSON:
```json
{
  "type": "clickHouse",
  "url": "clickhouse://<host>:8443?ssl=true",
  "username": "default",
  "password": "<password>",
  "databaseName": "default"
}
```

Use the HTTPS variant of the host (`https://<host>:8443`) with basic auth for queries.

### Useful queries

See the solution doc for examples. The table schema is:

| Column | Type | Notes |
| --- | --- | --- |
| `token_id` | `String` | CTF position token ID |
| `user` | `String` | Wallet address (lowercased) |
| `amount` | `Nullable(String)` | Raw USDC units — divide by `1e6` |
| `avg_price` | `Nullable(String)` | Raw units — divide by `1e6` |
| `realized_pnl` | `Nullable(String)` | Raw USDC units — divide by `1e6` |
| `total_bought` | `Nullable(String)` | Raw USDC units — divide by `1e6` |
| `last_updated_block` | `Nullable(Int64)` | Polygon block number |
| `is_deleted` | `UInt8` | Filter to `0` |

**Core "find active profitable wallets" query:**
```sql
SELECT
  user,
  count() as positions,
  round(countIf(toFloat64OrZero(realized_pnl) > 0) / count() * 100, 1) as win_rate_pct,
  round(sum(toFloat64OrZero(realized_pnl))/1e6, 0) as pnl_usd,
  round(avg(toFloat64OrZero(total_bought))/1e6, 0) as avg_pos_usd
FROM polymarket_user_positions_pnl
WHERE is_deleted = 0
GROUP BY user
HAVING positions >= 100 AND win_rate_pct >= 80 AND pnl_usd > 500
ORDER BY pnl_usd DESC
LIMIT 30
```

**Last 7 days only** — approximate block range: get `max(last_updated_block)` minus `302400` (~7 days at 2s blocks).

**Filter to specific market type** (e.g. BTC 5m): collect the `clobTokenIds` from Gamma for the target events and use `token_id IN (...)`.

### Verifying candidates

`user` in the ClickHouse table is the Polymarket **proxy wallet address**, which is also what appears as `maker` / `taker` in CTF Exchange OrderFilled logs. Verify any candidate's actual trading profile by calling Polymarket's data API:
```
GET https://data-api.polymarket.com/positions?user=<wallet>
GET https://data-api.polymarket.com/trades?user=<wallet>&limit=30
```

This returns the market titles and recent trades — useful for confirming the wallet actually trades what you expect (crypto, sports, weather, etc.) rather than being surfaced by a flaw in the aggregate query.

### ClickHouse safety

**NEVER run a write query** (CREATE/DROP/INSERT/ALTER/DELETE) against the community ClickHouse without explicit user approval. Read-only `SELECT` queries only. The warehouse is shared with the rest of the Goldsky team.

## Workflow notes

- `api_version: "preview"` follows main. If you hit a new bug after a preview rebuild, pin to a specific SHA from `streamling` / `compose-cloud` release notes.
- After `goldsky compose deploy`, run `goldsky compose pause` + `goldsky compose resume` to force a fresh image pull — the preview tag is cached aggressively.
- Webhook sinks and the `skip_on_error` field: requires `streamling` with PR #662 merged. If you see `unknown field 'skip_on_error'` errors on apply, the runtime is older than 2026-04-17.

## Related docs

- `docs/brainstorms/2026-04-16-whale-copy-trading-brainstorm.md` — original design discussion
- `docs/plans/2026-04-16-001-feat-polymarket-whale-copy-trader-plan.md` — plan with "shipped state" diff
- `docs/solutions/integration-issues/` — reusable patterns documented during development
- External: `goldsky-io/fly-polymarket-proxy` — the geo-unblock proxy (deploy your own if you want to isolate from the shared one)
