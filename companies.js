// ============================================================
// /api/companies  — Vercel serverless-funktion
// Hämtar offentlig data LIVE vid anrop, slår ihop per bolag,
// räknar score och returnerar JSON. Ingen databas behövs.
// Cachar resultatet i minnet i 30 min så det går snabbt och
// så vi inte spammar källorna (FI begränsar antal sökningar).
//
// Källor:
//   • FI Insynsregistret (CSV) — insiders köp/sälj
//   • FI Blankningsregistret  — korta nettopositioner
//   • MFN flaggningar          — >5/10/15% ägande
//
// ⚠ VERIFIERA URL:erna nedan mot källorna i din webbläsare första
//   gången — de kan behöva justeras. Varje källa är feltolerant:
//   om en fallerar fortsätter de andra.
// ============================================================

const TTL_MS = 30 * 60 * 1000;
let CACHE = { ts: 0, data: null };

// --- Endpoints (verifiera vid behov) ---
const INSIDER_CSV =
  "https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search" +
  "?SearchFunctionType=Insyn&button=export&Page=1";
const SHORT_URL = "https://www.fi.se/sv/vara-register/blankningsregistret/GetAktuellaPositioner/";
const MFN_FEED = "https://mfn.se/all/a.json?filter=type:ext.se.fi.major-shareholding&limit=200";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (CACHE.data && Date.now() - CACHE.ts < TTL_MS) {
      return res.status(200).json({ source: "cache", companies: CACHE.data });
    }
    const map = new Map(); // nyckel: normaliserat bolagsnamn

    const [insider, shorts, flags] = await Promise.allSettled([
      fetchInsider(), fetchShort(), fetchFlags(),
    ]);

    if (insider.status === "fulfilled") mergeInsider(map, insider.value);
    if (shorts.status === "fulfilled") mergeShort(map, shorts.value);
    if (flags.status === "fulfilled") mergeFlags(map, flags.value);

    const companies = [...map.values()].map(scoreCompany).sort((a, b) => b.score.composite - a.score.composite);

    CACHE = { ts: Date.now(), data: companies };
    res.status(200).json({
      source: "live",
      fetched: { insider: insider.status, shorts: shorts.status, flags: flags.status },
      companies,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}

// ---------- helpers ----------
const UA = "BudRadar/0.1 (+offentlig data)";
function norm(name) {
  return (name || "").toLowerCase()
    .replace(/\s+(ab|asa|oyj|plc|publ|holding|group|\(publ\))\b/g, "")
    .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}
function getCo(map, name) {
  const key = norm(name);
  if (!key) return null;
  if (!map.has(key)) {
    map.set(key, {
      name, ticker: key.toUpperCase().slice(0, 8), list: null, priceSEK: null, mcapMSEK: null,
      _insider: [], _flags: [], _shorts: [], _bv: [],
    });
  }
  return map.get(key);
}
function toNum(s) { return Number(String(s ?? "").replace(/\s/g, "").replace(",", ".")) || 0; }
function dateIn(s) { const m = String(s ?? "").match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; }

// ---------- FI Insynsregistret ----------
async function fetchInsider() {
  const r = await fetch(INSIDER_CSV, { headers: { "user-agent": UA, accept: "text/csv,*/*" } });
  if (!r.ok) throw new Error("insider " + r.status);
  const text = await r.text();
  return parseCsv(text);
}
function mergeInsider(map, rows) {
  for (const row of rows) {
    const issuer = row["Utgivare"] || row["Emittent"] || "";
    if (!issuer) continue;
    const co = getCo(map, issuer); if (!co) continue;
    const vol = toNum(row["Volym"]);
    const price = toNum(row["Pris"]);
    co._insider.push({
      person: row["Person i ledande ställning"] || row["Namn"] || "—",
      tx_type: row["Karaktär"] || row["Karaktar"] || "",
      amount_sek: vol * price,
      tx_date: dateIn(row["Transaktionsdatum"]),
    });
  }
}

// ---------- FI Blankning ----------
async function fetchShort() {
  const r = await fetch(SHORT_URL, { headers: { "user-agent": UA, accept: "text/csv,*/*" } });
  if (!r.ok) throw new Error("short " + r.status);
  const text = await r.text();
  return parseCsv(text);
}
function mergeShort(map, rows) {
  for (const row of rows) {
    const issuer = row["Namn på emittent"] || row["Emittent"] || "";
    if (!issuer) continue;
    const co = getCo(map, issuer); if (!co) continue;
    co._shorts.push({
      holder: row["Innehavare av positionen"] || row["Innehavare"] || "—",
      position_pct: toNum(row["Position i procent"] || row["Position"]),
      position_date: dateIn(row["Datum för positionen"] || row["Datum"]),
    });
  }
}

// ---------- MFN flaggningar ----------
async function fetchFlags() {
  const r = await fetch(MFN_FEED, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error("mfn " + r.status);
  const j = await r.json();
  return j.items || [];
}
function mergeFlags(map, items) {
  for (const it of items) {
    const issuer = it.author?.name || "";
    if (!issuer) continue;
    const co = getCo(map, issuer); if (!co) continue;
    const txt = `${it.content?.title || it.title || ""} ${it.content?.preamble || ""}`;
    co._flags.push({ ...parseFlag(txt), flag_date: dateIn(it.publish_date), url: it.url });
  }
}
function parseFlag(text) {
  const t = (text || "").toLowerCase();
  const pcts = [...t.matchAll(/(\d{1,2})(?:[.,]\d+)?\s*(?:procent|%)/g)].map(m => Number(m[1]));
  const ths = [5, 10, 15, 20, 25, 30, 50, 66, 90];
  let threshold = null;
  for (const p of pcts) { const n = ths.find(x => Math.abs(x - p) <= 1); if (n) { threshold = n + "%"; break; } }
  const direction = /(överstig|ökat|nått|överskrid|passerat upp)/.test(t) ? "upp"
    : /(understig|minskat|sålt|sjunkit|underskrid)/.test(t) ? "ner" : "upp";
  const hm = (text || "").match(/^(.*?)\s+(?:har|genom|via)\b/i);
  const holder = hm ? hm[1].replace(/flaggningsmeddelande[:\-]?/i, "").trim() : null;
  return { holder, threshold, direction };
}

// ---------- enkel CSV-parser (semikolon, ev. citattecken) ----------
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const delim = lines[0].includes(";") ? ";" : ",";
  const headers = splitLine(lines[0], delim);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (cells[idx] ?? "").trim(); });
    out.push(row);
  }
  return out;
}
function splitLine(line, delim) {
  const res = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; continue; }
    if (c === delim && !q) { res.push(cur); cur = ""; continue; }
    cur += c;
  }
  res.push(cur);
  return res;
}

// ---------- scoring ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const tier = s => (s >= 65 ? "HÖG" : s >= 40 ? "MEDEL" : "LÅG");
function scoreCompany(co) {
  const now = Date.now(), d90 = 90 * 864e5, d120 = 120 * 864e5;
  const recentIns = co._insider.filter(x => x.tx_date && now - Date.parse(x.tx_date) < d90);
  let netMSEK = 0; const buyers = new Set(), sellers = new Set();
  for (const x of recentIns) {
    if (/förvärv|forvarv|köp/i.test(x.tx_type)) { netMSEK += x.amount_sek / 1e6; buyers.add(x.person); }
    else if (/avyttr|sälj|salj/i.test(x.tx_type)) { netMSEK -= x.amount_sek / 1e6; sellers.add(x.person); }
  }
  const insider = clamp(Math.max(0, netMSEK) * 4 + buyers.size * 6 - sellers.size * 5, 0, 100);

  const recentFlags = co._flags.filter(f => !f.flag_date || now - Date.parse(f.flag_date) < d120);
  const flags = clamp(recentFlags.reduce((s, f) => {
    const w = f.threshold === "15%" ? 45 : f.threshold === "10%" ? 35 : f.threshold === "5%" ? 20 : 15;
    return s + (f.direction === "ner" ? -w : w);
  }, 0), 0, 100);

  let shortSig = 0;
  const sorted = [...co._shorts].filter(s => s.position_date).sort((a, b) => a.position_date.localeCompare(b.position_date));
  if (sorted.length >= 2) shortSig = clamp(-(sorted.at(-1).position_pct - sorted[0].position_pct) * 18, 0, 100);

  const bv = clamp(co._bv.reduce((s, e) => s + (/bidco|spv|newco/i.test(e.note || "") ? 50 : 15), 0), 0, 100);

  const composite = Math.round(insider * 0.3 + flags * 0.3 + shortSig * 0.2 + bv * 0.2);
  return {
    ticker: co.ticker, name: co.name, list: co.list, priceSEK: co.priceSEK, mcapMSEK: co.mcapMSEK,
    score: { composite, tier: tier(composite), parts: { insider: Math.round(insider), flags: Math.round(flags), shortSig: Math.round(shortSig), bv: Math.round(bv) } },
    detail: {
      insider: recentIns.slice(0, 8),
      flags: recentFlags,
      shorts: sorted.slice(-10).reverse(),
      bolagsverket: co._bv,
    },
  };
}
