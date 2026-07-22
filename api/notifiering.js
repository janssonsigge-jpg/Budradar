// ============================================================
// /api/notifiering — PRENUMERATION PÅ BOLAGSHÄNDELSER
//
// Bolagsverket kan meddela oss i realtid när något ändras i bolag vi
// bevakar: styrelseändringar, adressbyten, nya firmatecknare, likvidation.
// Det är faktiska händelser hos potentiella uppköpsmål, direkt från källan.
//
// SÅ FUNGERAR DET
//   1. Vi skapar en prenumeration med en callback-URL (vår /api/notifiering-callback)
//   2. Vi lägger till organisationsnummer vi vill bevaka (upp till 200 000)
//   3. Bolagsverket anropar vår callback när något händer
//
// VIKTIG BEGRÄNSNING
//   Man kan bara prenumerera på organisationsnummer man REDAN känner till.
//   Det går alltså inte att få notiser om nyregistrerade bolag (t.ex. nya
//   bidcos) — för dem krävs POIT eller motsvarande.
//
// KRÄVER i Vercel:
//   BOLAGSVERKET_CLIENT_ID, BOLAGSVERKET_CLIENT_SECRET
//   NOTIFIERING_SECRET     — hemlighet vi delar med Bolagsverket (X-Signature)
//   NOTIFIERING_TOKEN      — token de skickar tillbaka i Authorization-headern
//
// ANVÄNDNING
//   ?key=NYCKEL&action=status              visa prenumerationer
//   ?key=NYCKEL&action=setup               skapa/uppdatera prenumerationen
//   ?key=NYCKEL&action=add&orgNr=A,B,C     lägg till bolag att bevaka
//   ?key=NYCKEL&action=remove&orgNr=A      sluta bevaka
//   ?key=NYCKEL&action=list                visa bevakade bolag
// ============================================================

import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const CLIENT_ID = process.env.BOLAGSVERKET_CLIENT_ID;
const CLIENT_SECRET = process.env.BOLAGSVERKET_CLIENT_SECRET;
const NOTIF_SECRET = process.env.NOTIFIERING_SECRET || "";
const NOTIF_TOKEN = process.env.NOTIFIERING_TOKEN || "";

const TOKEN_URL = "https://portal.api.bolagsverket.se/oauth2/token";
const API_BASE = "https://gw.api.bolagsverket.se/notifiering/v1";
const SUB_NAME = "budradar";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const key = req.query && req.query.key;
  if (process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: "Saknar BOLAGSVERKET_CLIENT_ID / _SECRET" });
  }

  const action = (req.query.action || "status").toLowerCase();

  try {
    switch (action) {
      case "ping": {
        const r = await bv("GET", "/isalive", null, "notifiering:ping");
        return res.status(200).json({ ok: true, isalive: r });
      }

      case "status": {
        const subs = await bv("GET", "/prenumerationer", null, "notifiering:read");
        return res.status(200).json({ ok: true, prenumerationer: subs });
      }

      case "setup": {
        // Callback-URL måste peka på vår egen app
        const proto = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const callbackUrl = `${proto}://${host}/api/notifiering-callback`;

        if (!NOTIF_SECRET || !NOTIF_TOKEN) {
          return res.status(500).json({
            error: "Saknar NOTIFIERING_SECRET och/eller NOTIFIERING_TOKEN",
            hjälp: "Hitta på två långa slumpsträngar och lägg in dem i Vercel. " +
                   "De används för att verifiera att notiserna verkligen kommer från Bolagsverket.",
          });
        }

        const body = {
          callbackUrl,
          authorizationHeaderNamn: "Authorization",
          authorizationHeaderData: NOTIF_TOKEN,
          xSignatureSecret: NOTIF_SECRET,
          meddelandetyp: "FORETAGSINFO",
        };
        const r = await bv("PUT", `/prenumerationer/${SUB_NAME}`, body, "notifiering:write");
        return res.status(200).json({ ok: true, callbackUrl, svar: r });
      }

      case "add":
      case "remove": {
        const list = String(req.query.orgNr || "")
          .split(",").map(s => s.replace(/\D/g, "")).filter(s => s.length === 10);
        if (!list.length) {
          return res.status(400).json({ error: "Ange orgNr, kommaseparerat. Exempel: &orgNr=5565018909,5560125790" });
        }
        const body = { atgard: action === "add" ? "SKAPA" : "RADERA", dataidentiteter: list };
        const r = await bv("POST", `/prenumerationer/${SUB_NAME}/dataidentiteter`, body, "notifiering:write");
        return res.status(200).json({ ok: true, atgard: body.atgard, antal: list.length, svar: r });
      }

      case "list": {
        const r = await bv("GET", `/prenumerationer/${SUB_NAME}/dataidentiteter`, null, "notifiering:read");
        return res.status(200).json({ ok: true, bevakade: r });
      }

      case "events": {
        // Visa mottagna notiser ur databasen
        if (!CONN) return res.status(500).json({ error: "Ingen databas" });
        const sql = neon(CONN);
        await ensureSchema(sql);
        const rows = await sql`
          SELECT org_nr, company, event_type, payload, received_at
          FROM bv_notifications ORDER BY received_at DESC LIMIT 100`;
        return res.status(200).json({ ok: true, count: rows.length, händelser: rows });
      }

      default:
        return res.status(400).json({
          error: "Okänd action",
          giltiga: ["ping", "status", "setup", "add", "remove", "list", "events"],
        });
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({
      error: msg,
      tolkning: msg.includes("401") ? "Autentisering nekad — kontrollera client id/secret."
        : msg.includes("403") ? "Behörighet saknas — kanske täcker din prenumeration inte Notifiering-API:t."
        : msg.includes("404") ? "Prenumerationen finns inte än. Kör ?action=setup först."
        : "Okänt fel.",
    });
  }
}

// ---------- OAuth2 med scope ----------
const TOKENS = new Map(); // scope → { ts, token }

async function getToken(scope) {
  const cached = TOKENS.get(scope);
  if (cached && Date.now() - cached.ts < 45 * 60 * 1000) return cached.token;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token HTTP ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  TOKENS.set(scope, { ts: Date.now(), token: j.access_token });
  return j.access_token;
}

/** Anropar Notifiering-API:t. X-Request-Id är obligatorisk. */
async function bv(method, path, body, scope) {
  const token = await getToken(scope);
  const headers = {
    authorization: `Bearer ${token}`,
    "X-Request-Id": crypto.randomUUID(),
    accept: "application/json",
  };
  if (body) headers["content-type"] = "application/json";

  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} HTTP ${r.status}: ${text.slice(0, 300)}`);
  try { return text ? JSON.parse(text) : { status: r.status }; }
  catch { return { status: r.status, raw: text.slice(0, 300) }; }
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
