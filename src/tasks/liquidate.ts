/**
 * liquidate — HTTP-triggered one-shot
 *
 * Sells all (or a specified subset of) currently-held positions via FAK SELL.
 * Used to free up capital tied up in positions inherited from a prior
 * watched-wallet config.
 *
 * Body:
 *   { tokenIds?: string[] } — if omitted, sells every open on-chain position.
 *
 * For each position: looks up market via Gamma, then submits a FAK SELL at
 * (current_mid − 8 ticks) for the full share count. Same slippage convention
 * as copy_trade's mirror sells.
 */
import type { TaskContext } from "compose";
import { privateKeyToAccount } from "viem/accounts";
import { executeTrade } from "../lib/clob";
import { lookupMarketByTokenId } from "../lib/gamma";

type DataApiPosition = {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  outcomeIndex: number;
  redeemable?: boolean;
  curPrice?: number;
};

export async function main(
  ctx: TaskContext,
  params?: Record<string, unknown>
) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const clobHost = ctx.env.CLOB_HOST || "https://clob.polymarket.com";
  const gammaHost = ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  const onchain = (await ctx.fetch(
    `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0&limit=500`
  )) as DataApiPosition[];

  const open = (onchain ?? []).filter((p) => p.size > 0 && !p.redeemable);

  const targetSet = Array.isArray(params?.tokenIds)
    ? new Set((params!.tokenIds as string[]).map((t) => String(t)))
    : null;

  const targets = targetSet
    ? open.filter((p) => targetSet.has(p.asset))
    : open;

  console.log(
    `[liquidate] addr=${address} open=${open.length} targets=${targets.length}`
  );

  const results: Array<Record<string, unknown>> = [];

  for (const p of targets) {
    const market = await lookupMarketByTokenId(ctx.fetch, gammaHost, p.asset);
    if (!market) {
      results.push({ tokenId: p.asset, skipped: "gamma_lookup_failed" });
      continue;
    }
    if (market.closed) {
      results.push({
        tokenId: p.asset,
        skipped: "market_closed",
        question: market.question,
      });
      continue;
    }

    // Use current curPrice from data API (more current than gamma outcomePrices)
    // as the reference. executeTrade subtracts 8 ticks for SELL slippage.
    const refPrice =
      typeof p.curPrice === "number" && p.curPrice > 0
        ? p.curPrice
        : p.outcomeIndex === 0
          ? market.outcomePrices[0]
          : market.outcomePrices[1];

    if (!refPrice || refPrice <= 0 || refPrice >= 1) {
      results.push({
        tokenId: p.asset,
        skipped: "bad_ref_price",
        refPrice,
      });
      continue;
    }

    const result = await executeTrade(
      ctx,
      pk,
      clobHost,
      p.asset,
      "SELL",
      0, // amountUsd unused on SELL
      refPrice,
      market.tickSize,
      market.minOrderSize,
      market.negRisk,
      market.feeRateBps,
      p.size
    );

    results.push({
      tokenId: p.asset,
      question: market.question,
      shares: p.size,
      refPrice,
      ...result,
    });
  }

  return {
    address,
    attempted: targets.length,
    results,
  };
}
