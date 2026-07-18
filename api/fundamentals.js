// ============================================================
// /api/fundamentals — BÖRSVÄRDE & KURS
//
// Detta är förutsättningen för uppköpbarhetsfiltret. Utan börsvärde
// kan vi inte skilja "Intrum, 20 mdkr, blir aldrig uppköpt" från
// "litet bolag där insiders köper".
//
// Källa: Yahoo Finance (gratis, ingen nyckel). Svenska bolag har
// suffix .ST — t.ex. INTRUM.ST. Vi slår upp ticker via ISIN-sökning
// och cachar resultatet i databasen så vi inte spammar Yahoo.
//
// Cachen håller 7 dagar (börsvärde ändras långsamt nog).
//
// Anrop: /api/fundamentals?key=NYCKEL          → uppdaterar saknade/gamla
//        /api/fundamentals?key=NYCKEL&all=1    → tvingar uppdatering av alla
// ============================================================

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const UA = "Mozilla/5.0 (compatible; BudRadar/0.3)";
const STALE_DAYS = 7;
const MAX_PER_RUN = 60; // var snäll mot Yahoo; resten tas nästa körning

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const isCron = req.headers["x-vercel-cron"] != null;
  const key = req.query && req.query.key;
  if (!isCron && process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CONN) return res.status(500).json({ error: "Ingen databas konfigurerad." });

  try {
    const sql = neon(CONN);
    await ensureSchema(sql);
    const forceAll = req.query && (req.query.all === "1");

    // Hämta bolagen (med ISIN) från vårt eget API — ISIN är en exakt nyckel
    // och ger mycket bättre träffsäkerhet än namnsökning.
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    let companies = [];
    try {
      const r = await fetch(`${proto}://${host}/api/companies`);
      if (r.ok) {
        const j = await r.json();
        companies = (j.companies || []).map(c => ({ ticker: c.ticker, name: c.name, isin: c.isin || null }));
      }
    } catch { /* faller tillbaka nedan */ }

    // Fallback: senaste snapshot om API:t inte svarade
    if (!companies.length) {
      companies = await sql`
        SELECT DISTINCT ON (s.ticker) s.ticker, s.name, NULL::text AS isin
        FROM signal_history s
        WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM signal_history)
        ORDER BY s.ticker`;
    }

    const existing = await sql`SELECT ticker, updated_at FROM fundamentals`;
    const seen = new Map(existing.map(r => [r.ticker, r.updated_at]));
    const cutoff = Date.now() - STALE_DAYS * 864e5;

    const todo = companies.filter(c => {
      if (forceAll) return true;
      const u = seen.get(c.ticker);
      return !u || new Date(u).getTime() < cutoff;
    }).slice(0, MAX_PER_RUN);

    let updated = 0, failed = 0;
    const results = [];

    for (const c of todo) {
      try {
        const y = await lookupYahoo(c.name, c.isin);
        if (!y) {
          // Skriv ändå en rad — annars provas bolaget om vid varje körning
          // och remainingStale når aldrig noll.
          await sql`
            INSERT INTO fundamentals (ticker, name, yahoo_symbol, market_cap_msek, price_sek, currency, lookup_status, updated_at)
            VALUES (${c.ticker}, ${c.name}, NULL, NULL, NULL, NULL, 'not_found', now())
            ON CONFLICT (ticker) DO UPDATE SET lookup_status = 'not_found', updated_at = now()`;
          failed++;
          results.push({ ticker: c.ticker, name: c.name, status: "hittades ej" });
          continue;
        }
        await sql`
          INSERT INTO fundamentals (ticker, name, yahoo_symbol, market_cap_msek, price_sek, currency, lookup_status, updated_at)
          VALUES (${c.ticker}, ${c.name}, ${y.symbol}, ${y.mcapMSEK}, ${y.price}, ${y.currency}, 'ok', now())
          ON CONFLICT (ticker) DO UPDATE SET
            yahoo_symbol = EXCLUDED.yahoo_symbol,
            market_cap_msek = EXCLUDED.market_cap_msek,
            price_sek = EXCLUDED.price_sek,
            currency = EXCLUDED.currency,
            lookup_status = 'ok',
            updated_at = now()`;
        updated++;
        results.push({ ticker: c.ticker, name: c.name, symbol: y.symbol, mcapMSEK: y.mcapMSEK, price: y.price });
      } catch (e) {
        // Även fel loggas som rad, så vi inte fastnar i en loop
        try {
          await sql`
            INSERT INTO fundamentals (ticker, name, lookup_status, updated_at)
            VALUES (${c.ticker}, ${c.name}, 'error', now())
            ON CONFLICT (ticker) DO UPDATE SET lookup_status = 'error', updated_at = now()`;
        } catch { /* strunta */ }
        failed++;
        results.push({ ticker: c.ticker, name: c.name, status: "FEL: " + String(e.message).slice(0, 60) });
      }
      await sleep(250); // snäll paus
    }

    // Räkna korrekt: hur många av dagens bolag saknar en färsk rad?
    const fresh = await sql`
      SELECT ticker FROM fundamentals WHERE updated_at > ${new Date(cutoff).toISOString()}`;
    const freshSet = new Set(fresh.map(r => r.ticker));
    const remaining = companies.filter(c => !freshSet.has(c.ticker)).length;

    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM fundamentals`;
    const [{ withMcap }] = await sql`SELECT COUNT(*)::int AS "withMcap" FROM fundamentals WHERE market_cap_msek IS NOT NULL`;
    const [{ notFound }] = await sql`SELECT COUNT(*)::int AS "notFound" FROM fundamentals WHERE lookup_status <> 'ok'`;

    res.status(200).json({
      ok: true,
      candidates: companies.length,
      processed: todo.length,
      updated, failed,
      totalStored: total,
      medBörsvärde: withMcap,
      utanBörsvärde: notFound,
      remainingStale: remaining,
      note: remaining > 0
        ? `Kör igen — ${remaining} bolag kvar (max ${MAX_PER_RUN} per körning).`
        : `Klart. ${withMcap} av ${companies.length} bolag har börsvärde; ${notFound} hittades inte hos Yahoo.`,
      results: results.slice(0, 40),
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS fundamentals (
      ticker           TEXT PRIMARY KEY,
      name             TEXT,
      yahoo_symbol     TEXT,
      market_cap_msek  NUMERIC,
      price_sek        NUMERIC,
      currency         TEXT,
      updated_at       TIMESTAMPTZ DEFAULT now()
    )`;
  // Lägg till statuskolumnen om tabellen redan fanns
  await sql`ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS lookup_status TEXT DEFAULT 'ok'`;
}

/** Slå upp bolaget på Yahoo. Provar ISIN först (exakt), sen namn. */
async function lookupYahoo(name, isin) {
  let pick = null;

  // 1) ISIN är en exakt nyckel — Yahoo söker på den.
  if (isin) pick = await searchYahoo(isin);

  // 2) Fallback: namn, i några varianter (utan "AB", utan serie-suffix osv.)
  if (!pick) {
    for (const variant of nameVariants(name)) {
      pick = await searchYahoo(variant);
      if (pick) break;
      await sleep(150);
    }
  }
  if (!pick) return null;

  // Hämta kurs
  const cres = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pick.symbol)}?range=1d&interval=1d`,
    { headers: { "user-agent": UA, accept: "application/json" } }
  );
  if (!cres.ok) throw new Error("chart HTTP " + cres.status);
  const cjson = await cres.json();
  const meta = cjson?.chart?.result?.[0]?.meta || {};
  const price = meta.regularMarketPrice ?? null;

  // Börsvärde. Yahoo:s quoteSummary kräver numera cookie och ger ofta null,
  // så vi provar flera vägar och räknar ut det själva som sista utväg.
  let mcap = null;

  // 1) quoteSummary (fungerar ibland)
  try {
    const qres = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(pick.symbol)}?modules=price,defaultKeyStatistics`,
      { headers: { "user-agent": UA, accept: "application/json" } }
    );
    if (qres.ok) {
      const qjson = await qres.json();
      const r0 = qjson?.quoteSummary?.result?.[0] || {};
      mcap = r0?.price?.marketCap?.raw ?? null;
      // Räkna ut om marketCap saknas men aktieantal finns
      if (mcap == null && price != null) {
        const shares =
          r0?.defaultKeyStatistics?.sharesOutstanding?.raw ??
          r0?.price?.sharesOutstanding?.raw ?? null;
        if (shares) mcap = shares * price;
      }
    }
  } catch { /* prova nästa */ }

  // 2) v7/quote — lättare endpoint som ofta har marketCap
  if (mcap == null) {
    try {
      const vres = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(pick.symbol)}`,
        { headers: { "user-agent": UA, accept: "application/json" } }
      );
      if (vres.ok) {
        const vjson = await vres.json();
        const q0 = vjson?.quoteResponse?.result?.[0] || {};
        mcap = q0.marketCap ?? null;
        if (mcap == null && price != null && q0.sharesOutstanding) {
          mcap = q0.sharesOutstanding * price;
        }
      }
    } catch { /* ge upp */ }
  }

  return {
    symbol: pick.symbol,
    price,
    currency: meta.currency || "SEK",
    mcapMSEK: mcap != null ? Math.round(mcap / 1e6) : null,
  };
}

/** Sök på Yahoo och returnera bästa svenska träffen. */
async function searchYahoo(q) {
  const res = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`,
    { headers: { "user-agent": UA, accept: "application/json" } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const quotes = (json.quotes || []).filter(x => x.symbol);
  return (
    quotes.find(x => String(x.symbol).endsWith(".ST")) ||
    quotes.find(x => x.exchange === "STO") ||
    null
  );
}

/** Namnvarianter att prova, från mest till minst specifik. */
function nameVariants(name) {
  const base = String(name || "")
    .replace(/\s*\(publ\)\s*/gi, " ")
    .replace(/\s+/g, " ").trim();
  const noSeries = base.replace(/\s+(ser(ie)?\.?\s*)?[AB]$/i, "").trim();
  const noAB = noSeries.replace(/\s+AB$/i, "").trim();
  return [...new Set([base, noSeries, noAB].filter(v => v && v.length > 1))];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
