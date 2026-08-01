-- sql/002_bolagsverket_seen.sql
-- Håller reda på vilka organisationsnummer vi redan sett i Bolagsverkets
-- bulkfil, så vi kan identifiera NYA registreringar varje vecka via diff.

CREATE TABLE IF NOT EXISTS bolagsverket_seen (
    org_nr          TEXT PRIMARY KEY,
    name            TEXT,
    orgform         TEXT,
    registered_at   DATE,
    description     TEXT,
    address         TEXT,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bv_seen_registered ON bolagsverket_seen (registered_at DESC);

-- Loggar varje veckokörning, så vi vet om bootstrap redan kört och kan se historik
CREATE TABLE IF NOT EXISTS bolagsverket_scan_runs (
    run_id          TEXT PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running',
    total_rows      INTEGER,
    new_orgs        INTEGER,
    candidates      INTEGER,
    flagged         INTEGER,
    orgform_counts  JSONB,
    error           TEXT
);
