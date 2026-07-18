// ============================================================
// BUDREGISTER — dataset över faktiska bud på svenska börsbolag.
// Detta är grunden för backtestet: för varje bud vet vi DATUMET budet
// offentliggjordes, vilket gör att vi kan gå tillbaka i signal_history
// och fråga "hur såg signalerna ut 30/60/90 dagar INNAN?".
//
// FÄLT:
//   ticker        — matchar ticker i signal_history (viktigt!)
//   company       — bolagsnamn
//   announced     — DATUM budet blev offentligt (nyckeln för backtest)
//   bidder        — budgivare
//   bidco         — skalbolaget budet gick genom (om känt) ← BudRadars tes
//   pricePerShare — budpris per aktie (SEK)
//   premiumPct    — premie mot senaste kurs före budet
//   outcome       — "Genomfört" | "Höjt bud" | "Drogs tillbaka" | "Pågår"
//
// UTÖKA DETTA: Affärsvärldens Uppköpsguide listar alla bud per år
// (~30 bud på svenska bolag under 2025). Varje rad du lägger till gör
// backtestet starkare. Detta är din viktigaste manuella tillgång.
// ============================================================

export const BUD = [
  // ---- 2026 (verifierade) ----
  { ticker: "SLEEP", company: "Sleep Cycle", announced: "2026-02-16", bidder: "Altor",
    bidco: "Snark Bidco", pricePerShare: 24.5, premiumPct: 47, outcome: "Genomfört" },
  { ticker: "CINT", company: "Cint Group", announced: "2026-01-26", bidder: "Triton + Bolero",
    bidco: "TriCarbs BidCo", pricePerShare: 6.0, premiumPct: 33, outcome: "Höjt bud" },
  { ticker: "VIVA", company: "Viva Wine Group", announced: "2026-03-02", bidder: "Grundarna",
    bidco: "Riesling Ventures", pricePerShare: 38.5, premiumPct: 38, outcome: "Genomfört" },
  { ticker: "BIOT", company: "Biotage", announced: "2026-01-12", bidder: "KKR",
    bidco: null, pricePerShare: null, premiumPct: 60, outcome: "Genomfört" },
  { ticker: "HUM", company: "Humana", announced: "2026-02-09", bidder: "Ambea",
    bidco: null, pricePerShare: null, premiumPct: 27, outcome: "Genomfört" },

  // ---- 2025 ----
  // Fortnox var årets största bud (Olof Hallrup + EQT).
  { ticker: "FNOX", company: "Fortnox", announced: "2025-06-16", bidder: "Olof Hallrup + EQT",
    bidco: "First Kraft AB", pricePerShare: 90, premiumPct: 38, outcome: "Genomfört" },

  // ---- LÄGG TILL FLER HÄR ----
  // Källa: Affärsvärldens Uppköpsguide (alla bud per år), MFN-pressmeddelanden.
  // Under 2025 presenterades ~30 bud på svenska bolag; två drogs tillbaka.
  // Ju fler rader, desto mer statistiskt meningsfullt blir backtestet.
];

/** Snittpremie för genomförda bud. */
export function avgPremium(rows = BUD) {
  const done = rows.filter(b => b.premiumPct > 0);
  if (!done.length) return null;
  return Math.round(done.reduce((s, b) => s + b.premiumPct, 0) / done.length);
}
