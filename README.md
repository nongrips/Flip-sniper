# Flip-Sniper 🔄

**Vinted → eBay / Kleinanzeigen Arbitrage-Bot**

Ein Fork des [FBM Sniper Community](https://github.com/ethanashi/fbm-sniper-community) Projekts, erweitert um eine vollständige **Arbitrage-Pipeline**: Kaufe günstig auf Vinted, verkaufe teurer auf eBay und eBay Kleinanzeigen — mit automatischer Preisanalyse und Profit-Berechnung.

Alles läuft lokal auf deinem Rechner. Discord-Benachrichtigungen optional.

---

## 🆕 Was dieser Fork hinzufügt

### Arbitrage-Mode (`npm run arb`)
- **Automatische Preis-Recherche**: Sobald ein Deal auf Vinted gefunden wird, checkt der Bot automatisch:
  - **eBay DE** — verkaufte Artikel (realistische Resale-Preise)
  - **eBay Kleinanzeigen** — aktuelle Live-Listings
- **Profit-Rechner** mit echten Gebühren:
  - Vinted: Versand + Käuferschutz + Elektronik-Aufschlag
  - eBay: PayPal-Gebühren (2,99% + 0,39€) + Versand (DHL 5,49€)
  - Kleinanzeigen: PayPal + Versand (kostenlose Listings für Privat)
- **Smart Scoring**: `strong_buy` / `buy` / `maybe` / `skip` — direkt mit ROI-Prozent
- **Discord-Alerts** nur für lohnende Deals (Grade A, Profit > 20€)

### Neue Module

| Modul | Zweck |
|---|---|
| `lib/ebay-client.js` | eBay DE Sold-Listing-Scraper (Puppeteer+Stealth) |
| `lib/kleinanzeigen-client.js` | Kleinanzeigen Live-Preis-Scraper |
| `lib/arbitrage-calc.js` | Profit-Rechner mit Plattform-Gebühren |
| `lib/arbitrage-sniper.js` | End-to-End Orchestrator |

---

## 🚀 Quickstart Arbitrage

```bash
git clone https://github.com/nongrips/Flip-sniper.git
cd Flip-sniper
npm install

# Einmaliger Scan (testen)
npm run arb:once

# Dauerbetrieb (scannt alle 60 Sekunden)
npm run arb
```

**Voraussetzungen:**
- Node.js 18+
- Vinted-Land in `data/shared-marketplace/config.json` auf Deutschland (`www.vinted.de`) gesetzt
- Vinted-Cookie (wird auto-fetched, manuelles Cookie für bessere Raten optional)
- Optional: Discord-Webhooks für Deal-Alerts

---

## Supported bots

| Bot | Purpose |
| --- | --- |
| 🚗 Cars | Original Facebook Marketplace car scanner |
| 📘 Facebook | Electronics sniper driven by the shared watchlist |
| 🛒 Wallapop | Electronics sniper with shared watchlist + rate-limit backoff |
| 👗 Vinted | Electronics sniper with fee-aware ceilings and cookie refresh |
| 🔄 **Arbitrage** | **Vinted → eBay/Kleinanzeigen Flip-Pipeline (NEU)** |

---

## Arbitrage Workflow

```
Vinted-Fund: "iPhone 15 Pro 256GB" für EUR 500
         ↓
eBay DE (verkauft):  Median EUR 720 (15 Verkäufe)
Kleinanzeigen:       Median EUR 680 (22 Anzeigen)
         ↓
📊 ARBITRAGE:
  Buy (Vinted):   EUR 500 + 9.20 Gebühren = EUR 509.20
  Sell (eBay):    EUR 720 - 21.92 PayPal - 5.49 Versand = EUR 692.59
  💰 PROFIT:      EUR 183.39 (36% ROI) 🏆
  Verdict:        strong_buy → Discord-Alert!
```

---

## CLI Commands

```bash
# Original Sniper
npm run scan          # Cars scanner
npm run scan:test     # Cars test mode
npm run ui            # Web UI + API server
npm run desktop       # Electron desktop app

# Flip-Sniper Arbitrage (NEU)
npm run arb           # Dauerbetrieb
npm run arb:once      # Einmaliger Scan
npm run check:arb     # Syntax-Check Arbitrage-Module

# Dev
npm run check         # Syntax-Check aller Module
npm run seed          # Sample-Daten generieren
```

---

## Discord Webhooks

Drei optionale Webhooks im Settings-Tab:

- `All Webhook` — jeder Deal (inkl. Arbitrage-Funde)
- `Buy Now Webhook` — Grade A+B, starke Arbitrage-Deals
- `Maybe Webhook` — Grade C+D

Arbitrage-Deals mit Verdict `strong_buy` werden automatisch an den Buy-Now-Webhook gesendet — inklusive Profit, ROI und Plattform-Empfehlung.

---

## Vinted Country + Cookie Setup

Vinted läuft pro Land auf einer eigenen Domain. Für Deutschland:

1. Wähle `Germany (www.vinted.de)` im Settings → Vinted Country Dropdown
2. Cookie ist optional — der Bot holt sich automatisch einen
3. Für bessere Raten: manuelles Cookie mit `access_token_web=...` von vinted.de

---

## Environment Variables

- `VINTED_COOKIE` — Manuelles Vinted-Cookie (optional)
- `VINTED_USER_AGENT` — Custom User-Agent (optional)
- `VINTED_PROXY` — Proxy für Vinted-Requests
- `PROXY_ENABLED` / `PROXY_HOST` / `PROXY_PORT` — Proxy für eBay/Kleinanzeigen

---

## Data Layout

```
data/
  arbitrage/
    found.ndjson      ← Arbitrage-Funde mit Profit-Daten (NEU)
    seen_ids.json      ← Bereits geprüfte Vinted-IDs
  vinted/
    found.ndjson       ← Vinted-Rohfunde
  facebook/
    found.ndjson
  wallapop/
    found.ndjson
  shared-marketplace/
    config.json        ← Plattform-Config
    watchlist.json     ← Geteilte Watchlist
```

---

## Project Layout

```text
lib/
  arbitrage-sniper.js      ← Arbitrage-Orchestrator (NEU)
  arbitrage-calc.js        ← Profit-Rechner (NEU)
  ebay-client.js           ← eBay DE Scraper (NEU)
  kleinanzeigen-client.js  ← Kleinanzeigen Scraper (NEU)
  vinted-sniper.js         ← Vinted Scanner
  facebook-sniper.js
  wallapop-sniper.js
  mercari-sniper.js / mercari-client.js
  shared-marketplace/      ← Geteilte Framework-Module
server.cjs                 ← Express + WebSocket Backend
electron.cjs               ← Electron Shell
ui/                        ← Static Dashboard
data/                      ← Runtime Data
```

---

## Credits

Dies ist ein Fork von **[ethanashi/fbm-sniper-community](https://github.com/ethanashi/fbm-sniper-community)** — einem Open-Source Multi-Plattform Marketplace Sniper.

Fork-Maintainer: [nongrips](https://github.com/nongrips)

## License

MIT — see [LICENSE](LICENSE)
