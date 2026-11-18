// scripts/takeover-backtest.mjs
// Uppköpsmodell v1: rankar alla bolag med ägarhistorik efter hur "uppköpbara"
// de ser ut, och testar mot budregistret UTAN framtidsdata:
// för varje bud räknas läget ut som det såg ut N dagar före budet, bara med
// flaggningar/insynsaffärer som var PUBLICERADE före den dagen.
//
//   node scripts/takeover-backtest.mjs [dagarFöre=30]
import zlib from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { REGISTRY } from "../api/_registry-data.js";

const load = (f) => existsSync(f) ? JSON.parse(zlib.gunzipSync(readFileSync(f)).toString()) : [];
const FLAGS = load("data/flag-archive.json.gz").filter((f) => f.i && f.p);
const INS = load("data/insider-archive.json.gz").filter((x) => x.i && (x.p || x.d));

export const norm = (s) => String(s || "").toLowerCase()
  .replace(/&amp;/g, "&").replace(/\(.*?\)/g, " ")
  .replace(/\b(aktiebolag|ab|asa|oyj|plc|publ|holding|holdings|group|ltd|inc|se|sweden)\b/g, " ")
  .replace(/[^a-z0-9åäöæøü&]+/g, " ").replace(/\s+/g, " ").trim();

// Private equity och andra typiska budgivare. Träff i ägarnamnet = budgivare redan i bolaget.
export const PE = /\b(eqt|nordic capital|kkr|triton|altor|adelis|summa equity|capman|ik partners|ik investment|bain capital|carlyle|cinven|advent|hg capital|hgcapital|apax|accent equity|verdane|valedo|fsn capital|litorina|segulah|polaris|axcel|procuritas|priveq|ratos|blackstone|permira|hellman|thoma bravo|vitruvian|hayfin|kkr|tpg|warburg|ardian|partners group|eurazeo|bridgepoint|pai partners|investcorp|silver lake)\b/i;
// OBS: listan får bara innehålla generiska budgivare. Namn hämtade från buden i registret
// (t.ex. köparens eget bolag) vore facit i förväg och gör backtesten ogiltig.
// Bolaget självt / förvaltare som sällan säger något om uppköp
const PASSIVE = /\b(blackrock|vanguard|norges bank|state street|jpmorgan|morgan stanley|goldman|ubs|citigroup|bank of america|swedbank robur|handelsbanken fonder|seb investment|seb fonder|nordea|amf|ap-fonden|alecta|lannebo|didner|spiltan|carnegie fonder|capital group|fidelity|dnb|danske|skandia|folksam|avanza|nordnet|länsförsäkringar|sebfonder|skandinaviska enskilda|svenska handelsbanken|swedbank|citibank|barclays|deutsche bank|bnp paribas|société générale|societe generale|credit suisse|hsbc|jp morgan)\b/i;

// Storbolag köps sällan upp. Samma lista som api/companies.js använder.
const LARGE = /^(abb|alfa laval|assa abloy|astrazeneca|atlas copco|autoliv|axfood|beijer ref|boliden|castellum|electrolux|elekta|epiroc|eqt|ericsson|telefonaktiebolaget lm ericsson|essity|evolution|fabege|fastighets balder|getinge|hennes & mauritz|svenska handelsbanken|hexagon|holmen|husqvarna|industrivärden|indutrade|investor|kinnevik|l e lundbergföretagen|lifco|nibe industrier|nordea bank|saab|sagax|sandvik|svenska cellulosa|skandinaviska enskilda banken|securitas|skanska|skf|ssab|swedbank|swedish orphan biovitrum|tele2|telia company|trelleborg|volvo|volvo car|wallenstam|wihlborgs fastigheter|addtech|aak|avanza bank|nordnet|sweco|thule|investment latour|lagercrantz|hexpol|loomis|mycronic|sectra|atrium ljungberg|catena|hufvudstaden|dometic|nolato|peab|ncc|jm|bravida|munters|alleima|embracer|billerud|sinch|camurus|storskogen|vitec software|bufab|beijer alma|intrum)$/;

const day = (s) => Date.parse(s);
function byIssuer(rows) {
  const m = new Map();
  for (const r of rows) { const k = norm(r.i); if (!k) continue; if (!m.has(k)) m.set(k, { name: r.i, rows: [] }); m.get(k).rows.push(r); }
  for (const v of m.values()) v.rows.sort((a, b) => a.p.localeCompare(b.p));
  return m;
}
const FL = byIssuer(FLAGS);
const IN = byIssuer(INS.map((x) => ({ ...x, p: x.p || x.d })));

// Läget för ett bolag ett visst datum
export function featuresAt(key, T) {
  const t = day(T);
  const fl = (FL.get(key)?.rows || []).filter((r) => day(r.p) <= t && t - day(r.p) < 4 * 365 * 864e5);
  const holders = new Map();
  for (const r of fl) {
    const h = norm(r.h); if (!h) continue;
    // Vid minskning anger flaggningen ofta andelen FÖRE affären. Ägaren ligger då under
    // gränsen som passerades, så vi sätter andelen strax under den.
    const thr = Number(String(r.t || "").replace("%", "")) || null;
    let pct = r.s ?? holders.get(h)?.pct ?? 5;
    if (r.dir === "ner") pct = thr ? Math.min(pct, thr - 0.1) : (r.s != null && r.s < 5 ? 0 : pct);
    holders.set(h, { name: r.h, pct: +pct.toFixed(1), p: r.p, dir: r.dir });
  }
  const live = [...holders.values()].filter((h) => h.pct >= 5 && h.pct <= 100);
  const active = live.filter((h) => !PASSIVE.test(h.name));
  const top = active.sort((a, b) => b.pct - a.pct)[0] || null;
  const pe = active.find((h) => PE.test(h.name)) || null;
  const yr = fl.filter((r) => t - day(r.p) < 365 * 864e5);
  const accum = yr.filter((r) => r.dir === "upp" && (r.s ?? 0) >= 10 && !PASSIVE.test(r.h || ""));
  const recent6m = fl.filter((r) => t - day(r.p) < 182 * 864e5).length;
  const ins = (IN.get(key)?.rows || []).filter((x) => day(x.p) <= t && t - day(x.p) < 120 * 864e5);
  const buyers = new Set(ins.filter((x) => /förvärv|köp/i.test(x.k || "")).map((x) => x.who));
  const sellers = new Set(ins.filter((x) => /avyttr|sälj/i.test(x.k || "")).map((x) => x.who));
  return {
    top: top ? { name: top.name, pct: top.pct } : null,
    pe: pe ? { name: pe.name, pct: pe.pct } : null,
    blocks: active.filter((h) => h.pct >= 10).length,
    accum: accum.length, accumWho: accum.length ? accum[accum.length - 1].h : null,
    recent6m, buyers: buyers.size, sellers: sellers.size,
    hasData: fl.length > 0,
  };
}

// Poäng 0–100. Medvetet enkel och förklarbar — 18 bud räcker inte för att "träna" något.
export function score(f) {
  let s = 0; const why = [];
  if (f.top) {
    if (f.top.pct >= 50) { s += 8; }                                   // redan kontrollägare: bud möjligt men ofta inte
    else if (f.top.pct >= 20) { s += 30; why.push(`${f.top.name} har flaggat ${f.top.pct} %`); }
    else if (f.top.pct >= 10) { s += 18; why.push(`${f.top.name} har flaggat ${f.top.pct} %`); }
  }
  if (f.pe) { s += 25; why.push(`private equity bland ägarna: ${f.pe.name}`); }
  if (f.accum) { s += Math.min(20, 10 * f.accum); why.push(`${f.accum} ägare har ökat över 10 % senaste året`); }
  if (f.recent6m >= 3) { s += 8; why.push(`${f.recent6m} flaggningar senaste halvåret`); }
  if (f.buyers) { s += Math.min(12, 4 * f.buyers); why.push(`${f.buyers} insiders har köpt`); }
  if (f.sellers > f.buyers + 1) s -= 6;
  return { score: Math.max(0, Math.min(100, s)), why };
}

export function rankAt(T) {
  const out = [];
  for (const [key, v] of FL) {
    const f = featuresAt(key, T);
    if (!f.hasData) continue;
    const last = v.rows.filter((r) => day(r.p) <= day(T)).pop();
    if (!last || day(T) - day(last.p) > 3 * 365 * 864e5) continue; // inte aktiv på 3 år = troligen avnoterad
    const sc = score(f);
    if (LARGE.test(key)) { sc.score = Math.max(0, sc.score - 25); sc.why.push("storbolag, köps sällan upp"); }
    out.push({ key, name: v.name, ...sc, f });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- backtest ----------
export function runBacktest(before = 30) {
  const rows = [];
  for (const b of REGISTRY) {
    const T = new Date(day(b.announced) - before * 864e5).toISOString().slice(0, 10);
    const ranking = rankAt(T);
    const tk = norm(b.target.replace(/\(.*\)/, ""));
    const idx = ranking.findIndex((r) => r.key === tk || r.key.startsWith(tk + " ") || tk.startsWith(r.key + " "));
    const hit = idx >= 0 ? ranking[idx] : null;
    rows.push({
      target: b.target, announced: b.announced, premium: b.premiumLastClose ?? null,
      rank: hit ? idx + 1 : null, of: ranking.length,
      topPct: hit ? Math.max(1, Math.round(((idx + 1) / ranking.length) * 100)) : null,
      score: hit ? hit.score : null, why: hit ? hit.why : [],
    });
  }
  const t = rows.filter((r) => r.rank);
  return {
    daysBefore: before, tested: t.length, total: rows.length,
    top10: t.filter((r) => r.topPct <= 10).length, top25: t.filter((r) => r.topPct <= 25).length,
    random10: +(t.length * 0.1).toFixed(1), random25: +(t.length * 0.25).toFixed(1),
    rows,
  };
}

// Mål i registret: redan budade bolag ska inte ligga kvar som "kandidater".
export const BID_KEYS = new Set(REGISTRY.map((b) => norm(b.target.replace(/\(.*\)/, ""))));

if (process.argv[1] && process.argv[1].endsWith("takeover-backtest.mjs")) {
  const r = runBacktest(Number(process.argv[2] || 30));
  console.log(`Flaggningar: ${FLAGS.length}, insynsrader: ${INS.length}\nLäge ${r.daysBefore} dagar före varje bud:\n`);
  for (const x of r.rows) console.log(`${x.target.padEnd(28)} ${x.announced}  ${x.rank ? `plats ${x.rank}/${x.of}  topp ${x.topPct}%  poäng ${x.score}  ${x.why.join("; ")}` : "ingen ägarhistorik"}`);
  console.log(`\nTestbara: ${r.tested}/${r.total}. I topp 10 %: ${r.top10} (slump: ${r.random10}). I topp 25 %: ${r.top25} (slump: ${r.random25}).`);
}
