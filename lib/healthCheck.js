// lib/healthCheck.js
//
// Håller koll på om FI/Bolagsverket/MFN-hämtningar tyst går sönder.
// Myndighets-filer ändrar format utan förvarning (t.ex. FI:s CSV-encoding) —
// detta gör att ni märker det inom ett dygn istället för att upptäcka det
// tre veckor senare när ni undrar varför inga nya flaggor kommit in.

import { sql } from './db.js';
import { sendAlert } from './notify.js';

const VALID_SOURCES = ['bolagsverket', 'fi_insider', 'fi_short', 'mfn'];

/**
 * Anropa denna EFTER varje försök att hämta från en källa, oavsett om det lyckades.
 */
export async function recordHealthCheck({ source, success, rowCount, error }) {
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`Okänd source: ${source}. Förväntade en av ${VALID_SOURCES.join(', ')}`);
  }

  if (success) {
    await sql`
      INSERT INTO source_health (source, last_success_at, last_attempt_at, last_row_count, last_error, consecutive_failures, updated_at)
      VALUES (${source}, now(), now(), ${rowCount ?? null}, NULL, 0, now())
      ON CONFLICT (source) DO UPDATE SET
        last_success_at = now(),
        last_attempt_at = now(),
        last_row_count = ${rowCount ?? null},
        last_error = NULL,
        consecutive_failures = 0,
        updated_at = now()
    `;
  } else {
    await sql`
      INSERT INTO source_health (source, last_attempt_at, last_error, consecutive_failures, updated_at)
      VALUES (${source}, now(), ${error ?? 'Okänt fel'}, 1, now())
      ON CONFLICT (source) DO UPDATE SET
        last_attempt_at = now(),
        last_error = ${error ?? 'Okänt fel'},
        consecutive_failures = source_health.consecutive_failures + 1,
        updated_at = now()
    `;
  }

  // Larma om 2+ misslyckanden i rad — justera tröskel efter smak
  const { rows } = await sql`SELECT consecutive_failures FROM source_health WHERE source = ${source}`;
  if (!success && rows[0]?.consecutive_failures >= 2) {
    await alertFailure(source, error);
  }
}

/**
 * Skickar ett larm via webhook (Slack/Discord/generic). Sätt ALERT_WEBHOOK_URL
 * i Vercel env vars. Om den inte är satt loggas bara till console.
 * (Delar logik med lib/notify.js så vi bara underhåller Discord/Slack-formatet
 * på ett ställe.)
 */
async function alertFailure(source, error) {
  const message = `🚨 BudRadar: källan "${source}" har misslyckats 2+ gånger i rad. Senaste fel: ${error}`;
  await sendAlert(message);
}

/**
 * Hämta status för alla källor — används av /api/health.
 */
export async function getAllHealth() {
  const { rows } = await sql`SELECT * FROM source_health ORDER BY source`;
  return rows;
}
