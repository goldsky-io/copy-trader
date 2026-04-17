/**
 * setup_approvals — HTTP-triggered, run once after funding the wallet
 *
 * Grants USDC + ConditionalTokens approvals to Polymarket's exchange contracts.
 * Required once before the bot can trade. Uses Compose's sponsored gas, so
 * the EOA doesn't need MATIC.
 *
 * Call: curl -X POST -H "Authorization: Bearer $COMPOSE_TOKEN" \
 *   https://api.goldsky.com/api/admin/compose/v1/bot-composer/tasks/setup_approvals
 */
import type { TaskContext } from "compose";
import { CONTRACTS } from "../lib/types";

const MAX_UINT256 =
  115792089237316195423570985008687907853269984665640564039457584007913129639935n;

const ERC20_APPROVE_ABI =
  "function approve(address spender, uint256 amount) returns (bool)";
const ERC1155_SET_APPROVAL_ABI =
  "function setApprovalForAll(address operator, bool approved)";

export async function main(ctx: TaskContext) {
  const wallet = await ctx.evm.wallet({
    name: "bot-composer",
    privateKey: ctx.env.PRIVATE_KEY as `0x${string}`,
    sponsorGas: true,
  });

  const exchanges = [
    { name: "CTF Exchange", address: CONTRACTS.ctfExchange },
    { name: "NegRisk Exchange", address: CONTRACTS.negRiskExchange },
  ];

  // USDC.e (ERC-20) approvals — let each exchange spend our USDC
  for (const ex of exchanges) {
    ctx.logEvent({
      code: "APPROVING_USDC",
      message: `Approving USDC for ${ex.name}`,
    });
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.usdc as `0x${string}`,
      ERC20_APPROVE_ABI,
      [ex.address, MAX_UINT256]
    );
    ctx.logEvent({
      code: "APPROVED_USDC",
      message: `USDC approved for ${ex.name}`,
      data: { tx: tx.hash },
    });
  }

  // ConditionalTokens (ERC-1155) approvals — let each exchange move our share tokens
  for (const ex of exchanges) {
    ctx.logEvent({
      code: "APPROVING_CTF",
      message: `Approving ConditionalTokens for ${ex.name}`,
    });
    const tx = await wallet.writeContract(
      ctx.evm.chains.polygon,
      CONTRACTS.conditionalTokens as `0x${string}`,
      ERC1155_SET_APPROVAL_ABI,
      [ex.address, true]
    );
    ctx.logEvent({
      code: "APPROVED_CTF",
      message: `ConditionalTokens approved for ${ex.name}`,
      data: { tx: tx.hash },
    });
  }

  return { success: true, wallet: wallet.address };
}
