// ============================================================
// /api/snapshot  — DAGLIG LAGRING (kärnan i din datatillgång)
//
// Kör en gång per dygn via Vercel Cron (se vercel.json). Hämtar dagens
// signalläge från /api/companies-logiken och sparar en rad per bolag.
// Efter ett tag kan du se FÖRÄNDRING över tid — det är det som gör
// datan värdefull och omöjlig att replikera i efterhand.
//
// Kräver en Postgres-databas. I Vercel: Storage → Create → Postgres.
// Sätt miljövariabeln DATABASE_URL (Vercel gör det oftast automatiskt
// som POSTGRES_URL — koden accepterar båda).
//
// Manuell körning: /api/snapshot?key=DIN_CRON_SECRET
// ============================================================

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Enkel skydd: Vercel Cron skickar en särskild header; manuellt kräver nyckel.
  const isCron = req.headers["x-vercel-cron"] != null;
  const key = req.query && req.query.key;
  if (!isCron && process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CONN) {
    return res.status(500).json({ error: "Ingen databas konfigurerad. Sätt DATABASE_URL i Vercel." });
  }

  try {
    const sql = neon(CONN);
    await ensureSchema(sql);

    // Hämta dagens läge från vårt eget API (samma host).
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const r = await fetch(`${proto}://${host}/api/companies?fresh=1`);
    if (!r.ok) throw new Error("companies HTTP " + r.status);
    const j = await r.json();
    const companies = j.companies || [];
    if (!companies.length) throw new Error("inga bolag returnerades");

    const day = new Date().toISOString().slice(0, 10);
    let saved = 0;

    for (const c of companies) {
      const p = c.score.parts;
      await sql`
        INSERT INTO signal_history
          (snapshot_date, ticker, name, composite, part_insider, part_flags, part_short, part_bv, tier)
        VALUES
          (${day}, ${c.ticker}, ${c.name}, ${c.score.composite},
           ${p.insider}, ${p.flags}, ${p.shortSig}, ${p.bv}, ${c.score.tier})
        ON CONFLICT (snapshot_date, ticker) DO UPDATE SET
          composite = EXCLUDED.composite,
          part_insider = EXCLUDED.part_insider,
          part_flags = EXCLUDED.part_flags,
          part_short = EXCLUDED.part_short,
          part_bv = EXCLUDED.part_bv,
          tier = EXCLUDED.tier,
          name = EXCLUDED.name
      `;
      saved++;
    }

    // Spara även råa flaggningar (de är historiskt värdefulla i sig)
    let flagsSaved = 0;
    for (const c of companies) {
      for (const f of (c.detail && c.detail.flags) || []) {
        if (!f.flag_date) continue;
        await sql`
          INSERT INTO flag_history (flag_date, ticker, company, holder, threshold, share_pct, reason)
          VALUES (${f.flag_date}, ${c.ticker}, ${c.name}, ${f.holder || null},
                  ${f.threshold || null}, ${f.sharePct != null ? f.sharePct : null}, ${f.reason || null})
          ON CONFLICT DO NOTHING
        `;
        flagsSaved++;
      }
    }

    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM signal_history`;
    const [{ days }] = await sql`SELECT COUNT(DISTINCT snapshot_date)::int AS days FROM signal_history`;

    res.status(200).json({ ok: true, day, saved, flagsSaved, totalRows: count, daysCollected: days });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS signal_history (
      snapshot_date DATE NOT NULL,
      ticker        TEXT NOT NULL,
      name          TEXT,
      composite     INT,
      part_insider  INT,
      part_flags    INT,
      part_short    INT,
      part_bv       INT,
      tier          TEXT,
      PRIMARY KEY (snapshot_date, ticker)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS flag_history (
      flag_date  DATE NOT NULL,
      ticker     TEXT NOT NULL,
      company    TEXT,
      holder     TEXT,
      threshold  TEXT,
      share_pct  NUMERIC,
      reason     TEXT,
      UNIQUE (flag_date, ticker, holder, threshold)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sig_ticker ON signal_history (ticker, snapshot_date)`;
}
