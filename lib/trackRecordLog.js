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

// ---------- Kanonisk hashning (v2, 2026-11-17) ----------
// v1 hashade råvärden. Det bröt kedjan direkt: Postgres returnerar score som
// "100.00" (NUMERIC) och jsonb sorterar om nycklarna i signal_snapshot, så
// samma rad gav olika hash vid insert och vid verifiering. v2 normaliserar
// varje fält till en entydig form innan hashning.
function canonical(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonical);
  return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
}
function normSnapshot(s) {
  if (s == null) return null;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return s; } }
  return canonical(s);
}
const normScore = (x) => (x == null || x === '' ? null : Number(x).toFixed(2));
const normDate = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

export function computeRowHash({ company_name, org_nr, flag_reason, score, signal_snapshot, prev_hash, created_at }) {
  const payload = JSON.stringify({
    v: 2,
    company_name: company_name ?? null,
    org_nr: org_nr ?? null,
    flag_reason: flag_reason ?? null,
    score: normScore(score),
    signal_snapshot: normSnapshot(signal_snapshot),
    prev_hash,
    created_at: normDate(created_at),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Lägg till en ny flagg i track record-loggen.
 * Skriver till Postgres OCH committar till ett publikt GitHub-repo
 * som extern, oberoende tidsstämpel.
 *
 * @param {string} [source='live'] — 'live' (framåtblickande, det starka beviset)
 *   eller 'historical_verification' (bakåtblickande import, utfallet redan känt).
 * @param {string} [created_at_override] — ISO-datum att använda istället för nu.
 *   ENDAST för historical_verification — en live-flagg ska alltid tidsstämplas nu.
 * @param {string} [initial_outcome] — sätt utfall direkt vid insert (för historik
 *   där utfallet redan är känt). Live-flaggor ska INTE använda detta — de börjar
 *   som 'pending', det är hela poängen.
 * @param {string} [outcome_date]
 * @param {string} [outcome_note]
 * @param {boolean} [notify=true] — sätt false vid bulk-import för att undvika
 *   att spamma Discord med gamla, redan kända affärer.
 */
export async function appendFlag({
  company_name, org_nr, ticker, flag_reason, score, signal_snapshot,
  source = 'live', created_at_override = null,
  initial_outcome = null, outcome_date = null, outcome_note = null,
  notify = true,
}) {
  if (source === 'live' && created_at_override) {
    throw new Error('created_at_override får bara användas för historical_verification — en live-flagg måste tidsstämplas nu.');
  }

  // Hämta senaste radens hash för kedjan
  const { rows } = await sql`
    SELECT row_hash FROM track_record_log
    ORDER BY id DESC
    LIMIT 1
  `;
  const prev_hash = rows.length > 0 ? rows[0].row_hash : GENESIS_HASH;
  const created_at = created_at_override || new Date().toISOString();

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
      (company_name, org_nr, ticker, flag_reason, score, signal_snapshot, row_hash, prev_hash, created_at,
       source, outcome, outcome_date, outcome_note)
    VALUES
      (${company_name}, ${org_nr}, ${ticker}, ${flag_reason}, ${score}, ${JSON.stringify(signal_snapshot)},
       ${row_hash}, ${prev_hash}, ${created_at},
       ${source}, ${initial_outcome || 'pending'}, ${outcome_date}, ${outcome_note})
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
  if (notify) {
    try {
      await notifyNewFlag({
        id: logId,
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
  let reseals = [];
  try {
    const r = await sql`SELECT resealed_at, reason, rows, old_head, new_head FROM track_record_reseals ORDER BY resealed_at ASC`;
    reseals = r.rows;
  } catch { /* tabellen skapas vid första omförseglingen */ }

  for (const row of rows) {
    if (row.prev_hash !== expectedPrevHash) {
      return { valid: false, brokenAtId: row.id, reason: 'prev_hash matchar inte föregående rads row_hash', reseals };
    }
    if (computeRowHash(row) !== row.row_hash) {
      return { valid: false, brokenAtId: row.id, reason: 'row_hash matchar inte innehållet — raden har ändrats', reseals };
    }
    expectedPrevHash = row.row_hash;
  }

  return {
    valid: true,
    totalRows: rows.length,
    firstId: rows.length ? rows[0].id : null,
    lastId: rows.length ? rows[rows.length - 1].id : null,
    head: expectedPrevHash,
    reseals,
  };
}

/**
 * Försegla om hela kedjan med aktuell hashfunktion. Används EN gång när
 * hashformatet ändras. Ändrar inga flaggor — bara prev_hash/row_hash — och
 * loggar händelsen öppet i track_record_reseals så att den syns publikt.
 */
export async function resealChain(reason) {
  if (!reason) throw new Error('Ange en anledning — omförseglingar ska alltid vara motiverade.');
  await sql`
    CREATE TABLE IF NOT EXISTS track_record_reseals (
      id serial PRIMARY KEY,
      resealed_at timestamptz NOT NULL DEFAULT now(),
      reason text NOT NULL,
      rows integer NOT NULL,
      old_head text,
      new_head text NOT NULL
    )
  `;
  const { rows } = await sql`
    SELECT id, company_name, org_nr, flag_reason, score, signal_snapshot, row_hash, prev_hash, created_at
    FROM track_record_log ORDER BY id ASC
  `;
  const oldHead = rows.length ? rows[rows.length - 1].row_hash : null;
  let prev = GENESIS_HASH;
  for (const row of rows) {
    const h = computeRowHash({ ...row, prev_hash: prev });
    await sql`UPDATE track_record_log SET prev_hash = ${prev}, row_hash = ${h} WHERE id = ${row.id}`;
    prev = h;
  }
  await sql`INSERT INTO track_record_reseals (reason, rows, old_head, new_head) VALUES (${reason}, ${rows.length}, ${oldHead}, ${prev})`;
  return { rows: rows.length, oldHead, newHead: prev };
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
