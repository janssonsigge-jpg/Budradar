// ============================================================
// /api/bidco  — Bidco-spår
// Letar efter nyregistrerade/omnämnda "bidco"-bolag i färska
// marknadsmeddelanden. Ett bidco (eller lagerbolaget "Goldcup NNNN AB")
// är skalet ett uppköp genomförs genom — dyker ofta upp strax före
// eller i samband med att ett bud blir känt.
//
// Källa: MFN:s öppna flöde (samma som vi vet fungerar för flaggningar).
// Vi skannar rubriker/ingresser efter bidco-mönster och listar träffarna.
//
// OBS: Detta är inte realtidsdetektering från Bolagsverket (POIT kräver
// scraping som kan blockeras). Det fångar bidco-omnämnanden i pressflödet,
// vilket i praktiken ofta är snabbast ändå eftersom budgivaren måste
// pressmeddela. Kan byggas ut mot POIT senare.
// ============================================================

const TTL_MS = 20 * 60 * 1000;
let CACHE = { ts: 0, data: null };
const UA = "BudRadar/0.1 (+offentlig data)";

// Flera MFN-flöden: FI (flaggningar), samt hela nordiska flödet där
// budpressmeddelanden dyker upp.
const FEEDS = [
  "https://mfn.se/all/s/nordic.json?limit=300",
  "https://mfn.se/all/a/fi-se.json?limit=200",
];

// Mönster som avslöjar ett uppköpsskal.
const BIDCO_RE = /\b([A-ZÅÄÖ][\wÅÄÖåäö&.\-]*(?:\s+[\wÅÄÖåäö&.\-]+){0,3}\s+(?:bidco|holdco|midco|topco))\b/i;
const GOLDCUP_RE = /\bGoldcup\s+\d+\s+AB\b/i;
const OFFER_RE = /(uppköpserbjudande|offentligt erbjudande|kontantbud|rekommenderat bud|public (cash )?offer|takeover)/i;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const fresh = req.query && (req.query.fresh === "1" || req.query.fresh === "true");
    if (!fresh && CACHE.data && Date.now() - CACHE.ts < TTL_MS) {
      return res.status(200).json({ source: "cache", items: CACHE.data });
    }

    const results = await Promise.allSettled(FEEDS.map(fetchFeed));
    const fetched = {};
    let items = [];
    results.forEach((r, i) => {
      const key = FEEDS[i].includes("fi-se") ? "fi" : "nordic";
      if (r.status === "fulfilled") { items = items.concat(r.value); fetched[key] = `ok (${r.value.length})`; }
      else fetched[key] = "FEL: " + String(r.reason).slice(0, 100);
    });

    // Deduplicera på bidco-namn + emittent
    const seen = new Set();
    const hits = [];
    for (const it of items) {
      const title = it.title || "";
      const body = `${title} ${it.preamble || ""}`;
      let bidco = null;
      const g = body.match(GOLDCUP_RE);
      const b = body.match(BIDCO_RE);
      if (g) bidco = g[0];
      else if (b) bidco = b[1];
      if (!bidco) continue;

      const key = (bidco + "|" + (it.author || "")).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        bidco: bidco.trim(),
        issuer: it.author || null,
        title: title.slice(0, 140),
        isOffer: OFFER_RE.test(body),
        date: it.date || null,
        url: it.url || null,
      });
    }

    // Nyast först, bud-relaterade högst
    hits.sort((a, b) => (b.isOffer - a.isOffer) || String(b.date).localeCompare(String(a.date)));

    CACHE = { ts: Date.now(), data: hits };
    res.status(200).json({ source: fresh ? "fresh" : "live", fetched, count: hits.length, items: hits });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

async function fetchFeed(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const raw = j.items || j.news || [];
  return raw.map(normalize);
}
function normalize(it) {
  return {
    title: (it.content && it.content.title) || it.title || it.header || "",
    preamble: (it.content && it.content.preamble) || "",
    author: (it.author && it.author.name) || it.source || "",
    date: (it.publish_date || it.date || "").slice(0, 10),
    url: it.url || null,
  };
}
