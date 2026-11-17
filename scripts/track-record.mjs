// scripts/track-record.mjs
//
// Två lägen, körs från GitHub Actions (.github/workflows/track-record.yml):
//
//   node scripts/track-record.mjs anchor
//     Verifierar kedjan och lägger till en rad i track-record/ANCHORS.md med
//     dagens topp-hash. Workflowen committar filen till det publika repot —
//     git-historiken blir en extern, oberoende tidsstämpel som vi inte kan
//     ändra i efterhand utan att det syns.
//
//   node scripts/track-record.mjs reseal "anledning"
//     Försegla om kedjan med aktuell hashfunktion (bara vid formatbyte).
//     Händelsen loggas i track_record_reseals och i ANCHORS.md.

import fs from 'node:fs';
import path from 'node:path';
import { verifyChain, resealChain } from '../lib/trackRecordLog.js';

const FILE = path.join('track-record', 'ANCHORS.md');
const HEADER = `# BudRadar — förankring av track record

Varje rad nedan skrivs automatiskt en gång per dygn av GitHub Actions.
\`head\` är hashen för den senaste raden i BudRadars hash-kedjade flagglogg.
Eftersom varje rad i loggen innehåller föregående rads hash kan ingen flagga
ändras, tas bort eller backdateras utan att alla senare hashar ändras — och
då stämmer de inte längre med raderna här, som git har tidsstämplat.

Verifiera själv: https://budradar.vercel.app/api/system?action=verify

| Tid (UTC) | Rader | Topp-hash | Status |
|---|---|---|---|
`;

function append(line) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, HEADER);
  fs.appendFileSync(FILE, line + '\n');
}

const [mode, ...rest] = process.argv.slice(2);
const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

if (mode === 'reseal') {
  const reason = rest.join(' ').trim();
  const before = await verifyChain();
  const r = await resealChain(reason);
  console.log(`Omförseglat ${r.rows} rader. Gammal topp ${r.oldHead}, ny topp ${r.newHead}.`);
  console.log(`Före: ${before.valid ? 'giltig' : 'bruten vid id ' + before.brokenAtId}`);
  append(`| ${now} | ${r.rows} | \`${r.newHead}\` | Omförseglad: ${reason.replace(/\|/g, '/')} |`);
} else if (mode === 'anchor') {
  const v = await verifyChain();
  console.log(JSON.stringify({ valid: v.valid, totalRows: v.totalRows, head: v.head, brokenAtId: v.brokenAtId }, null, 2));
  if (!v.valid) {
    append(`| ${now} | — | — | **Bruten vid rad ${v.brokenAtId}** |`);
    process.exitCode = 1;
  } else {
    append(`| ${now} | ${v.totalRows} | \`${v.head}\` | Giltig |`);
  }
} else {
  console.error('Använd: node scripts/track-record.mjs anchor | reseal "anledning"');
  process.exit(2);
}
