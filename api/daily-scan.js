// api/cron/daily-scan.js
//
// GET /api/cron/daily-scan (körs av Vercel Cron, se vercel.json)
//
// Detta är en SKELETT-orkestrering som visar HUR era befintliga
// hämtningsfunktioner (Bolagsverket/FI/MFN) ska kopplas in i:
//   1. idempotens (kör inte om samma dag redan är klar)
//   2. rådata-arkivering INNAN processning
//   3. health check-loggning
//   4. signal_log (allt observerat, för framtida backtest)
//   5. scoring + ev. flaggning
//
// Byt ut TODO-blocken mot era befintliga fetch/parse-funktioner.

import { sql } from '../../lib/db.js';
import { recordHealthCheck } from '../../lib/healthCheck.js';
import { archiveRawSnapshot, todaysRunId } from '../../lib/archiveSnapshot.js';
import { scoreCompany, FLAG_THRESHOLD } from '../../lib/scoring.js';
import { appendFlag } from '../../lib/trackRecordLog.js';

export default async function handler(req, res) {
  // Skydda mot obehöriga anrop — Vercel Cron skickar en secret header/query
  // du kan sätta i vercel.json, eller kolla CRON_SECRET env var.
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const runId = todaysRunId();

  // --- IDEMPOTENS: har dagens körning redan slutförts? ---
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
    // ============================================================
    // 1. BOLAGSVERKET — nya SNI 64200-registreringar
    // ============================================================
    try {
      // TODO: ersätt med er befintliga Bolagsverket-hämtning
      // const rawData = await fetchBolagsverketRegistrations();
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

        // Scoring + ev. flaggning direkt i pipelinen
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

    // ============================================================
    // 2. FI INSIDER REGISTER
    // ============================================================
    try {
      // TODO: ersätt med er befintliga FI-insider-hämtning (CSV/UTF-16)
      const rawData = await placeholderFetch('fi_insider');
      await archiveRawSnapshot('fi_insider', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'fi_insider', success: true, rowCount: rawData.length });
      // TODO: logga signaler till signal_log, samma mönster som ovan
    } catch (err) {
      await recordHealthCheck({ source: 'fi_insider', success: false, error: err.message });
      summary.errors.push({ source: 'fi_insider', error: err.message });
    }

    // ============================================================
    // 3. FI SHORT-REGISTER
    // ============================================================
    try {
      // TODO: ersätt med er befintliga FI short-hämtning (ODS)
      const rawData = await placeholderFetch('fi_short');
      await archiveRawSnapshot('fi_short', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'fi_short', success: true, rowCount: rawData.length });
      // TODO: logga signaler till signal_log
    } catch (err) {
      await recordHealthCheck({ source: 'fi_short', success: false, error: err.message });
      summary.errors.push({ source: 'fi_short', error: err.message });
    }

    // ============================================================
    // 4. MFN — flaggningsmeddelanden och pressmeddelanden
    // ============================================================
    try {
      // TODO: ersätt med er befintliga MFN-hämtning
      const rawData = await placeholderFetch('mfn');
      await archiveRawSnapshot('mfn', JSON.stringify(rawData), 'json');
      await recordHealthCheck({ source: 'mfn', success: true, rowCount: rawData.length });
      // TODO: logga signaler till signal_log
    } catch (err) {
      await recordHealthCheck({ source: 'mfn', success: false, error: err.message });
      summary.errors.push({ source: 'mfn', error: err.message });
    }

    await sql`
      UPDATE cron_runs
      SET status = ${summary.errors.length === 0 ? 'success' : 'success'}, finished_at = now(), summary = ${JSON.stringify(summary)}
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

// Ta bort denna — bara här så filen är körbar innan ni kopplat in riktig hämtning.
async function placeholderFetch(source) {
  console.warn(`placeholderFetch(${source}) anropad — koppla in er riktiga hämtningslogik här`);
  return [];
}
