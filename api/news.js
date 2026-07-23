// ============================================================
// /api/news — PRESSMEDDELANDEN PER BOLAG
//
// Visar bolagets senaste pressmeddelanden i detaljvyn. För M&A-syfte är
// pressflödet den viktigaste mediekällan: bud, flaggningar, kallelser till
// extra bolagsstämma (ofta ett tecken på att något är på gång).
//
// Källa: MFN:s öppna flöde — samma som redan används för flaggningar och
// buddetektering. Gratis och fritt att använda, till skillnad från
// Retriever/Meltwater som säljer mediearkiv.
//
// Anrop: /api/news?company=Episurf%20Medical
//        /api/news?company=...&limit=8
// ============================================================

const TTL_MS = 15 * 60 * 1000;
const CACHE = new Map(); // norm(namn) → { ts, items }
const UA = "BudRadar/0.3 (+offentlig data)";

// Händelser som är särskilt relevanta för uppköp
const SIGNAL_PATTERNS = [
  { re: /uppköpserbjudande|offentligt erbjudande|kontantbud|rekommenderat bud/i, tag: "BUD", weight: 3 },
  { re: /flaggningsmeddelande|major shareholding/i, tag: "FLAGGNING", weight: 2 },
  { re: /extra bolagsstämma|extraordinary general meeting/i, tag: "EXTRA STÄMMA", weight: 2 },
  { re: /strategisk översyn|strategic review|utvärderar alternativ/i, tag: "STRATEGISK ÖVERSYN", weight: 3 },
  { re: /riktad nyemission|företrädesemission/i, tag: "EMISSION", weight: 1 },
  { re: /vd avgår|ny vd|styrelseordförande/i, tag: "LEDNING", weight: 1 },
  { re: /återköp av egna aktier/i, tag: "ÅTERKÖP", weight: 1 },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const company = (req.query && req.query.company || "").trim();
    if (!company) return res.status(400).json({ error: "company saknas" });
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));

    const key = norm(company);
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) {
      return res.status(200).json({ source: "cache", company, count: hit.items.length, items: hit.items.slice(0, limit) });
    }

    const raw = await fetchFeed();
    const target = norm(company);

    const items = raw
      .filter(it => {
        const author = norm(it.author);
        const title = norm(it.title);
        // Matcha på avsändare i första hand, annars bolagsnamn i rubriken
        return (author && (author.includes(target) || target.includes(author))) ||
               (target.length > 3 && title.includes(target));
      })
      .map(it => {
        const text = `${it.title} ${it.preamble}`;
        const hits = SIGNAL_PATTERNS.filter(p => p.re.test(text));
        return {
          title: it.title.slice(0, 180),
          date: it.date,
          url: it.url,
          author: it.author,
          tags: hits.map(h => h.tag),
          weight: hits.reduce((s, h) => s + h.weight, 0),
        };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    CACHE.set(key, { ts: Date.now(), items });
    res.status(200).json({ source: "live", company, count: items.length, items: items.slice(0, limit) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

let FEED_CACHE = { ts: 0, data: null };

async function fetchFeed() {
  if (FEED_CACHE.data && Date.now() - FEED_CACHE.ts < TTL_MS) return FEED_CACHE.data;
  const r = await fetch("https://mfn.se/all/s/nordic.json?limit=400", {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  if (!r.ok) throw new Error("mfn HTTP " + r.status);
  const j = await r.json();
  const data = (j.items || j.news || []).map(it => ({
    title: (it.content && it.content.title) || it.title || "",
    preamble: (it.content && it.content.preamble) || "",
    author: (it.author && it.author.name) || "",
    date: (it.publish_date || it.date || "").slice(0, 10),
    url: it.url || null,
  }));
  FEED_CACHE = { ts: Date.now(), data };
  return data;
}

function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/\s+(ab|asa|oyj|plc|publ|holding|group|\(publ\))\b/g, "")
    .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}
