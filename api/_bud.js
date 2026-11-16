// ============================================================
// BUDREGISTER — "facit" som backtestet mäter mot.
//
// Härleds nu direkt ur _registry-data.js så att det bara finns EN källa
// till sanning (tidigare låg samma bud med olika datum i två filer).
//
// `ticker` är BudRadars interna nyckel — samma normalisering som
// api/companies.js använder — så att backtestet kan matcha mot
// signal_snapshots. `symbol` är den riktiga börstickern.
// ============================================================

import { REGISTRY } from "./_registry-data.js";

function internalKey(name) {
  return (name || "").toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(aktiebolag|ab|asa|oyj|plc|publ|holding|group|ltd|inc)\b/g, " ")
    .replace(/[^a-z0-9åäö ]/g, "").replace(/\s+/g, " ").trim()
    .toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export const BUD = REGISTRY
  .filter((r) => r.announced)
  .map((r) => ({
    ticker: internalKey(r.target),
    symbol: r.targetTicker || null,
    company: r.target,
    announced: r.announced,
    bidder: r.bidder,
    bidco: (r.bidcoChain && r.bidcoChain.length > 1) ? r.bidcoChain[r.bidcoChain.length - 1] : null,
    pricePerShare: r.pricePerShare,
    premiumPct: r.premiumLastClose,
    outcome: r.outcome,
    note: r.notes,
  }))
  .sort((a, b) => b.announced.localeCompare(a.announced));

/** Snittpremie för bud med positiv premie (budpliktsbud under kurs exkluderas). */
export function avgPremium(rows = BUD) {
  const done = rows.filter((b) => b.premiumPct > 0);
  if (!done.length) return null;
  return Math.round(done.reduce((s, b) => s + b.premiumPct, 0) / done.length);
}
