// api/track-record/index.js
//
// GET /api/track-record
// Publik, oautentiserad endpoint som listar historiska flaggningar med
// utfall. Detta är datan bakom "Track Record"-sektionen på data.html.
// Inkluderar github_commit_sha så vem som helst kan verifiera tidsstämpeln
// direkt på github.com/<repo>/commit/<sha>.

import { sql } from '../../lib/db.js';

export default async function handler(req, res) {
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
