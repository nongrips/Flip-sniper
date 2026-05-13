/**
 * Arbitrage Profit Calculator — Community Fork
 *
 * Calculates profit margins for Vinted → eBay/Kleinanzeigen flips.
 * All values in EUR. Configurable fees for each platform.
 *
 * Fee defaults reflect German marketplace reality (May 2026):
 * - Vinted buy fees: shipping + buyer protection + electronics surcharge
 * - eBay DE sell: 0% for private sellers (since March 2023), PayPal ~2.99%+€0.39
 * - Kleinanzeigen: free for private listings, PayPal same as above
 */

// ─── Vinted Buy-Side Fees ───────────────────────────────────────────────────

const VINTED_FEES_DEFAULT = {
  shipping: 3.5,          // Standardversand innerhalb DE
  electronicsFee: 5.0,    // Elektronik-Aufschlag
  buyerProtectionFlat: 0.7,
  buyerProtectionPct: 0.05, // 5% des Artikelpreises
};

/**
 * Calculate total Vinted cost (what you actually pay).
 */
export function calcVintedTotal(itemPrice, fees = {}) {
  const f = { ...VINTED_FEES_DEFAULT, ...fees };
  const protection = f.buyerProtectionFlat + itemPrice * f.buyerProtectionPct;
  const total = itemPrice + f.shipping + f.electronicsFee + protection;
  return {
    itemPrice,
    shipping: f.shipping,
    electronicsFee: f.electronicsFee,
    buyerProtection: Math.round(protection * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

// ─── Sell-Side Fees ─────────────────────────────────────────────────────────

const EBAY_FEES_DEFAULT = {
  insertionFee: 0,         // 0€ für Privatverkäufer in DE
  finalValuePct: 0,        // 0% für Privatverkäufer in DE (seit März 2023)
  finalValueFlat: 0,
  paymentPct: 0.0299,      // PayPal Waren/Dienstleistungen DE
  paymentFlat: 0.39,
  shippingCost: 5.49,      // DHL Päckchen M (versichert bis 500€)
};

const KLEINANZEIGEN_FEES_DEFAULT = {
  listingFee: 0,            // Kostenlos für privat
  direkktKaufenFee: 0,      // Optional, zahlt meist der Käufer
  paymentPct: 0.0299,       // PayPal
  paymentFlat: 0.39,
  shippingCost: 5.49,
};

/**
 * Calculate net proceeds from selling on eBay DE.
 *
 * @param {number} sellPrice - The price you sell for
 * @param {object} [fees] - Override default fee structure
 * @returns {{ sellPrice, ebayFee, paymentFee, shippingCost, netProfit }}
 */
export function calcEbayProceeds(sellPrice, fees = {}) {
  const f = { ...EBAY_FEES_DEFAULT, ...fees };
  const ebayFee = f.insertionFee + sellPrice * f.finalValuePct + f.finalValueFlat;
  const paymentFee = sellPrice * f.paymentPct + f.paymentFlat;
  const net = sellPrice - ebayFee - paymentFee - f.shippingCost;

  return {
    sellPrice,
    ebayFee: Math.round(ebayFee * 100) / 100,
    paymentFee: Math.round(paymentFee * 100) / 100,
    shippingCost: f.shippingCost,
    netProceeds: Math.round(net * 100) / 100,
  };
}

/**
 * Calculate net proceeds from selling on eBay Kleinanzeigen.
 */
export function calcKleinanzeigenProceeds(sellPrice, fees = {}) {
  const f = { ...KLEINANZEIGEN_FEES_DEFAULT, ...fees };
  const platformFee = f.listingFee + f.direkktKaufenFee;
  const paymentFee = sellPrice * f.paymentPct + f.paymentFlat;
  const net = sellPrice - platformFee - paymentFee - f.shippingCost;

  return {
    sellPrice,
    platformFee: Math.round(platformFee * 100) / 100,
    paymentFee: Math.round(paymentFee * 100) / 100,
    shippingCost: f.shippingCost,
    netProceeds: Math.round(net * 100) / 100,
  };
}

// ─── Full Arbitrage Calculation ─────────────────────────────────────────────

/**
 * Run a full arbitrage scenario: buy on Vinted, sell on eBay/Kleinanzeigen.
 *
 * @param {object} params
 * @param {number} params.vintedPrice - Vinted listing price (EUR)
 * @param {number} params.ebayEstimate - Estimated eBay resale price (median of sold)
 * @param {number} params.kleinanzeigenEstimate - Estimated Kleinanzeigen resale price (median)
 * @param {object} [params.vintedFees]
 * @param {object} [params.ebayFees]
 * @param {object} [params.kleinanzeigenFees]
 * @returns {object} Full arbitrage breakdown
 */
export function calcArbitrage({
  vintedPrice,
  ebayEstimate,
  kleinanzeigenEstimate,
  vintedFees = {},
  ebayFees = {},
  kleinanzeigenFees = {},
}) {
  const buy = calcVintedTotal(vintedPrice, vintedFees);

  const ebaySell = ebayEstimate != null
    ? calcEbayProceeds(ebayEstimate, ebayFees)
    : null;

  const kaSell = kleinanzeigenEstimate != null
    ? calcKleinanzeigenProceeds(kleinanzeigenEstimate, kleinanzeigenFees)
    : null;

  const result = {
    buy,
    ebay: ebaySell
      ? {
          ...ebaySell,
          profit: Math.round((ebaySell.netProceeds - buy.total) * 100) / 100,
          roi: Math.round(((ebaySell.netProceeds - buy.total) / buy.total) * 10000) / 100,
        }
      : null,
    kleinanzeigen: kaSell
      ? {
          ...kaSell,
          profit: Math.round((kaSell.netProceeds - buy.total) * 100) / 100,
          roi: Math.round(((kaSell.netProceeds - buy.total) / buy.total) * 10000) / 100,
        }
      : null,
  };

  // Best platform recommendation
  const profits = [];
  if (result.ebay?.profit != null) profits.push({ platform: "eBay", profit: result.ebay.profit });
  if (result.kleinanzeigen?.profit != null) profits.push({ platform: "Kleinanzeigen", profit: result.kleinanzeigen.profit });
  profits.sort((a, b) => b.profit - a.profit);
  result.recommendation = profits[0] || null;

  // Quick verdict
  if (result.ebay?.profit != null && result.ebay.profit > 20) result.verdict = "strong_buy";
  else if (result.ebay?.profit != null && result.ebay.profit > 5) result.verdict = "buy";
  else if (result.ebay?.profit != null && result.ebay.profit > -10) result.verdict = "maybe";
  else if (result.kleinanzeigen?.profit != null && result.kleinanzeigen.profit > 5) result.verdict = "buy_ka";
  else result.verdict = result.ebay?.profit != null ? "skip" : "no_data";

  return result;
}

/**
 * Format an arbitrage result as human-readable summary lines.
 * Returns an array of strings suitable for console/cli output.
 */
export function formatArbitrageSummary(result) {
  const lines = [];

  lines.push("📦 BUY (Vinted)");
  lines.push(`   Item:      EUR ${result.buy.itemPrice.toFixed(2)}`);
  lines.push(`   Shipping:  EUR ${result.buy.shipping.toFixed(2)}`);
  lines.push(`   Protection: EUR ${result.buy.buyerProtection.toFixed(2)}`);
  lines.push(`   E-Fee:     EUR ${result.buy.electronicsFee.toFixed(2)}`);
  lines.push(`   ─────────────────────`);
  lines.push(`   TOTAL:     EUR ${result.buy.total.toFixed(2)}`);

  if (result.ebay) {
    lines.push("");
    lines.push("💰 SELL (eBay DE)");
    lines.push(`   Price:     EUR ${result.ebay.sellPrice.toFixed(2)}`);
    lines.push(`   eBay Fee:  EUR ${result.ebay.ebayFee.toFixed(2)}`);
    lines.push(`   PayPal:    EUR ${result.ebay.paymentFee.toFixed(2)}`);
    lines.push(`   Shipping:  EUR ${result.ebay.shippingCost.toFixed(2)}`);
    lines.push(`   ─────────────────────`);
    lines.push(`   Net:       EUR ${result.ebay.netProceeds.toFixed(2)}`);
    lines.push(`   PROFIT:    EUR ${result.ebay.profit.toFixed(2)} (${result.ebay.roi}% ROI)`);
  }

  if (result.kleinanzeigen) {
    lines.push("");
    lines.push("📋 SELL (Kleinanzeigen)");
    lines.push(`   Price:     EUR ${result.kleinanzeigen.sellPrice.toFixed(2)}`);
    lines.push(`   PayPal:    EUR ${result.kleinanzeigen.paymentFee.toFixed(2)}`);
    lines.push(`   Shipping:  EUR ${result.kleinanzeigen.shippingCost.toFixed(2)}`);
    lines.push(`   ─────────────────────`);
    lines.push(`   Net:       EUR ${result.kleinanzeigen.netProceeds.toFixed(2)}`);
    lines.push(`   PROFIT:    EUR ${result.kleinanzeigen.profit.toFixed(2)} (${result.kleinanzeigen.roi}% ROI)`);
  }

  if (result.recommendation) {
    lines.push("");
    lines.push(`🏆 Best: ${result.recommendation.platform} → EUR ${result.recommendation.profit.toFixed(2)} profit`);
  }

  lines.push(`📊 Verdict: ${result.verdict}`);
  return lines;
}
