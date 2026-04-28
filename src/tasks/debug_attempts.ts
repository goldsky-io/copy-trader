/**
 * debug_attempts — HTTP-triggered diagnostic
 *
 * Returns recent rows from trade_attempts (what copy_trade tried) and
 * seen_fills (the dedup ledger). Used to investigate why mirror coverage
 * is low — surfaces failed/delayed/never-fired attempts that the
 * dashboard's on-chain view can't see by definition.
 */
import type { TaskContext } from "compose";
import type { TradeAttempt } from "../lib/types";

export async function main(ctx: TaskContext) {
  const attempts = await ctx.collection<TradeAttempt>("trade_attempts");
  const seen = await ctx.collection<{ id: string }>("seen_fills");

  const allAttempts = await attempts.findMany({});
  // sort client-side; Compose findMany sort only supports id ordering.
  const recentAttempts = allAttempts
    .slice()
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
    .slice(0, 50);

  const seenAll = await seen.findMany({});
  const seenCount = seenAll.length;

  // Aggregate by syncStatus
  const byStatus: Record<string, number> = {};
  const byError: Record<string, number> = {};
  for (const a of recentAttempts) {
    byStatus[a.syncStatus] = (byStatus[a.syncStatus] || 0) + 1;
    if (a.syncError) {
      const key = a.syncError.slice(0, 60);
      byError[key] = (byError[key] || 0) + 1;
    }
  }

  return {
    summary: {
      attempts_total: recentAttempts.length,
      seen_fills_total: seenCount,
      by_sync_status: byStatus,
      by_error: byError,
    },
    last_20_attempts: recentAttempts.slice(0, 20).map((a) => ({
      ts: a.timestamp,
      side: a.side,
      tokenId: a.tokenId,
      whalePrice: a.whalePrice,
      syncStatus: a.syncStatus,
      syncError: a.syncError,
      orderId: a.orderId || null,
      txHash: a.eventTxHash,
    })),
  };
}
