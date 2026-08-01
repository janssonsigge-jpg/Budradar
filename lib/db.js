// lib/db.js
// Tunn wrapper runt @neondatabase/serverless (redan ert paket i package.json).
// Vercel Postgres-integrationen är numera byggd på Neon under huven, så detta
// är rätt klient för er setup.
//
// Env var: kollar flera vanliga namn eftersom Vercel↔Neon-integrationen kan
// sätta olika variabelnamn beroende på hur kopplingen gjordes
// (DATABASE_URL, POSTGRES_URL, DATABASE_URL_UNPOOLED).

import { neon } from '@neondatabase/serverless';

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED;

if (!connectionString) {
  throw new Error(
    'Ingen databas-connection string hittad. Förväntade DATABASE_URL, POSTGRES_URL eller DATABASE_URL_UNPOOLED i env vars.'
  );
}

// `sql` är en tagged-template-funktion, exakt samma användningsmönster
// som i alla andra lib/api-filer: await sql`SELECT ... WHERE x = ${val}`
export const sql = neon(connectionString);
