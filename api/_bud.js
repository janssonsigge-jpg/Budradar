// ============================================================
// BUDREGISTER — faktiska bud på svenska börsbolag.
// Detta är "facit" som backtestet mäter mot.
//
// announced = datumet budet blev OFFENTLIGT. Det är nyckelfältet:
// backtestet går tillbaka N dagar från detta datum och frågar
// "låg bolaget högt i BudRadar då?".
//
// Nya bud fångas automatiskt av /api/detect-bids och hamnar i
// databastabellen bid_registry. Denna fil är historiskt seed —
// bud som skedde innan den automatiska detekteringen startade.
//
// Källor: MFN-pressmeddelanden, Placera, EFN, Affärsvärlden.
// ============================================================

export const BUD = [
  // ---- 2026 ----
  { ticker: "BAHNHOF", company: "Bahnhof", announced: "2026-07-08", bidder: "Telenor",
    bidco: null, pricePerShare: 62, premiumPct: 22, outcome: "Genomfört",
    note: "Grundarna Karlung och Norman sålde 50,8% av aktierna / 86% av rösterna." },

  { ticker: "SLEEP", company: "Sleep Cycle", announced: "2026-05-11", bidder: "Altor Fund V",
    bidco: "Snark BidCo", pricePerShare: 24.5, premiumPct: 47, outcome: "Genomfört",
    note: "Aktien handlades nära 52-veckors lägsta (15–16 kr) före budet." },

  { ticker: "NILORNGR", company: "Nilörngruppen", announced: "2026-05-04", bidder: "Trimco Group (Brookfield)",
    bidco: null, pricePerShare: 77, premiumPct: 53, outcome: "Genomfört",
    note: "Värderade bolaget till 878 Mkr. Traction (26,3% kapital / 58,1% röster) accepterade oåterkalleligen." },

  { ticker: "CINT", company: "Cint Group", announced: "2026-04-27", bidder: "Triton + Bolero Holdings",
    bidco: "TriCarbs BidCo", pricePerShare: 6.0, premiumPct: 33, outcome: "Höjt bud",
    note: "Först 5,60 kr, höjt till 6,00. Värderade Cint till ca 2 mdkr." },

  { ticker: "VIVA", company: "Viva Wine Group", announced: "2026-03-02", bidder: "Grundarna",
    bidco: "Riesling Ventures", pricePerShare: 38.5, premiumPct: 38, outcome: "Genomfört",
    note: "Grundarna köpte ut bolaget. Budet låg under noteringskursen 49 kr." },

  { ticker: "HUM", company: "Humana", announced: "2026-02-09", bidder: "Ambea",
    bidco: null, pricePerShare: null, premiumPct: 27, outcome: "Genomfört",
    note: "Kombinerat kontant- och aktiebud från branschkollega." },

  { ticker: "BIOT", company: "Biotage", announced: "2026-01-12", bidder: "KKR",
    bidco: null, pricePerShare: null, premiumPct: 60, outcome: "Genomfört",
    note: "Aktien steg över 55% på veckan — börsens bästa." },

  // ---- 2025 ----
  { ticker: "FNOX", company: "Fortnox", announced: "2025-06-16", bidder: "Olof Hallrup + EQT",
    bidco: "First Kraft AB", pricePerShare: 90, premiumPct: 38, outcome: "Genomfört",
    note: "Årets största bud 2025." },

  // ---- LÄGG TILL FLER ----
  // Under 2025 kom 22–30 bud på svenska börsen; H1 2026 gav 12 bud på 11 bolag.
  // Affärsvärldens Uppköpsguide sammanställer alla. Ju fler rader, desto
  // starkare backtest. Historiskt snitt för budpremie: ca 33%.
];

/** Snittpremie för genomförda bud. */
export function avgPremium(rows = BUD) {
  const done = rows.filter(b => b.premiumPct > 0);
  if (!done.length) return null;
  return Math.round(done.reduce((s, b) => s + b.premiumPct, 0) / done.length);
}
