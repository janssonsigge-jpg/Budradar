// scripts/takeover-rank.mjs
// Skriver data/takeover.json: dagens uppköpslista + backtesten som bevis.
// Filen serveras statiskt av Vercel på /data/takeover.json.
import { writeFileSync } from "node:fs";
import { rankAt, runBacktest, BID_KEYS } from "./takeover-backtest.mjs";

const today = new Date().toISOString().slice(0, 10);
const all = rankAt(today);
const recentCut = Date.now() - 400 * 864e5;
const list = all
  .filter((r) => !BID_KEYS.has(r.key))                       // redan budade
  .filter((r) => r.score > 0)
  .slice(0, 40)
  .map((r, i) => ({
    rank: i + 1, name: r.name.replace(/\s+\(publ\)/i, "").trim(), score: r.score,
    why: r.why.map((w) => w.replace(/,\s*(acting|som|as|in its).*?(har flaggat|$)/i, " $2").replace(/\s+/g, " ").trim()),
    top: r.f.top ? { name: short(r.f.top.name), pct: r.f.top.pct } : null,
    pe: r.f.pe ? { name: short(r.f.pe.name), pct: r.f.pe.pct } : null,
    buyers: r.f.buyers, accum: r.f.accum,
  }));
function short(n) { return String(n || "").split(/,| som | acting /i)[0].replace(/\s+/g, " ").trim(); }

const bt = runBacktest(30);
const out = {
  generated: new Date().toISOString(),
  universe: all.length,
  method: "Poäng 0–100 från FI:s flaggningar och insynsregister: en aktiv storägare på 10–50 %, private equity bland ägarna, ägare som ökat över 10 % senaste året, insiders som köpt och många flaggningar senaste halvåret. Bara publicerade data används.",
  backtest: { ...bt, rows: bt.rows.map(({ why, ...x }) => x) },
  list,
};
writeFileSync("data/takeover.json", JSON.stringify(out, null, 1));
console.log(`Skrev data/takeover.json: ${list.length} kandidater av ${all.length} bolag. Backtest: ${bt.top10}/${bt.tested} i topp 10 %.`);
