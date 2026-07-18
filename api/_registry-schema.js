// ============================================================
// NORDISKT BUDREGISTER — datamodell
//
// Detta är produkten. Inte appen — datan.
//
// Affärsvärldens Uppköpsguide är artiklar. Modular Finance har ägardata.
// Börsdata har fundamenta. INGEN har en maskinläsbar databas över nordiska
// offentliga uppköpserbjudanden med bidco-kedja, ägarstruktur före budet,
// tidslinje och utfall. Det är glappet.
//
// KÖPARE: PE-fonder (jämförbara transaktioner), advokatbyråer (prejudikat
// och premienivåer), corporate finance (pitchmaterial), akademiker.
//
// VAD SOM GÖR DET SÄLJBART — inte bara "vem köpte vad" utan:
//   1. Bidco-kedjan (topco → midco → bidco) — hur affären strukturerades
//   2. Ägarstruktur FÖRE budet — vem band sig, med hur mycket röstmakt
//   3. Tidslinjen — flaggning → rykte → bud → acceptperiod → utfall
//   4. Villkoren — acceptansgräns, due diligence, budplikt
//   5. Premien mot flera referenspunkter, inte bara gårdagens kurs
// ============================================================

/**
 * @typedef {Object} Bud
 *
 * IDENTITET
 * @property {string}  id              Unikt: "2026-05-04-nilorngruppen"
 * @property {string}  target          Målbolagets namn
 * @property {string}  targetTicker    Ticker
 * @property {string}  targetIsin      ISIN (stabil nyckel)
 * @property {string}  targetOrgNr     Organisationsnummer
 * @property {string}  market          "Nasdaq Stockholm" | "First North" | "Spotlight" | "NGM"
 * @property {string}  sector          Bransch
 *
 * BUDGIVARE & STRUKTUR  ← detta är det unika
 * @property {string}  bidder          Yttersta budgivaren ("Brookfield")
 * @property {string}  bidderType      "PE" | "Industriell" | "Grundare" | "Storägare" | "Utländsk"
 * @property {string}  bidderCountry   Budgivarens hemland
 * @property {string[]} bidcoChain     Hela kedjan: ["Trimco Group Holdings", "Trimco Group (UK)"]
 * @property {string}  bidcoOrgNr      Bidcons organisationsnummer (Bolagsverket)
 * @property {string}  bidcoRegistered Datum bidcon registrerades ← BudRadars kärntes
 *
 * EKONOMI
 * @property {number}  pricePerShare   Budpris per aktie
 * @property {string}  currency
 * @property {number}  equityValueMSEK Aktievärde
 * @property {number}  evMSEK          Enterprise value
 * @property {number}  premiumLastClose Premie mot senaste stängningskurs
 * @property {number}  premium30d      Premie mot 30-dagars VWAP
 * @property {number}  premium90d      Premie mot 90-dagars VWAP
 * @property {number}  evEbit          EV/EBIT-multipel
 * @property {number}  evSales         EV/Sales-multipel
 * @property {string}  consideration   "Kontant" | "Aktier" | "Blandat"
 *
 * ÄGARSTRUKTUR FÖRE BUDET  ← svårt att få tag på, därför värdefullt
 * @property {Object[]} preBidOwners   [{name, capitalPct, votesPct, committed}]
 * @property {number}  committedPct    Andel som band sig innan
 * @property {number}  committedVotes  Röstandel som band sig
 * @property {boolean} irrevocable     Bindande oavsett konkurrerande bud?
 * @property {number}  freeFloat       Fri float före budet
 *
 * TIDSLINJE  ← här kopplas BudRadars signaler in
 * @property {string}  firstFlagging   Första flaggning som visade positionsbyggande
 * @property {string}  rumourDate      Första medierykte (om något)
 * @property {string}  announced       Budet offentliggjort
 * @property {string}  acceptStart     Acceptperiod start
 * @property {string}  acceptEnd       Acceptperiod slut
 * @property {string}  settlement      Likviddag
 * @property {string}  delisting       Avnotering
 * @property {number}  daysFlagToAnnounce  Dagar från flaggning till bud
 *
 * VILLKOR & UTFALL
 * @property {number}  acceptanceThreshold  Villkorad acceptansgräns (oftast 90%)
 * @property {boolean} dueDiligence         Genomförde budgivaren DD?
 * @property {boolean} mandatoryOffer       Budplikt (över 30%)?
 * @property {boolean} boardRecommended     Rekommenderat av styrelsen?
 * @property {boolean} fairnessOpinion      Fairness opinion inhämtad?
 * @property {string}  outcome         "Genomfört" | "Höjt bud" | "Konkurrerande bud" | "Drogs tillbaka" | "Pågår"
 * @property {number}  finalAcceptance Slutlig acceptansgrad
 * @property {number}  raisedTo        Om budet höjdes: till vilket pris
 *
 * KÄLLOR — spårbarhet gör datan trovärdig
 * @property {string[]} sources        URL:er till pressmeddelanden
 */

/** Fält som MÅSTE finnas för att en rad ska räknas som komplett. */
export const REQUIRED = ["id", "target", "announced", "bidder", "outcome"];

/** Fält som gör raden kommersiellt värdefull (utöver de obligatoriska). */
export const PREMIUM_FIELDS = [
  "bidcoChain", "bidcoRegistered", "preBidOwners", "committedVotes",
  "premiumLastClose", "premium90d", "evEbit", "firstFlagging",
  "acceptanceThreshold", "finalAcceptance",
];

/** Räkna hur komplett en post är (0–100). Driver kvalitetsmått i API:t. */
export function completeness(bud) {
  const all = [...REQUIRED, ...PREMIUM_FIELDS];
  const filled = all.filter(f => {
    const v = bud[f];
    return v != null && v !== "" && !(Array.isArray(v) && !v.length);
  });
  return Math.round((filled.length / all.length) * 100);
}

/** Validera en post innan den sparas. */
export function validate(bud) {
  const errors = [];
  for (const f of REQUIRED) {
    if (bud[f] == null || bud[f] === "") errors.push(`saknar ${f}`);
  }
  if (bud.announced && !/^\d{4}-\d{2}-\d{2}$/.test(bud.announced)) errors.push("announced måste vara YYYY-MM-DD");
  if (bud.premiumLastClose != null && (bud.premiumLastClose < -50 || bud.premiumLastClose > 500)) {
    errors.push("premiumLastClose orimlig");
  }
  if (bud.bidcoRegistered && bud.announced && bud.bidcoRegistered > bud.announced) {
    errors.push("bidco registrerad efter budet — kontrollera datum");
  }
  return { ok: errors.length === 0, errors };
}

/** Härled fält som går att räkna ut. */
export function derive(bud) {
  const out = { ...bud };
  if (bud.firstFlagging && bud.announced) {
    out.daysFlagToAnnounce = Math.round(
      (Date.parse(bud.announced) - Date.parse(bud.firstFlagging)) / 864e5
    );
  }
  if (bud.bidcoRegistered && bud.announced) {
    out.daysBidcoToAnnounce = Math.round(
      (Date.parse(bud.announced) - Date.parse(bud.bidcoRegistered)) / 864e5
    );
  }
  if (bud.preBidOwners && bud.preBidOwners.length) {
    out.committedPct = bud.preBidOwners.filter(o => o.committed)
      .reduce((s, o) => s + (o.capitalPct || 0), 0);
    out.committedVotes = bud.preBidOwners.filter(o => o.committed)
      .reduce((s, o) => s + (o.votesPct || 0), 0);
  }
  out.completeness = completeness(out);
  return out;
}
