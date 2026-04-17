var module = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/tasks/redeem.ts
  var redeem_exports = {};
  __export(redeem_exports, {
    main: () => main
  });

  // src/lib/gamma.ts
  async function lookupMarketByTokenId(fetch, gammaHost, tokenId) {
    try {
      const resp = await fetch(
        `${gammaHost}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`
      );
      const markets = resp;
      if (!markets?.length) return null;
      const m = markets[0];
      const clobTokenIds = JSON.parse(m.clobTokenIds || "[]");
      const outcomePrices = JSON.parse(m.outcomePrices || "[0,0]");
      return {
        tokenId,
        conditionId: m.conditionId,
        question: m.question,
        tickSize: m.orderPriceMinTickSize?.toString() || "0.01",
        negRisk: m.negRiskOther === true,
        enableOrderBook: m.enableOrderBook === true,
        closed: m.closed === true,
        outcomePrices: [
          parseFloat(outcomePrices[0]) || 0,
          parseFloat(outcomePrices[1]) || 0
        ],
        clobTokenIds: [clobTokenIds[0] || "", clobTokenIds[1] || ""]
      };
    } catch {
      return null;
    }
  }
  function isResolved(market) {
    if (!market.closed) return false;
    return market.outcomePrices[0] >= 0.99 || market.outcomePrices[1] >= 0.99;
  }
  function winningOutcomeIndex(market) {
    if (!market.closed) return null;
    if (market.outcomePrices[0] >= 0.99) return 0;
    if (market.outcomePrices[1] >= 0.99) return 1;
    return null;
  }

  // src/lib/types.ts
  var CONTRACTS = {
    ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    negRiskExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
    conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
  };

  // src/tasks/redeem.ts
  var CONDITIONAL_TOKENS_ABI = [
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
  ];
  async function main(ctx) {
    const positions = await ctx.collection("positions").findMany({
      status: "open"
    });
    const openWithSize = positions.filter((p) => p.size > 0);
    if (!openWithSize.length) return;
    const gammaHost = ctx.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
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
        const ourOutcomeIndex = pos.side === "YES" ? 0 : 1;
        if (ourOutcomeIndex !== winner) {
          ctx.logEvent({
            code: "POSITION_LOST",
            message: `Lost position on ${market.question} (held ${pos.side})`
          });
          await ctx.collection("positions").setById(pos.id, {
            ...pos,
            status: "redeemed"
          });
          continue;
        }
        ctx.logEvent({
          code: "REDEEMING",
          message: `Redeeming winning ${pos.side} position on ${market.question}`,
          data: { conditionId: pos.conditionId, size: pos.size }
        });
        const wallet = await ctx.evm.wallet({
          name: "bot-composer",
          privateKey: ctx.env.PRIVATE_KEY,
          sponsorGas: false
        });
        const indexSets = [winner === 0 ? 1 : 2];
        const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";
        await wallet.callContract(
          ctx.evm.chains.polygon,
          CONTRACTS.conditionalTokens,
          CONDITIONAL_TOKENS_ABI[0],
          [CONTRACTS.usdc, parentCollectionId, pos.conditionId, indexSets]
        );
        ctx.logEvent({
          code: "REDEEMED",
          message: `Successfully redeemed ${pos.side} on ${market.question}`
        });
        await ctx.collection("positions").setById(pos.id, {
          ...pos,
          status: "redeemed"
        });
      } catch (err) {
        ctx.logEvent({
          code: "REDEEM_ERROR",
          message: `Failed to redeem ${pos.tokenId}: ${err}`
        });
      }
    }
  }
  return __toCommonJS(redeem_exports);
})();
