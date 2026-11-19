// lib/access.js
//
// Betalväggen i en fil: API-nycklar, kvoter, väntelista och "försegling".
//
// FÖRSEGLING (commit–reveal)
//   En live-flagga är förseglad i DELAY_DAYS dagar. Under den tiden visar den
//   publika sidan bara id, tid, poäng och row_hash — inte bolagsnamn eller org.nr.
//   Hashen bevisar att flaggan fanns vid den tidpunkten (den ingår i kedjan och
//   förankras dagligen i ANCHORS.md). När förseglingen släpps, eller när budet
//   blivit offentligt (outcome = hit), visas allt och vem som helst kan räkna om
//   hashen. API-kunder ser allt direkt.
//
// TABELLER skapas automatiskt vid första anrop (samma mönster som
// track_record_reseals) — ingen manuell SQL behövs. Se även sql/003_api.sql.

import crypto from 'crypto';
import { sql } from './db.js';

export const DELAY_DAYS = Number(process.env.FREE_DELAY_DAYS || 30);
const DAY_MS = 86400000;

export const PLANS = {
  partner: { daily: 2000, label: 'Designpartner' },
  pro: { daily: 500, label: 'Pro' },
  fund: { daily: 20000, label: 'Fond' },
};

// ---------------------------------------------------------------- tabeller
let tablesReady = false;
export async function ensureTables() {
  if (tablesReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id serial PRIMARY KEY,
      key_hash text UNIQUE NOT NULL,
      key_prefix text NOT NULL,
      owner text NOT NULL,
      email text,
      plan text NOT NULL DEFAULT 'partner',
      daily_quota integer NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS api_usage (
      key_id integer NOT NULL REFERENCES api_keys(id),
      day date NOT NULL,
      count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, day)
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS waitlist_signups (
      id serial PRIMARY KEY,
      email text NOT NULL,
      interest text NOT NULL DEFAULT 'free',
      company text,
      message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (email, interest)
    )`;
  tablesReady = true;
}

// ---------------------------------------------------------------- nycklar
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

export async function createKey({ owner, email = null, plan = 'partner', note = null, daily_quota = null }) {
  if (!owner) throw new Error('owner krävs');
  if (!PLANS[plan]) throw new Error(`Okänd plan: ${plan}. Giltiga: ${Object.keys(PLANS).join(', ')}`);
  await ensureTables();
  const key = 'br_live_' + crypto.randomBytes(24).toString('base64url');
  const quota = daily_quota || PLANS[plan].daily;
  const { rows } = await sql`
    INSERT INTO api_keys (key_hash, key_prefix, owner, email, plan, daily_quota, note)
    VALUES (${hashKey(key)}, ${key.slice(0, 12)}, ${owner}, ${email}, ${plan}, ${quota}, ${note})
    RETURNING id, key_prefix, owner, plan, daily_quota, created_at`;
  // Klartextnyckeln returneras EN gång. Vi sparar bara hashen.
  return { ...rows[0], key };
}

export async function listKeys() {
  await ensureTables();
  const { rows } = await sql`
    SELECT k.id, k.key_prefix, k.owner, k.email, k.plan, k.daily_quota, k.note,
           k.created_at, k.last_used_at, k.revoked_at,
           COALESCE(u.count, 0)::int AS used_today
    FROM api_keys k
    LEFT JOIN api_usage u ON u.key_id = k.id AND u.day = CURRENT_DATE
    ORDER BY k.id`;
  return rows;
}

export async function revokeKey(id) {
  await ensureTables();
  await sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
}

function readKey(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer br_')) return h.slice(7).trim();
  const x = req.headers['x-api-key'];
  if (x && String(x).startsWith('br_')) return String(x).trim();
  return null;
}

/**
 * Autentiserar och räknar kvot. Returnerar { key } eller { error, status }.
 * Varje lyckat anrop räknas — även 404:or — så kvoten är förutsägbar.
 */
export async function authenticate(req) {
  const raw = readKey(req);
  if (!raw) return { status: 401, error: 'API-nyckel saknas. Skicka "Authorization: Bearer br_live_..." — ansök om nyckel på /api-docs' };
  await ensureTables();
  const { rows } = await sql`
    SELECT id, owner, plan, daily_quota, revoked_at FROM api_keys WHERE key_hash = ${hashKey(raw)}`;
  const key = rows[0];
  if (!key) return { status: 401, error: 'Ogiltig API-nyckel' };
  if (key.revoked_at) return { status: 403, error: 'API-nyckeln är spärrad' };

  const { rows: u } = await sql`
    INSERT INTO api_usage (key_id, day, count) VALUES (${key.id}, CURRENT_DATE, 1)
    ON CONFLICT (key_id, day) DO UPDATE SET count = api_usage.count + 1
    RETURNING count`;
  const used = Number(u[0].count);
  sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${key.id}`.catch(() => {});
  if (used > key.daily_quota) {
    return { status: 429, error: `Dygnskvoten (${key.daily_quota} anrop) är förbrukad. Nollställs 00:00 UTC.`, key, used };
  }
  return { key, used };
}

// ---------------------------------------------------------------- försegling
// Rådgivarens namn i flag_reason (t.ex. "adressbyte_advokat_Advokatfirman_Delphi") räcker
// för att hitta bolaget via adress + datum, så det tas bort i den publika vyn.
export function publicReason(r) {
  return String(r || '').replace(/(adressbyte_advokat|advokatadress)_[^+]+/g, '$1');
}

export function isSealed(flag, now = Date.now()) {
  if (flag.source === 'historical_verification') return false;
  if (flag.outcome === 'hit') return false; // budet är offentligt — inget kvar att skydda
  return now - new Date(flag.created_at).getTime() < DELAY_DAYS * DAY_MS;
}

export function revealAt(flag) {
  return new Date(new Date(flag.created_at).getTime() + DELAY_DAYS * DAY_MS).toISOString();
}

/**
 * Publik version av en track_record_log-rad. Samma fält som originalet så att
 * befintliga renderare fungerar, men identifierande innehåll är borttaget.
 */
export function sealTrackRow(f) {
  if (!isSealed(f)) return { ...f, sealed: false };
  return {
    id: f.id,
    company_name: `Förseglad flagga #${f.id}`,
    org_nr: null,
    ticker: null,
    flag_reason: publicReason(f.flag_reason),
    score: f.score,
    outcome: f.outcome,
    outcome_date: null,
    outcome_note: null,
    source: f.source,
    row_hash: f.row_hash,
    github_commit_sha: f.github_commit_sha || null,
    created_at: f.created_at,
    sealed: true,
    reveal_at: revealAt(f),
  };
}

// ---------------------------------------------------------------- väntelista
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function addToWaitlist({ email, interest = 'free', company = null, message = null }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw Object.assign(new Error('Ogiltig e-postadress'), { status: 400 });
  if (!['free', 'pro', 'api'].includes(interest)) interest = 'free';
  await ensureTables();
  await sql`
    INSERT INTO waitlist_signups (email, interest, company, message)
    VALUES (${email}, ${interest}, ${company ? String(company).slice(0, 200) : null}, ${message ? String(message).slice(0, 2000) : null})
    ON CONFLICT (email, interest) DO NOTHING`;
  return { ok: true };
}

export async function listWaitlist() {
  await ensureTables();
  const { rows } = await sql`SELECT * FROM waitlist_signups ORDER BY created_at DESC`;
  return rows;
}
