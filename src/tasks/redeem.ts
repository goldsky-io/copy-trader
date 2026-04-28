/**
 * redeem — cron task (every 5 min)
 *
 * Queries Polymarket's data API for our wallet's redeemable positions and
 * calls redeemPositions() on-chain for each. Polymarket marks a position
 * `redeemable: true` when its condition has resolved on-chain.
 *
 * This intentionally doesn't use the local `positions` collection — the data
 * API is the source of truth and already knows the conditionId + outcomeIndex
 * for every share we hold, including trades that happened before this task
 * existed or that didn't get recorded locally.
 */
import type { TaskContext } from "compose";
import { CONTRACTS } from "../lib/types";
import { privateKeyToAccount } from "viem/accounts";

const CONDITIONAL_TOKENS_ABI =
  "redeemPositions(address,bytes32,bytes32,uint256[])";

// NegRiskAdapter exposes a different redeem path:
//   redeemPositions(bytes32 conditionId, uint256[2] amounts)
// where amounts[0] = YES tokens to burn, amounts[1] = NO tokens to burn,
// in raw units (1e6 for USDC-collateralized markets).
const NEG_RISK_REDEEM_ABI =
  "redeemPositions(bytes32,uint256[])";

type DataApiPosition = {
  asset: string;
  conditionId: string;
  title: string;
  outcomeIndex: number;
  size: number;
  currentValue: number;
  redeemable: boolean;
  // True for markets that route through the NegRisk adapter — positions are
  // held against the adapter's wrapped collateral, not USDC directly. Calling
  // ConditionalTokens.redeemPositions with USDC as collateral computes the
  // wrong positionId and silently no-ops (PayoutRedemption fires with payout=0
  // and no _burn). NegRisk markets must redeem via NegRiskAdapter instead.
  negativeRisk?: boolean;
  // Multi-outcome markets have outcomeCount > 2; binary markets have 2.
  // For a binary market, indexSets are: outcome 0 → 1, outcome 1 → 2.
};

export async function main(ctx: TaskContext) {
  const pk = ctx.env.PRIVATE_KEY as `0x${string}`;
  const address = privateKeyToAccount(
    pk.startsWith("0x") ? pk : (`0x${pk}` as `0x${string}`)
  ).address;

  // sizeThreshold=0 is required: Polymarket's default threshold is 1.0, which
  // hides any position holding <1 share. Fills that land just under 1 share
  // (e.g. 0.9985 when buying at $0.99 due to fee routing) would otherwise
  // never surface here, and winning positions of that size would sit
  // un-redeemed indefinitely.
  const resp = (await ctx.fetch(
    `https://data-api.polymarket.com/positions?user=${address}&limit=100&sortBy=CURRENT&sortOrder=DESC&sizeThreshold=0`
  )) as DataApiPosition[];

  const toRedeem = (resp ?? []).filter(
    (p) => p.redeemable === true && p.size > 0
  );

  if (!toRedeem.length) {
    console.log("[redeem] no redeemable positions");
    return { redeemed: 0 };
  }

  console.log(`[redeem] ${toRedeem.length} redeemable positions`);

  const wallet = await ctx.evm.wallet({
    name: "copy-trader",
    privateKey: pk,
    sponsorGas: true,
  });

  const parentCollectionId =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  const results: Array<{ condition: string; tx?: string; error?: string }> = [];

  // Group by condition: a single redeem call clears all sides we hold for that
  // condition. For NegRisk we pass [yes_size, no_size] in raw units; for
  // vanilla CT we pass indexSets [1, 2] and the contract reads our balances.
  type Bucket = {
    conditionId: string;
    title: string;
    negRisk: boolean;
    yesSize: number;
    noSize: number;
  };
  const byCondition = new Map<string, Bucket>();
  for (const pos of toRedeem) {
    const b = byCondition.get(pos.conditionId) ?? {
      conditionId: pos.conditionId,
      title: pos.title,
      negRisk: pos.negativeRisk === true,
      yesSize: 0,
      noSize: 0,
    };
    if (pos.outcomeIndex === 0) b.yesSize += pos.size;
    else b.noSize += pos.size;
    byCondition.set(pos.conditionId, b);
  }

  for (const b of byCondition.values()) {
    try {
      console.log(
        `[redeem] ${b.negRisk ? "NEGRISK" : "CT"} condition ${b.conditionId.slice(0, 12)}... yes=${b.yesSize} no=${b.noSize} (${b.title.slice(0, 40)})`
      );

      let tx: { hash: string };
      if (b.negRisk) {
        // amounts in raw 6-decimal USDC-equivalent units. Round down so we
        // never request more than we hold (the contract reverts on shortfall).
        const yesRaw = BigInt(Math.floor(b.yesSize * 1e6));
        const noRaw = BigInt(Math.floor(b.noSize * 1e6));
        tx = await wallet.writeContract(
          ctx.evm.chains.polygon,
          CONTRACTS.negRiskAdapter as `0x${string}`,
          NEG_RISK_REDEEM_ABI,
          [b.conditionId, [yesRaw, noRaw]]
        );
      } else {
        // Binary market: indexSet 1 = outcome 0 (YES), indexSet 2 = outcome 1 (NO).
        // Passing both [1, 2] redeems whatever we hold in one call.
        tx = await wallet.writeContract(
          ctx.evm.chains.polygon,
          CONTRACTS.conditionalTokens as `0x${string}`,
          CONDITIONAL_TOKENS_ABI,
          // V2 markets are collateralized in pUSD; redeemPositions burns
          // outcome shares back to the same collateral the market was minted
          // against. Pre-cutover positions held in USDC.e will need to be
          // redeemed manually until/if we add per-condition collateral lookup.
          [CONTRACTS.pUsd, parentCollectionId, b.conditionId, [1, 2]]
        );
      }
      console.log(`[redeem] redeemed: ${tx.hash}`);
      results.push({ condition: b.conditionId, tx: tx.hash });
    } catch (err) {
      console.log(`[redeem] error for ${b.conditionId}: ${err}`);
      results.push({ condition: b.conditionId, error: String(err) });
    }
  }

  return { redeemed: results.length, results };
}
