// api/track-record/verify.js
//
// GET /api/track-record/verify
// Publik endpoint som verifierar hela hash-kedjans integritet.
// Länka till denna från data.html med texten typ:
// "Verifiera att vår logg inte manipulerats →"
// Detta är ett trovärdighetsverktyg riktat mot tekniskt kunniga köpare
// (M&A-rådgivare med egen analytiker/utvecklare som vill dubbelkolla er).

import { verifyChain } from '../../lib/trackRecordLog.js';

export default async function handler(req, res) {
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
