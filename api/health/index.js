// api/health/index.js
//
// GET /api/health
// Intern (eller publik, om ni vill visa "system status" för trovärdighet)
// endpoint som visar senaste lyckade hämtning per källa.

import { getAllHealth } from '../../lib/healthCheck.js';

const STALE_THRESHOLD_HOURS = 30; // en daglig cron som inte lyckats på 30h räknas som stale

export default async function handler(req, res) {
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
