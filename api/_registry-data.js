// ============================================================
// BUDREGISTER — data
// Fullständiga poster enligt _registry-schema.js
//
// Nilörngruppen och Sleep Cycle är byggda som REFERENSPOSTER — de visar
// hur en komplett rad ser ut. Använd dem som mall när du fyller på.
//
// Källor: MFN-pressmeddelanden, Placera, EFN, Affärsvärlden, VQM.
// ============================================================

export const REGISTRY = [
  {
    id: "2026-05-04-nilorngruppen",
    target: "Nilörngruppen", targetTicker: "NIL B", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Industri / Etiketter",

    bidder: "Trimco Group", bidderType: "PE", bidderCountry: "UK",
    bidcoChain: ["Brookfield", "Trimco Group Holdings Limited", "Trimco Group (UK) Limited"],
    bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: 77, currency: "SEK",
    equityValueMSEK: 878, evMSEK: null,
    premiumLastClose: 53, premium30d: null, premium90d: null,
    evEbit: 12.9, evSales: 0.9, consideration: "Kontant",

    preBidOwners: [
      { name: "AB Traction", capitalPct: 26.3, votesPct: 58.1, committed: true },
      { name: "Protector Forsikring ASA", capitalPct: null, votesPct: null, committed: true },
      { name: "Kavaljer Fonder", capitalPct: null, votesPct: null, committed: true },
      { name: "Krister Magnusson (VD)", capitalPct: null, votesPct: null, committed: true },
    ],
    irrevocable: true, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-05-04", acceptStart: "2026-06-19", acceptEnd: "2026-07-10",
    settlement: null, delisting: null,

    acceptanceThreshold: 90, dueDiligence: true, mandatoryOffer: false,
    boardRecommended: true, fairnessOpinion: true,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "Traction band sig oåterkalleligen även vid högre konkurrerande bud — " +
           "med 58,1% av rösterna var affären därmed i praktiken avgjord vid offentliggörandet.",
    sources: [
      "https://mfn.se/one/a/nilorngruppen/nilorngruppen-offentliggor-styrelsens-uttalande-med-anledning-av-offentligt-uppkopserbjudande-fran-trimco-group-ca9faf4c",
    ],
  },

  {
    id: "2026-05-11-sleepcycle",
    target: "Sleep Cycle", targetTicker: "SLEEP", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Konsument / Mjukvara",

    bidder: "Altor Fund V", bidderType: "PE", bidderCountry: "SE",
    bidcoChain: ["Altor Fund V", "Snark BidCo AB"],
    bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: 24.5, currency: "SEK",
    equityValueMSEK: null, evMSEK: null,
    premiumLastClose: 47, premium30d: null, premium90d: null,
    evEbit: null, evSales: null, consideration: "Kontant",

    preBidOwners: [
      { name: "Grundare + näst största ägare", capitalPct: 63, votesPct: null, committed: true },
    ],
    irrevocable: true, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-05-11", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: 90, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: true, fairnessOpinion: null,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "Aktien handlades nära 52-veckors lägsta (15–16 kr) när budet kom. " +
           "Klassiskt mönster: budgivaren slår till på nedtryckt kurs, inte på toppen.",
    sources: [],
  },

  {
    id: "2026-04-27-cint",
    target: "Cint Group", targetTicker: "CINT", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Tech / Marknadsundersökning",

    bidder: "Triton Partners + Bolero Holdings", bidderType: "PE", bidderCountry: "Internationell",
    bidcoChain: ["Triton Partners", "TriCarbs BidCo"],
    bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: 6.0, currency: "SEK",
    equityValueMSEK: 2000, evMSEK: null,
    premiumLastClose: 33, premium30d: null, premium90d: 70,
    evEbit: null, evSales: null, consideration: "Kontant",

    preBidOwners: [
      { name: "Patrick Comer (VD)", capitalPct: null, votesPct: null, committed: true },
    ],
    irrevocable: null, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-04-27", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: 90, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: true, fairnessOpinion: null,
    outcome: "Höjt bud", finalAcceptance: null, raisedTo: 6.0,

    notes: "Först 5,60 kr. Aktiemarknadsnämnden invände mot att VD satt i budkonsortiet; " +
           "konsortiet stöptes om och budet höjdes till 6,00. Illustrerar hur management-deltagande " +
           "kan tvinga fram en höjning.",
    sources: [],
  },

  {
    id: "2026-07-08-bahnhof",
    target: "Bahnhof", targetTicker: "BAHN B", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Telekom",

    bidder: "Telenor", bidderType: "Industriell", bidderCountry: "NO",
    bidcoChain: ["Telenor Group"], bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: 62, currency: "SEK",
    equityValueMSEK: null, evMSEK: null,
    premiumLastClose: 22, premium30d: null, premium90d: null,
    evEbit: null, evSales: null, consideration: "Kontant",

    preBidOwners: [
      { name: "Jon Karlung + Andreas Norman (grundare)", capitalPct: 50.8, votesPct: 86, committed: true },
      { name: "Investment AB Öresund", capitalPct: 6.7, votesPct: 1.9, committed: true },
    ],
    irrevocable: true, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-07-08", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: null, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: null, fairnessOpinion: null,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "Grundarna fick 60 kr/aktie medan Öresund och övriga fick 62 kr. " +
           "Med 86% av rösterna hos grundarna var utgången given när de bestämt sig.",
    sources: ["https://efn.se/snalt-bud-darfor-ar-bahnhof-ar-vart-mer"],
  },

  {
    id: "2026-03-02-vivawine",
    target: "Viva Wine Group", targetTicker: "VIVA", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Konsument / Dryck",

    bidder: "Grundarna", bidderType: "Grundare", bidderCountry: "SE",
    bidcoChain: ["Riesling Ventures"], bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: 38.5, currency: "SEK",
    equityValueMSEK: null, evMSEK: null,
    premiumLastClose: 38, premium30d: null, premium90d: null,
    evEbit: null, evSales: null, consideration: "Kontant",

    preBidOwners: [], irrevocable: null, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-03-02", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: 90, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: null, fairnessOpinion: null,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "Budet låg under noteringskursen 49 kr — premien mäts mot kursen före budet, " +
           "inte mot IPO-pris eller historisk topp.",
    sources: [],
  },

  {
    id: "2026-01-12-biotage",
    target: "Biotage", targetTicker: "BIOT", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Life Science",

    bidder: "KKR", bidderType: "PE", bidderCountry: "US",
    bidcoChain: ["KKR"], bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: null, currency: "SEK",
    equityValueMSEK: null, evMSEK: null,
    premiumLastClose: 60, premium30d: null, premium90d: null,
    evEbit: null, evSales: null, consideration: "Kontant",

    preBidOwners: [], irrevocable: null, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-01-12", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: null, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: null, fairnessOpinion: null,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "Aktien steg över 55% på veckan — börsens klart bästa. Högsta premien i registret.",
    sources: [],
  },

  {
    id: "2026-02-09-humana",
    target: "Humana", targetTicker: "HUM", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Omsorg",

    bidder: "Ambea", bidderType: "Industriell", bidderCountry: "SE",
    bidcoChain: ["Ambea AB"], bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: null, currency: "SEK",
    equityValueMSEK: null, evMSEK: null,
    premiumLastClose: 27, premium30d: null, premium90d: null,
    evEbit: null, evSales: null, consideration: "Blandat",

    preBidOwners: [], irrevocable: null, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2026-02-09", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: null, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: null, fairnessOpinion: null,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "Branschkonsolidering — konkurrenten köpte. Kombinerat kontant- och aktiebud.",
    sources: [],
  },

  {
    id: "2025-06-16-fortnox",
    target: "Fortnox", targetTicker: "FNOX", targetIsin: null, targetOrgNr: null,
    market: "Nasdaq Stockholm", sector: "Tech / Affärssystem",

    bidder: "Olof Hallrup + EQT", bidderType: "Storägare", bidderCountry: "SE",
    bidcoChain: ["First Kraft AB"], bidcoOrgNr: null, bidcoRegistered: null,

    pricePerShare: 90, currency: "SEK",
    equityValueMSEK: null, evMSEK: null,
    premiumLastClose: 38, premium30d: null, premium90d: null,
    evEbit: null, evSales: null, consideration: "Kontant",

    preBidOwners: [
      { name: "Olof Hallrup", capitalPct: null, votesPct: null, committed: true },
    ],
    irrevocable: null, freeFloat: null,

    firstFlagging: null, rumourDate: null,
    announced: "2025-06-16", acceptStart: null, acceptEnd: null,
    settlement: null, delisting: null,

    acceptanceThreshold: 90, dueDiligence: null, mandatoryOffer: false,
    boardRecommended: null, fairnessOpinion: null,
    outcome: "Genomfört", finalAcceptance: null, raisedTo: null,

    notes: "2025 års största bud. Storägare gick ihop med PE — vanligt mönster " +
           "när en befintlig ägare vill ta hem bolaget men saknar kapital själv.",
    sources: [],
  },
];
