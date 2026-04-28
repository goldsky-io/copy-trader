/**
 * setup_approvals — HTTP-triggered, run once after V2 cutover (and after
 * funding the wallet). Idempotent: re-running just re-approves to MAX_UINT256
 * and re-wraps whatever USDC.e is in the wallet into pUSD.
 *
 * V2 (2026-04-28) collateral is pUSD, not USDC.e. To trade we need:
 *   1. USDC.e → CollateralOnramp approval (so wrap() can pull our USDC.e)
 *   2. pUSD    → V2 exchanges approval (the actual trading token)
 *   3. ConditionalTokens → V2 exchanges approval (share transfers)
 *   4. CollateralOnramp.wrap(USDC.e, EOA, balance) to convert any sitting
 *      USDC.e balance to pUSD in one shot.
 *
 * Uses Compose's sponsored gas, so the EOA doesn't need MATIC.
 *
 * Call: curl -X POST -H "Authorization: Bearer $COMPOSE_TOKEN" \
 *   https://api.goldsky.com/api/admin/compose/v1/copy-trader/tasks/setup_approvals
 */
import type { TaskContext } from "compose";
import { CONTRACTS } from "../lib/types";

const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const ERC20_APPROVE_ABI = "approve(address,uint256)";
const ERC1155_SET_APPROVAL_ABI = "setApprovalForAll(address,bool)";
// CollateralOnramp.wrap(asset, to, amount) — pulls `amount` of `asset` from
// the caller and mints pUSD 1:1 to `to`.
const ONRAMP_WRAP_ABI = "wrap(address,address,uint256)";

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

async function getErc20Balance(
  ctx: TaskContext,
  token: string,
  owner: string
): Promise<bigint> {
  const resp = (await ctx.fetch(POLYGON_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [
        {
          to: token,
          data:
            "0x70a08231000000000000000000000000" +
            owner.slice(2).toLowerCase(),
        },
        "latest",
      ],
      id: 1,
    }),
  })) as { result?: string };
  return resp?.result ? BigInt(resp.result) : 0n;
}

export async function main(ctx: TaskContext) {
  const wallet = await ctx.evm.wallet({
    name: "copy-trader",
    privateKey: ctx.env.PRIVATE_KEY as `0x${string}`,
    sponsorGas: true,
  });

  const exchanges = [
    { name: "CTF Exchange", address: CONTRACTS.ctfExchange },
    { name: "NegRisk Exchange", address: CONTRACTS.negRiskExchange },
    { name: "NegRisk Adapter", address: CONTRACTS.negRiskAdapter },
  ];

  const results: Array<{ name: string; type: string; tx: string }> = [];

  // 1. USDC.e → CollateralOnramp (so wrap() can pull our USDC.e)
  console.log(`[setup_approvals] Approving USDC.e for CollateralOnramp`);
  {
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.usdcE as `0x${string}`,
      ERC20_APPROVE_ABI,
      [CONTRACTS.collateralOnramp, MAX_UINT256]
    );
    console.log(`[setup_approvals] USDC.e → Onramp: ${tx.hash}`);
    results.push({ name: "CollateralOnramp", type: "USDC.e", tx: tx.hash });
  }

  // 2. pUSD → V2 exchanges
  for (const ex of exchanges) {
    console.log(`[setup_approvals] Approving pUSD for ${ex.name}`);
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.pUsd as `0x${string}`,
      ERC20_APPROVE_ABI,
      [ex.address, MAX_UINT256]
    );
    console.log(`[setup_approvals] pUSD → ${ex.name}: ${tx.hash}`);
    results.push({ name: ex.name, type: "pUSD", tx: tx.hash });
  }

  // 3. ConditionalTokens → V2 exchanges
  for (const ex of exchanges) {
    console.log(`[setup_approvals] Approving ConditionalTokens for ${ex.name}`);
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.conditionalTokens as `0x${string}`,
      ERC1155_SET_APPROVAL_ABI,
      [ex.address, true]
    );
    console.log(`[setup_approvals] CTF → ${ex.name}: ${tx.hash}`);
    results.push({ name: ex.name, type: "CTF", tx: tx.hash });
  }

  // 4. Wrap any sitting USDC.e balance into pUSD. Skip if zero.
  const usdcEBalance = await getErc20Balance(
    ctx,
    CONTRACTS.usdcE,
    wallet.address
  );
  let wrapResult: { wrapped: string; tx: string } | { wrapped: string } = {
    wrapped: "0",
  };
  if (usdcEBalance > 0n) {
    console.log(
      `[setup_approvals] Wrapping ${usdcEBalance} USDC.e → pUSD via Onramp`
    );
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.collateralOnramp as `0x${string}`,
      ONRAMP_WRAP_ABI,
      [CONTRACTS.usdcE, wallet.address, usdcEBalance]
    );
    console.log(`[setup_approvals] wrap: ${tx.hash}`);
    wrapResult = { wrapped: usdcEBalance.toString(), tx: tx.hash };
    results.push({ name: "CollateralOnramp", type: "wrap", tx: tx.hash });
  } else {
    console.log(`[setup_approvals] no USDC.e balance to wrap`);
  }

  return {
    success: true,
    wallet: wallet.address,
    approvals: results,
    wrap: wrapResult,
  };
}
