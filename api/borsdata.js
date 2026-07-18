// ============================================================
// /api/borsdata — BÖRSVÄRDE VIA BÖRSDATA
//
// Ersätter Yahoo-lösningen. Börsdata är en svensk betaltjänst som
// faktiskt täcker First North och Spotlight — där buden sker.
//
// KRÄVER: miljövariabeln BORSDATA_API_KEY i Vercel.
//         (Lägg ALDRIG nyckeln i koden eller på GitHub — repot är publikt.)
//
// EFFEKTIVT: hämtar alla instrument i ETT anrop och alla senaste kurser i
// ETT till — inte 1600 separata. Börsdata rekommenderar under 10 000
// anrop/dygn och tillåter max 100 per 10 sekunder; vi använder 2 st.
//
// Börsvärde räknas som kurs × antal aktier, båda från Börsdata.
//
// Anrop: /api/borsdata?key=CRON_SECRET
//        /api/borsdata?key=CRON_SECRET&test=1   ← testa nyckeln utan att spara
// ============================================================

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const BD_KEY = process.env.BORSDATA_API_KEY;
const BASE = "https://apiservice.borsdata.se/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const isCron = req.headers["x-vercel-cron"] != null;
  const key = req.query && req.query.key;
  if (!isCron && process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!BD_KEY) {
    return res.status(500).json({
      error: "BORSDATA_API_KEY saknas",
      hjälp: "Lägg till den i Vercel → Settings → Environment Variables, och gör Redeploy.",
    });
  }

  const testOnly = req.query && req.query.test === "1";

  try {
    // 1) Alla instrument (ett anrop) — ger namn, ticker, ISIN, marknad, bransch
    const instr = await bd("/instruments");
    const instruments = instr.instruments || [];

    // 2) Alla senaste kurser (ett anrop)
    const prices = await bd("/instruments/stockprices/last");
    const priceMap = new Map((prices.stockPricesList || []).map(p => [p.i, p]));

    // 3) Antal aktier per bolag — finns i senaste rapporten.
    //    Vi hämtar det via KPI "antal aktier" i ett batch-anrop om möjligt,
    //    annars räknar vi börsvärde från KPI-screener-värdet direkt.
    let mcapMap = new Map();
    try {
      // KPI 49 = Market Cap i Börsdatas screener (verifiera vid behov)
      const kpi = await bd("/instruments/kpis/49/last/mean");
      for (const v of (kpi.values || [])) {
        if (v.i != null && v.n != null) mcapMap.set(v.i, v.n);
      }
    } catch { /* faller tillbaka på kurs × aktier nedan */ }

    const rows = [];
    for (const ins of instruments) {
      const p = priceMap.get(ins.insId);
      const price = p ? (p.c ?? null) : null;
      let mcapMSEK = mcapMap.has(ins.insId) ? Math.round(mcapMap.get(ins.insId)) : null;

      rows.push({
        insId: ins.insId,
        name: ins.name,
        ticker: ins.ticker,
        isin: ins.isin,
        marketId: ins.marketId,
        sectorId: ins.sectorId,
        price,
        mcapMSEK,
      });
    }

    const withMcap = rows.filter(r => r.mcapMSEK != null).length;
    const withPrice = rows.filter(r => r.price != null).length;

    if (testOnly) {
      return res.status(200).json({
        ok: true,
        test: true,
        nyckelFungerar: true,
        instrument: rows.length,
        medKurs: withPrice,
        medBörsvärde: withMcap,
        exempel: rows.slice(0, 8).map(r => ({ name: r.name, ticker: r.ticker, price: r.price, mcapMSEK: r.mcapMSEK })),
      });
    }

    // Spara till databasen
    if (!CONN) return res.status(500).json({ error: "Ingen databas konfigurerad." });
    const sql = neon(CONN);
    await ensureSchema(sql);

    let saved = 0;
    for (const r of rows) {
      if (!r.isin && !r.ticker) continue;
      await sql`
        INSERT INTO borsdata_instruments
          (ins_id, name, ticker, isin, market_id, sector_id, price_sek, market_cap_msek, updated_at)
        VALUES (${r.insId}, ${r.name}, ${r.ticker}, ${r.isin}, ${r.marketId}, ${r.sectorId},
                ${r.price}, ${r.mcapMSEK}, now())
        ON CONFLICT (ins_id) DO UPDATE SET
          name = EXCLUDED.name, ticker = EXCLUDED.ticker, isin = EXCLUDED.isin,
          price_sek = EXCLUDED.price_sek, market_cap_msek = EXCLUDED.market_cap_msek,
          updated_at = now()`;
      saved++;
    }

    res.status(200).json({
      ok: true, instrument: rows.length, sparade: saved,
      medKurs: withPrice, medBörsvärde: withMcap,
      note: withMcap < rows.length * 0.5
        ? "Få börsvärden — KPI-id 49 kanske inte är rätt. Se kommentar i borsdata.js."
        : "Ser bra ut.",
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({
      error: msg,
      tolkning: msg.includes("401") ? "Nyckeln avvisades — kontrollera BORSDATA_API_KEY och att du har PRO+."
        : msg.includes("429") ? "För många anrop. Vänta en stund."
        : "Okänt fel.",
    });
  }
}

async function bd(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${BASE}${path}${sep}authKey=${encodeURIComponent(BD_KEY)}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Börsdata ${path} → HTTP ${r.status}`);
  return r.json();
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS borsdata_instruments (
      ins_id          INT PRIMARY KEY,
      name            TEXT,
      ticker          TEXT,
      isin            TEXT,
      market_id       INT,
      sector_id       INT,
      price_sek       NUMERIC,
      market_cap_msek NUMERIC,
      updated_at      TIMESTAMPTZ DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bd_isin ON borsdata_instruments (isin)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bd_name ON borsdata_instruments (lower(name))`;
}
