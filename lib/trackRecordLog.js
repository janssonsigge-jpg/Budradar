// lib/trackRecordLog.js
//
// Append-only, hash-kedjad logg över alla flaggningar BudRadar gör.
// Syfte: göra det verifierbart att en flagg skedde INNAN utfallet var känt.
// Varje rad innehåller hash(föregående rad + denna rads data), så om
// någon i efterhand skulle manipulera en gammal rad bryts kedjan och
// verify() upptäcker det direkt.
//
// Detta är INTE blockchain och behöver inte vara det — poängen är bara
// en verifierbar append-only-struktur, inte distribuerad konsensus.

import crypto from 'crypto';
import { sql } from './db.js';
import { commitFlagToGithub } from './githubTimestamp.js';
import { notifyNewFlag } from './notify.js';

const GENESIS_HASH = 'genesis';

function computeRowHash({ company_name, org_nr, flag_reason, score, signal_snapshot, prev_hash, created_at }) {
  const payload = JSON.stringify({
    company_name,
    org_nr,
    flag_reason,
    score,
    signal_snapshot,
    prev_hash,
    created_at,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Lägg till en ny flagg i track record-loggen.
 * Skriver till Postgres OCH committar till ett publikt GitHub-repo
 * som extern, oberoende tidsstämpel.
 */
export async function appendFlag({ company_name, org_nr, ticker, flag_reason, score, signal_snapshot }) {
  // Hämta senaste radens hash för kedjan
  const { rows } = await sql`
    SELECT row_hash FROM track_record_log
    ORDER BY id DESC
    LIMIT 1
  `;
  const prev_hash = rows.length > 0 ? rows[0].row_hash : GENESIS_HASH;
  const created_at = new Date().toISOString();

  const row_hash = computeRowHash({
    company_name,
    org_nr,
    flag_reason,
    score,
    signal_snapshot,
    prev_hash,
    created_at,
  });

  const inserted = await sql`
    INSERT INTO track_record_log
      (company_name, org_nr, ticker, flag_reason, score, signal_snapshot, row_hash, prev_hash, created_at)
    VALUES
      (${company_name}, ${org_nr}, ${ticker}, ${flag_reason}, ${score}, ${JSON.stringify(signal_snapshot)}, ${row_hash}, ${prev_hash}, ${created_at})
    RETURNING id
  `;

  const logId = inserted.rows[0].id;

  // Extern tidsstämpel — best effort, ska INTE blockera flaggningen om GitHub är nere
  let commitSha = null;
  try {
    commitSha = await commitFlagToGithub({
      id: logId,
      company_name,
      org_nr,
      flag_reason,
      score,
      row_hash,
      prev_hash,
      created_at,
    });
    if (commitSha) {
      await sql`UPDATE track_record_log SET github_commit_sha = ${commitSha} WHERE id = ${logId}`;
    }
  } catch (err) {
    console.error('GitHub timestamp commit misslyckades (icke-blockerande):', err.message);
  }

  // Notis — icke-blockerande, ska aldrig få hela flaggningen att faila
  try {
    await notifyNewFlag({
      company_name,
      org_nr,
      score,
      flag_reason,
      registered_at: signal_snapshot?.registered_at,
      matchedAdvisor: signal_snapshot?.matchedAdvisor,
      githubCommitSha: commitSha,
      githubRepo: process.env.GITHUB_TIMESTAMP_REPO,
    });
  } catch (err) {
    console.error('Notis misslyckades (icke-blockerande):', err.message);
  }

  return { id: logId, row_hash, prev_hash };
}

/**
 * Verifiera hela kedjans integritet. Returnerar { valid: boolean, brokenAtId?: number }.
 * Kör denna publikt (t.ex. via /api/track-record/verify) så vem som helst
 * kan bekräfta att loggen inte manipulerats.
 */
export async function verifyChain() {
  const { rows } = await sql`
    SELECT id, company_name, org_nr, flag_reason, score, signal_snapshot, row_hash, prev_hash, created_at
    FROM track_record_log
    ORDER BY id ASC
  `;

  let expectedPrevHash = GENESIS_HASH;

  for (const row of rows) {
    if (row.prev_hash !== expectedPrevHash) {
      return { valid: false, brokenAtId: row.id, reason: 'prev_hash matchar inte föregående rads row_hash' };
    }
    const recomputed = computeRowHash({
      company_name: row.company_name,
      org_nr: row.org_nr,
      flag_reason: row.flag_reason,
      score: row.score,
      signal_snapshot: row.signal_snapshot,
      prev_hash: row.prev_hash,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    });
    if (recomputed !== row.row_hash) {
      return { valid: false, brokenAtId: row.id, reason: 'row_hash matchar inte innehållet — raden har manipulerats' };
    }
    expectedPrevHash = row.row_hash;
  }

  return { valid: true, totalRows: rows.length };
}

/**
 * Uppdatera utfall för en flagg när ett bud faktiskt kommer (eller inte).
 * Detta lägger INTE till en ny rad i hash-kedjan (skulle bryta append-only-
 * principen för själva flaggen) — det är en separat kolumn som får uppdateras,
 * eftersom utfallet per definition är känt EFTER flaggen och inte påverkar
 * beviset om NÄR flaggen begicks.
 */
export async function recordOutcome({ id, outcome, outcome_note }) {
  if (!['hit', 'miss', 'expired'].includes(outcome)) {
    throw new Error(`Ogiltigt outcome: ${outcome}`);
  }
  await sql`
    UPDATE track_record_log
    SET outcome = ${outcome}, outcome_date = now(), outcome_note = ${outcome_note || null}
    WHERE id = ${id}
  `;
}
