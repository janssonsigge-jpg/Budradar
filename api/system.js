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
import { appendFlag, verifyChain } from '../lib/trackRecordLog.js';
import { recordHealthCheck, getAllHealth } from '../lib/healthCheck.js';
import { archiveRawSnapshot, todaysRunId } from '../lib/archiveSnapshot.js';

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
    default:
      return res.status(400).json({
        error: 'Okänd eller saknad ?action=. Giltiga värden: track-record | verify | health | flag | daily-scan',
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
// ============================================================
async function handleDailyScan(req, res) {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

  const summary = { flagsCreated: 0, signalsLogged: 0, errors: [] };

  try {
    // ---- Bolagsverket ----
    try {
      const rawData = await placeholderFetch('bolagsverket');
      await archiveRawSnapshot('bolagsverket', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'bolagsverket', success: true, rowCount: rawData.length });

      for (const company of rawData) {
        await sql`
          INSERT INTO signal_log (source, company_name, org_nr, signal_type, raw_payload, run_id)
          VALUES ('bolagsverket', ${company.name}, ${company.org_nr}, 'sni_64200_registration', ${JSON.stringify(company)}, ${runId})
          ON CONFLICT (source, signal_type, org_nr, run_id) DO NOTHING
        `;
        summary.signalsLogged++;

        const scored = await scoreCompany({
          isBidcoSniRegistration: true,
          signatoryName: company.signatoryName,
          registeredAddress: company.registeredAddress,
        });

        if (scored.shouldFlag) {
          await appendFlag({
            company_name: company.name,
            org_nr: company.org_nr,
            ticker: company.suspectedTargetTicker || null,
            flag_reason: scored.breakdown.map((b) => b.signal).join('+'),
            score: scored.score,
            signal_snapshot: { ...company, breakdown: scored.breakdown },
          });
          summary.flagsCreated++;
        }
      }
    } catch (err) {
      await recordHealthCheck({ source: 'bolagsverket', success: false, error: err.message });
      summary.errors.push({ source: 'bolagsverket', error: err.message });
    }

    // ---- FI insider ----
    try {
      const rawData = await placeholderFetch('fi_insider');
      await archiveRawSnapshot('fi_insider', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'fi_insider', success: true, rowCount: rawData.length });
    } catch (err) {
      await recordHealthCheck({ source: 'fi_insider', success: false, error: err.message });
      summary.errors.push({ source: 'fi_insider', error: err.message });
    }

    // ---- FI short ----
    try {
      const rawData = await placeholderFetch('fi_short');
      await archiveRawSnapshot('fi_short', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'fi_short', success: true, rowCount: rawData.length });
    } catch (err) {
      await recordHealthCheck({ source: 'fi_short', success: false, error: err.message });
      summary.errors.push({ source: 'fi_short', error: err.message });
    }

    // ---- MFN ----
    try {
      const rawData = await placeholderFetch('mfn');
      await archiveRawSnapshot('mfn', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'mfn', success: true, rowCount: rawData.length });
    } catch (err) {
      await recordHealthCheck({ source: 'mfn', success: false, error: err.message });
      summary.errors.push({ source: 'mfn', error: err.message });
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

async function placeholderFetch(source) {
  console.warn(`placeholderFetch(${source}) anropad — koppla in er riktiga hämtningslogik här`);
  return [];
}
