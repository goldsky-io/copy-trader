/**
 * redeem — cron task (every 5 min)
 *
 * Checks open positions for market resolution via Gamma API.
 * Auto-redeems winning shares on-chain via ConditionalTokens contract.
 */
import type { TaskContext } from "compose";
import { lookupMarketByTokenId, isResolved, winningOutcomeIndex } from "../lib/gamma";
import type { Position } from "../lib/types";
import { CONTRACTS } from "../lib/types";

const CONDITIONAL_TOKENS_ABI = [
  "redeemPositions(address,bytes32,bytes32,uint256[])",
] as const;

export async function main(ctx: TaskContext) {
  const positionsCollection = await ctx.collection<Position>("positions");
  const positions = (await positionsCollection.findMany({
    status: "open",
  })) as Position[];

  const openWithSize = positions.filter((p) => p.size > 0);
  if (!openWithSize.length) return;

  const gammaHost =
    ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

  for (const pos of openWithSize) {
    try {
      const market = await lookupMarketByTokenId(
        ctx.fetch,
        gammaHost,
        pos.tokenId
      );
      if (!market || !isResolved(market)) continue;

      const winner = winningOutcomeIndex(market);
      if (winner === null) continue;

      // Check if we hold the winning side
      const ourOutcomeIndex = pos.side === "YES" ? 0 : 1;
      if (ourOutcomeIndex !== winner) {
        console.log(`[redeem] POSITION_LOST: ${market.question} (held ${pos.side})`);
        await positionsCollection.setById(pos.id, {
          ...pos,
          status: "redeemed",
        });
        continue;
      }

      console.log(`[redeem] REDEEMING: winning ${pos.side} position on ${market.question}`);

      const wallet = await ctx.evm.wallet({
        name: "copy-trader",
        privateKey: ctx.env.PRIVATE_KEY as `0x${string}`,
        sponsorGas: true,
      });

      // indexSets: [1] for outcome 0 (YES), [2] for outcome 1 (NO)
      // Binary market: indexSet 1 = 0b01 = YES, indexSet 2 = 0b10 = NO
      const indexSets = [winner === 0 ? 1 : 2];
      const parentCollectionId =
        "0x0000000000000000000000000000000000000000000000000000000000000000";

      await wallet.writeContract(
        ctx.evm.chains.polygon,
        CONTRACTS.conditionalTokens as `0x${string}`,
        CONDITIONAL_TOKENS_ABI[0],
        [CONTRACTS.usdc, parentCollectionId, pos.conditionId, indexSets]
      );

      console.log(`[redeem] REDEEMED: ${pos.side} on ${market.question}`);

      await positionsCollection.setById(pos.id, {
        ...pos,
        status: "redeemed",
      });
    } catch (err) {
      console.log(`[redeem] REDEEM_ERROR for ${pos.tokenId}: ${err}`);
      // Continue to next position — don't let one failure block others
    }
  }
}
