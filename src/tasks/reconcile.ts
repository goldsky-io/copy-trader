/**
 * reconcile — cron task (every 5 min) + http
 *
 * Polymarket's CLOB has a risk-delay queue: /order returns "status: delayed"
 * immediately, the actual match (or kill) happens async seconds later. The
 * /order response gives no fill amounts, so we can't tell from the original
 * task whether a delayed order ever filled.
 *
 * Result: orders that fill after the delay leave on-chain shares the bot
 * never recorded, while orders that get killed stay correctly absent. The
 * SELL path, redeem task, and dashboard already query Polymarket's data API
 * for on-chain truth — but the local `positions` collection drifts.
 *
 * This task pulls /positions and brings the local collection in sync:
 *   - upsert anything on-chain that's missing or stale
 *   - zero out anything local that's no longer on-chain (sold or redeemed)
 */
import type { TaskContext } from "compose";
import { privateKeyToAccount } from "viem/accounts";
import type { Position } from "../lib/types";

type DataApiPosition = {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  outcomeIndex: number;
  redeemable?: boolean;
};

export async function main(
  ctx: TaskContext,
  params?: Record<string, unknown>
) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  const onchain = (await ctx.fetch(
    `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0&limit=500`
  )) as DataApiPosition[];

  let positionsCollection = await ctx.collection<Position>("positions");

  // One-shot reset: drop the collection before rebuild. Used to recover from
  // the row-id-vs-value-id duplication bug that polluted the table before
  // insertOne started passing opts.id. Recreate after drop so subsequent
  // findMany/insertOne calls land in a fresh table.
  if (params?.reset === true || params?.reset === "true") {
    await positionsCollection.drop();
    positionsCollection = await ctx.collection<Position>("positions");
    console.log("[reconcile] dropped positions collection (reset=true)");
  }

  const local = (await positionsCollection.findMany({})) as Position[];
  const localByTokenId = new Map(local.map((p) => [p.tokenId, p]));
  const onchainByAsset = new Map(
    (onchain ?? []).map((p) => [p.asset, p])
  );

  let inserted = 0;
  let updated = 0;
  let zeroed = 0;

  for (const oc of onchain ?? []) {
    const existing = localByTokenId.get(oc.asset);
    if (existing) {
      const sizeDrifted = Math.abs((existing.size ?? 0) - oc.size) > 1e-6;
      const priceDrifted =
        Math.abs((existing.avgPrice ?? 0) - (oc.avgPrice ?? 0)) > 1e-6;
      if (sizeDrifted || priceDrifted) {
        await positionsCollection.setById(existing.id, {
          ...existing,
          size: oc.size,
          avgPrice: oc.avgPrice,
        });
        updated++;
      }
    } else {
      // opts.id MUST be passed — without it the row id is a random UUID,
      // while a doc-level `id` field would shadow it on findMany. Subsequent
      // setById calls would upsert new rows instead of updating, accreting
      // duplicates on every cron tick.
      await positionsCollection.insertOne(
        {
          tokenId: oc.asset,
          conditionId: oc.conditionId,
          side: oc.outcomeIndex === 0 ? "YES" : "NO",
          size: oc.size,
          avgPrice: oc.avgPrice,
          status: "open",
        },
        { id: oc.asset }
      );
      inserted++;
    }
  }

  // Local positions that are no longer on-chain → zero them out (sold or
  // redeemed). Don't delete; we keep the row for trade history references.
  for (const lp of local) {
    if ((lp.size ?? 0) > 0 && !onchainByAsset.has(lp.tokenId)) {
      await positionsCollection.setById(lp.id, { ...lp, size: 0 });
      zeroed++;
    }
  }

  console.log(
    `[reconcile] onchain=${onchain?.length ?? 0} local=${local.length} ` +
      `inserted=${inserted} updated=${updated} zeroed=${zeroed}`
  );

  return {
    onchainCount: onchain?.length ?? 0,
    localCount: local.length,
    inserted,
    updated,
    zeroed,
  };
}
