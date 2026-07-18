// ============================================================
// /api/detect-bids  — AUTOMATISK BUDDETEKTERING
//
// Körs dagligen via cron. Skannar pressflödet efter offentliga
// uppköpserbjudanden, plockar ut målbolag / budgivare / datum / bidco
// och skriver in dem i tabellen bid_registry.
//
// Därmed fyller budregistret sig självt — backtestet behöver inte
// längre att du lägger till rader för hand.
//
// VAD DEN FÅNGAR:  vem, vad, när, bidco (nyckelfälten för backtest)
// VAD DEN INTE FÅNGAR: premie i procent (kräver aktiekurs dagen före
//   budet — den datan har vi inte). Premien är bara kosmetisk för
//   Historik-fliken; backtestet använder den inte.
//
// Manuell körning: /api/detect-bids?key=DIN_CRON_SECRET
// ============================================================

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const UA = "BudRadar/0.2 (+offentlig data)";

const FEEDS = [
  "https://mfn.se/all/s/nordic.json?limit=300",
  "https://mfn.se/all/a/fi-se.json?limit=200",
];

// Ett pressmeddelande om ett bud. Måste vara ganska strikt för att undvika
// brus från "vi utvärderar strategiska alternativ" osv.
const OFFER_RE = /(offentligt uppköpserbjudande|uppköpserbjudande till aktieägarna|rekommenderat (kontant)?bud|offentligt (kontant)?erbjudande|lämnar ett (kontant)?bud|public (cash )?offer to the shareholders|recommended (cash )?offer)/i;
// Filtrera bort saker som INTE är nya bud
const NOISE_RE = /(utfall|fullföljer|slutligt resultat|förlänger acceptperioden|avnotering|tvångsinlösen|completion of the offer|settlement)/i;

const BIDCO_RE = /\b([A-ZÅÄÖ][\wÅÄÖåäö&.\-]*(?:\s+[\wÅÄÖåäö&.\-]+){0,3}\s+(?:BidCo|Bidco|HoldCo|Holdco|MidCo|TopCo))\b/;
const GOLDCUP_RE = /\bGoldcup\s+\d+\s+AB\b/i;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const isCron = req.headers["x-vercel-cron"] != null;
  const key = req.query && req.query.key;
  if (!isCron && process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CONN) return res.status(500).json({ error: "Ingen databas konfigurerad (DATABASE_URL)." });

  try {
    const sql = neon(CONN);
    await ensureSchema(sql);

    const settled = await Promise.allSettled(FEEDS.map(fetchFeed));
    const fetched = {};
    let items = [];
    settled.forEach((r, i) => {
      const k = FEEDS[i].includes("fi-se") ? "fi" : "nordic";
      if (r.status === "fulfilled") { items = items.concat(r.value); fetched[k] = `ok (${r.value.length})`; }
      else fetched[k] = "FEL: " + String(r.reason).slice(0, 100);
    });

    const found = [];
    let inserted = 0;

    for (const it of items) {
      const text = `${it.title} ${it.preamble}`;
      if (!OFFER_RE.test(text)) continue;
      if (NOISE_RE.test(it.title)) continue;

      const target = extractTarget(it);
      if (!target) continue;

      const bidder = extractBidder(it) || null;
      const bidco = (text.match(GOLDCUP_RE) || [])[0] || (text.match(BIDCO_RE) || [])[1] || null;
      const announced = it.date;
      if (!announced) continue;

      const ticker = normTicker(target);
      const rec = { ticker, company: target, announced, bidder, bidco, title: it.title.slice(0, 200), url: it.url };
      found.push(rec);

      const r = await sql`
        INSERT INTO bid_registry (ticker, company, announced, bidder, bidco, source_title, source_url, detected_at)
        VALUES (${ticker}, ${target}, ${announced}, ${bidder}, ${bidco}, ${rec.title}, ${rec.url}, now())
        ON CONFLICT (ticker, announced) DO UPDATE SET
          bidder = COALESCE(EXCLUDED.bidder, bid_registry.bidder),
          bidco  = COALESCE(EXCLUDED.bidco,  bid_registry.bidco)
        RETURNING (xmax = 0) AS is_new`;
      if (r[0] && r[0].is_new) inserted++;
    }

    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM bid_registry`;
    res.status(200).json({ ok: true, fetched, scanned: items.length, matched: found.length, inserted, totalInRegistry: total, found });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS bid_registry (
      ticker       TEXT NOT NULL,
      company      TEXT NOT NULL,
      announced    DATE NOT NULL,
      bidder       TEXT,
      bidco        TEXT,
      premium_pct  NUMERIC,
      outcome      TEXT,
      source_title TEXT,
      source_url   TEXT,
      detected_at  TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (ticker, announced)
    )`;
}

// Målbolaget: pressmeddelanden formulerar sig olika. Vi provar mönster i tur och ordning.
function extractTarget(it) {
  const t = it.title || "";
  const pats = [
    // Viktigast: "...till aktieägarna i X" täcker de flesta svenska budrubriker
    /till aktieägarna i\s+(.+?)(?:\s*[\(\-–—]|$)/i,
    /uppköpserbjudande (?:avseende|på|för)\s+(.+?)(?:\s*[\(\-–—]|$)/i,
    /\bbud (?:på|avseende)\s+(.+?)(?:\s*[\(\-–—]|$)/i,
    /erbjudande (?:avseende|på)\s+(.+?)(?:\s*[\(\-–—]|$)/i,
    /offer to the shareholders of\s+(.+?)(?:\s*[\(\-–—]|$)/i,
    /offer for\s+(.+?)(?:\s*[\(\-–—]|$)/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m && m[1]) {
      const cand = clean(m[1]);
      // Målbolaget är aldrig ett budskal
      if (!/bidco|holdco|midco|topco|goldcup/i.test(cand)) return cand;
    }
  }
  return null; // hellre inget än fel bolag
}
function extractBidder(it) {
  const t = it.title || "";
  const m = t.match(/^(.+?)\s+(?:lämnar|offentliggör|announces|presenterar)\b/i);
  return m ? clean(m[1]) : (it.author ? clean(it.author) : null);
}
function clean(s) {
  return String(s).replace(/\s+/g, " ").replace(/[",.]$/g, "").trim().slice(0, 120);
}
// Samma normalisering som companies.js använder, så tickers matchar signal_history.
function normTicker(name) {
  const key = (name || "").toLowerCase()
    .replace(/\s+(ab|asa|oyj|plc|publ|holding|group|\(publ\))\b/g, "")
    .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  return key.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

async function fetchFeed(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return (j.items || j.news || []).map(it => ({
    title: (it.content && it.content.title) || it.title || "",
    preamble: (it.content && it.content.preamble) || "",
    author: (it.author && it.author.name) || "",
    date: (it.publish_date || it.date || "").slice(0, 10),
    url: it.url || null,
  }));
}
