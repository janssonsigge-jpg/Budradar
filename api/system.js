// api/system.js
//
// EN enda serverless function som ersätter fem separata filer:
//   api/flag/create.js
//   api/track-record/index.js
//   api/track-record/verify.js
//   api/health/index.js
//   api/cron/daily-scan.js
//
// Anledning: Vercel Hobby-planen tillåter max 12 serverless functions totalt
// per deployment, och varje fil i api/ (oavsett undermapp) räknas som en
// egen funktion. Genom att slå ihop allt till en fil och routa internt via
// ?action=... sparar vi 4 av de 5 funktionsslottarna.
//
// ANVÄNDNING (byt ut alla tidigare URL:er mot dessa):
//   GET  /api/system?action=track-record       (ersätter GET /api/track-record)
//   GET  /api/system?action=verify              (ersätter GET /api/track-record/verify)
//   GET  /api/system?action=health               (ersätter GET /api/health)
//   POST /api/system?action=flag                 (ersätter POST /api/flag/create)
//   GET  /api/system?action=daily-scan            (ersätter GET /api/cron/daily-scan, kräver CRON_SECRET)
//
// Om ni senare uppgraderar till Vercel Pro (ingen 12-funktionsgräns) kan ni
// när som helst splitta upp denna fil till separata filer igen om ni vill —
// koden i varje "gren" nedan är oförändrad, bara flyttad hit.

import { sql } from '../lib/db.js';
import { scoreCompany, FLAG_THRESHOLD } from '../lib/scoring.js';
import { appendFlag, verifyChain, recordOutcome } from '../lib/trackRecordLog.js';
import { recordHealthCheck, getAllHealth } from '../lib/healthCheck.js';
import { archiveRawSnapshot, todaysRunId } from '../lib/archiveSnapshot.js';
import { REGISTRY } from './_registry-data.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DELAY_DAYS, PLANS, ensureTables, createKey, listKeys, revokeKey, authenticate,
  isSealed, sealTrackRow, addToWaitlist, listWaitlist,
} from '../lib/access.js';

// Enkel bearer-token-koll för admin-actions. Sätt ADMIN_SECRET i Vercel env vars.
function requireAdmin(req, res) {
  const authHeader = req.headers['authorization'];
  if (!process.env.ADMIN_SECRET) {
    res.status(500).json({ error: 'ADMIN_SECRET är inte konfigurerad på servern' });
    return false;
  }
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized — saknar eller felaktig Authorization-header' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  const action = req.query.action;

  switch (action) {
    case 'track-record':
      return handleTrackRecord(req, res);
    case 'verify':
      return handleVerify(req, res);
    case 'health':
      return handleHealth(req, res);
    case 'flag':
      return handleFlag(req, res);
    case 'daily-scan':
      return handleDailyScan(req, res);
    case 'bolagsverket-status':
      return handleBolagsverketStatus(req, res);
    case 'admin-add-advisor':
      return handleAdminAddAdvisor(req, res);
    case 'admin-outcome':
      return handleAdminOutcome(req, res);
    case 'flagged-tickers':
      return handleFlaggedTickers(req, res);
    case 'admin-sync-historical':
      return handleAdminSyncHistorical(req, res);
    case 'bv-mirror':
      return handleBvMirror(req, res);
    case 'watchlist-status':
      return handleWatchlistStatus(req, res);
    case 'shell-flags':
      return handleShellFlags(req, res);
    case 'waitlist':
      return handleWaitlist(req, res);
    case 'v1':
      return handleV1(req, res);
    case 'admin-keys':
      return handleAdminKeys(req, res);
    case 'admin-waitlist':
      return handleAdminWaitlist(req, res);
    default:
      return res.status(400).json({
        error: 'Okänd eller saknad ?action=. Giltiga värden: track-record | verify | health | flag | daily-scan | bolagsverket-status | admin-add-advisor | admin-outcome | flagged-tickers | admin-sync-historical | watchlist-status | shell-flags | waitlist | v1 | admin-keys | admin-waitlist',
      });
  }
}

// ============================================================
// GET ?action=track-record
// ============================================================
async function handleTrackRecord(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Endast GET tillåtet' });
  }
  try {
    const { rows } = await sql`
      SELECT
        id, company_name, org_nr, ticker, flag_reason, score,
        outcome, outcome_date, outcome_note, source,
        row_hash, github_commit_sha, created_at
      FROM track_record_log
      ORDER BY created_at DESC
    `;

    const liveRows = rows.filter((r) => r.source !== 'historical_verification');
    const historicalRows = rows.filter((r) => r.source === 'historical_verification');

    const hits = liveRows.filter((r) => r.outcome === 'hit').length;
    const misses = liveRows.filter((r) => r.outcome === 'miss').length;
    const pending = liveRows.filter((r) => r.outcome === 'pending').length;

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

    return res.status(200).json({
      summary: {
        total: liveRows.length,
        hits, misses, pending,
        // hitRate räknas ENDAST på live-flaggor — historisk import är per
        // definition alltid "hit" (vi importerar bara bekräftade affärer),
        // så den ska aldrig blandas in i träffsäkerhetsmåttet.
        hitRate: liveRows.length > pending ? hits / (liveRows.length - pending) : null,
        historicalVerified: historicalRows.length,
        sealed: rows.filter((r) => isSealed(r)).length,
        delayDays: DELAY_DAYS,
      },
      // Publik vy: live-flaggor yngre än DELAY_DAYS är förseglade (bara hash + tid).
      // Fullständig data i realtid finns via /v1/flags med API-nyckel.
      flags: rows.map(sealTrackRow),
      githubRepo: process.env.GITHUB_TIMESTAMP_REPO || null,
    });
  } catch (err) {
    console.error('Fel vid hämtning av track record:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// GET ?action=verify
// ============================================================
async function handleVerify(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Endast GET tillåtet' });
  }
  try {
    const result = await verifyChain();
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Fel vid verifiering av kedja:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// GET ?action=health
// ============================================================
const STALE_THRESHOLD_HOURS = 30;

async function handleHealth(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Endast GET tillåtet' });
  }
  try {
    const sources = await getAllHealth();

    const withStatus = sources.map((s) => {
      const hoursSinceSuccess = s.last_success_at
        ? (Date.now() - new Date(s.last_success_at).getTime()) / (1000 * 60 * 60)
        : Infinity;
      return {
        ...s,
        status: hoursSinceSuccess > STALE_THRESHOLD_HOURS ? 'stale' : 'ok',
        hoursSinceSuccess: Math.round(hoursSinceSuccess * 10) / 10,
      };
    });

    const overallOk = withStatus.every((s) => s.status === 'ok');

    return res.status(overallOk ? 200 : 207).json({
      overall: overallOk ? 'ok' : 'degraded',
      sources: withStatus,
    });
  } catch (err) {
    console.error('Fel vid hämtning av health status:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// POST ?action=flag
// ============================================================
async function handleFlag(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Endast POST tillåtet' });
  }

  const {
    company_name,
    org_nr,
    ticker,
    isBidcoSniRegistration,
    signatoryName,
    registeredAddress,
    insiderBuySpike,
    shortDecreaseSpike,
  } = req.body || {};

  if (!company_name) {
    return res.status(400).json({ error: 'company_name krävs' });
  }

  try {
    const result = await scoreCompany({
      isBidcoSniRegistration,
      signatoryName,
      registeredAddress,
      insiderBuySpike,
      shortDecreaseSpike,
    });

    if (!result.shouldFlag) {
      return res.status(200).json({
        flagged: false,
        score: result.score,
        threshold: FLAG_THRESHOLD,
        breakdown: result.breakdown,
      });
    }

    const flagReasonParts = result.breakdown.map((b) => b.signal);
    const logEntry = await appendFlag({
      company_name,
      org_nr,
      ticker,
      flag_reason: flagReasonParts.join('+'),
      score: result.score,
      signal_snapshot: {
        isBidcoSniRegistration,
        signatoryName,
        registeredAddress,
        insiderBuySpike,
        shortDecreaseSpike,
        breakdown: result.breakdown,
        matchedAdvisor: result.matchedAdvisor,
        matchedAddress: result.matchedAddress,
      },
    });

    return res.status(201).json({
      flagged: true,
      score: result.score,
      breakdown: result.breakdown,
      trackRecordId: logEntry.id,
      rowHash: logEntry.row_hash,
    });
  } catch (err) {
    console.error('Fel vid flaggning:', err);
    return res.status(500).json({ error: 'Internt fel vid flaggning', detail: err.message });
  }
}

// ============================================================
// GET ?action=daily-scan  (cron)
//
// Kopplar ihop er befintliga pipeline med track record-loggen:
//   1. Hämtar live scoring från /api/companies (er befintliga motor:
//      insider + MFN-flaggningar + blankning + bolagsverket-signal)
//   2. Bolag som klassas som tier "HÖG" (composite >= 65) och inte
//      redan har en väntande flagg → skrivs till track_record_log
//   3. Matchar väntande flaggor mot bid_registry (från detect-bids.js)
//      — om ett verkligt bud dykt upp för ett flaggat bolag sätts
//      outcome='hit' automatiskt, ingen manuell uppdatering behövs
// ============================================================
async function handleDailyScan(req, res) {
  const authHeader = req.headers['authorization'];
  const isCron = req.headers['x-vercel-cron'] != null;
  if (!isCron && process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runId = todaysRunId();

  const existing = await sql`SELECT status FROM cron_runs WHERE run_id = ${runId}`;
  if (existing.rows.length > 0 && existing.rows[0].status === 'success') {
    return res.status(200).json({ skipped: true, reason: 'Redan körd idag', runId });
  }

  await sql`
    INSERT INTO cron_runs (run_id, status)
    VALUES (${runId}, 'running')
    ON CONFLICT (run_id) DO UPDATE SET started_at = now(), status = 'running'
  `;

  const summary = { newFlags: 0, hitsMatched: 0, errors: [] };

  try {
    // ---- 1. Hämta live scoring från er befintliga /api/companies ----
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;

    const companiesRes = await fetch(`${proto}://${host}/api/companies?fresh=1`);
    if (!companiesRes.ok) throw new Error('companies HTTP ' + companiesRes.status);
    const companiesData = await companiesRes.json();
    const companies = companiesData.companies || [];

    // Arkivera rådata innan vi processar (samma princip som snapshot.js,
    // men här sparar vi den fulla scoring-payloaden för framtida backtest)
    await archiveRawSnapshot('companies-daily', JSON.stringify(companiesData), 'json');

    // Health check per underliggande källa, baserat på companiesData.fetched
    const sourceMap = { insider: 'fi_insider', shorts: 'fi_short', flags: 'mfn' };
    for (const [key, mappedSource] of Object.entries(sourceMap)) {
      const status = companiesData.fetched?.[key] || '';
      const ok = status.startsWith('ok');
      await recordHealthCheck({
        source: mappedSource,
        success: ok,
        rowCount: ok ? Number((status.match(/\((\d+)/) || [])[1]) || null : null,
        error: ok ? null : status,
      });
      if (!ok) summary.errors.push({ source: mappedSource, error: status });
    }

    // ---- 2. Flagga nya "HÖG"-klassade bolag (composite >= 65) ----
    for (const c of companies) {
      if (c.score.tier !== 'HÖG') continue;

      const alreadyPending = await sql`
        SELECT id FROM track_record_log WHERE ticker = ${c.ticker} AND outcome = 'pending' LIMIT 1
      `;
      if (alreadyPending.rows.length > 0) continue; // redan flaggad, väntar på utfall

      await appendFlag({
        company_name: c.name,
        org_nr: null,
        ticker: c.ticker,
        flag_reason: `composite_${c.score.composite}_tier_hog`,
        score: c.score.composite,
        signal_snapshot: {
          parts: c.score.parts,
          insiderCount: c.detail?.insider?.length || 0,
          flagsCount: c.detail?.flags?.length || 0,
          shortsCount: c.detail?.shorts?.length || 0,
        },
      });
      summary.newFlags++;
    }

    // ---- 3. Matcha väntande flaggor mot verkliga bud (bid_registry) ----
    const pending = await sql`SELECT id, ticker, created_at FROM track_record_log WHERE outcome = 'pending'`;
    for (const p of pending.rows) {
      const bidMatch = await sql`
        SELECT company, announced, bidder, bidco FROM bid_registry
        WHERE ticker = ${p.ticker} AND announced >= ${p.created_at}::date
        ORDER BY announced ASC LIMIT 1
      `;
      if (bidMatch.rows.length > 0) {
        const bid = bidMatch.rows[0];
        await recordOutcome({
          id: p.id,
          outcome: 'hit',
          outcome_note: `Bud från ${bid.bidder || 'okänd budgivare'}${bid.bidco ? ` (bidco: ${bid.bidco})` : ''} offentliggjort ${bid.announced}`,
        });
        summary.hitsMatched++;
      }
    }

    await sql`
      UPDATE cron_runs
      SET status = 'success', finished_at = now(), summary = ${JSON.stringify(summary)}
      WHERE run_id = ${runId}
    `;

    return res.status(200).json({ runId, summary });
  } catch (err) {
    await sql`
      UPDATE cron_runs
      SET status = 'failed', finished_at = now(), summary = ${JSON.stringify({ ...summary, fatalError: err.message })}
      WHERE run_id = ${runId}
    `;
    console.error('Cron-körning misslyckades fatalt:', err);
    return res.status(500).json({ error: 'Cron misslyckades', detail: err.message });
  }
}

// ============================================================
// GET ?action=bolagsverket-status
// Visar de senaste veckoscanningarna (från bolagsverket-scan.mjs,
// körs via GitHub Actions, skriver till bolagsverket_scan_runs).
// ============================================================
async function handleBolagsverketStatus(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Endast GET tillåtet' });
  }
  try {
    const { rows } = await sql`
      SELECT run_id, started_at, finished_at, status,
             total_rows, new_orgs, candidates, flagged, orgform_counts, error
      FROM bolagsverket_scan_runs
      ORDER BY started_at DESC
      LIMIT 20
    `;
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ runs: rows });
  } catch (err) {
    console.error('Fel vid hämtning av bolagsverket-status:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// POST ?action=admin-add-advisor
// Lägg till/uppdatera en rad i known_advisors utan att öppna Neon SQL Editor.
// Kräver Authorization: Bearer <ADMIN_SECRET>
//
// Body: { name, type, match_names: [...], known_address, weight }
// ============================================================
async function handleAdminAddAdvisor(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Endast POST tillåtet' });
  }
  if (!requireAdmin(req, res)) return;

  const { name, type, match_names, known_address, weight } = req.body || {};

  if (!name || !type || !Array.isArray(match_names) || match_names.length === 0) {
    return res.status(400).json({
      error: 'name, type och match_names (array, minst 1 alias) krävs',
    });
  }
  if (!['law_firm', 'pe_firm', 'investment_bank'].includes(type)) {
    return res.status(400).json({ error: "type måste vara 'law_firm', 'pe_firm' eller 'investment_bank'" });
  }

  try {
    const { rows } = await sql`
      INSERT INTO known_advisors (name, type, match_names, known_address, weight)
      VALUES (${name}, ${type}, ${match_names}, ${known_address || null}, ${weight ?? 1.0})
      ON CONFLICT (name) DO UPDATE SET
        type = EXCLUDED.type,
        match_names = EXCLUDED.match_names,
        known_address = EXCLUDED.known_address,
        weight = EXCLUDED.weight
      RETURNING id, name
    `;
    return res.status(201).json({ added: rows[0] });
  } catch (err) {
    console.error('Fel vid tillägg av rådgivare:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// POST ?action=admin-outcome
// Markera utfall (hit/miss/expired) på en befintlig flagg.
// Kräver Authorization: Bearer <ADMIN_SECRET>
//
// Body: { id, outcome: 'hit'|'miss'|'expired', outcome_note }
// ============================================================
async function handleAdminOutcome(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Endast POST tillåtet' });
  }
  if (!requireAdmin(req, res)) return;

  const { id, outcome, outcome_note } = req.body || {};

  if (!id || !outcome) {
    return res.status(400).json({ error: 'id och outcome krävs' });
  }

  try {
    await recordOutcome({ id, outcome, outcome_note });
    return res.status(200).json({ updated: id, outcome });
  } catch (err) {
    console.error('Fel vid uppdatering av utfall:', err);
    return res.status(400).json({ error: err.message });
  }
}

// ============================================================
// GET ?action=flagged-tickers
// Lättviktig lista över tickers som har minst en flagg i track_record_log.
// Används av Rank-fliken i index.html för att visa en 🚩-badge på bolag
// som redan är flaggade, så appens svagaste signal (generisk aktivitet)
// och starkaste signal (verifierad bidco-flaggning) kopplas ihop visuellt.
// ============================================================
async function handleFlaggedTickers(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Endast GET tillåtet' });
  }
  try {
    const { rows } = await sql`
      SELECT ticker, outcome, source, created_at
      FROM track_record_log
      WHERE ticker IS NOT NULL AND ticker != ''
    `;
    const seen = new Set();
    const open = rows.filter((r) => !isSealed(r)).filter((r) => {
      const k = r.ticker + '|' + r.outcome;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({
      tickers: open.map((r) => ({ ticker: r.ticker, outcome: r.outcome })),
    });
  } catch (err) {
    console.error('Fel vid hämtning av flaggade tickers:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// POST ?action=admin-sync-historical
// Engångsimport: hämtar redan verifierade bidco-poster ur bidco_registry
// (samma tabell som ger "Bidco → bud"-medianen på data.html) och lägger in
// dem i track_record_log med source='historical_verification'.
//
// VIKTIGT: dessa poster skapas MEDVETET med redan känt utfall — det är inte
// samma bevis som en live-flagg (som skapas innan utfallet är känt). Därför
// den separata source-kolumnen, så de aldrig visas som om de vore
// förutsägelser i efterhand.
//
// Säker att köra flera gånger — hoppar över org.nr som redan importerats.
// Kräver Authorization: Bearer <ADMIN_SECRET>
// ============================================================
async function handleAdminSyncHistorical(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Endast POST tillåtet' });
  }
  if (!requireAdmin(req, res)) return;

  try {
    const { rows: bidcoRows } = await sql`
      SELECT bidco, org_nr, registered::text, announced::text, bud_id
      FROM bidco_registry
      WHERE registered IS NOT NULL AND announced IS NOT NULL
    `;

    if (bidcoRows.length === 0) {
      return res.status(200).json({ synced: 0, skipped: 0, message: 'bidco_registry innehåller inga rader med både registered och announced satta.' });
    }

    const registryById = new Map(REGISTRY.map((r) => [r.id, r]));

    let synced = 0;
    let skipped = 0;
    const results = [];

    for (const row of bidcoRows) {
      if (!row.org_nr) { skipped++; continue; }

      const existing = await sql`
        SELECT id FROM track_record_log
        WHERE org_nr = ${row.org_nr} AND source = 'historical_verification'
        LIMIT 1
      `;
      if (existing.rows.length > 0) { skipped++; continue; }

      const matchedEntry = row.bud_id ? registryById.get(row.bud_id) : null;
      const outcomeNote = matchedEntry
        ? `Bud från ${matchedEntry.bidder} på ${matchedEntry.target}, offentliggjort ${row.announced}`
        : `Bud offentliggjort ${row.announced}`;

      const logEntry = await appendFlag({
        company_name: row.bidco,
        org_nr: row.org_nr,
        ticker: matchedEntry?.targetTicker || null,
        flag_reason: 'historisk_verifiering_bidco_registrering',
        score: 100, // fast värde, skiljer sig medvetet från live-flaggors 50-95 spann
        signal_snapshot: {
          registered_at: row.registered,
          announced_at: row.announced,
          target: matchedEntry?.target || null,
          bidder: matchedEntry?.bidderType || null,
        },
        source: 'historical_verification',
        created_at_override: new Date(row.registered).toISOString(),
        initial_outcome: 'hit',
        outcome_date: new Date(row.announced).toISOString(),
        outcome_note: outcomeNote,
        notify: false, // undvik att spamma Discord med 8 gamla, redan kända affärer
      });

      synced++;
      results.push({ id: logEntry.id, company_name: row.bidco, org_nr: row.org_nr });
    }

    return res.status(200).json({ synced, skipped, results });
  } catch (err) {
    console.error('Fel vid historisk synk:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// GET ?action=watchlist-status
// Snabb överblick över bevakningslistan — hur många väntar, hur många
// har flaggats via en förändring, hur många gått ut utan att hända något.
//
// UPPDATERAD: returnerar nu även den faktiska listan över bolag som väntar
// (status='pending'), inte bara ett antal, så index.html kan visa dem under
// Bidco-spår-fliken.
// ============================================================
async function handleWatchlistStatus(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Endast GET tillåtet' });
  }
  try {
    const { rows: counts } = await sql`
      SELECT status, COUNT(*)::int AS count FROM watchlist GROUP BY status
    `;
    const { rows: recentlyFlagged } = await sql`
      SELECT w.org_nr, w.original_name, w.score, w.last_checked_at, w.flagged_track_record_id,
             t.created_at, t.outcome, t.source
      FROM watchlist w
      LEFT JOIN track_record_log t ON t.id = w.flagged_track_record_id
      WHERE w.status = 'flagged'
      ORDER BY w.last_checked_at DESC LIMIT 10
    `;
    for (const r of recentlyFlagged) {
      const sealed = r.created_at && isSealed({ created_at: r.created_at, outcome: r.outcome, source: r.source || 'live' });
      if (sealed) { r.org_nr = null; r.original_name = `Förseglad flagga #${r.flagged_track_record_id}`; r.sealed = true; }
      delete r.created_at; delete r.outcome; delete r.source;
    }
    // NYTT: faktiska bolag under bevakning, inte bara ett antal.
    // Nyast registrerade först -- det är de som fortfarande har längst kvar
    // av sitt 90-dagarsfönster och är mest relevanta att hålla koll på.
    const { rows: pending } = await sql`
      SELECT org_nr, original_name, registered_at, window_expires_at, last_checked_at
      FROM watchlist WHERE status = 'pending'
      ORDER BY registered_at DESC LIMIT 50
    `;
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
      recentlyFlagged,
      pending,
    });
  } catch (err) {
    console.error('Fel vid hämtning av watchlist-status:', err);
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// ============================================================
// POST ?action=bv-mirror  — speglar Bolagsverkets bulkfil till privat Vercel Blob
//
// Bolagsverkets server bryter långa nedladdningar från GitHubs servrar. Vercel
// når dem utan problem, så här hämtas filen i bitar om 16 MB (Range-anrop)
// och varje bit sparas som en egen privat blob. Varje anrop gör så många bitar
// som hinns inom tidsbudgeten; GitHub-jobbet anropar tills complete=true och
// sätter sedan ihop bitarna. Gamla versioner av filen städas bort automatiskt.
// Skydd: anroparen skickar en Blob-token som bearer-token. Den godkänns bara om
// den faktiskt fungerar mot Blob-lagringen (samma token används för alla blob-anrop).
// ============================================================
async function handleBvMirror(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { put, list, del } = await import('@vercel/blob');
  try {
    await list({ token, prefix: 'bv-bulk/', limit: 1 });
  } catch (e) {
    return res.status(401).json({ error: 'Ogiltig Blob-token: ' + e.message });
  }
  const URL_BV = 'https://vardefulla-datamangder.bolagsverket.se/bolagsverket/bolagsverket_bulkfil.zip';
  const UA = 'BudRadar/0.2 (+offentlig data)';
  const CHUNK = 16 * 1024 * 1024;
  const BUDGET_MS = 25000;
  const t0 = Date.now();

  const h = await fetch(URL_BV, { method: 'HEAD', headers: { 'user-agent': UA } });
  if (!h.ok) return res.status(200).json({ complete: false, done: 0, total: 0, errors: [`HEAD HTTP ${h.status}`] });
  const size = Number(h.headers.get('content-length'));
  const version = (h.headers.get('etag') || h.headers.get('last-modified') || 'okand').replace(/[^a-zA-Z0-9]/g, '');
  const prefix = `bv-bulk/${version}/`;
  const total = Math.ceil(size / CHUNK);
  const partName = (i) => `${prefix}part-${String(i).padStart(3, '0')}.bin`;
  const expected = (i) => Math.min(CHUNK, size - i * CHUNK);

  const existing = new Map();
  let cursor;
  do {
    const r = await list({ token, prefix, cursor, limit: 1000 });
    for (const b of r.blobs) existing.set(b.pathname, b.size);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);

  const isDone = (i) => existing.get(partName(i)) === expected(i);
  const errors = [];
  for (let i = 0; i < total; i++) {
    if (isDone(i)) continue;
    if (Date.now() - t0 > BUDGET_MS) break;
    const start = i * CHUNK;
    const end = start + expected(i) - 1;
    try {
      const r = await fetch(URL_BV, { headers: { 'user-agent': UA, range: `bytes=${start}-${end}` } });
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== expected(i)) throw new Error(`fel storlek ${buf.length}`);
      await put(partName(i), buf, { token, access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/octet-stream' });
      existing.set(partName(i), buf.length);
    } catch (e) {
      errors.push(`del ${i}: ${e.message}`);
      break;
    }
  }

  const parts = Array.from({ length: total }, (_, i) => partName(i));
  const done = parts.filter((_, i) => isDone(i)).length;
  const complete = done === total;

  if (complete) {
    try {
      const old = [];
      let c;
      do {
        const r = await list({ token, prefix: 'bv-bulk/', cursor: c, limit: 1000 });
        for (const b of r.blobs) if (!b.pathname.startsWith(prefix)) old.push(b.url);
        c = r.hasMore ? r.cursor : undefined;
      } while (c);
      if (old.length) await del(old, { token });
    } catch {}
  }

  return res.status(200).json({ complete, size, version, done, total, parts: complete ? parts : undefined, errors });
}

// ============================================================
// GET ?action=shell-flags — skal som flaggats (namnbyte, adressbyte eller
// bidco-namn) med allt vi vet om dem. Frontend matchar mot börsbolag.
// Omklassificerade felflaggor (augusti 2026) tas inte med.
// ============================================================
async function handleShellFlags(req, res) {
  try {
    const { rows } = await sql`
      SELECT t.id, t.company_name, t.org_nr, t.flag_reason, t.score, t.signal_snapshot,
             t.outcome, t.outcome_note, t.created_at,
             w.original_name, w.original_address, w.registered_at
      FROM track_record_log t
      LEFT JOIN watchlist w ON w.flagged_track_record_id = t.id
      WHERE t.source = 'live'
        AND (t.outcome_note IS NULL OR t.outcome_note NOT ILIKE 'Omklassificerad%')
      ORDER BY t.created_at DESC
      LIMIT 50
    `;
    const items = rows.map((r) => {
      if (isSealed({ ...r, source: 'live' })) {
        return {
          id: r.id, name: `Förseglad flagga #${r.id}`, originalName: null, orgNr: null,
          address: null, originalAddress: null, description: null, advisor: null,
          reason: r.flag_reason, score: r.score != null ? Number(r.score) : null,
          outcome: r.outcome, registeredAt: null, flaggedAt: r.created_at,
          sealed: true, revealAt: sealTrackRow({ ...r, source: 'live' }).reveal_at,
        };
      }
      let s = r.signal_snapshot;
      if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = {}; } }
      s = s || {};
      return {
        id: r.id,
        name: s.new_name || r.company_name,
        originalName: s.original_name || r.original_name || null,
        orgNr: r.org_nr,
        address: s.new_address || s.address || null,
        originalAddress: s.original_address || r.original_address || null,
        description: s.description || s.new_description || null,
        advisor: s.matchedAdvisor || null,
        reason: r.flag_reason,
        score: r.score != null ? Number(r.score) : null,
        outcome: r.outcome,
        registeredAt: s.registered_at || r.registered_at || null,
        flaggedAt: r.created_at,
      };
    });
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ count: items.length, sealed: items.filter((i) => i.sealed).length, delayDays: DELAY_DAYS, items });
  } catch (err) {
    return res.status(500).json({ error: 'Internt fel', detail: err.message });
  }
}

// =====================================================================
// BETALVÄGG: väntelista, nyckeladmin och API v1
// =====================================================================

// POST /api/system?action=waitlist   { email, interest: free|pro|api, company?, message? }
async function handleWaitlist(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Endast POST tillåtet' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.website) return res.status(200).json({ ok: true }); // honeypot mot botar
    await addToWaitlist(body);
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
}

// GET  /api/system?action=admin-keys                     lista nycklar
// POST /api/system?action=admin-keys  { owner, email?, plan?, note?, daily_quota? }  skapa nyckel
// POST /api/system?action=admin-keys  { revoke: <id> }   spärra nyckel
async function handleAdminKeys(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    if (req.method === 'GET') return res.status(200).json({ plans: PLANS, keys: await listKeys() });
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET eller POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.revoke) {
      await revokeKey(Number(body.revoke));
      return res.status(200).json({ ok: true, revoked: Number(body.revoke) });
    }
    const created = await createKey(body);
    return res.status(201).json({
      ...created,
      warning: 'Spara nyckeln nu — den visas aldrig igen. Bara hashen lagras.',
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// GET /api/system?action=admin-waitlist
async function handleAdminWaitlist(req, res) {
  if (!requireAdmin(req, res)) return;
  try {
    return res.status(200).json({ signups: await listWaitlist() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------
// API v1 — nås via vercel.json-rewrite: /v1/<route>  →  ?action=v1&route=<route>
// Allt i realtid, ingen försegling. Kräver API-nyckel.
// ---------------------------------------------------------------------
const V1_ROUTES = ['me', 'flags', 'flags/{id}', 'watchlist', 'bids', 'candidates', 'verify'];

function parseSnapshot(s) {
  if (typeof s === 'string') { try { return JSON.parse(s); } catch { return {}; } }
  return s || {};
}

function v1Flag(r) {
  const s = parseSnapshot(r.signal_snapshot);
  return {
    id: Number(r.id),
    name: s.new_name || r.company_name,
    original_name: s.original_name || r.original_name || null,
    org_nr: r.org_nr || null,
    ticker: r.ticker || null,
    reason: r.flag_reason,
    score: r.score != null ? Number(r.score) : null,
    address: s.new_address || s.address || null,
    original_address: s.original_address || r.original_address || null,
    description: s.description || s.new_description || null,
    advisor: s.matchedAdvisor || null,
    registered_at: s.registered_at || r.registered_at || null,
    flagged_at: r.created_at,
    source: r.source,
    outcome: r.outcome,
    outcome_date: r.outcome_date || null,
    outcome_note: r.outcome_note || null,
    proof: { row_hash: r.row_hash, prev_hash: r.prev_hash, github_commit_sha: r.github_commit_sha || null },
  };
}

let _candidates = null;
function loadCandidates() {
  if (!_candidates) _candidates = JSON.parse(readFileSync(join(process.cwd(), 'data', 'takeover.json'), 'utf8'));
  return _candidates;
}

async function handleV1(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-API-Key, Content-Type');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Endast GET' });

  const route = [].concat(req.query.route || '').join('/').replace(/^\/+|\/+$/g, '');
  const auth = await authenticate(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { key, used } = auth;
  res.setHeader('X-RateLimit-Limit', String(key.daily_quota));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, key.daily_quota - used)));

  const q = req.query;
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);

  try {
    // GET /v1/me
    if (route === 'me' || route === '') {
      return res.status(200).json({
        owner: key.owner, plan: key.plan, daily_quota: key.daily_quota, used_today: used,
        routes: V1_ROUTES.map((r) => '/v1/' + r),
      });
    }

    // GET /v1/flags?since=2026-11-01&limit=100&historical=1&outcome=pending
    if (route === 'flags') {
      const since = q.since ? new Date(q.since) : new Date(0);
      if (isNaN(since)) return res.status(400).json({ error: 'Ogiltigt since-datum (ISO 8601)' });
      const withHist = q.historical === '1' || q.historical === 'true';
      const outcome = q.outcome || null;
      const { rows } = await sql`
        SELECT t.*, w.original_name, w.original_address, w.registered_at
        FROM track_record_log t
        LEFT JOIN watchlist w ON w.flagged_track_record_id = t.id
        WHERE t.created_at >= ${since.toISOString()}
          AND (${withHist} OR t.source = 'live')
          AND (${outcome}::text IS NULL OR t.outcome = ${outcome})
          AND (t.outcome_note IS NULL OR t.outcome_note NOT ILIKE 'Omklassificerad%')
        ORDER BY t.created_at DESC
        LIMIT ${limit}`;
      return res.status(200).json({ count: rows.length, data: rows.map(v1Flag) });
    }

    // GET /v1/flags/123
    const m = route.match(/^flags\/(\d+)$/);
    if (m) {
      const { rows } = await sql`
        SELECT t.*, w.original_name, w.original_address, w.registered_at
        FROM track_record_log t
        LEFT JOIN watchlist w ON w.flagged_track_record_id = t.id
        WHERE t.id = ${Number(m[1])}`;
      if (!rows.length) return res.status(404).json({ error: 'Flaggan finns inte' });
      return res.status(200).json({ data: v1Flag(rows[0]) });
    }

    // GET /v1/watchlist?status=pending|flagged|expired&limit=100
    if (route === 'watchlist') {
      const status = ['pending', 'flagged', 'expired'].includes(q.status) ? q.status : 'pending';
      const { rows } = await sql`
        SELECT org_nr, original_name, original_address, original_description, registered_at,
               status, score, window_expires_at, last_checked_at, flagged_track_record_id
        FROM watchlist WHERE status = ${status}
        ORDER BY registered_at DESC LIMIT ${limit}`;
      const { rows: counts } = await sql`SELECT status, COUNT(*)::int AS count FROM watchlist GROUP BY status`;
      return res.status(200).json({
        counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
        count: rows.length, data: rows,
      });
    }

    // GET /v1/bids?from=2025-01-01&bidderType=PE
    if (route === 'bids') {
      let data = REGISTRY;
      if (q.from) data = data.filter((b) => (b.announced || '') >= q.from);
      if (q.to) data = data.filter((b) => (b.announced || '') <= q.to);
      if (q.bidderType) data = data.filter((b) => (b.bidderType || '').toLowerCase() === String(q.bidderType).toLowerCase());
      if (q.hasBidco === '1') data = data.filter((b) => b.bidcoRegistered);
      return res.status(200).json({ count: data.length, data });
    }

    // GET /v1/candidates — hela uppköpslistan med poäng och motivering
    if (route === 'candidates') {
      const c = loadCandidates();
      return res.status(200).json({
        generated: c.generated, universe: c.universe, method: c.method,
        backtest: c.backtest, count: c.list.length, data: c.list,
      });
    }

    // GET /v1/verify
    if (route === 'verify') {
      return res.status(200).json(await verifyChain());
    }

    return res.status(404).json({ error: `Okänd route /v1/${route}`, routes: V1_ROUTES.map((r) => '/v1/' + r) });
  } catch (err) {
    console.error('[v1]', route, err);
    return res.status(500).json({ error: 'Internt fel' });
  }
}
