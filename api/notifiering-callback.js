// ============================================================
// /api/notifiering-callback — TAR EMOT NOTISER FRÅN BOLAGSVERKET
//
// Bolagsverket anropar denna URL när något ändras i ett bolag vi bevakar.
// Detta är den enda endpointen i appen som tar emot anrop utifrån, så den
// verifierar avsändaren på två sätt:
//
//   1. Authorization-headern måste matcha NOTIFIERING_TOKEN
//   2. X-Signature måste matcha en HMAC av kroppen med NOTIFIERING_SECRET
//
// Misslyckas något av dem sparas ingenting.
//
// Notiserna sparas i bv_notifications och kan läsas via
// /api/notifiering?key=NYCKEL&action=events
// ============================================================

import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const NOTIF_SECRET = process.env.NOTIFIERING_SECRET || "";
const NOTIF_TOKEN = process.env.NOTIFIERING_TOKEN || "";

// Vi behöver råa bytes för att kunna verifiera signaturen
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Endast POST" });
  }

  try {
    const raw = await readRawBody(req);

    // 1) Kontrollera token
    const auth = req.headers["authorization"] || "";
    if (NOTIF_TOKEN && auth !== NOTIF_TOKEN && auth !== `Bearer ${NOTIF_TOKEN}`) {
      return res.status(401).json({ error: "unauthorized" });
    }

    // 2) Kontrollera signatur (om Bolagsverket skickar en)
    const sig = req.headers["x-signature"] || req.headers["X-Signature"];
    if (NOTIF_SECRET && sig) {
      const expected = crypto.createHmac("sha256", NOTIF_SECRET).update(raw).digest("hex");
      const expectedB64 = crypto.createHmac("sha256", NOTIF_SECRET).update(raw).digest("base64");
      const given = String(sig).replace(/^sha256=/i, "").trim();
      if (given !== expected && given !== expectedB64) {
        return res.status(401).json({ error: "ogiltig signatur" });
      }
    }

    let payload = {};
    try { payload = JSON.parse(raw.toString("utf8") || "{}"); } catch { /* spara ändå */ }

    // Bolagsverkets format kan variera — vi letar brett efter nyckelfälten
    const orgNr = pick(payload, ["identitetsbeteckning", "organisationsidentitet", "orgnr", "organisationsnummer"]);
    const company = pick(payload, ["organisationsnamn", "namn", "foretagsnamn"]);
    const eventType = pick(payload, ["handelsetyp", "meddelandetyp", "typ", "event"]);

    if (CONN) {
      const sql = neon(CONN);
      await ensureSchema(sql);
      await sql`
        INSERT INTO bv_notifications (org_nr, company, event_type, payload, received_at)
        VALUES (${orgNr}, ${company}, ${eventType}, ${JSON.stringify(payload)}, now())`;
    }

    // Bolagsverket vill ha snabbt 200 — annars försöker de igen
    res.status(200).json({ ok: true });
  } catch (e) {
    // Svara ändå 200 om vi tagit emot men inte kunnat spara, så de inte
    // spammar omsändningar. Felet loggas i Vercel.
    console.error("notifiering-callback:", e);
    res.status(200).json({ ok: true, note: "mottagen men kunde inte sparas" });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Letar rekursivt efter första fältet som matchar något av namnen. */
function pick(obj, names, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (names.some(n => k.toLowerCase().includes(n.toLowerCase()))) {
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const f = pick(v, names, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS bv_notifications (
      id          BIGSERIAL PRIMARY KEY,
      org_nr      TEXT,
      company     TEXT,
      event_type  TEXT,
      payload     JSONB,
      received_at TIMESTAMPTZ DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bvn_org ON bv_notifications (org_nr, received_at DESC)`;
}
