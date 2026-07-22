// ============================================================
// /api/bolagsverket — REGISTRERINGSDATUM FÖR BIDCOS
//
// Detta är kärnan i BudRadars tes: avståndet mellan att budgivaren
// registrerar sitt skalbolag och att budet blir offentligt.
//
// Bolagsverkets "API för värdefulla datamängder" är AVGIFTSFRITT enligt
// EU-direktiv och fritt att bygga på — till skillnad från Börsdata, som
// förbjuder externa hemsidor. Detta är alltså den enda datakällan i
// projektet som både är unik och juridiskt ren.
//
// KRÄVER i Vercel:
//   BOLAGSVERKET_CLIENT_ID
//   BOLAGSVERKET_CLIENT_SECRET
//   BOLAGSVERKET_ENV = "test" eller "prod"   (default: test)
//
// ANVÄNDNING
//   /api/bolagsverket?key=NYCKEL&orgNr=559520-3331
//        → hämtar bolaget och sparar registreringsdatum i bidco_registry
//   /api/bolagsverket?key=NYCKEL&orgNr=...&announced=2025-03-10
//        → sparar även budets datum och räknar ut gapet direkt
//   /api/bolagsverket?key=NYCKEL&ping=1
//        → testar bara att autentiseringen fungerar
// ============================================================

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const CLIENT_ID = process.env.BOLAGSVERKET_CLIENT_ID;
const CLIENT_SECRET = process.env.BOLAGSVERKET_CLIENT_SECRET;
const ENV = (process.env.BOLAGSVERKET_ENV || "test").toLowerCase();

// Bolagsverket har TVÅ olika hostar:
//   portal.api.bolagsverket.se → OAuth2-token och dokumentation
//   gw.api.bolagsverket.se     → själva API-anropen (gateway)
// Att blanda ihop dem ger 403 med en HTML-sida istället för JSON.
const TOKEN_URL = "https://portal.api.bolagsverket.se/oauth2/token";
const API_BASE = "https://gw.api.bolagsverket.se/vardefulla-datamangder/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const key = req.query && req.query.key;
  if (process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({
      error: "Saknar BOLAGSVERKET_CLIENT_ID / BOLAGSVERKET_CLIENT_SECRET",
      hjälp: "Lägg in dem i Vercel → Settings → Environment Variables och gör Redeploy.",
    });
  }

  try {
    const q = req.query || {};

    // Enkelt anslutningstest
    if (q.ping === "1") {
      const token = await getToken();
      return res.status(200).json({
        ok: true, miljö: ENV, tokenUrl: TOKEN_URL, apiBase: API_BASE,
        token: token ? "hämtad" : "misslyckades",
        nästaSteg: "Testa ett bolag: ?key=DIN_NYCKEL&orgNr=559520-3331",
      });
    }

    const orgNr = normOrgNr(q.orgNr);
    if (!orgNr) {
      return res.status(400).json({
        error: "orgNr saknas",
        exempel: "/api/bolagsverket?key=DIN_NYCKEL&orgNr=559520-3331",
      });
    }

    const info = await fetchCompany(orgNr);
    if (!info) return res.status(404).json({ error: "Bolaget hittades inte", orgNr, miljö: ENV });

    // Spara om vi fick ett registreringsdatum
    let saved = null, dagarTillBud = null;
    const announced = (q.announced || "").match(/^\d{4}-\d{2}-\d{2}$/) ? q.announced : null;

    if (CONN && info.registrationDate) {
      const sql = neon(CONN);
      await ensureSchema(sql);
      await sql`
        INSERT INTO bidco_registry (bidco, org_nr, registered, announced, updated_at)
        VALUES (${info.name || orgNr}, ${orgNr}, ${info.registrationDate}, ${announced}, now())
        ON CONFLICT (bidco) DO UPDATE SET
          org_nr = EXCLUDED.org_nr,
          registered = EXCLUDED.registered,
          announced = COALESCE(EXCLUDED.announced, bidco_registry.announced),
          updated_at = now()`;
      const [row] = await sql`SELECT * FROM bidco_registry WHERE org_nr = ${orgNr} LIMIT 1`;
      saved = row;
      if (row && row.registered && row.announced) {
        dagarTillBud = Math.round((Date.parse(row.announced) - Date.parse(row.registered)) / 864e5);
      }
    }

    res.status(200).json({
      ok: true, miljö: ENV,
      bolag: info,
      sparad: saved,
      dagarTillBud,
      kommentar: dagarTillBud != null
        ? `${info.name} registrerades ${dagarTillBud} dagar före budet.`
        : info.registrationDate
          ? "Registreringsdatum sparat. Lägg till &announced=ÅÅÅÅ-MM-DD för att räkna ut gapet."
          : "Inget registreringsdatum i svaret — se rawKeys för vad som fanns.",
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({
      error: msg,
      miljö: ENV,
      tolkning: msg.includes("401") || msg.includes("invalid_client")
        ? "Autentisering nekad — kontrollera client id/secret."
        : msg.includes("403") ? "Åtkomst nekad — kontrollera att sökvägen är rätt (se Developer Portal) och att din prenumeration täcker API:t."
        : msg.includes("404") ? "Endpoint hittades inte — kontrollera sökvägen mot Developer Portal."
        : msg.includes("400") ? "Felaktig begäran — kontrollera formatet på organisationsnumret."
        : "Okänt fel.",
      användeApiBase: API_BASE,
    });
  }
}

// ---------- OAuth2 (client credentials) ----------
let TOKEN_CACHE = { ts: 0, token: null };

async function getToken() {
  if (TOKEN_CACHE.token && Date.now() - TOKEN_CACHE.ts < 45 * 60 * 1000) return TOKEN_CACHE.token;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "vardefulla-datamangder:read",
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token HTTP ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  TOKEN_CACHE = { ts: Date.now(), token: j.access_token };
  return j.access_token;
}

// ---------- Hämta bolagsinformation ----------
async function fetchCompany(orgNr) {
  const token = await getToken();
  const clean = orgNr.replace("-", "");

  // Värdefulla datamängder: /organisationer tar emot ett eller flera orgnr.
  const r = await fetch(`${API_BASE}/organisationer`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ identitetsbeteckning: [clean] }),
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`organisationer HTTP ${r.status}: ${text.slice(0, 300)}`);

  let j;
  try { j = JSON.parse(text); } catch { throw new Error("kunde inte tolka svaret som JSON"); }

  const org = pickOrg(j);
  if (!org) return null;

  return {
    orgNr,
    name: deepFind(org, ["namn", "organisationsnamn", "foretagsnamn"]) || null,
    registrationDate: normDate(deepFind(org, ["registreringsdatum", "registreringstidpunkt", "bildatDatum", "startdatum"])),
    legalForm: deepFind(org, ["juridiskForm", "organisationsform"]) || null,
    status: deepFind(org, ["status", "avregistrerad"]) || null,
    // Hjälper felsökning om fältnamnen skiljer sig från vad vi gissat
    rawKeys: Object.keys(org).slice(0, 30),
  };
}

/** Plockar ut organisationsobjektet oavsett hur svaret är inkapslat. */
function pickOrg(j) {
  if (!j || typeof j !== "object") return null;
  for (const k of ["organisationer", "organisation", "foretag", "results", "data"]) {
    const v = j[k];
    if (Array.isArray(v) && v.length) return v[0];
    if (v && typeof v === "object") return v;
  }
  if (Array.isArray(j) && j.length) return j[0];
  return j;
}

/** Letar rekursivt efter första fältet vars namn matchar någon av kandidaterna. */
function deepFind(obj, names, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return null;
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (names.some(n => lk === n.toLowerCase() || lk.includes(n.toLowerCase()))) {
      if (typeof v === "string" || typeof v === "number") return String(v);
      if (v && typeof v === "object") {
        const inner = v.varde ?? v.value ?? v.kod ?? v.beskrivning;
        if (typeof inner === "string" || typeof inner === "number") return String(inner);
      }
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = deepFind(v, names, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function normOrgNr(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, "");
  if (d.length !== 10) return null;
  return `${d.slice(0, 6)}-${d.slice(6)}`;
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS bidco_registry (
      bidco      TEXT PRIMARY KEY,
      org_nr     TEXT,
      registered DATE,
      announced  DATE,
      bud_id     TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
}
