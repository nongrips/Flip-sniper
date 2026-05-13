/**
 * Arbitrage Sniper — Community Fork
 *
 * End-to-end Vinted → eBay/Kleinanzeigen arbitrage workflow.
 *
 * Flow:
 *   1. Search Vinted for deals using the shared watchlist
 *   2. For each deal, check eBay DE sold prices + Kleinanzeigen current listings
 *   3. Calculate profit margins (all fees included)
 *   4. Save enriched results to data/arbitrage/found.ndjson
 *   5. Optional Discord notifications
 *
 * Usage:
 *   node lib/arbitrage-sniper.js
 *   node lib/arbitrage-sniper.js --test       (single scan, no loop)
 *   node lib/arbitrage-sniper.js --once       (single scan, exit)
 */

import axios from "axios";
import chalk from "chalk";
import fs from "fs";
import path from "path";

import { DATA_DIR, VINTED_SEEN_FILE } from "./paths.js";
import {
  loadWorkspaceConfig,
  loadWorkspaceWatchlist,
  ensureWorkspaceFiles,
  resolveTargetForPlatform,
  hasConfirmedLocation,
  vintedDomainInfo,
  VINTED_DOMAINS,
} from "./shared-marketplace/workspace.js";
import { getActivePlatformTargets, targetMatchesText } from "./shared-marketplace/target-utils.js";
import { scoreElectronicsListing, scoreGenericListing } from "./shared-marketplace/programmatic-scorer.js";
import { notify } from "./shared-marketplace/notifier.js";
import { resolveTargetPriceBand, resolveTargetReferencePrice } from "./shared-marketplace/price-band.js";
import { convertPriceBandForCurrency, createCurrencyConverter, currencyForVintedDomain } from "./shared-marketplace/currency.js";
import { normalizeProxyInput } from "./shared-marketplace/proxy.js";

import { fetchEbaySoldPrices, EbayBlockedError, EbayTimeoutError } from "./ebay-client.js";
import { fetchKleinanzeigenPrices, KleinanzeigenBlockedError, KleinanzeigenTimeoutError } from "./kleinanzeigen-client.js";
import { calcArbitrage, formatArbitrageSummary } from "./arbitrage-calc.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const ARBITRAGE_DATA_DIR = path.join(DATA_DIR, "arbitrage");
const ARBITRAGE_FOUND_FILE = path.join(ARBITRAGE_DATA_DIR, "found.ndjson");
const ARBITRAGE_SEEN_FILE = path.join(ARBITRAGE_DATA_DIR, "seen_ids.json");

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const BRAND_IDS = "54661";
const CATALOG_IDS = "3661";
const STATUS_IDS = "2,3,1,6";

const FEE_SHIPPING = 3.50;
const FEE_ELECTRONICS = 5.00;
const FEE_PROTECTION_FLAT = 0.70;
const FEE_PROTECTION_PCT = 0.05;

const POLL_INTERVAL_MS = 60000;

const FLAG_TEST = process.argv.includes("--test");
const FLAG_ONCE = process.argv.includes("--once") || FLAG_TEST;

// ─── Vinted API helpers (minimal replica for standalone use) ────────────────

let activeUserAgent = MOBILE_UA;
let VINTED_BASE = "";
let VINTED_LANG = "en-US,en;q=0.9";

const CATALOG_URL = () => `${VINTED_BASE}/api/v2/catalog/items`;
const COOKIE_URL = () => `${VINTED_BASE}/`;

function resolveUserAgent(workspaceConfig) {
  const fromConfig = workspaceConfig?.bots?.vinted?.userAgent;
  const fromEnv = process.env.VINTED_USER_AGENT;
  const candidate = String(fromConfig || fromEnv || "").trim();
  activeUserAgent = candidate || MOBILE_UA;
  return activeUserAgent;
}

function extractToken(cookieStr) {
  const s = String(cookieStr || "").trim();
  if (!s) return null;
  const m = s.match(/(?:^|;\s*)access_token_web=([^;]+)/);
  return m ? m[1] : s;
}

let cookieCache = { value: null, token: null, fetchedAt: 0 };

function loadManualCookie(workspaceConfig) {
  const raw = workspaceConfig?.bots?.vinted?.cookie || process.env.VINTED_COOKIE;
  if (!raw) return null;
  const trimmed = raw.trim();
  const token = extractToken(trimmed);
  if (!token) return null;
  const value = /access_token_web=/i.test(trimmed) ? trimmed : `access_token_web=${token}`;
  return { value, token, fetchedAt: Date.now() };
}

async function fetchCookie(proxyUrl) {
  const response = await axios.get(COOKIE_URL(), {
    headers: {
      "User-Agent": activeUserAgent,
      "Accept-Language": VINTED_LANG,
      Accept: "text/html,application/xhtml+xml",
    },
    proxy: proxyUrl || false,
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  const setCookie = response.headers["set-cookie"] || [];
  const parts = [];
  let token = null;
  for (const entry of setCookie) {
    const pair = entry.split(";")[0];
    parts.push(pair);
    if (pair.startsWith("access_token_web=")) token = pair.slice("access_token_web=".length);
  }
  if (!token) throw new Error(`access_token_web not found (HTTP ${response.status})`);
  const value = parts.join("; ");
  cookieCache = { value, token, fetchedAt: Date.now() };
  return cookieCache;
}

async function getCookie(workspaceConfig, { force = false } = {}) {
  if (!force) {
    const manual = loadManualCookie(workspaceConfig);
    if (manual) {
      cookieCache = manual;
      return cookieCache;
    }
  }
  if (!force && cookieCache.value && Date.now() - cookieCache.fetchedAt < 55 * 60 * 1000) {
    return cookieCache;
  }
  while (true) {
    try {
      return await fetchCookie();
    } catch (err) {
      const manual = loadManualCookie(workspaceConfig);
      if (manual) {
        console.log(chalk.yellow(`[arb] Auto-fetch failed (${err.message}) — using manual cookie`));
        cookieCache = manual;
        return cookieCache;
      }
      console.error(chalk.red(`[arb] Cookie fetch failed: ${err.message} — retrying in 30s`));
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

function vintedHeaders(cookie) {
  return {
    Cookie: cookie.value,
    Authorization: `Bearer ${cookie.token}`,
    "User-Agent": activeUserAgent,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": VINTED_LANG,
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${VINTED_BASE}/catalog`,
  };
}

async function searchListings(cookie, { keyword, priceFrom = 0, priceTo = 800, generic = false }) {
  const params = {
    search_text: keyword,
    status_ids: STATUS_IDS,
    price_from: priceFrom,
    price_to: priceTo,
    currency: "EUR",
    order: "newest_first",
    per_page: 30,
    page: 1,
  };
  if (!generic) {
    params.brand_ids = BRAND_IDS;
    params.catalog_ids = CATALOG_IDS;
  }
  const response = await axios.get(CATALOG_URL(), {
    headers: vintedHeaders(cookie),
    params,
    timeout: 20000,
    validateStatus: () => true,
  });
  if (response.status === 429) {
    console.log(chalk.yellow("[arb] Vinted 429 — cooling off 2 min"));
    await new Promise((r) => setTimeout(r, 120000));
    return [];
  }
  if (response.status === 403) {
    console.log(chalk.yellow("[arb] Vinted 403 — cookie may need refresh"));
    return [];
  }
  if (response.status >= 400) {
    console.log(chalk.yellow(`[arb] Vinted search returned ${response.status}`));
    return [];
  }
  return Array.isArray(response.data?.items) ? response.data.items : [];
}

function extractPrice(item) {
  const raw = item?.price;
  if (raw == null) return NaN;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  if (typeof raw === "object") return Number(raw.amount);
  return NaN;
}

// ─── File I/O ───────────────────────────────────────────────────────────────

function loadSeenIds() {
  try {
    if (fs.existsSync(ARBITRAGE_SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(ARBITRAGE_SEEN_FILE, "utf8"));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch { /* start fresh */ }
  return new Set();
}

function saveSeenIds(seenIds) {
  let arr = Array.from(seenIds);
  if (arr.length > 10000) arr = arr.slice(arr.length - 10000);
  fs.mkdirSync(ARBITRAGE_DATA_DIR, { recursive: true });
  fs.writeFileSync(ARBITRAGE_SEEN_FILE, JSON.stringify(arr), "utf8");
}

function appendFound(record) {
  fs.mkdirSync(ARBITRAGE_DATA_DIR, { recursive: true });
  fs.appendFileSync(ARBITRAGE_FOUND_FILE, JSON.stringify(record) + "\n", "utf8");
}

// ─── Price checking ─────────────────────────────────────────────────────────

/**
 * Build a clean search query for eBay/Kleinanzeigen from a Vinted listing.
 * Strips condition info, focuses on model + storage.
 */
function buildResaleQuery(itemTitle, itemDescription) {
  const text = `${itemTitle || ""} ${itemDescription || ""}`.toLowerCase();

  // Extract core model info: "iPhone 15 Pro Max 256GB"
  const modelMatch = text.match(/iphone\s*\d{1,2}\s*(pro\s*max|pro|plus|mini)?/i);
  if (!modelMatch) return (itemTitle || "").slice(0, 80).trim();

  let query = modelMatch[0].replace(/\s+/g, " ").trim();

  // Try to append storage
  const storageMatch = text.match(/(\d{2,4})\s*(gb|go|tb)/i);
  if (storageMatch) {
    query += ` ${storageMatch[1]}GB`;
  }

  return query;
}

/**
 * Run price checks on both platforms with graceful degradation.
 */
async function checkResalePrices(query, options = {}) {
  const results = { ebay: null, kleinanzeigen: null, errors: [] };

  // eBay (sold listings)
  try {
    console.log(chalk.gray(`[arb] Checking eBay: "${query}"`));
    results.ebay = await fetchEbaySoldPrices(query, {
      pages: options.ebayPages || 1,
      limit: 30,
    });
    if (results.ebay.count > 0) {
      console.log(
        chalk.gray(
          `[arb] eBay: ${results.ebay.count} sold, median EUR ${results.ebay.medianPrice}, avg EUR ${results.ebay.avgPrice}`
        )
      );
    } else {
      console.log(chalk.yellow(`[arb] eBay: no sold listings found for "${query}"`));
    }
  } catch (error) {
    const msg = `eBay: ${error.message}`;
    results.errors.push(msg);
    console.log(chalk.yellow(`[arb] ${msg}`));
  }

  // Kleinanzeigen (current listings)
  try {
    console.log(chalk.gray(`[arb] Checking Kleinanzeigen: "${query}"`));
    results.kleinanzeigen = await fetchKleinanzeigenPrices(query, {
      pages: options.kaPages || 1,
      limit: 30,
    });
    if (results.kleinanzeigen.count > 0) {
      console.log(
        chalk.gray(
          `[arb] Kleinanzeigen: ${results.kleinanzeigen.count} listings, median EUR ${results.kleinanzeigen.medianPrice}`
        )
      );
    } else {
      console.log(chalk.yellow(`[arb] Kleinanzeigen: no listings found for "${query}"`));
    }
  } catch (error) {
    const msg = `Kleinanzeigen: ${error.message}`;
    results.errors.push(msg);
    console.log(chalk.yellow(`[arb] ${msg}`));
  }

  return results;
}

// ─── Scan Cycle ─────────────────────────────────────────────────────────────

let seenIds = new Set();
let cycleCount = 0;

async function runTargetQuery(target, cookie, workspaceConfig) {
  const keyword = target?.query || target?.label || "iphone";
  const priceBand = resolveTargetPriceBand(target);
  const product = String(target?.product || "general").toLowerCase();
  const isIphone = product === "iphone";
  const items = await searchListings(cookie, {
    keyword,
    priceFrom: priceBand.minPrice,
    priceTo: priceBand.maxPrice,
    generic: !isIphone,
  });

  for (const item of items) {
    const id = item?.id;
    if (!id || seenIds.has(String(id))) continue;
    seenIds.add(String(id));

    const listedPrice = extractPrice(item);
    if (!Number.isFinite(listedPrice) || listedPrice <= 0) continue;

    const title = String(item?.title || "").trim();
    if (!targetMatchesText(target, `${title} ${item.description || ""}`)) continue;

    console.log(
      chalk.cyan(`\n[arb] 🔍 Found: "${title.slice(0, 60)}" — EUR ${listedPrice}`)
    );

    // Build resale search query
    const resaleQuery = buildResaleQuery(title, item?.description || "");

    // Run price checks
    const priceData = await checkResalePrices(resaleQuery);

    // Calculate arbitrage
    const arbitrage = calcArbitrage({
      vintedPrice: listedPrice,
      ebayEstimate: priceData.ebay?.medianPrice || priceData.ebay?.avgPrice || null,
      kleinanzeigenEstimate:
        priceData.kleinanzeigen?.medianPrice || priceData.kleinanzeigen?.avgPrice || null,
    });

    // Print summary
    console.log(formatArbitrageSummary(arbitrage).join("\n"));

    // Build enriched record
    const record = {
      id: `arb-${id}`,
      timestamp: new Date().toISOString(),
      platform: "arbitrage",
      source: "vinted",
      source_id: id,
      title,
      url: `${VINTED_BASE}/items/${id}`,
      vinted_price: listedPrice,
      query: resaleQuery,
      arbitrage,
      ebay_data: priceData.ebay
        ? {
            avgPrice: priceData.ebay.avgPrice,
            medianPrice: priceData.ebay.medianPrice,
            minPrice: priceData.ebay.minPrice,
            maxPrice: priceData.ebay.maxPrice,
            count: priceData.ebay.count,
          }
        : null,
      kleinanzeigen_data: priceData.kleinanzeigen
        ? {
            avgPrice: priceData.kleinanzeigen.avgPrice,
            medianPrice: priceData.kleinanzeigen.medianPrice,
            minPrice: priceData.kleinanzeigen.minPrice,
            maxPrice: priceData.kleinanzeigen.maxPrice,
            count: priceData.kleinanzeigen.count,
          }
        : null,
      errors: priceData.errors,
    };

    appendFound(record);

    // Discord notification for strong deals
    if (arbitrage.verdict === "strong_buy") {
      const bestProfit =
        arbitrage.recommendation?.profit || arbitrage.ebay?.profit || 0;
      await notify({
        platform: "arbitrage",
        grade: "A",
        title: `🔥 Flip: ${title}`,
        url: record.url,
        listing_price: listedPrice,
        max_buy: arbitrage.buy.total,
        max_buy_all_in: arbitrage.buy.total,
        score: Math.min(100, Math.round(bestProfit)),
        reasons: [
          `Buy EUR ${listedPrice} → Sell ~EUR ${arbitrage.ebay?.sellPrice || arbitrage.kleinanzeigen?.sellPrice || "?"}`,
          `Profit: EUR ${bestProfit.toFixed(2)}`,
          `Platform: ${arbitrage.recommendation?.platform || "?"}`,
          `ROI: ${arbitrage.ebay?.roi || arbitrage.kleinanzeigen?.roi || 0}%`,
        ],
        target: { label: resaleQuery, group: "Arbitrage" },
        condition: item?.status || "Unknown",
      }).catch((err) => console.log(chalk.yellow(`[arb] Discord notify failed: ${err.message}`)));
    }

    // Small delay between items to avoid rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.green("🔄 Flip-Sniper Arbitrage Mode"));
  console.log(chalk.gray("Vinted → eBay DE / eBay Kleinanzeigen\n"));

  const workspaceConfig = loadWorkspaceConfig();
  ensureWorkspaceFiles(workspaceConfig);

  // Configure Vinted domain
  const vintedDomain = workspaceConfig?.bots?.vinted?.domain || "www.vinted.de";
  const domainInfo = vintedDomainInfo(vintedDomain);
  if (!domainInfo) {
    console.error(chalk.red(`[arb] Unknown Vinted domain: ${vintedDomain}`));
    console.error(chalk.red("Set it in Settings → Vinted Country dropdown."));
    process.exit(1);
  }
  VINTED_BASE = `https://${domainInfo.domain}`;
  VINTED_LANG = domainInfo.lang;
  console.log(chalk.gray(`[arb] Vinted domain: ${VINTED_BASE}`));

  resolveUserAgent(workspaceConfig);

  // Load watchlist (Vinted targets only)
  const workspaceWatchlist = loadWorkspaceWatchlist();
  const targets = getActivePlatformTargets(workspaceWatchlist, "vinted");
  if (!targets.length) {
    console.error(chalk.red("[arb] No active Vinted targets in shared watchlist."));
    console.error(chalk.red("Add targets in the Shared Watchlist tab with platform=vinted."));
    process.exit(1);
  }
  console.log(chalk.gray(`[arb] ${targets.length} Vinted target(s) loaded\n`));

  // Load seen IDs
  seenIds = loadSeenIds();
  console.log(chalk.gray(`[arb] ${seenIds.size} seen IDs loaded\n`));

  // Main loop
  while (true) {
    cycleCount++;
    console.log(chalk.gray(`\n── Cycle ${cycleCount} ── ${new Date().toLocaleString()}`));

    try {
      const cookie = await getCookie(workspaceConfig);

      for (const target of targets) {
        try {
          await runTargetQuery(target, cookie, workspaceConfig);
        } catch (error) {
          console.error(chalk.red(`[arb] Target error: ${error.message}`));
        }
        // Delay between targets
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (error) {
      console.error(chalk.red(`[arb] Cycle error: ${error.message}`));
    }

    // Save seen IDs periodically
    saveSeenIds(seenIds);

    if (FLAG_ONCE) {
      console.log(chalk.green("\n✓ Single scan complete"));
      break;
    }

    console.log(chalk.gray(`[arb] Next scan in ${POLL_INTERVAL_MS / 1000}s...`));
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error(chalk.red(`[arb] Fatal: ${error.message}`));
  process.exit(1);
});
