// scripts/bolagsverket-scan.mjs
//
// Körs veckovis via GitHub Actions (.github/workflows/bolagsverket-weekly.yml),
// INTE som en Vercel serverless-funktion — filen är för stor (50-500 MB) för
// Hobby-planens tids- och minnesgränser.
//
// VAD DEN GÖR:
//   1. Laddar ner bolagsverket_bulkfil.zip
//   2. Packar upp och läser textfilen radvis (inte allt i minnet samtidigt)
//   3. Jämför org.nr mot förra veckans org.nr-lista (sparad som komprimerad
//      textfil i Vercel Blob — INTE i Postgres, se not nedan)
//   4. FÖRSTA körningen: bara bootstrap — sparar alla org.nr, flaggar INGET
//      (annars skulle miljontals befintliga bolag räknas som "nya")
//   5. Efterföljande körningar: nya org.nr som är aktiebolag, aktiva,
//      och har en kort/generisk verksamhetsbeskrivning → kandidater
//   6. Kandidater vars adress matchar known_advisors → flaggas i
//      track_record_log (samma hash-kedja + GitHub-tidsstämpel som allt annat)
//
// VARFÖR BLOB OCH INTE POSTGRES FÖR ORG.NR-LISTAN:
//   Ett första försök lagrade alla sedda org.nr i en Postgres-tabell och
//   sprängde Neons gratisnivås 512 MB-gräns efter ~1,2 miljoner rader.
//   Org.nr-listan (miljontals enkla strängar) hör hemma i billig fillagring,
//   inte i en relationsdatabas — Postgres ska bara innehålla den faktiska
//   värdefulla datan (flaggor, known_advisors).
//
// KÖRS LOKALT FÖR TEST:
//   DATABASE_URL=... node scripts/bolagsverket-scan.mjs
//
// VIKTIGT ATT VERIFIERA EFTER FÖRSTA KÖRNINGEN:
//   Skriptet loggar en fördelning av alla organisationsform-koder den ser
//   (orgform_counts i bolagsverket_scan_runs). Använd den för att bekräfta
//   att AKTIEBOLAG_KODER nedan faktiskt matchar rätt kod för aktiebolag —
//   jag har gissat baserat på mönstret i exempeldatan (S-ORGFO=stiftelse,
//   I-ORGFO=ideell förening), men Bolagsverkets fullständiga kodlista har
//   jag inte kunnat verifiera. Justera AKTIEBOLAG_KODER om loggen visar
//   att gissningen är fel.

import { neon } from '@neondatabase/serverless';
import { put, head } from '@vercel/blob';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
if (!CONN) {
  console.error('DATABASE_URL saknas.');
  process.exit(1);
}
const sql = neon(CONN, { fullResults: true });

const BULK_URL = 'https://vardefulla-datamangder.bolagsverket.se/bolagsverket/bolagsverket_bulkfil.zip';
const UA = 'BudRadar/0.2 (+offentlig data)';

// GISSNING — verifiera mot orgform_counts efter första körningen, se kommentar ovan
const AKTIEBOLAG_KODER = ['AB-ORGFO'];

// Mönster som är typiska för skalbolag (bidco/holdingbolag) i verksamhetsbeskrivning
const HOLDING_PATTERN = /^$|förvalta|holdingverksamhet|äga och förvalta|kapitalförvaltning|inneha aktier|bedriva handel med och förvaltning av aktier/i;
const MAX_DESCRIPTION_LENGTH = 80; // korta/tomma beskrivningar är typiska för skalbolag

function todaysRunId() {
  const d = new Date();
  return `bv-weekly-${d.toISOString().slice(0, 10)}`;
}

const SNAPSHOT_BLOB_PATH = 'bolagsverket/seen-org-numbers.txt.gz';

// Hämta förra veckans org.nr-lista från Blob. Returnerar tom Set om ingen finns än (bootstrap).
async function loadPreviousSnapshot() {
  try {
    const info = await head(SNAPSHOT_BLOB_PATH);
    console.log(`Hittade tidigare snapshot: ${(info.size / 1e6).toFixed(1)} MB, uppladdad ${info.uploadedAt}`);
    const res = await fetch(info.url);
    const gz = Buffer.from(await res.arrayBuffer());
    const text = zlib.gunzipSync(gz).toString('utf8');
    const set = new Set(text.split('\n').filter(Boolean));
    console.log(`${set.size} kända org.nr sedan förra körningen.`);
    return set;
  } catch (err) {
    console.log('Ingen tidigare snapshot hittad — detta är bootstrap-körningen.');
    return new Set();
  }
}

// Ladda upp hela den aktuella org.nr-listan (komprimerad) som ny snapshot för nästa körning
async function saveSnapshot(orgNrSet) {
  const text = Array.from(orgNrSet).join('\n');
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
  console.log(`Laddar upp ny snapshot: ${orgNrSet.size} org.nr, ${(gz.length / 1e6).toFixed(1)} MB komprimerat`);
  await put(SNAPSHOT_BLOB_PATH, gz, { access: 'public', addRandomSuffix: false, allowOverwrite: true });
}

// ---------- Nedladdning + uppackning via CLI (robust, hanterar alla zip-varianter) ----------
const WORK_DIR = '/tmp/bv-scan';

async function downloadAndExtract() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const zipPath = path.join(WORK_DIR, 'bulkfil.zip');
  console.log('Laddar ner bulkfil...');
  const res = await fetch(BULK_URL, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error('Nedladdning misslyckades: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, buf);
  console.log(`Nedladdad: ${(buf.length / 1e6).toFixed(1)} MB`);

  console.log('Packar upp (unzip CLI)...');
  execSync(`unzip -o "${zipPath}" -d "${WORK_DIR}"`, { stdio: 'inherit' });

  // Hitta den uppackade text/csv-filen (ta första .txt eller .csv som inte är zip:en själv)
  const files = fs.readdirSync(WORK_DIR).filter((f) => /\.(txt|csv)$/i.test(f));
  if (files.length === 0) throw new Error('Ingen .txt/.csv-fil hittades efter uppackning');
  const extractedPath = path.join(WORK_DIR, files[0]);
  console.log(`Uppackad fil: ${files[0]} (${(fs.statSync(extractedPath).size / 1e6).toFixed(1)} MB)`);
  return extractedPath;
}

// ---------- CSV-radparser (semikolon, citattecken) ----------
function splitLine(line) {
  const res = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; continue; }
    if (c === ';' && !q) { res.push(cur); cur = ''; continue; }
    cur += c;
  }
  res.push(cur);
  return res;
}

function clean(str) {
  if (!str) return str;
  // Ta bort null-bytes och andra osynliga kontrolltecken som Postgres text-kolumner
  // inte accepterar. Källdatan innehåller sporadiskt sådana skräptecken.
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function parseRow(cells) {
  // Kolumnordning enligt bekräftad header:
  // organisationsidentitet;namnskyddslopnummer;registreringsland;organisationsnamn;
  // organisationsform;avregistreringsdatum;avregistreringsorsak;
  // pagandeAvvecklingsEllerOmstruktureringsforfarande;registreringsdatum;
  // verksamhetsbeskrivning;postadress
  const orgIdRaw = cells[0] || '';
  const org_nr = clean(orgIdRaw.split('$')[0].trim());
  if (!org_nr) return null;

  const nameRaw = cells[3] || '';
  const name = clean(nameRaw.split('$')[0].trim());

  const orgform = clean((cells[4] || '').trim());
  const avregistreringsdatum = (cells[5] || '').trim();
  const registered_at = (cells[8] || '').trim() || null;
  const description = clean((cells[9] || '').trim());

  const addrRaw = cells[10] || '';
  const addrParts = addrRaw.split('$');
  const address = clean([addrParts[0], addrParts[2], addrParts[3]].filter(Boolean).join(', '));

  return {
    org_nr,
    name,
    orgform,
    active: !avregistreringsdatum,
    registered_at,
    description,
    address,
  };
}

// ---------- Huvudflöde ----------
async function main() {
  const runId = todaysRunId();
  console.log(`Startar körning ${runId}`);

  const existing = await sql`SELECT status FROM bolagsverket_scan_runs WHERE run_id = ${runId}`;
  if (existing.rows.length > 0 && existing.rows[0].status === 'success') {
    console.log('Redan körd idag, avbryter.');
    return;
  }
  await sql`
    INSERT INTO bolagsverket_scan_runs (run_id, status)
    VALUES (${runId}, 'running')
    ON CONFLICT (run_id) DO UPDATE SET started_at = now(), status = 'running'
  `;

  try {
    const extractedPath = await downloadAndExtract();

    const fileStream = fs.createReadStream(extractedPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let header = null;

    // Ladda förra veckans org.nr-lista från Blob (tom Set = bootstrap-körning)
    const seenSet = await loadPreviousSnapshot();
    const isBootstrap = seenSet.size === 0;
    if (isBootstrap) console.log('FÖRSTA KÖRNINGEN — bootstrap-läge, inga flaggor skapas denna gång.');
    const startSize = seenSet.size;

    // Hämta known_advisors för adressmatchning
    const advisorsResult = await sql`SELECT name, known_address, weight FROM known_advisors WHERE known_address IS NOT NULL`;
    const advisors = advisorsResult.rows;

    let totalRows = 0;
    let newOrgs = 0;
    let candidates = 0;
    let flagged = 0;
    const orgformCounts = {};

    for await (const line of rl) {
      if (header === null) { header = line; console.log('Header:', header); continue; }
      if (!line.trim()) continue;
      totalRows++;

      const cells = splitLine(line);
      const row = parseRow(cells);
      if (!row) continue;

      orgformCounts[row.orgform] = (orgformCounts[row.orgform] || 0) + 1;

      if (totalRows % 200000 === 0) {
        console.log(`... ${totalRows} rader bearbetade, ${newOrgs} nya org.nr hittills`);
      }

      if (seenSet.has(row.org_nr)) continue; // känt sedan tidigare
      newOrgs++;
      seenSet.add(row.org_nr);

      if (isBootstrap) continue; // bootstrap: bara spara, inte utvärdera

      // ---- Kandidatfilter ----
      if (!AKTIEBOLAG_KODER.includes(row.orgform)) continue;
      if (!row.active) continue;
      const shortOrHoldingDesc =
        row.description.length <= MAX_DESCRIPTION_LENGTH || HOLDING_PATTERN.test(row.description);
      if (!shortOrHoldingDesc) continue;
      candidates++;

      // ---- Adressmatchning mot known_advisors ----
      let matchedAdvisor = null;
      for (const advisor of advisors) {
        if (row.address && advisor.known_address && row.address.toLowerCase().includes(advisor.known_address.toLowerCase())) {
          matchedAdvisor = advisor;
          break;
        }
      }
      if (!matchedAdvisor) continue; // ingen adressmatch → för svagt signal ännu, hoppa över

      // ---- Flagga i track_record_log (hash-kedja + GitHub-tidsstämpel) ----
      const score = 40 + 30 * Number(matchedAdvisor.weight); // enkel poängmodell, samma anda som lib/scoring.js
      const flagPayload = {
        company_name: row.name,
        org_nr: row.org_nr,
        ticker: null,
        flag_reason: `bolagsverket_bulk_registrering+advokatadress_${matchedAdvisor.name.replace(/\s+/g, '_')}`,
        score,
        signal_snapshot: {
          registered_at: row.registered_at,
          description: row.description,
          address: row.address,
          matchedAdvisor: matchedAdvisor.name,
        },
      };

      // Enkel direkt-insert (undviker att importera lib/trackRecordLog.js's
      // GitHub-commit-logik per rad här — batch:a GitHub-commits separat om
      // volymen blir hög. MVP: en rad i taget, samma hash-kedjeprincip.)
      await insertFlagWithHashChain(flagPayload);
      flagged++;
      console.log(`FLAGGAD: ${row.name} (${row.org_nr}) — ${matchedAdvisor.name}, score ${score}`);
    }

    await saveSnapshot(seenSet);
    console.log(`Snapshot sparad: ${startSize} -> ${seenSet.size} org.nr (${newOrgs} nya).`);

    await sql`
      UPDATE bolagsverket_scan_runs
      SET status = 'success', finished_at = now(),
          total_rows = ${totalRows}, new_orgs = ${newOrgs},
          candidates = ${candidates}, flagged = ${flagged},
          orgform_counts = ${JSON.stringify(orgformCounts)}
      WHERE run_id = ${runId}
    `;

    console.log(`Klart. ${totalRows} rader, ${newOrgs} nya org.nr, ${candidates} kandidater, ${flagged} flaggade.`);
    console.log('Orgform-fördelning (verifiera AKTIEBOLAG_KODER mot denna):', orgformCounts);
  } catch (err) {
    console.error('Körning misslyckades:', err);
    await sql`
      UPDATE bolagsverket_scan_runs
      SET status = 'failed', finished_at = now(), error = ${String(err.message || err)}
      WHERE run_id = ${runId}
    `;
    process.exit(1);
  }
}

async function insertFlagWithHashChain(payload) {
  const { rows } = await sql`SELECT row_hash FROM track_record_log ORDER BY id DESC LIMIT 1`;
  const prev_hash = rows.length > 0 ? rows[0].row_hash : 'genesis';
  const created_at = new Date().toISOString();
  const row_hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ ...payload, prev_hash, created_at }))
    .digest('hex');

  await sql`
    INSERT INTO track_record_log
      (company_name, org_nr, ticker, flag_reason, score, signal_snapshot, row_hash, prev_hash, created_at)
    VALUES
      (${payload.company_name}, ${payload.org_nr}, ${payload.ticker}, ${payload.flag_reason},
       ${payload.score}, ${JSON.stringify(payload.signal_snapshot)}, ${row_hash}, ${prev_hash}, ${created_at})
  `;
  // Not: GitHub-tidsstämpling (samma som lib/githubTimestamp.js) kan läggas till
  // här på samma sätt om ni vill ha extern tidsstämpel även för dessa flaggor.
}

main();
