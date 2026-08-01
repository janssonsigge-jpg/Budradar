// api/flag/create.js
//
// POST /api/flag/create
// Anropas av er cron/detection-logik när ett bolag ska övervägas för flaggning.
// Kör scoring, och OM tröskeln nås: skriver till hash-kedjad track record-logg
// (inkl. extern GitHub-tidsstämpel).
//
// Body: {
//   company_name, org_nr, ticker,
//   isBidcoSniRegistration, signatoryName, registeredAddress,
//   insiderBuySpike, shortDecreaseSpike
// }

import { scoreCompany, FLAG_THRESHOLD } from '../../lib/scoring.js';
import { appendFlag } from '../../lib/trackRecordLog.js';

export default async function handler(req, res) {
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
