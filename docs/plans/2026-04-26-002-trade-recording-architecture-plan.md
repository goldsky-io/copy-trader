---
title: "Trade-recording architecture: align local state with on-chain truth"
type: refactor
status: draft
date: 2026-04-26
origin: discovered while validating slippage fix on 2026-04-26
---

# Trade-recording architecture

## Problem

Today's session shipped four fixes:
1. Phantom-trade gate (don't record orders that came back with zero fills)
2. Tick-based slippage (+2 ticks) so FAK orders cross
3. `positions` collection id bug (insertOne now passes `opts.id`)
4. NegRisk redemption path (NegRisk markets redeem via the adapter, not bare CT)

Validation at 18:25 caught a problem with #1: 4 BUY fires for `Estrela vs Porto` markets all logged `TRADE_FAILED: no_fill: status=delayed`. On-chain, the bot now holds **6.24 shares of Estrela O/U 2.5 outcome=1 @ 0.3249 avg** — exactly what those 4 attempts tried to buy. Slippage worked, the orders crossed, but they crossed **after** the synchronous `/order` response returned `status=delayed`.

The architectural mistake: we are trying to determine fill outcome from the synchronous `/order` response. Polymarket's risk-delay queue makes that fundamentally unreliable — most orders return `status=delayed` and resolve async 5–30s later. Sometimes they fill, sometimes they're killed, and the sync response can't tell us which.

Symptoms:
- `trades` collection undercounts fills: every delayed-then-filled order is missing.
- `TRADE_FAILED` log line is misleading on-call.
- `positions` collection would be wrong, except reconcile rebuilds it from on-chain every 5 min.
- `seen_fills` dedup gate locks us out of retrying orders that were "killed" because we still claimed them as seen.

## Diagnosis

There is no synchronous answer. The CLOB returns `status=delayed` and the actual outcome is observable only by:
- Polling `GET /order/<orderId>` after the queue resolves (~5–30s).
- Reading on-chain CTF balances (data-api `/positions` or chain RPC).
- Reading the trade tape (data-api `/trades?user=…`).

Of those three, the trade tape and positions are already authoritative and free. We don't need to invent a polling loop — the bot already has a reconcile cron that pulls positions. We can extend the same pattern for trades.

## Approach

**Make on-chain data the source of truth for both positions and trades. Treat the synchronous `/order` response as a best-effort attempt log, not an outcome.**

Once that principle is settled:
- `copy_trade` writes an attempt record (orderId, side, intended price, whalePrice, signed price, timestamp, sync status). It does **not** write the trades or positions collections.
- A cron task pulls `data-api /trades?user=<addr>` and inserts new trades into a `trades` collection, keyed by `(transactionHash, assetId, side)`.
- Reconcile keeps owning positions sync (already does).
- The status task and dashboard read from these on-chain-derived collections, which are already what they want anyway.

This removes the need for the phantom-trade gate, the `no_fill` gate, and the avgPrice math in `copy_trade`.

## Changes (in dependency order)

### 1. Stop bleeding: relax the sync gate (small, immediate)
- `clob.ts` `executeTrade`: drop the `no_fill` early return. Return `success: true, status: "delayed"` for delayed responses (we don't know it's a fail).
- `copy_trade.ts`: log `TRADE_SUBMITTED` for `status=delayed`, `TRADE_EXECUTED` for synchronous match with non-zero fills, `TRADE_FAILED` only when the API returns a hard `errorMsg`.
- Stop touching the `positions` collection from `copy_trade`. Reconcile owns it.

### 2. Trades-from-chain (new task)
- Add a `trades_from_chain` cron task (every 5 min) or extend `reconcile`. Query `data-api /trades?user=<addr>&limit=500` (paginate if needed).
- Write to a `trades` collection, keyed by `id = ${transactionHash}-${asset}-${side}`. Idempotent.
- Drop the in-process `trades` writes from `copy_trade`.

### 3. Attempt log (renamed `trades` → `trade_attempts`)
- Rename the existing `trades` collection use-case in `copy_trade` to `trade_attempts`. Each row is what we tried, not what filled. Useful for debugging slippage tuning, dedup analysis, latency.
- Status dashboard renders attempts vs filled side by side — visible "kill rate" without guessing.

### 4. Cleanup
- Remove the phantom-trade gate from `clob.ts` (no longer needed once we trust on-chain).
- Status task: read trades from the on-chain-derived collection; remove local trade counting.
- `seen_fills`: keep as-is (it dedups whale event legs, not our orders).

## What this does not change

- Slippage logic (already shipped, validated).
- NegRisk redeem branching (already shipped, validated).
- Reconcile (already correct).
- The `positions` collection schema or row-id-vs-doc-id contract (already fixed).

## Open questions

- **Trade-tape pagination depth**: data-api `/trades` returns 500 max. For a heavily-traded wallet we may need a `?after=<lastSeenTs>` cursor stored in a small `cursors` collection. Cheap to add, ignored if not needed.
- **Cron frequency**: trades cron at 5 min means up to 5 min lag between a fill and our local row. Status dashboard shows that. If unacceptable, drop to 1 min — the data-api can absorb it.
- **`status=delayed` retry semantics**: if a delayed order is killed (not filled), we never retry the whale fill we mirrored. That's fine in v1 — the next whale fill will trigger another attempt. If kill rate is high once we measure it, we can add a retry cron later.

## Order of work

1. Ship #1 (relax gate). One file edit, ~10 lines. Validates the principle on the next BUY.
2. Ship #2 (trades-from-chain). New cron task. Backfill on first run.
3. Ship #3 (rename to attempts) + #4 (cleanup). Mostly deletions.

Each step is independently shippable and reversible. No big-bang rewrite.
