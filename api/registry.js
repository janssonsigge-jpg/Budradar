// ============================================================
// /api/registry  — NORDISKT BUDREGISTER, publikt API
//
// Detta är produkten. En maskinläsbar databas över nordiska offentliga
// uppköpserbjudanden — med bidco-kedja, ägarstruktur före budet, tidslinje
// och utfall. Ingen annan har detta strukturerat.
//
// ANVÄNDNING
//   /api/registry                          alla poster
//   /api/registry?sector=Tech              filtrera på bransch
//   /api/registry?bidderType=PE            filtrera på budgivartyp
//   /api/registry?from=2026-01-01          från datum
//   /api/registry?minPremium=40            minsta premie
//   /api/registry?hasBidco=1               bara affärer med känd bidco
//   /api/registry?stats=1                  aggregerad statistik istället för poster
//   /api/registry?format=csv               CSV för Excel
//
// De aggregerade svaren är det som gör registret värt att betala för:
// "vilken premie har PE-fonder betalat i svensk tech senaste två åren"
// är en fråga corporate finance-team ställer varje vecka.
// ============================================================

import { REGISTRY } from "./_registry-data.js";
import { derive, completeness } from "./_registry-schema.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const q = req.query || {};
    let rows = REGISTRY.map(derive);

    // ---- filter ----
    if (q.sector) rows = rows.filter(r => (r.sector || "").toLowerCase().includes(String(q.sector).toLowerCase()));
    if (q.bidderType) rows = rows.filter(r => (r.bidderType || "").toLowerCase() === String(q.bidderType).toLowerCase());
    if (q.bidderCountry) rows = rows.filter(r => (r.bidderCountry || "").toLowerCase() === String(q.bidderCountry).toLowerCase());
    if (q.market) rows = rows.filter(r => (r.market || "").toLowerCase().includes(String(q.market).toLowerCase()));
    if (q.outcome) rows = rows.filter(r => (r.outcome || "").toLowerCase() === String(q.outcome).toLowerCase());
    if (q.from) rows = rows.filter(r => r.announced >= q.from);
    if (q.to) rows = rows.filter(r => r.announced <= q.to);
    if (q.minPremium) rows = rows.filter(r => (r.premiumLastClose ?? -999) >= Number(q.minPremium));
    if (q.maxPremium) rows = rows.filter(r => (r.premiumLastClose ?? 999) <= Number(q.maxPremium));
    if (q.hasBidco === "1") rows = rows.filter(r => r.bidcoChain && r.bidcoChain.length > 1);
    if (q.ticker) rows = rows.filter(r => (r.targetTicker || "").toLowerCase() === String(q.ticker).toLowerCase());

    rows.sort((a, b) => String(b.announced).localeCompare(String(a.announced)));

    // ---- statistik ----
    if (q.stats === "1") return res.status(200).json(buildStats(rows));

    // ---- CSV ----
    if (q.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.status(200).send(toCsv(rows));
    }

    res.status(200).json({
      count: rows.length,
      coverage: {
        total: REGISTRY.length,
        avgCompleteness: Math.round(REGISTRY.map(derive).reduce((s, r) => s + r.completeness, 0) / REGISTRY.length),
        earliest: REGISTRY.map(r => r.announced).sort()[0],
        latest: REGISTRY.map(r => r.announced).sort().slice(-1)[0],
      },
      results: rows,
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

function buildStats(rows) {
  const prem = rows.map(r => r.premiumLastClose).filter(v => v != null);
  const sorted = [...prem].sort((a, b) => a - b);
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;

  const byType = {}, bySector = {}, byOutcome = {}, byYear = {};
  for (const r of rows) {
    push(byType, r.bidderType, r.premiumLastClose);
    push(bySector, r.sector, r.premiumLastClose);
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    const y = String(r.announced || "").slice(0, 4);
    if (y) byYear[y] = (byYear[y] || 0) + 1;
  }

  const withBidco = rows.filter(r => r.bidcoChain && r.bidcoChain.length > 1);
  const committed = rows.map(r => r.committedVotes).filter(v => v != null && v > 0);

  return {
    n: rows.length,
    premie: {
      snitt: prem.length ? round(prem.reduce((a, b) => a + b, 0) / prem.length) : null,
      median: median != null ? round(median) : null,
      lägsta: prem.length ? Math.min(...prem) : null,
      högsta: prem.length ? Math.max(...prem) : null,
      antalMedPremie: prem.length,
    },
    perBudgivartyp: summarize(byType),
    perBransch: summarize(bySector),
    perUtfall: byOutcome,
    perÅr: byYear,
    bidco: {
      andelMedKändBidco: rows.length ? Math.round((withBidco.length / rows.length) * 100) : 0,
      exempel: withBidco.slice(0, 6).map(r => ({ target: r.target, bidco: r.bidcoChain.slice(-1)[0] })),
    },
    ägarbindning: {
      antalMedData: committed.length,
      snittBundenRöstandel: committed.length ? round(committed.reduce((a, b) => a + b, 0) / committed.length) : null,
      kommentar: "Hög bunden röstandel före budet = affären i praktiken avgjord vid offentliggörandet.",
    },
  };
}

function push(obj, key, val) {
  if (!key) return;
  if (!obj[key]) obj[key] = [];
  if (val != null) obj[key].push(val);
}
function summarize(obj) {
  const out = {};
  for (const [k, arr] of Object.entries(obj)) {
    out[k] = { antal: arr.length, snittPremie: arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length) : null };
  }
  return out;
}
const round = n => Math.round(n * 10) / 10;

function toCsv(rows) {
  const cols = [
    "id", "target", "targetTicker", "market", "sector", "announced",
    "bidder", "bidderType", "bidderCountry", "bidco",
    "pricePerShare", "currency", "equityValueMSEK",
    "premiumLastClose", "premium90d", "evEbit", "evSales", "consideration",
    "committedPct", "committedVotes", "irrevocable",
    "acceptanceThreshold", "outcome", "raisedTo", "completeness",
  ];
  const esc = v => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[;"\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [cols.join(";")];
  for (const r of rows) {
    const flat = { ...r, bidco: r.bidcoChain ? r.bidcoChain.slice(-1)[0] : null };
    lines.push(cols.map(c => esc(flat[c])).join(";"));
  }
  return "\uFEFF" + lines.join("\n"); // BOM så Excel läser svenska tecken rätt
}
