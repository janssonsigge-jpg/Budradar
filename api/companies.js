import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
// ============================================================
// /api/companies  — Vercel serverless-funktion
// Hämtar offentlig data LIVE, slår ihop per bolag, räknar score.
// Cachar 30 min. Lägg till ?fresh=1 i URL:en för att hoppa över cachen.
//
// Källor:
//   • FI Insynsregistret (CSV, UTF-16) — insiders köp/sälj  [FUNGERAR]
//   • FI Blankningsregistret            — korta positioner   (kan behöva justeras)
//   • MFN flaggningar                   — >5/10/15% ägande   (kan behöva justeras)
// Varje källa är feltolerant: om en fallerar fortsätter de andra.
// ============================================================

const TTL_MS = 30 * 60 * 1000;
let CACHE = { ts: 0, data: null };

const INSIDER_CSV =
  "https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search" +
  "?SearchFunctionType=Insyn&button=export&Page=1";
const SHORT_URL = "https://www.fi.se/sv/vara-register/blankningsregistret/GetAktuellaPositioner/";
const MFN_FEED = "https://mfn.se/all/a/fi-se.json?limit=200";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const fresh = req.query && (req.query.fresh === "1" || req.query.fresh === "true");
    if (!fresh && CACHE.data && Date.now() - CACHE.ts < TTL_MS) {
      return res.status(200).json({ source: "cache", companies: CACHE.data });
    }
    const map = new Map();

    const [insider, shorts, flags] = await Promise.allSettled([
      fetchInsider(), fetchShort(), fetchFlags(),
    ]);

    const fetched = {};
    if (insider.status === "fulfilled") { mergeInsider(map, insider.value); fetched.insider = `ok (${insider.value.length} rader)`; }
    else fetched.insider = "FEL: " + String(insider.reason).slice(0, 120);
    if (shorts.status === "fulfilled") { mergeShort(map, shorts.value); fetched.shorts = `ok (${shorts.value.length} rader)`; }
    else fetched.shorts = "FEL: " + String(shorts.reason).slice(0, 120);
    if (flags.status === "fulfilled") { mergeFlags(map, flags.value); fetched.flags = `ok (${flags.value.length} rader)`; }
    else fetched.flags = "FEL: " + String(flags.reason).slice(0, 120);

    const companies = mergeByIsin(map).map(scoreCompany)
      .filter(c => c.score.composite > 0 || c.detail.insider.length || c.detail.flags.length)
      .sort((a, b) => b.score.composite - a.score.composite);

    // Berika med börsvärde/kurs från fundamentals-tabellen (om databas finns).
    // Detta driver storleksfiltret — stora bolag blir sällan uppköpta.
    await enrichWithFundamentals(companies);
    for (const c of companies) {
      c.largeCap = (c.mcapMSEK != null && c.mcapMSEK >= 10000) || isKnownLargeCap(c.name);
      c.lastEvent = lastEventDate(c);
    }

    CACHE = { ts: Date.now(), data: companies };
    res.status(200).json({ source: fresh ? "fresh" : "live", fetched, count: companies.length, companies });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

// ---------- helpers ----------
const UA = "BudRadar/0.1 (+offentlig data)";
function norm(name) {
  // "Sandvik Aktiebolag", "Sandvik AB" och "SANDVIK AB (publ)" ska bli samma bolag.
  return (name || "").toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(aktiebolag|ab|asa|oyj|plc|publ|holding|group|ltd|inc|se)\b/g, " ")
    .replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}
function getCo(map, name) {
  const key = norm(name);
  if (!key) return null;
  if (!map.has(key)) {
    // ticker = intern nyckel (används av snapshots/backtest). symbol = riktig börsticker, sätts i berikningen.
    map.set(key, { name, ticker: key.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8), symbol: null,
      list: null, priceSEK: null, mcapMSEK: null, _insider: [], _flags: [], _shorts: [], _bv: [] });
  }
  return map.get(key);
}
function toNum(s) { return Number(String(s == null ? "" : s).replace(/\s/g, "").replace(/\u00a0/g, "").replace(",", ".")) || 0; }
function dateIn(s) { const m = String(s == null ? "" : s).match(/\d{4}-\d{2}-\d{2}/); return m ? m[0] : null; }

// Samma bolag kan dyka upp under olika namn i olika källor. När ISIN finns
// (från insynsregistret) slår vi ihop posterna på den.
function mergeByIsin(map) {
  const byIsin = new Map();
  const out = [];
  for (const co of map.values()) {
    if (!co._isin) { out.push(co); continue; }
    const prev = byIsin.get(co._isin);
    if (!prev) { byIsin.set(co._isin, co); out.push(co); continue; }
    prev._insider.push(...co._insider);
    prev._flags.push(...co._flags);
    prev._shorts.push(...co._shorts);
    prev._bv.push(...co._bv);
    if (!prev._totalShares && co._totalShares) prev._totalShares = co._totalShares;
    if (co.name.length < prev.name.length) prev.name = co.name;
  }
  // Andra varvet: poster utan ISIN men med samma normaliserade nyckel som en ISIN-post
  const byKey = new Map(out.filter(c => c._isin).map(c => [norm(c.name), c]));
  return out.filter(co => {
    if (co._isin) return true;
    const twin = byKey.get(norm(co.name));
    if (!twin || twin === co) return true;
    twin._insider.push(...co._insider); twin._flags.push(...co._flags);
    twin._shorts.push(...co._shorts); twin._bv.push(...co._bv);
    return false;
  });
}

// Nasdaq Stockholm Large Cap — blir sällan uppköpta. Används när börsvärde saknas.
const LARGE_CAP = [
  "abb", "alfa laval", "assa abloy", "astrazeneca", "atlas copco", "autoliv", "axfood", "beijer ref",
  "boliden", "castellum", "electrolux", "elekta", "epiroc", "eqt", "telefonaktiebolaget lm ericsson", "ericsson",
  "essity", "evolution", "fabege", "fastighets balder", "getinge", "hennes & mauritz", "h & m", "svenska handelsbanken",
  "hexagon", "holmen", "husqvarna", "industrivärden", "indutrade", "investor", "kinnevik", "l e lundbergföretagen",
  "lifco", "nibe industrier", "nordea bank", "saab", "sagax", "sandvik", "svenska cellulosa", "skandinaviska enskilda banken",
  "securitas", "skanska", "skf", "ssab", "swedbank", "swedish orphan biovitrum", "tele2", "telia company", "trelleborg",
  "volvo", "volvo car", "wallenstam", "wihlborgs fastigheter", "addtech", "aak", "avanza bank", "nordnet", "sweco",
  "thule", "investment latour", "lagercrantz", "hexpol", "loomis", "mycronic", "sectra", "atrium ljungberg",
  "catena", "hufvudstaden", "dometic", "nolato", "peab", "ncc", "jm", "bravida", "munters", "alleima", "embracer",
  "industrivarden", "billerud", "sinch", "camurus", "storskogen", "vitec software", "bufab", "beijer alma",
];
const LARGE_CAP_KEYS = new Set(LARGE_CAP.map(norm));
function isKnownLargeCap(name) {
  const k = norm(name);
  return LARGE_CAP_KEYS.has(k) || LARGE_CAP_KEYS.has(k.replace(/^ab /, "")) || LARGE_CAP_KEYS.has(k.split(" ")[0] === "ab" ? k.slice(3) : k);
}

function lastEventDate(c) {
  const d = [
    ...c.detail.insider.map(x => x.tx_date),
    ...c.detail.flags.map(x => x.flag_date),
    ...c.detail.shorts.map(x => x.position_date),
  ].filter(Boolean).sort();
  return d.length ? d[d.length - 1] : null;
}

// ---------- FI Insynsregistret (UTF-16!) ----------
async function fetchInsider() {
  const r = await fetch(INSIDER_CSV, { headers: { "user-agent": UA, accept: "text/csv,*/*" } });
  if (!r.ok) throw new Error("insider HTTP " + r.status);
  // Filen är UTF-16 med BOM. Läs som bytes och avkoda med TextDecoder.
  const buf = await r.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Upptäck UTF-16 LE/BE via BOM; fall tillbaka på LE.
  let enc = "utf-16le";
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) enc = "utf-16be";
  else if (bytes[0] === 0xFF && bytes[1] === 0xFE) enc = "utf-16le";
  else if (bytes[0] === 0xEF && bytes[1] === 0xBB) enc = "utf-8";
  const text = new TextDecoder(enc).decode(bytes);
  return parseCsv(text);
}
function mergeInsider(map, rows) {
  for (const row of rows) {
    const issuer = row["Emittent"] || "";
    if (!issuer) continue;
    const co = getCo(map, issuer); if (!co) continue;
    if (row["ISIN"] && !co._isin) co._isin = row["ISIN"];
    const vol = toNum(row["Volym"]);
    const price = toNum(row["Pris"]);
    let amount = vol * price;
    // Filtrera bort orimliga rader (felskrivna pris/volym i FI-datan).
    // En enskild insynstransaktion på > 1 miljard SEK är nästan alltid ett datafel.
    if (!isFinite(amount) || amount > 1e9) amount = 0;
    co._insider.push({
      person: row["Person i ledande ställning"] || row["Anmälningsskyldig"] || "—",
      tx_type: row["Karaktär"] || "",
      amount_sek: amount,
      tx_date: dateIn(row["Transaktionsdatum"]),
    });
  }
}

// ---------- FI Blankning (läses från medföljande ODS-fil) ----------
// FI serverar filen som en tillfällig "blob" i webbläsaren — ingen fast URL att
// hämta från. Därför läser vi api/blankning.ods som ligger i projektet.
// Uppdatera genom att ladda upp en ny fil till GitHub (räcker sällan).
async function fetchShort() {
  const buf = readFileSync(join(__dir, "blankning.ods"));
  return parseOds(buf);
}
function mergeShort(map, rows) {
  for (const row of rows) {
    const issuer = row["Namn på emittent"] || "";
    if (!issuer) continue;
    const co = getCo(map, issuer); if (!co) continue;
    co._shorts.push({
      holder: row["Innehavare av positionen"] || "—",
      position_pct: toNum(row["Position i procent"]),
      position_date: dateIn(row["Datum för positionen"]),
    });
  }
}

// Läser en fil ur en ODS (zip) och returnerar rad-objekt nycklade på rubrik.
function readZipEntry(buf, targetName) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i + 4 <= buf.length) {
    if (dv.getUint32(i, true) === 0x04034b50) {
      const method = dv.getUint16(i + 8, true);
      const compSize = dv.getUint32(i + 18, true);
      const nameLen = dv.getUint16(i + 26, true);
      const extraLen = dv.getUint16(i + 28, true);
      const nameStart = i + 30;
      const name = Buffer.from(buf.subarray(nameStart, nameStart + nameLen)).toString("utf8");
      const dataStart = nameStart + nameLen + extraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (name === targetName) {
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error("okänd komprimering " + method);
      }
      i = dataStart + compSize;
    } else i++;
  }
  throw new Error(targetName + " saknas i ODS");
}
function parseOds(buf) {
  const xml = readZipEntry(buf, "content.xml").toString("utf8");
  const rawRows = xml.match(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g) || [];
  const grid = [];
  for (const r of rawRows) {
    const cells = [];
    const cellRe = /<table:table-cell([^>]*)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g;
    let m;
    while ((m = cellRe.exec(r))) {
      const attrs = m[1] || "", inner = m[2] || "";
      const rep = /number-columns-repeated="(\d+)"/.exec(attrs);
      const valAttr = /office:value="([^"]*)"/.exec(attrs);
      let text = inner.replace(/<[^>]+>/g, "").trim();
      if (!text && valAttr) text = valAttr[1];
      const times = rep ? Math.min(Number(rep[1]), 50) : 1;
      for (let k = 0; k < times; k++) cells.push(text);
    }
    grid.push(cells);
  }
  const hi = grid.findIndex(c => c.some(x => x.includes("emittent") || x.includes("Innehavare")));
  if (hi < 0) return [];
  const headers = grid[hi].map(h => h.replace(/\(.*?\)/g, "").trim());
  const out = [];
  for (const cells of grid.slice(hi + 1)) {
    if (!cells[0] || !cells[1]) continue;
    const row = {};
    headers.forEach((h, idx) => { if (h) row[h] = (cells[idx] || "").trim(); });
    out.push(row);
  }
  return out;
}

// ---------- MFN flaggningar ----------
async function fetchFlags() {
  const r = await fetch(MFN_FEED, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error("mfn HTTP " + r.status);
  const j = await r.json();
  return j.items || j.news || [];
}
function mergeFlags(map, items) {
  for (const it of items) {
    const title = (it.content && it.content.title) || it.title || it.header || "";
    if (!/flaggning|major shareholding/i.test(title)) continue;
    const im = title.match(/[Ff]laggningsmeddelande i\s+(.+?)\s*$/);
    let issuer = im ? im[1] : ((it.author && it.author.name) || "");
    if (!issuer || /finansinspektion/i.test(issuer)) continue;
    const html = (it.content && it.content.html) || (it.content && it.content.preamble) || "";
    const f = parseFlagHtml(html);
    // Emittent från HTML är mer exakt (utan "Finansinspektionen: i ...")
    if (f.issuer) issuer = f.issuer;
    const co = getCo(map, issuer); if (!co) continue;
    if (f.totalShares && !co._totalShares) co._totalShares = f.totalShares;
    co._flags.push({
      holder: f.holder,
      threshold: f.threshold,
      sharePct: f.sharePct,
      reason: f.reason,
      direction: f.direction,
      flag_date: f.date || dateIn(it.publish_date || it.date),
      url: it.url,
      label: /korrigering/i.test(title) ? "Korrigering" : "Flaggning",
    });
  }
}

// FI:s flaggningar kommer som en HTML-tabell. Vi drar ut de rena fälten.
function parseFlagHtml(html) {
  // Bygg upp "etikett → värde" ur <td>Etikett</td><td>Värde</td>
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const cells = [];
  let m;
  while ((m = cellRe.exec(html))) cells.push(m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());

  const findAfter = (labelRe) => {
    for (let i = 0; i < cells.length - 1; i++) if (labelRe.test(cells[i])) return cells[i + 1];
    return null;
  };
  const issuerRaw = findAfter(/^Emittent$/i);              // "556767-0541 Episurf Medical AB"
  const issuer = issuerRaw ? issuerRaw.replace(/^\s*\d{6}-\d{4}\s*/, "").trim() : null;
  const holder = findAfter(/^Innehavare$/i);
  const reason = findAfter(/Skäl för flaggning/i);         // t.ex. "Nyemission", "Förvärv"
  const date = (findAfter(/^Datum$/i) || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;

  // Andel efter transaktionen (aktier) — leta procent nära "Andel"/"aktier"
  const pctVals = cells.map(c => {
    const mm = c.match(/^(\d{1,3}(?:[.,]\d+)?)\s*%$/);
    return mm ? Number(mm[1].replace(",", ".")) : null;
  }).filter(v => v != null);
  const sharePct = pctVals.length ? Math.max(...pctVals) : null; // störst = totalt innehav efter

  // Tröskel: gränsvärdet som passerades (5/10/15/20/25/30...)
  const thWord = findAfter(/Gränsvärde för antal aktier/i) || "";
  const thNum = Number((thWord.match(/(\d{1,2})/) || [])[1]);
  const ths = [5, 10, 15, 20, 25, 30, 50, 66, 90];
  let threshold = null;
  if (thNum) { const n = ths.find(x => Math.abs(x - thNum) <= 1); if (n) threshold = n + "%"; }

  const direction = /avyttr|minsk|sålt|sälj|salj|överlåt|utlån/i.test(reason || "") ? "ner" : "upp";

  // Räkna ut bolagets TOTALA antal aktier ur flaggningen.
  // Flaggningen anger innehavarens antal aktier OCH deras andel i procent,
  // men de står i olika delar av tabellen ("Antal" resp "Andel").
  // total = antal / (andel/100). Ger börsvärde när vi har kursen — gratis.
  let totalShares = null;
  {
    // Samla alla "- aktier"-rader och deras värden
    const counts = [], pcts = [];
    for (let i = 0; i < cells.length - 1; i++) {
      if (!/^\s*-?\s*aktier\s*$/i.test(cells[i])) continue;
      const raw = String(cells[i + 1]).trim();
      const pm = raw.match(/^(\d{1,3}(?:[.,]\d+)?)\s*%$/);
      if (pm) {
        pcts.push(Number(pm[1].replace(",", ".")));
      } else {
        const n = Number(raw.replace(/[\s\u00a0]/g, "").replace(/,/g, ""));
        if (isFinite(n) && n > 0) counts.push(n);
      }
    }
    // Para ihop första antalet med första procenten
    if (counts.length && pcts.length) {
      const cnt = counts[0], pct = pcts[0];
      if (pct > 0.01 && pct <= 100) {
        const est = Math.round(cnt / (pct / 100));
        if (est > 1e5 && est < 1e11) totalShares = est;
      }
    }
  }

  return { issuer, holder, reason, date, sharePct, threshold, direction, totalShares };
}

// ---------- CSV-parser (semikolon, citattecken) ----------
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const delim = (lines[0].split(";").length > lines[0].split(",").length) ? ";" : ",";
  const headers = splitLine(lines[0], delim).map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cells[idx] == null ? "" : cells[idx]).trim(); });
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
    // Teckning i emission väger hälften — det är ofta att delta i en nyemission, inte en marknadsköp.
    if (/teckn/i.test(x.tx_type)) { netMSEK += x.amount_sek / 2e6; buyers.add(x.person); }
    else if (/förvärv|forvarv|köp/i.test(x.tx_type)) { netMSEK += x.amount_sek / 1e6; buyers.add(x.person); }
    else if (/avyttr|sälj|salj|avytt/i.test(x.tx_type)) { netMSEK -= x.amount_sek / 1e6; sellers.add(x.person); }
  }
  const insider = clamp(Math.max(0, netMSEK) * 4 + buyers.size * 6 - sellers.size * 5, 0, 100);

  const recentFlags = co._flags.filter(f => !f.flag_date || now - Date.parse(f.flag_date) < d120);
  const flags = clamp(recentFlags.reduce((s, f) => {
    const w = f.threshold === "15%" ? 45 : f.threshold === "10%" ? 35 : f.threshold === "5%" ? 20 : 15;
    return s + (f.direction === "ner" ? -w : w);
  }, 0), 0, 100);

  let shortSig = 0;
  const sorted = [...co._shorts].filter(s => s.position_date).sort((a, b) => a.position_date.localeCompare(b.position_date));
  if (sorted.length >= 2) shortSig = clamp(-(sorted[sorted.length - 1].position_pct - sorted[0].position_pct) * 18, 0, 100);

  const bv = clamp(co._bv.reduce((s, e) => s + (/bidco|spv|newco/i.test(e.note || "") ? 50 : 15), 0), 0, 100);

  const composite = Math.round(insider * 0.3 + flags * 0.3 + shortSig * 0.2 + bv * 0.2);
  return {
    ticker: co.ticker, symbol: co.symbol || null, name: co.name, list: co.list, priceSEK: co.priceSEK, mcapMSEK: co.mcapMSEK, isin: co._isin || null, _totalShares: co._totalShares || null,
    score: { composite, tier: tier(composite), parts: { insider: Math.round(insider), flags: Math.round(flags), shortSig: Math.round(shortSig), bv: Math.round(bv) } },
    detail: {
      insider: recentIns.slice(0, 8),
      flags: recentFlags,
      shorts: sorted.slice(-10).reverse(),
      bolagsverket: co._bv,
    },
  };
}

// ---------- berikning: börsvärde & kurs ----------
// Läser fundamentals-tabellen (fylls av /api/fundamentals) och sätter
// mcapMSEK + priceSEK på bolagen. Feltolerant: saknas databas eller
// tabell fortsätter appen precis som förut.
async function enrichWithFundamentals(companies) {
  const conn = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
  if (conn) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(conn);

    // 1) BÖRSDATA först — bäst täckning, matchar på ISIN (exakt nyckel).
    try {
      const bd = await sql`
        SELECT isin, lower(name) AS lname, ticker, price_sek, market_cap_msek
        FROM borsdata_instruments`;
      const byIsin = new Map(), byName = new Map();
      for (const r of bd) {
        if (r.isin) byIsin.set(r.isin, r);
        if (r.lname) byName.set(r.lname, r);
      }
      for (const c of companies) {
        const hit = (c.isin && byIsin.get(c.isin)) || byName.get((c.name || "").toLowerCase());
        if (!hit) continue;
        if (hit.ticker && !c.symbol) c.symbol = String(hit.ticker).trim();
        if (hit.market_cap_msek != null) c.mcapMSEK = Number(hit.market_cap_msek);
        if (hit.price_sek != null) c.priceSEK = Number(hit.price_sek);
      }
    } catch { /* tabellen finns kanske inte än */ }

    // 1b) companies-tabellen — riktiga tickers via ISIN
    try {
      const rows = await sql`SELECT isin, ticker FROM companies WHERE isin IS NOT NULL AND ticker IS NOT NULL`;
      const t = new Map(rows.map(r => [r.isin, String(r.ticker).trim()]));
      for (const c of companies) if (!c.symbol && c.isin && t.get(c.isin)) c.symbol = t.get(c.isin);
    } catch { /* tabellen finns kanske inte */ }

    // 2) Yahoo-tabellen som komplement för det Börsdata missar
    try {
      const rows = await sql`SELECT ticker, market_cap_msek, price_sek FROM fundamentals`;
      const map = new Map(rows.map(r => [r.ticker, r]));
      for (const c of companies) {
        const f = map.get(c.ticker);
        if (!f) continue;
        if (c.mcapMSEK == null && f.market_cap_msek != null) c.mcapMSEK = Number(f.market_cap_msek);
        if (c.priceSEK == null && f.price_sek != null) c.priceSEK = Number(f.price_sek);
      }
    } catch { /* strunta */ }
  }

  // 3) Sista utväg: räkna ut från kurs × antal aktier (ur flaggningsdatan)
  for (const c of companies) {
    if (c.mcapMSEK == null && c.priceSEK != null && c._totalShares) {
      const est = Math.round((c.priceSEK * c._totalShares) / 1e6);
      if (est > 0 && est < 1e7) { c.mcapMSEK = est; c.mcapEstimated = true; }
    }
    delete c._totalShares;
  }
}
