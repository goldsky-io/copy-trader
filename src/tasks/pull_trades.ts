/**
 * pull_trades — cron task (every 5 min)
 *
 * Pulls Polymarket's data-api /trades?user=<wallet> tape and upserts each
 * row into the local `trades` collection. The on-chain trade ledger is the
 * source of truth for what filled — the synchronous /order response can't
 * tell us (most orders return status=delayed and resolve async 5–30s later).
 *
 * Rows are keyed by `${transactionHash}-${asset}-${side}` so reruns are
 * idempotent: every cron tick refreshes the recent slice without duplicating
 * older rows. Backfills naturally on first run.
 *
 * The data-api caps a single response at limit=500. A heavily-traded wallet
 * could outrun that between ticks; if that becomes real, add an `?after=`
 * cursor in a small `cursors` collection. Until then 500/5min is plenty.
 */
import type { TaskContext } from "compose";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainTrade } from "../lib/types";

type DataApiTrade = {
  proxyWallet?: string;
  side: string;
  asset: string;
  conditionId?: string;
  size: number | string;
  price: number | string;
  timestamp: number;
  title?: string;
  outcome?: string;
  outcomeIndex?: number;
  transactionHash: string;
};

export async function main(ctx: TaskContext) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  const resp = (await ctx.fetch(
    `https://data-api.polymarket.com/trades?user=${address}&limit=500`
  )) as DataApiTrade[];

  const trades = resp ?? [];
  if (!trades.length) {
    console.log("[pull_trades] no trades returned");
    return { fetched: 0, inserted: 0, updated: 0 };
  }

  const collection = await ctx.collection<ChainTrade>("trades");

  let upserted = 0;

  for (const t of trades) {
    const side = String(t.side).toUpperCase() as "BUY" | "SELL";
    if (side !== "BUY" && side !== "SELL") continue;

    const id = `${t.transactionHash}-${t.asset}-${side}`;
    // setById is upsert: idempotent across reruns. The doc-level `id` field
    // mirrors the row key so findMany consumers (status, dashboard) can read
    // it back out of the JSONB without a separate lookup. opts is irrelevant
    // here because setById already targets a specific row.
    await collection.setById(id, {
      id,
      transactionHash: t.transactionHash,
      asset: t.asset,
      conditionId: t.conditionId,
      title: t.title,
      side,
      size: Number(t.size),
      price: Number(t.price),
      outcome: t.outcome,
      outcomeIndex: t.outcomeIndex,
      timestamp: t.timestamp,
    });
    upserted++;
  }

  console.log(`[pull_trades] fetched=${trades.length} upserted=${upserted}`);
  return { fetched: trades.length, upserted };
}
