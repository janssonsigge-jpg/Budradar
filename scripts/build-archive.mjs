// scripts/build-archive.mjs
// Engångs-/veckokörning: hämtar HELA historiken av
//   1) FI-flaggningar via MFN-arkivet (ca 14 000 st sedan 2015)
//   2) FI:s insynsregister, månad för månad sedan 2023
// och sparar kompakta, gzippade JSON-filer i data/. De används för att
// backtesta uppköpsmodellen mot budregistret utan framtidsdata.
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const UA = "BudRadar/0.1 (+offentlig data)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- flaggningar ----------
async function flagArchive() {
  const out = [];
  for (let off = 0; ; off += 200) {
    let j;
    for (let t = 0; t < 4; t++) {
      try {
        const r = await fetch(`https://mfn.se/all/a/fi-se.json?limit=200&offset=${off}`, { headers: { "user-agent": UA } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        j = await r.json(); break;
      } catch (e) { console.log("  retry", off, e.message); await sleep(2000 * (t + 1)); }
    }
    const items = (j && j.items) || [];
    if (!items.length) break;
    for (const it of items) {
      const c = it.content || {};
      const title = c.title || "";
      if (!/flaggning/i.test(title)) continue;
      const f = parseFlagHtml(c.html || "");
      const im = title.match(/[Ff]laggningsmeddelande i\s+(.+?)\s*$/);
      out.push({
        d: f.date || (c.publish_date || "").slice(0, 10),
        p: (c.publish_date || "").slice(0, 10),
        i: f.issuer || (im ? im[1] : null),
        o: f.orgnr,
        h: f.holder, s: f.sharePct, t: f.threshold, r: f.reason, dir: f.direction,
        k: /korrigering/i.test(title) ? 1 : 0,
      });
    }
    if (off % 2000 === 0) console.log(`  flaggningar: offset ${off}, ${out.length} rader, senast ${out[out.length - 1]?.p}`);
    await sleep(250);
  }
  return out;
}

// ---------- insynshandel ----------
const INSIDER = "https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search?SearchFunctionType=Insyn&button=export&Page=1";
async function insiderRange(from, to) {
  const url = `${INSIDER}&Transaktionsdatum.From=${from}&Transaktionsdatum.To=${to}`;
  let buf;
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/csv,*/*" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      buf = new Uint8Array(await r.arrayBuffer()); break;
    } catch (e) { console.log("  retry", from, e.message); await sleep(2000 * (t + 1)); }
  }
  if (!buf) return [];
  let enc = "utf-16le";
  if (buf[0] === 0xFE && buf[1] === 0xFF) enc = "utf-16be";
  else if (buf[0] === 0xEF && buf[1] === 0xBB) enc = "utf-8";
  return parseCsv(new TextDecoder(enc).decode(buf));
}
const iso = (d) => d.toISOString().slice(0, 10);
async function insiderSpan(from, to, depth = 0) {
  const rows = await insiderRange(iso(from), iso(to));
  await sleep(300);
  // Exporten verkar ha ett tak — dela intervallet om vi slår i det.
  if (rows.length >= 990 && to - from > 864e5) {
    const mid = new Date(from.getTime() + Math.floor((to - from) / 864e5 / 2) * 864e5);
    const a = await insiderSpan(from, mid, depth + 1);
    const b = await insiderSpan(new Date(mid.getTime() + 864e5), to, depth + 1);
    return a.concat(b);
  }
  return rows;
}
async function insiderArchive(startYear) {
  const out = [];
  const now = new Date();
  for (let d = new Date(Date.UTC(startYear, 0, 1)); d < now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const rows = await insiderSpan(d, end);
    for (const x of rows) {
      out.push({
        d: (String(x["Transaktionsdatum"] || "").match(/\d{4}-\d{2}-\d{2}/) || [null])[0],
        p: (String(x["Publiceringsdatum"] || "").match(/\d{4}-\d{2}-\d{2}/) || [null])[0],
        i: x["Emittent"] || null, isin: x["ISIN"] || null,
        who: x["Person i ledande ställning"] || null, role: x["Befattning"] || null,
        k: x["Karaktär"] || null, v: x["Volym"] || null, px: x["Pris"] || null, cur: x["Valuta"] || null,
      });
    }
    console.log(`  insyn ${iso(d).slice(0, 7)}: ${rows.length} rader (totalt ${out.length})`);
  }
  return out;
}

function save(name, rows) {
  mkdirSync("data", { recursive: true });
  writeFileSync(`data/${name}.json.gz`, zlib.gzipSync(JSON.stringify(rows)));
  console.log(`Sparade data/${name}.json.gz: ${rows.length} rader`);
}

const what = process.argv[2] || "all";
if (what === "all" || what === "flags") save("flag-archive", await flagArchive());
if (what === "all" || what === "insider") save("insider-archive", await insiderArchive(Number(process.env.INSIDER_FROM || 2023)));

// ---------- tolkning (kopierad från api/companies.js, plus org.nr) ----------
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

  const orgnr = issuerRaw ? (issuerRaw.match(/\d{6}-\d{4}/) || [null])[0] : null;
  return { issuer, orgnr, holder, reason, date, sharePct, threshold, direction, totalShares };
}

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

