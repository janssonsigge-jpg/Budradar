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

    // Vilka bolag behöver uppdateras? Hämta namn+isin från senaste snapshot.
    const companies = await sql`
      SELECT DISTINCT ON (s.ticker) s.ticker, s.name
      FROM signal_history s
      WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM signal_history)
      ORDER BY s.ticker`;

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
        const y = await lookupYahoo(c.name);
        if (!y) { failed++; results.push({ ticker: c.ticker, name: c.name, status: "hittades ej" }); continue; }
        await sql`
          INSERT INTO fundamentals (ticker, name, yahoo_symbol, market_cap_msek, price_sek, currency, updated_at)
          VALUES (${c.ticker}, ${c.name}, ${y.symbol}, ${y.mcapMSEK}, ${y.price}, ${y.currency}, now())
          ON CONFLICT (ticker) DO UPDATE SET
            yahoo_symbol = EXCLUDED.yahoo_symbol,
            market_cap_msek = EXCLUDED.market_cap_msek,
            price_sek = EXCLUDED.price_sek,
            currency = EXCLUDED.currency,
            updated_at = now()`;
        updated++;
        results.push({ ticker: c.ticker, name: c.name, symbol: y.symbol, mcapMSEK: y.mcapMSEK, price: y.price });
      } catch (e) {
        failed++;
        results.push({ ticker: c.ticker, name: c.name, status: "FEL: " + String(e.message).slice(0, 60) });
      }
      await sleep(250); // snäll paus
    }

    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM fundamentals`;
    const remaining = companies.length - (await sql`SELECT COUNT(*)::int AS c FROM fundamentals WHERE updated_at > ${new Date(cutoff).toISOString()}`)[0].c;

    res.status(200).json({
      ok: true, candidates: companies.length, processed: todo.length,
      updated, failed, totalStored: total, remainingStale: Math.max(0, remaining),
      note: remaining > 0 ? "Kör igen för att beta av resten (max 60 per körning)." : "Alla uppdaterade.",
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
}

/** Slå upp bolaget på Yahoo och hämta börsvärde + kurs. */
async function lookupYahoo(name) {
  // 1) Sök fram rätt symbol (svenska bolag har .ST)
  const q = encodeURIComponent(cleanName(name));
  const sres = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=8&newsCount=0`,
    { headers: { "user-agent": UA, accept: "application/json" } }
  );
  if (!sres.ok) throw new Error("search HTTP " + sres.status);
  const sjson = await sres.json();
  const quotes = (sjson.quotes || []).filter(x => x.symbol);

  // Föredra svensk notering
  const pick =
    quotes.find(x => String(x.symbol).endsWith(".ST")) ||
    quotes.find(x => x.exchange === "STO") ||
    null;
  if (!pick) return null;

  // 2) Hämta kursdata + börsvärde
  const cres = await fetch(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pick.symbol)}?range=1d&interval=1d`,
    { headers: { "user-agent": UA, accept: "application/json" } }
  );
  if (!cres.ok) throw new Error("chart HTTP " + cres.status);
  const cjson = await cres.json();
  const meta = cjson?.chart?.result?.[0]?.meta || {};
  const price = meta.regularMarketPrice ?? null;

  // marketCap finns inte alltid i chart-meta → använd quoteSummary som backup
  let mcap = null;
  try {
    const qres = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(pick.symbol)}?modules=price`,
      { headers: { "user-agent": UA, accept: "application/json" } }
    );
    if (qres.ok) {
      const qjson = await qres.json();
      mcap = qjson?.quoteSummary?.result?.[0]?.price?.marketCap?.raw ?? null;
    }
  } catch { /* ignorera, kursen räcker */ }

  return {
    symbol: pick.symbol,
    price,
    currency: meta.currency || "SEK",
    mcapMSEK: mcap != null ? Math.round(mcap / 1e6) : null,
  };
}

function cleanName(n) {
  return String(n || "")
    .replace(/\s*\(publ\)\s*/gi, " ")
    .replace(/\bser(ie)?\.?\s*[AB]\b/gi, " ")
    .replace(/\s+/g, " ").trim();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
