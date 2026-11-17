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
//   6. Kandidater vars NAMN matchar ett EXPLICIT bidco-mönster (BidCo/HoldCo/
//      MidCo/TopCo/NewCo — medvetet valt namn) → flaggas direkt i
//      track_record_log. Kandidater med ett rått, obytt "Goldcup NNNN AB"-namn
//      läggs ALLTID i watchlist istället — ett sådant namn säger ingenting om
//      M&A-avsikt i sig (tusentals lagerbolag heter så varje år, oavsett syfte).
//   7. VARJE rad i bulkfilen (inte bara nya) jämförs mot watchlist. Om ett
//      bevakat bolag bytt namn bort från Goldcup-mönstret, eller flyttat
//      adress till en känd M&A-rådgivare, flaggas det — det är den starkaste
//      signalen av alla: skalbolaget har "aktiverats" för en affär.
//
// RÄTTELSE (2026-08-10): tidigare flaggades rått "Goldcup NNNN AB" direkt vid
// registrering (och fick t.o.m. HÖGRE score än ett explicit bidco-namn) —
// motsatsen till vad kommentarerna i koden alltid sagt att den skulle göra.
// Se `isExplicitBidcoName` / `isRawGoldcup`-uppdelningen nedan för fixen.
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

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import zlib from 'node:zlib';
import { sql } from '../lib/db.js';
import { appendFlag } from '../lib/trackRecordLog.js';

const BULK_URL = 'https://vardefulla-datamangder.bolagsverket.se/bolagsverket/bolagsverket_bulkfil.zip';
const UA = 'BudRadar/0.2 (+offentlig data)';

// GISSNING — verifiera mot orgform_counts efter första körningen, se kommentar ovan
const AKTIEBOLAG_KODER = ['AB-ORGFO'];

// Mönster som är typiska för skalbolag (bidco/holdingbolag) i verksamhetsbeskrivning
const HOLDING_PATTERN = /^$|förvalta|holdingverksamhet|äga och förvalta|kapitalförvaltning|inneha aktier|bedriva handel med och förvaltning av aktier/i;
const MAX_DESCRIPTION_LENGTH = 80; // korta/tomma beskrivningar är typiska för skalbolag

// Namnmönster typiska för bidco/skalbolag. STRIKT med flit — "Holding",
// "Ventures", "Capital" är för vanliga ord (många legitima bolag heter så)
// och gav falska träffar (t.ex. "LedgerBuddy" gick igenom på adress ensam
// innan detta ens fanns, men bredare ord hade ändå släppt igenom fel bolag).
// Kräver nu det faktiska bidco-mönstret: BidCo/HoldCo/MidCo/TopCo/NewCo,
// eller lagerbolagsnamnet "Goldcup NNNN AB".
const BIDCO_NAME_PATTERN = /\b(BidCo|Bidco|HoldCo|Holdco|MidCo|Midco|TopCo|Topco|NewCo|Newco)\b/i;
const GOLDCUP_PATTERN = /^Goldcup\s+\d+\s+AB$/i;

function todaysRunId() {
  const d = new Date();
  return `bv-weekly-${d.toISOString().slice(0, 10)}`;
}

// Sökväg hanteras av .github/workflows/bolagsverket-weekly.yml via actions/cache —
// workflown återställer denna fil från förra veckans cache innan skriptet körs,
// och sparar den uppdaterade filen till cachen igen efter att skriptet är klart.
// Ingen extern tjänst eller token behövs — GitHub Actions cache är gjord för
// exakt detta (spara data mellan schemalagda körningar).
const CACHE_PATH = path.join(process.cwd(), '.cache', 'bv-seen.txt.gz');

function loadPreviousSnapshot() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.log('Ingen tidigare snapshot hittad — detta är bootstrap-körningen.');
    return new Set();
  }
  const gz = fs.readFileSync(CACHE_PATH);
  const text = zlib.gunzipSync(gz).toString('utf8');
  const set = new Set(text.split('\n').filter(Boolean));
  console.log(`${set.size} kända org.nr sedan förra körningen.`);
  return set;
}

function saveSnapshot(orgNrSet) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  const text = Array.from(orgNrSet).join('\n');
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
  fs.writeFileSync(CACHE_PATH, gz);
  console.log(`Snapshot sparad lokalt: ${orgNrSet.size} org.nr, ${(gz.length / 1e6).toFixed(1)} MB komprimerat`);
}

// ---------- Nedladdning + uppackning via CLI (robust, hanterar alla zip-varianter) ----------
const WORK_DIR = '/tmp/bv-scan';

async function downloadAndExtract() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const zipPath = path.join(WORK_DIR, 'bulkfil.zip');
  // Bolagsverkets server bryter anslutningen från GitHubs servrar mitt i filen.
  // Därför hämtar Vercel filen i bitar (Range-anrop) och sparar dem i privat
  // Vercel Blob. Vi anropar speglingen tills alla bitar finns, och sätter sedan
  // ihop dem till zip-filen här.
  console.log('Laddar ner bulkfil via Vercel-spegling...');
  const MIRROR_URL = 'https://budradar.vercel.app/api/system?action=bv-mirror';
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN saknas');
  let status = null;
  for (let anrop = 1; anrop <= 60; anrop++) {
    status = null;
    try {
      const r = await fetch(MIRROR_URL, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const txt = await r.text();
      if (r.ok) status = JSON.parse(txt);
      console.log(`Spegling ${anrop}: HTTP ${r.status} ${status ? `${status.done}/${status.total} delar` : txt.slice(0, 200)}${status?.errors?.length ? ' — ' + status.errors.join('; ') : ''}`);
      if (status?.complete) break;
    } catch (err) {
      console.log(`Spegling ${anrop}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, status && !status.errors?.length ? 2000 : 30000));
  }
  if (!status?.complete) throw new Error('Speglingen av bulkfilen blev inte klar');

  const { get } = await import('@vercel/blob');
  const fd = fs.openSync(zipPath, 'w');
  for (const part of status.parts) {
    const g = await get(part, { access: 'private', token, useCache: false });
    if (!g || g.statusCode !== 200) throw new Error('Kunde inte läsa ' + part);
    fs.writeSync(fd, Buffer.from(await new Response(g.stream).arrayBuffer()));
  }
  fs.closeSync(fd);
  if (fs.statSync(zipPath).size !== status.size) throw new Error(`Fel storlek på ihopsatt fil: ${fs.statSync(zipPath).size} != ${status.size}`);
  execSync(`unzip -tq "${zipPath}"`, { stdio: 'inherit' }); // kontrollerar att zip:en är komplett
  console.log(`Nedladdad: ${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB`);

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

// ---------- Watchlist: poängsätt förändringar mot sparad baseline ----------
// Tröskel 40 för att flaggas — se sql/006_watchlist.sql för tabellen.
const WATCHLIST_FLAG_THRESHOLD = 40;

function scoreWatchlistChange(entry, row, advisors) {
  let score = 0;
  const changes = [];
  let matchedAdvisor = null;

  const wasGoldcup = GOLDCUP_PATTERN.test(entry.original_name);
  const stillGoldcup = GOLDCUP_PATTERN.test(row.name);
  if (wasGoldcup && !stillGoldcup && row.name !== entry.original_name) {
    score += 40;
    changes.push('namnbyte_fran_goldcup');
  }

  if (row.address && row.address !== entry.original_address) {
    for (const advisor of advisors) {
      if (advisor.known_address && row.address.toLowerCase().includes(advisor.known_address.toLowerCase())) {
        matchedAdvisor = advisor;
        break;
      }
    }
    if (matchedAdvisor) {
      score += 35 * Number(matchedAdvisor.weight);
      changes.push(`adressbyte_advokat_${matchedAdvisor.name.replace(/\s+/g, '_')}`);
    } else {
      score += 5; // svag signal — adress ändrad, men inte till en känd rådgivare
      changes.push('adressbyte_okand');
    }
  }

  const wasHoldingLike = HOLDING_PATTERN.test(entry.original_description || '');
  const nowHoldingLike = HOLDING_PATTERN.test(row.description || '');
  if (!wasHoldingLike && nowHoldingLike) {
    score += 10;
    changes.push('beskrivning_andrad_holding');
  }

  return { score, changes, matchedAdvisor };
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

    // Hämta pending watchlist-poster — kollas mot VARJE rad i bulkfilen
    // (inte bara nya org.nr), eftersom bevakade bolag registrerades tidigare veckor.
    const watchlistResult = await sql`
      SELECT org_nr, original_name, original_address, original_description
      FROM watchlist WHERE status = 'pending'
    `;
    const watchlistMap = new Map(watchlistResult.rows.map((w) => [w.org_nr, w]));
    console.log(`${watchlistMap.size} bolag under bevakning (watchlist).`);

    let totalRows = 0;
    let newOrgs = 0;
    let candidates = 0;
    let flagged = 0;
    let watchlistAdded = 0;
    let watchlistFlagged = 0;
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

      // ---- Watchlist-kontroll: körs för VARJE rad, inte bara nya org.nr,
      // eftersom bevakade bolag registrerades tidigare veckor.
      if (!isBootstrap && watchlistMap.has(row.org_nr)) {
        const entry = watchlistMap.get(row.org_nr);
        const { score: wScore, changes, matchedAdvisor } = scoreWatchlistChange(entry, row, advisors);

        if (wScore >= WATCHLIST_FLAG_THRESHOLD) {
          const logEntry = await appendFlag({
            company_name: row.name,
            org_nr: row.org_nr,
            ticker: null,
            flag_reason: `watchlist_${changes.join('+')}`,
            score: wScore,
            signal_snapshot: {
              original_name: entry.original_name,
              new_name: row.name,
              original_address: entry.original_address,
              new_address: row.address,
              new_description: row.description,
              registered_at: row.registered_at,
              matchedAdvisor: matchedAdvisor ? matchedAdvisor.name : null,
            },
          });
          await sql`
            UPDATE watchlist
            SET status = 'flagged', score = ${wScore}, last_checked_at = now(),
                flagged_track_record_id = ${logEntry.id}
            WHERE org_nr = ${row.org_nr}
          `;
          watchlistFlagged++;
          console.log(`WATCHLIST-FLAGG: ${entry.original_name} → ${row.name} (${row.org_nr}), score ${wScore}`);
        } else {
          await sql`UPDATE watchlist SET last_checked_at = now() WHERE org_nr = ${row.org_nr}`;
        }
        watchlistMap.delete(row.org_nr); // klar för denna körning
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

      // ---- RÄTTAD LOGIK ----
      // Ett EXPLICIT bidco-namn (BidCo/HoldCo/MidCo/TopCo/NewCo) är ett medvetet
      // val och flaggas direkt. Ett rått, obytt "Goldcup NNNN AB"-namn säger
      // ingenting om avsikt i sig — tusentals lagerbolag heter så varje år av
      // helt oskyldiga skäl. Sådana ska ALLTID till watchlist och vänta på en
      // verklig signal (namnbyte bort från Goldcup-mönstret, eller adressflytt
      // till en känd M&A-rådgivare) innan de räknas som en bidco-kandidat.
      const isExplicitBidcoName = BIDCO_NAME_PATTERN.test(row.name);

      if (!isExplicitBidcoName) {
        // Täcker både rått Goldcup-namn och andra kort/holding-liknande bolag
        // som redan passerat shortOrHoldingDesc-filtret ovan.
        await sql`
          INSERT INTO watchlist (org_nr, original_name, original_address, original_description, registered_at, window_expires_at)
          VALUES (${row.org_nr}, ${row.name}, ${row.address}, ${row.description}, ${row.registered_at},
                  (${row.registered_at}::date + INTERVAL '90 days'))
          ON CONFLICT (org_nr) DO NOTHING
        `;
        watchlistAdded++;
        continue;
      }
      candidates++;

      // ---- Adressmatchning mot known_advisors — förstärker score, filtrerar INTE bort.
      // Namnet (BidCo/HoldCo) är den starka signalen i sig. En adressmatch är
      // extra bekräftelse, inte ett krav — annars missar vi bidco kopplade till
      // rådgivare som ännu inte finns i known_advisors.
      let matchedAdvisor = null;
      for (const advisor of advisors) {
        if (row.address && advisor.known_address && row.address.toLowerCase().includes(advisor.known_address.toLowerCase())) {
          matchedAdvisor = advisor;
          break;
        }
      }

      // ---- Flagga i track_record_log (delad funktion: hash-kedja +
      // GitHub-tidsstämpel + Slack-notis, allt automatiskt) ----
      // baseScore är nu fast 50 -- denna gren nås bara av EXPLICITA bidco-namn,
      // så Goldcup-specialfallet (tidigare 55, felaktigt högre) är borttaget.
      const baseScore = 50;
      const advisorBonus = matchedAdvisor ? 30 * Number(matchedAdvisor.weight) : 0;
      const score = baseScore + advisorBonus;
      const reasonParts = ['bolagsverket_bulk_registrering', 'bidco_namnmonster'];
      if (matchedAdvisor) reasonParts.push(`advokatadress_${matchedAdvisor.name.replace(/\s+/g, '_')}`);

      await appendFlag({
        company_name: row.name,
        org_nr: row.org_nr,
        ticker: null,
        flag_reason: reasonParts.join('+'),
        score,
        signal_snapshot: {
          registered_at: row.registered_at,
          description: row.description,
          address: row.address,
          matchedAdvisor: matchedAdvisor ? matchedAdvisor.name : null,
        },
      });
      flagged++;
      console.log(`FLAGGAD: ${row.name} (${row.org_nr}) — ${matchedAdvisor ? matchedAdvisor.name : 'ingen adressmatch'}, score ${score}`);
    }

    await saveSnapshot(seenSet);
    console.log(`Snapshot sparad: ${startSize} -> ${seenSet.size} org.nr (${newOrgs} nya).`);

    // Bolag vars 90-dagarsfönster gått ut utan att något hänt — inga fler kontroller
    const expiredResult = await sql`
      UPDATE watchlist SET status = 'expired'
      WHERE status = 'pending' AND window_expires_at < CURRENT_DATE
      RETURNING org_nr
    `;
    if (expiredResult.rows.length > 0) {
      console.log(`${expiredResult.rows.length} watchlist-poster gick ut (90 dagar utan förändring).`);
    }

    await sql`
      UPDATE bolagsverket_scan_runs
      SET status = 'success', finished_at = now(), error = NULL,
          total_rows = ${totalRows}, new_orgs = ${newOrgs},
          candidates = ${candidates}, flagged = ${flagged},
          orgform_counts = ${JSON.stringify(orgformCounts)}
      WHERE run_id = ${runId}
    `;

    console.log(`Klart. ${totalRows} rader, ${newOrgs} nya org.nr, ${candidates} kandidater, ${flagged} flaggade direkt.`);
    console.log(`Watchlist: ${watchlistAdded} nya tillagda, ${watchlistFlagged} flaggade via förändring, ${expiredResult.rows.length} gick ut.`);
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

main();
