/**
 * status — HTTP-triggered status report
 *
 * Returns a JSON snapshot of the copy-trader bot:
 * wallet address, USDC balance, watched wallets, recent trade,
 * total trades, win rate, open/redeemed positions.
 *
 * Call: curl -X POST -H "Authorization: Bearer $TOKEN" \
 *   https://api.goldsky.com/api/admin/compose/v1/copy-trader/tasks/status
 */
import type { TaskContext } from "compose";
import { privateKeyToAccount } from "viem/accounts";

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

async function getUsdcBalance(
  ctx: TaskContext,
  address: string
): Promise<number> {
  const resp = (await ctx.fetch(POLYGON_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [
        {
          to: USDC,
          data:
            "0x70a08231000000000000000000000000" +
            address.slice(2).toLowerCase(),
        },
        "latest",
      ],
      id: 1,
    }),
  })) as { result?: string };
  return resp?.result ? Number(BigInt(resp.result)) / 1e6 : 0;
}

export async function main(ctx: TaskContext) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  const watchedWallets = (ctx.env.WATCHED_WALLETS || "")
    .split(",")
    .map((w: string) => w.trim())
    .filter(Boolean);

  // Fetch balance, trades, positions in parallel
  const [balance, trades, positions] = await Promise.all([
    getUsdcBalance(ctx, address),
    ctx.fetch(
      `https://data-api.polymarket.com/trades?user=${address}&limit=100`
    ) as Promise<any[]>,
    ctx.fetch(
      `https://data-api.polymarket.com/positions?user=${address}&limit=100`
    ) as Promise<any[]>,
  ]);

  const tradesArr = Array.isArray(trades) ? trades : [];
  const positionsArr = Array.isArray(positions) ? positions : [];

  // Compute stats from trade history
  const buys = tradesArr.filter((t) => t.side === "BUY").length;
  const sells = tradesArr.filter((t) => t.side === "SELL").length;
  const latestTrade = tradesArr[0]
    ? {
        side: tradesArr[0].side,
        price: tradesArr[0].price,
        size: tradesArr[0].size,
        market: tradesArr[0].title,
        timestamp: new Date(tradesArr[0].timestamp * 1000).toISOString(),
        minutesAgo: Math.floor(
          (Date.now() - tradesArr[0].timestamp * 1000) / 60000
        ),
      }
    : null;

  // Position stats
  const open = positionsArr.filter(
    (p) => !p.redeemable && p.size > 0
  );
  const pendingRedeem = positionsArr.filter(
    (p) => p.redeemable === true && p.size > 0
  );
  const resolvedWins = positionsArr.filter(
    (p) => p.redeemable === true && (p.cashPnl ?? 0) > 0
  );
  const resolvedLosses = positionsArr.filter(
    (p) => p.redeemable === true && (p.cashPnl ?? 0) < 0
  );
  const totalPnl = positionsArr.reduce(
    (sum, p) => sum + (p.cashPnl ?? 0),
    0
  );

  const totalResolved = resolvedWins.length + resolvedLosses.length;
  const winRate =
    totalResolved > 0
      ? Math.round((resolvedWins.length / totalResolved) * 1000) / 10
      : null;

  return {
    wallet: {
      address,
      usdcBalance: Number(balance.toFixed(6)),
    },
    watching: {
      count: watchedWallets.length,
      wallets: watchedWallets,
    },
    trades: {
      total: tradesArr.length,
      buys,
      sells,
      latest: latestTrade,
    },
    positions: {
      open: open.length,
      pendingRedeem: pendingRedeem.length,
      resolvedWins: resolvedWins.length,
      resolvedLosses: resolvedLosses.length,
      totalResolved,
      winRatePct: winRate,
      totalPnlUsd: Number(totalPnl.toFixed(4)),
    },
    openPositions: open.slice(0, 5).map((p) => ({
      market: p.title,
      size: p.size,
      currentValue: p.currentValue,
      pnl: p.cashPnl,
    })),
    pendingRedemptions: pendingRedeem.slice(0, 5).map((p) => ({
      market: p.title,
      size: p.size,
      pnl: p.cashPnl,
    })),
  };
}
