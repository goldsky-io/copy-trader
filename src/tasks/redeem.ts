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
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
] as const;

export async function main(ctx: TaskContext) {
  const positions = (await ctx.collection<Position>("positions").findMany({
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
        // We lost — mark position as redeemed (worth $0)
        ctx.logEvent({
          code: "POSITION_LOST",
          message: `Lost position on ${market.question} (held ${pos.side})`,
        });
        await ctx.collection<Position>("positions").setById(pos.id, {
          ...pos,
          status: "redeemed",
        });
        continue;
      }

      // We won — redeem on-chain
      ctx.logEvent({
        code: "REDEEMING",
        message: `Redeeming winning ${pos.side} position on ${market.question}`,
        data: { conditionId: pos.conditionId, size: pos.size },
      });

      const wallet = await ctx.evm.wallet({
        name: "bot-composer",
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

      ctx.logEvent({
        code: "REDEEMED",
        message: `Successfully redeemed ${pos.side} on ${market.question}`,
      });

      await ctx.collection<Position>("positions").setById(pos.id, {
        ...pos,
        status: "redeemed",
      });
    } catch (err) {
      ctx.logEvent({
        code: "REDEEM_ERROR",
        message: `Failed to redeem ${pos.tokenId}: ${err}`,
      });
      // Continue to next position — don't let one failure block others
    }
  }
}
