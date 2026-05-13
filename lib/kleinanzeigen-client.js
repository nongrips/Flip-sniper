/**
 * eBay Kleinanzeigen Price Checker — Community Fork
 *
 * Scrapes current listings on kleinanzeigen.de to determine market prices.
 * Kleinanzeigen has aggressive anti-scraping, so this uses Puppeteer+Stealth
 * with realistic delays and a session-wide cookie acceptance flow.
 *
 * Usage:
 *   import { fetchKleinanzeigenPrices } from "./lib/kleinanzeigen-client.js";
 *   const result = await fetchKleinanzeigenPrices("iPhone 15 128GB");
 *   // → { avgPrice: 580, medianPrice: 570, count: 24, priceRange: {...} }
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { normalizeProxyInput } from "./shared-marketplace/proxy.js";

export const KLEINANZEIGEN_BASE = "https://www.kleinanzeigen.de";

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

export class KleinanzeigenBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "KleinanzeigenBlockedError";
    this.code = "KA_BLOCKED";
  }
}

export class KleinanzeigenTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "KleinanzeigenTimeoutError";
    this.code = "KA_TIMEOUT";
  }
}

// ─── URL builders ───────────────────────────────────────────────────────────

/**
 * Build Kleinanzeigen search URL.
 * /s-{query}/k0 = search all categories
 */
export function buildKleinanzeigenUrl(keyword, { page = 1 } = {}) {
  const encoded = encodeURIComponent(String(keyword || "").trim().replace(/\(/g, "").replace(/\)/g, ""));
  // Kleinanzeigen uses /s-{slug}/k0 format
  const slug = encoded.toLowerCase().replace(/%20/g, "-").replace(/%2f/gi, "-");
  const path = page > 1
    ? `/s-${slug}/seite:${page}/k0`
    : `/s-${slug}/k0`;
  return `${KLEINANZEIGEN_BASE}${path}`;
}

// ─── Cookie acceptance ─────────────────────────────────────────────────────

/**
 * Try to accept the cookie consent banner on Kleinanzeigen.
 */
async function acceptCookies(page) {
  try {
    // Multiple possible consent button selectors
    const selectors = [
      "#gdpr-banner-accept",
      ".gdpr-banner-accept",
      '[data-testid="gdpr-banner-accept"]',
      'button[aria-label*="Alle"]',
      "#consent-banner .btn-primary",
      ".consent-banner button[data-accept]",
    ];

    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await new Promise((r) => setTimeout(r, 800));
          return true;
        }
      } catch { /* try next selector */ }
    }
    return false;
  } catch {
    return false;
  }
}

// ─── DOM scraping ──────────────────────────────────────────────────────────

/**
 * Extract listing data from a Kleinanzeigen search results page.
 */
async function scrapeKleinanzeigenPage(page) {
  return page.evaluate(() => {
    function parseEurPrice(text) {
      if (!text) return null;
      const cleaned = text
        .replace(/EUR|€|VB|Preis:|ab\s*/gi, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/\s/g, "");
      // Handle "1.200" (German thousands)
      const parsed = Number.parseFloat(cleaned);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    const listings = [];

    // Modern Kleinanzeigen layout: article elements with aditem class
    const articles = document.querySelectorAll(".aditem, article.aditem, [data-testid='search-result']");
    for (const article of articles) {
      const titleEl = article.querySelector(".aditem-main h2, .aditem-main .text-module-begin, [data-testid='result-title']");
      const title = (titleEl?.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) continue;

      const priceEl = article.querySelector(".aditem-main .aditem-main--middle--price-shipping--price, .aditem-main--price, [data-testid='result-price']");
      const price = parseEurPrice(priceEl?.textContent || "");
      if (price === null) continue;

      const linkEl = article.querySelector("a[href*='/s-anzeige/']");
      const url = linkEl?.href || "";

      const locationEl = article.querySelector(".aditem-main .aditem-main--top--left, [data-testid='result-location']");
      const location = (locationEl?.textContent || "").replace(/\s+/g, " ").trim();

      const descEl = article.querySelector(".aditem-main .aditem-main--middle--description, [data-testid='result-description']");
      const description = (descEl?.textContent || "").replace(/\s+/g, " ").trim();

      listings.push({
        title,
        price,
        currency: "EUR",
        url,
        location,
        description,
      });
    }

    // Fallback: generic search result items
    if (listings.length === 0) {
      const items = document.querySelectorAll(
        '[class*="srp"][class*="result"], [id*="srp"] article, #srp-results article'
      );
      for (const item of items) {
        const title = (item.querySelector("h2, h3, .title")?.textContent || "").replace(/\s+/g, " ").trim();
        if (!title || title.length < 3) continue;

        const priceText = (item.textContent || "").match(/(\d+[\.,]?\d*)\s*(?:EUR|€|VB)/i);
        const price = priceText ? parseEurPrice(priceText[0]) : null;
        if (price === null) continue;

        listings.push({
          title,
          price,
          currency: "EUR",
          url: "",
          location: "",
          description: "",
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

export async function createKleinanzeigenSession({
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
    // Block images/fonts for speed — prices are in text
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

  let cookiesAccepted = false;

  async function search(keyword, { pages = 2, limit = 50 } = {}) {
    const allListings = [];
    const pageObj = await browser.newPage();
    await configurePage(pageObj);

    for (let p = 1; p <= pages; p++) {
      try {
        const url = buildKleinanzeigenUrl(keyword, { page: p });
        await pageObj.goto(url, {
          waitUntil: "networkidle2",
          timeout: timeoutMs,
        });

        // Check for blocking / CAPTCHA
        const bodyText = await pageObj.evaluate(() => document.body?.innerText || "");
        if (/verify you are human|press and hold|cloudflare|turnstile/i.test(bodyText)) {
          throw new KleinanzeigenBlockedError(
            "Kleinanzeigen is showing a CAPTCHA/block page."
          );
        }

        // Accept cookies on first page
        if (!cookiesAccepted) {
          await acceptCookies(pageObj);
          cookiesAccepted = true;
          // Wait for any cookie overlay to disappear
          await new Promise((r) => setTimeout(r, 1000));
        }

        const listings = await scrapeKleinanzeigenPage(pageObj);
        allListings.push(...listings);

        // Stop if last page (fewer results than expected)
        if (listings.length < 15) break;
        if (allListings.length >= limit) break;

        // Human-like delay between pages
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
      } catch (error) {
        if (error instanceof KleinanzeigenBlockedError) throw error;
        if (p === 1) throw error;
        break;
      }
    }

    await pageObj.close().catch(() => {});
    return allListings.slice(0, limit);
  }

  return {
    search,
    acceptCookies: () => cookiesAccepted,
    close: () => browser.close(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch current listing prices from eBay Kleinanzeigen for a keyword.
 *
 * @param {string} keyword - Search query (e.g. "iPhone 15 128GB")
 * @param {object} [options]
 * @param {number} [options.pages=2]
 * @param {number} [options.limit=50]
 * @returns {Promise<{avgPrice: number|null, medianPrice: number|null, minPrice: number|null, maxPrice: number|null, count: number, listings: object[]}>}
 */
export async function fetchKleinanzeigenPrices(keyword, options = {}) {
  const session = await createKleinanzeigenSession(options);
  try {
    const listings = await session.search(keyword, {
      pages: options.pages || 2,
      limit: options.limit || 50,
    });

    const prices = listings
      .map((l) => l.price)
      .filter((p) => p !== null && Number.isFinite(p) && p > 0)
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

    const avgPrice =
      Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
    const medianPrice =
      prices.length % 2 === 0
        ? Math.round(
            ((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) * 100
          ) / 100
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
