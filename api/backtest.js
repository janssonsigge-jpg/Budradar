// ============================================================
// /api/backtest  — MÄTER OM SIGNALERNA FAKTISKT FUNKAR
//
// Frågan vi vill besvara: "Låg bolaget högt i BudRadar INNAN budet kom?"
//
// Metod:
//   För varje bud i budregistret, gå till signal_history och hämta bolagets
//   läge N dagar före offentliggörandet (default 30). Räkna ut:
//     • percentil — hur högt bolaget låg jämfört med alla andra den dagen
//     • hit       — låg det i topp X% (default 10%)?
//   Aggregera: träffprocent, snittpercentil, och en jämförelse mot slumpen.
//
// VIKTIGT — lookahead bias:
//   Vi använder ENDAST data som fanns tillgänglig före budets datum.
//   Därför krävs att /api/snapshot har kört ett tag. Bud som inträffade
//   innan din datainsamling startade kan inte testas — de rapporteras
//   som "ingen data" istället för att tyst uteslutas.
//
// Anrop: /api/backtest?days=30&top=10
// ============================================================

import { neon } from "@neondatabase/serverless";
import { BUD } from "./_bud.js";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!CONN) return res.status(500).json({ error: "Ingen databas konfigurerad (DATABASE_URL)." });

  const daysBefore = Math.max(1, Math.min(365, Number((req.query && req.query.days) || 30)));
  const topPct = Math.max(1, Math.min(50, Number((req.query && req.query.top) || 10)));

  try {
    const sql = neon(CONN);

    // Budregistret = automatiskt detekterade bud (bid_registry) + manuellt seed (_bud.js).
    // Automatiskt detekterade vinner vid dubbletter.
    let auto = [];
    try {
      auto = await sql`
        SELECT ticker, company, announced::text AS announced, bidder, bidco, premium_pct AS "premiumPct"
        FROM bid_registry ORDER BY announced DESC`;
    } catch { auto = []; } // tabellen finns kanske inte än

    const seen = new Set(auto.map(b => `${b.ticker}|${b.announced}`));
    const ALLA = auto.concat(BUD.filter(b => !seen.has(`${b.ticker}|${b.announced}`)));

    // Hur mycket historik har vi?
    const cov = await sql`
      SELECT MIN(snapshot_date)::text AS first_day,
             MAX(snapshot_date)::text AS last_day,
             COUNT(DISTINCT snapshot_date)::int AS days
      FROM signal_history`;
    const coverage = cov[0] || { first_day: null, last_day: null, days: 0 };

    const results = [];
    for (const bud of ALLA) {
      const target = addDays(bud.announced, -daysBefore);

      // Närmaste snapshot PÅ ELLER FÖRE måldatumet (aldrig efter → ingen lookahead)
      const snap = await sql`
        SELECT snapshot_date::text AS d, composite
        FROM signal_history
        WHERE ticker = ${bud.ticker} AND snapshot_date <= ${target}
        ORDER BY snapshot_date DESC LIMIT 1`;

      if (!snap.length) {
        results.push({ ...slim(bud), tested: false, reason: "ingen signaldata före budet" });
        continue;
      }
      const day = snap[0].d;
      const composite = snap[0].composite;

      // Percentil den dagen: hur många bolag hade lägre score?
      const pct = await sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE composite < ${composite})::int AS below
        FROM signal_history WHERE snapshot_date = ${day}`;
      const total = pct[0].total || 1;
      const percentile = Math.round((pct[0].below / total) * 100);
      const hit = percentile >= (100 - topPct);

      results.push({
        ...slim(bud), tested: true, snapshotDay: day, composite,
        percentile, universe: total, hit,
      });
    }

    const tested = results.filter(r => r.tested);
    const hits = tested.filter(r => r.hit);
    const summary = {
      budTotal: ALLA.length,
      autoDetected: auto.length,
      testable: tested.length,
      notTestable: ALLA.length - tested.length,
      hitRate: tested.length ? Math.round((hits.length / tested.length) * 100) : null,
      avgPercentile: tested.length ? Math.round(tested.reduce((s, r) => s + r.percentile, 0) / tested.length) : null,
      randomBaseline: topPct, // vad slumpen skulle ge
      // Lyft > 1 betyder att signalerna slår slumpen
      lift: tested.length && topPct ? Number(((hits.length / tested.length) * 100 / topPct).toFixed(2)) : null,
      params: { daysBefore, topPct },
      coverage,
    };

    res.status(200).json({
      summary,
      tolkning: tolka(summary),
      results: results.sort((a, b) => (b.percentile || 0) - (a.percentile || 0)),
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

function slim(b) {
  return { ticker: b.ticker, company: b.company, announced: b.announced, bidco: b.bidco, premiumPct: b.premiumPct };
}
function addDays(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function tolka(s) {
  if (!s.testable) {
    return "Ingen historik täcker något bud ännu. Låt /api/snapshot köra dagligen — " +
           "backtestet blir meningsfullt när bud inträffar EFTER att insamlingen startat.";
  }
  if (s.testable < 10) {
    return `Endast ${s.testable} bud kunde testas. För få för statistiska slutsatser — ` +
           "betrakta siffrorna som indikativa tills du har 20–30 testbara bud.";
  }
  if (s.lift >= 2) return `Signalerna slår slumpen ${s.lift}x. Det är ett verkligt resultat värt att bygga vidare på.`;
  if (s.lift >= 1.2) return `Svag men positiv effekt (${s.lift}x slumpen). Testa fler tidsfönster och vikter.`;
  return "Ingen tydlig effekt över slumpen. Vikterna i scoringen behöver troligen omkalibreras.";
}
