// fetch_fundamentals.mjs
// Läser alla bolag ur "companies"-tabellen (ISIN, ticker, namn - redan ifylld
// via fetch_companies.mjs) och hämtar kurs + börsvärde från Yahoo Finance.
// Skriver resultatet till "borsdata_instruments", som api/companies.js redan
// är kodad för att läsa (matchning på ISIN) för att filtrera bort stora bolag.
//
// ENV som krävs:
//   POSTGRES_URL   (samma som förut)
//
// npm i @vercel/postgres   (redan installerat om du kört fetch_companies.mjs)

import { sql } from "@vercel/postgres";

const BATCH_SIZE = 40; // Yahoo klarar en hel del symboler per anrop, men håll det säkert

function toYahooSymbol(ticker) {
  if (!ticker) return null;
  // Bloomberg-format "ERIC B" -> Yahoo-format "ERIC-B.ST"
  return ticker.trim().replace(/\s+/g, "-").toUpperCase() + ".ST";
}

async function fetchQuotes(symbols) {
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
    encodeURIComponent(symbols.join(","));

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Yahoo HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  return json?.quoteResponse?.result || [];
}

async function main() {
  console.log("Hämtar bolag ur companies-tabellen...");
  const { rows } = await sql`
    select isin, ticker, name from companies
    where isin is not null and ticker is not null
  `;
  console.log(`  -> ${rows.length} bolag med isin+ticker`);

  // Bygg map yahoo-symbol -> vår rad, så vi kan matcha tillbaka svaret
  const symbolMap = new Map();
  for (const row of rows) {
    const symbol = toYahooSymbol(row.ticker);
    if (symbol) symbolMap.set(symbol, row);
  }
  const allSymbols = [...symbolMap.keys()];

  let updated = 0;
  let failed = [];

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE);
    try {
      const quotes = await fetchQuotes(batch);
      const foundSymbols = new Set();

      for (const q of quotes) {
        foundSymbols.add(q.symbol);
        const row = symbolMap.get(q.symbol);
        if (!row) continue;

        const priceSek = q.regularMarketPrice ?? null;
        const marketCapMsek = q.marketCap != null ? q.marketCap / 1e6 : null;

        await sql`
          insert into borsdata_instruments (isin, name, ticker, price_sek, market_cap_msek)
          values (${row.isin}, ${row.name}, ${row.ticker}, ${priceSek}, ${marketCapMsek})
          on conflict (isin) do update set
            name = excluded.name,
            ticker = excluded.ticker,
            price_sek = excluded.price_sek,
            market_cap_msek = excluded.market_cap_msek,
            updated_at = now();
        `;
        updated++;
      }

      for (const s of batch) {
        if (!foundSymbols.has(s)) failed.push(s);
      }
    } catch (err) {
      console.error(`Batch ${i / BATCH_SIZE + 1} misslyckades: ${err.message}`);
      failed.push(...batch);
    }

    console.log(`  ${Math.min(i + BATCH_SIZE, allSymbols.length)}/${allSymbols.length} bearbetat`);
    await new Promise((r) => setTimeout(r, 300)); // var snäll mot Yahoo
  }

  console.log(`Klart. ${updated} bolag uppdaterade, ${failed.length} utan träff.`);
  if (failed.length) {
    console.log("Exempel på symboler utan träff (första 10):", failed.slice(0, 10));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// -----------------------------------------------------------------------
// Viktigt att veta:
//
// 1. Yahoos quote-API är INTE en officiell/dokumenterad publik API - den kan
//    sluta fungera eller kräva en "crumb"/cookie-autentisering utan
//    förvarning. Om scriptet får många 401/403-fel: säg till, då bygger vi
//    om mot en stabilare källa (t.ex. Stooq, som redan finns i din
//    ursprungliga källista och har enklare CSV-svar för kurs, dock utan
//    börsvärde/antal aktier direkt).
//
// 2. Tickerkonverteringen (mellanslag -> bindestreck + ".ST") missar en del
//    specialfall (t.ex. bolag med siffror i tickern, units, etc). De hamnar
//    i "failed"-listan i loggen - normalt, ingen krasch.
//
// 3. Jag har inte kunnat testköra mot liva Yahoo-API:et i den här sandboxen
//    (inget nätverk) - kör en testkörning och klistra in output/fel här.
// -----------------------------------------------------------------------
