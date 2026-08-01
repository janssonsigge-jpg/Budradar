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
    default:
      return res.status(400).json({
        error: 'Okänd eller saknad ?action=. Giltiga värden: track-record | verify | health | flag | daily-scan | bolagsverket-status | admin-add-advisor | admin-outcome',
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
        outcome, outcome_date, outcome_note,
        row_hash, github_commit_sha, created_at
      FROM track_record_log
      ORDER BY created_at DESC
    `;

    const total = rows.length;
    const hits = rows.filter((r) => r.outcome === 'hit').length;
    const misses = rows.filter((r) => r.outcome === 'miss').length;
    const pending = rows.filter((r) => r.outcome === 'pending').length;

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

    return res.status(200).json({
      summary: { total, hits, misses, pending, hitRate: total > pending ? hits / (total - pending) : null },
      flags: rows,
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
