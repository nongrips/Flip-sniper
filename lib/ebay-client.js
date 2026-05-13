/**
 * eBay DE Price Checker — Community Fork
 *
 * Scrapes sold listings on ebay.de to determine realistic resale prices.
 * Uses Puppeteer + stealth plugin (already a project dependency).
 *
 * Usage:
 *   import { fetchEbaySoldPrices } from "./lib/ebay-client.js";
 *   const result = await fetchEbaySoldPrices("iPhone 15 128GB");
 *   // → { avgPrice: 620, medianPrice: 610, minPrice: 520, maxPrice: 750, count: 12, ... }
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { normalizeProxyInput } from "./shared-marketplace/proxy.js";

export const EBAY_DE_BASE = "https://www.ebay.de";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let stealthRegistered = false;

function registerStealth() {
  if (stealthRegistered) return;
  puppeteer.use(StealthPlugin());
  stealthRegistered = true;
}

// ─── Error classes ──────────────────────────────────────────────────────────

export class EbayBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "EbayBlockedError";
    this.code = "EBAY_BLOCKED";
  }
}

export class EbayTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "EbayTimeoutError";
    this.code = "EBAY_TIMEOUT";
  }
}

// ─── URL builders ───────────────────────────────────────────────────────────

/**
 * Build eBay DE sold listings search URL.
 * LH_Sold=1 → only sold items, LH_Complete=1 → only completed listings.
 */
export function buildEbaySoldUrl(keyword, { page = 1 } = {}) {
  const url = new URL("/sch/i.html", EBAY_DE_BASE);
  url.searchParams.set("_nkw", String(keyword || "").trim());
  url.searchParams.set("LH_Sold", "1");
  url.searchParams.set("LH_Complete", "1");
  if (page > 1) url.searchParams.set("_pgn", String(page));
  return url.toString();
}

// ─── DOM scraping ───────────────────────────────────────────────────────────

/**
 * Extract sold listing data from the eBay search results page DOM.
 * Returns normalized price data.
 */
async function scrapeEbaySoldPage(page) {
  return page.evaluate(() => {
    /**
     * Parse a German-formatted price string like "EUR 620,00" or "620,00 €".
     */
    function parseEurPrice(text) {
      if (!text) return null;
      const cleaned = text.replace(/EUR|€|\s/g, "").replace(/\./g, "").replace(",", ".");
      const parsed = Number.parseFloat(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    }

    /**
     * Parse a date string like "30. Apr. 2026" or "Verkauft 30.04.2026".
     */
    function parseSoldDate(text) {
      if (!text) return null;
      // German month names
      const months = {
        jan: 0, feb: 1, "mär": 2, apr: 3, mai: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dez: 10
      };
      const match = text.match(/(\d{1,2})\.\s*(\w{3})\.?\s*(\d{4})/i);
      if (match) {
        const day = Number.parseInt(match[1], 10);
        const monthKey = match[2].toLowerCase().slice(0, 3);
        const year = Number.parseInt(match[3], 10);
        const month = months[monthKey];
        if (month !== undefined) return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
      // Try numeric format: 30.04.2026
      const numericMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      if (numericMatch) {
        return `${numericMatch[3]}-${String(Number(numericMatch[2])).padStart(2, "0")}-${String(Number(numericMatch[1])).padStart(2, "0")}`;
      }
      return null;
    }

    const listings = [];

    // Strategy 1: Find s-item containers (modern eBay layout)
    const items = document.querySelectorAll(".s-item");
    for (const item of items) {
      const titleEl = item.querySelector(".s-item__title");
      const title = (titleEl?.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || title.startsWith("Ergebnisse für") || title.includes("Neues Listing")) continue;

      const priceEl = item.querySelector(".s-item__price");
      const price = parseEurPrice(priceEl?.textContent || "");

      const shippingEl = item.querySelector(".s-item__shipping, .s-item__logisticsCost");
      const shippingText = (shippingEl?.textContent || "").trim();
      const shippingFree = /kostenlos|gratis/i.test(shippingText);
      const shippingCost = shippingFree ? 0 : parseEurPrice(shippingText);

      const linkEl = item.querySelector(".s-item__link");
      const url = linkEl?.href || "";

      const dateEl = item.querySelector(".s-item__endedDate, .s-item__title--date, .POSITIVE");
      const soldDate = parseSoldDate(dateEl?.textContent || "");

      // Skip items without a price (these are usually "price on request")
      if (price === null) continue;

      listings.push({
        title,
        price,
        currency: "EUR",
        shippingCost,
        shippingFree,
        url: url.split("?")[0],
        soldDate,
      });
    }

    // Strategy 2: If no s-items found, try generic srp-results layout
    if (listings.length === 0) {
      const resultItems = document.querySelectorAll(".srp-results li.s-item, .srp-results .s-item");
      for (const item of resultItems) {
        const titleEl = item.querySelector("h3, .s-item__title");
        const title = (titleEl?.textContent || "").replace(/\s+/g, " ").trim();
        if (!title) continue;

        const priceEl = item.querySelector(".s-item__price");
        const price = parseEurPrice(priceEl?.textContent || "");
        if (price === null) continue;

        listings.push({
          title,
          price,
          currency: "EUR",
          shippingCost: null,
          shippingFree: false,
          url: "",
          soldDate: null,
        });
      }
    }

    return listings;
  });
}

// ─── Session management ─────────────────────────────────────────────────────

function parseProxyUrl(raw) {
  const proxy = normalizeProxyInput(raw);
  if (!proxy) return null;
  return {
    server: proxy.server,
    username: proxy.username,
    password: proxy.password,
  };
}

export async function createEbaySession({
  proxy = "",
  userAgent = DEFAULT_USER_AGENT,
  headless = "new",
  timeoutMs = 45000,
} = {}) {
  registerStealth();
  const parsedProxy = parseProxyUrl(proxy);
  const args = ["--no-sandbox", "--disable-setuid-sandbox"];
  if (parsedProxy?.server) args.push(`--proxy-server=${parsedProxy.server}`);

  const browser = await puppeteer.launch({ headless, args });

  async function configurePage(page) {
    await page.setViewport({ width: 1365, height: 900 });
    await page.setUserAgent(userAgent || DEFAULT_USER_AGENT);
    if (parsedProxy?.username) {
      await page.authenticate({
        username: parsedProxy.username,
        password: parsedProxy.password || "",
      });
    }
    // Block unnecessary resources for speed
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  async function searchSold(keyword, { pages = 2, limit = 50 } = {}) {
    const allListings = [];
    const pageObj = await browser.newPage();
    await configurePage(pageObj);

    for (let p = 1; p <= pages; p++) {
      try {
        const url = buildEbaySoldUrl(keyword, { page: p });
        await pageObj.goto(url, {
          waitUntil: "networkidle2",
          timeout: timeoutMs,
        });

        // Check for blocking
        const bodyText = await pageObj.evaluate(() => document.body.innerText);
        if (/bitte bestätigen sie|confirm.*human|are you a robot|cloudflare/i.test(bodyText)) {
          throw new EbayBlockedError("eBay is showing a CAPTCHA or block page.");
        }

        const listings = await scrapeEbaySoldPage(pageObj);
        allListings.push(...listings);

        // Stop if we got fewer results than a full page
        if (listings.length < 20) break;
        if (allListings.length >= limit) break;

        // Small delay between pages
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
      } catch (error) {
        if (error instanceof EbayBlockedError) throw error;
        // On other errors, return what we have so far
        if (p === 1) throw error;
        break;
      }
    }

    await pageObj.close().catch(() => {});
    return allListings.slice(0, limit);
  }

  return {
    searchSold,
    close: () => browser.close(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch sold listing prices from eBay DE for a given keyword.
 *
 * @param {string} keyword - Search query (e.g. "iPhone 15 128GB")
 * @param {object} [options]
 * @param {string} [options.proxy] - Proxy string
 * @param {string} [options.userAgent] - Custom user agent
 * @param {number} [options.pages=2] - Number of result pages to scrape
 * @returns {Promise<{avgPrice: number|null, medianPrice: number|null, minPrice: number|null, maxPrice: number|null, count: number, listings: object[]}>}
 */
export async function fetchEbaySoldPrices(keyword, options = {}) {
  const session = await createEbaySession(options);
  try {
    const listings = await session.searchSold(keyword, {
      pages: options.pages || 2,
      limit: options.limit || 50,
    });

    const prices = listings
      .map((l) => l.price)
      .filter((p) => p !== null && Number.isFinite(p))
      .sort((a, b) => a - b);

    if (prices.length === 0) {
      return {
        avgPrice: null,
        medianPrice: null,
        minPrice: null,
        maxPrice: null,
        count: 0,
        listings: [],
      };
    }

    const avgPrice = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
    const medianPrice = prices.length % 2 === 0
      ? Math.round(((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) * 100) / 100
      : prices[Math.floor(prices.length / 2)];

    return {
      avgPrice,
      medianPrice,
      minPrice: prices[0],
      maxPrice: prices[prices.length - 1],
      count: prices.length,
      listings: listings.filter((l) => l.price !== null),
    };
  } finally {
    await session.close();
  }
}

/**
 * Quick price check — returns just the estimated resale value (median of sold).
 */
export async function estimateResalePrice(keyword, options = {}) {
  const result = await fetchEbaySoldPrices(keyword, options);
  return {
    estimatedPrice: result.medianPrice || result.avgPrice,
    confidence: result.count >= 5 ? "high" : result.count >= 2 ? "medium" : "low",
    sampleSize: result.count,
    priceRange: result.minPrice && result.maxPrice
      ? { min: result.minPrice, max: result.maxPrice }
      : null,
  };
}
