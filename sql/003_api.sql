-- 003_api.sql — betalvägg och API v1
-- Skapas automatiskt av lib/access.js vid första anrop. Filen finns för dokumentation.

CREATE TABLE IF NOT EXISTS api_keys (
  id serial PRIMARY KEY,
  key_hash text UNIQUE NOT NULL,        -- sha256 av nyckeln, klartext sparas aldrig
  key_prefix text NOT NULL,             -- "br_live_xxxx" för att känna igen nyckeln
  owner text NOT NULL,
  email text,
  plan text NOT NULL DEFAULT 'partner', -- partner | pro | fund
  daily_quota integer NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS api_usage (
  key_id integer NOT NULL REFERENCES api_keys(id),
  day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id serial PRIMARY KEY,
  email text NOT NULL,
  interest text NOT NULL DEFAULT 'free', -- free | pro | api
  company text,
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, interest)
);
