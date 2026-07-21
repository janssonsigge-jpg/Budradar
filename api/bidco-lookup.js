// ============================================================
// /api/bidco-lookup — BIDCO-REGISTRERINGSDATUM
//
// KÄRNTESEN: avståndet mellan att budgivaren registrerar sitt skalbolag
// och att budet offentliggörs. Ingen mäter detta. Om du kan visa
// "median 23 dagar från bidco-registrering till bud" har du en datapunkt
// som inte finns någon annanstans.
//
// TVÅ LÄGEN:
//   1. SPARA (fungerar alltid) — du matar in datum du hittat manuellt
//      POST /api/bidco-lookup   { bidco, orgNr, registered, budId }
//      eller GET med query-parametrar för enkelhets skull:
//      /api/bidco-lookup?key=X&save=1&bidco=Snark%20BidCo%20AB&orgNr=559123-4567&registered=2026-04-15&budId=2026-05-11-sleepcycle
//
//   2. SÖK (kan blockeras) — försöker slå upp automatiskt
//      /api/bidco-lookup?key=X&search=Snark BidCo
//
//   3. STATISTIK — det som gör arbetet värt något
//      /api/bidco-lookup?key=X&stats=1
//
// VAR HITTAR DU DATUMET MANUELLT?
//   • allabolag.se — sök bidco-namnet, "Registrerat" står på bolagssidan
//   • bolagsverket.se/sok-foretagsinformation
//   • poit.bolagsverket.se — kungörelsen om nyregistrering
// ============================================================

import { neon } from "@neondatabase/serverless";

const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const UA = "BudRadar/0.3 (+offentlig data; kontakt via budradar.vercel.app)";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const key = req.query && req.query.key;
  if (process.env.CRON_SECRET && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CONN) return res.status(500).json({ error: "Ingen databas konfigurerad." });

  try {
    const sql = neon(CONN);
    await ensureSchema(sql);
    const q = req.query || {};

    if (q.stats === "1") return res.status(200).json(await buildStats(sql));
    if (q.save === "1" || req.method === "POST") return await save(sql, req, res);
    if (q.search) return await search(q.search, res);
    if (q.list === "1") {
      const rows = await sql`SELECT * FROM bidco_registry ORDER BY registered DESC NULLS LAST`;
      return res.status(200).json({ count: rows.length, rows });
    }

    res.status(200).json({
      hjälp: "Använd ?save=1&bidco=&orgNr=&registered=&budId= för att spara, ?stats=1 för statistik, ?list=1 för alla.",
      hittaDatum: [
        "allabolag.se — sök bidco-namnet, kolla fältet 'Registrerat'",
        "bolagsverket.se/sok-foretagsinformation",
        "poit.bolagsverket.se — kungörelse om nyregistrering",
      ],
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

async function save(sql, req, res) {
  const src = req.method === "POST" && req.body ? req.body : req.query;
  const bidco = (src.bidco || "").trim();
  const registered = (src.registered || "").trim();
  const orgNr = (src.orgNr || "").trim() || null;
  const budId = (src.budId || "").trim() || null;
  const announced = (src.announced || "").trim() || null;

  if (!bidco) return res.status(400).json({ error: "bidco saknas" });
  if (registered && !/^\d{4}-\d{2}-\d{2}$/.test(registered)) {
    return res.status(400).json({ error: "registered måste vara YYYY-MM-DD" });
  }

  await sql`
    INSERT INTO bidco_registry (bidco, org_nr, registered, bud_id, announced, updated_at)
    VALUES (${bidco}, ${orgNr}, ${registered || null}, ${budId}, ${announced || null}, now())
    ON CONFLICT (bidco) DO UPDATE SET
      org_nr = COALESCE(EXCLUDED.org_nr, bidco_registry.org_nr),
      registered = COALESCE(EXCLUDED.registered, bidco_registry.registered),
      bud_id = COALESCE(EXCLUDED.bud_id, bidco_registry.bud_id),
      announced = COALESCE(EXCLUDED.announced, bidco_registry.announced),
      updated_at = now()`;

  const [row] = await sql`SELECT * FROM bidco_registry WHERE bidco = ${bidco}`;
  const days = row.registered && row.announced
    ? Math.round((Date.parse(row.announced) - Date.parse(row.registered)) / 864e5) : null;

  res.status(200).json({
    ok: true, sparad: row,
    dagarTillBud: days,
    kommentar: days != null
      ? `${bidco} registrerades ${days} dagar före budet offentliggjordes.`
      : "Lägg till både 'registered' och 'announced' för att räkna ut avståndet.",
  });
}

/** Försöker slå upp bolaget automatiskt. Kan blockeras — då får du söka manuellt. */
async function search(name, res) {
  const term = String(name).trim();
  const tried = [];

  // Bolagsverkets öppna söktjänst (kan kräva JS/session — vi provar ändå)
  try {
    const url = `https://sok.bolagsverket.se/api/foretagsinformation/v1/sok?sokterm=${encodeURIComponent(term)}`;
    tried.push(url);
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      return res.status(200).json({ källa: "bolagsverket", träffar: j });
    }
    tried.push(`→ HTTP ${r.status}`);
  } catch (e) { tried.push("→ " + String(e.message).slice(0, 60)); }

  res.status(200).json({
    automatiskSökning: "misslyckades",
    försökte: tried,
    görSåHärIstället: [
      `1. Öppna https://www.allabolag.se/what/${encodeURIComponent(term)}`,
      "2. Klicka på bolaget, leta upp fältet 'Registrerat'",
      "3. Spara med: /api/bidco-lookup?key=DIN_NYCKEL&save=1&bidco=" +
         encodeURIComponent(term) + "&registered=ÅÅÅÅ-MM-DD&announced=ÅÅÅÅ-MM-DD",
    ],
    varför: "Bolagsverket blockerar ofta automatiska anrop. Manuell inmatning tar ~1 min per bidco " +
            "och datan blir lika värdefull.",
  });
}

async function buildStats(sql) {
  const rows = await sql`
    SELECT bidco, org_nr, registered::text, announced::text, bud_id
    FROM bidco_registry WHERE registered IS NOT NULL AND announced IS NOT NULL`;

  const gaps = rows.map(r => ({
    bidco: r.bidco,
    budId: r.bud_id,
    registered: r.registered,
    announced: r.announced,
    dagar: Math.round((Date.parse(r.announced) - Date.parse(r.registered)) / 864e5),
  })).filter(g => g.dagar >= 0 && g.dagar < 3650).sort((a, b) => a.dagar - b.dagar);

  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM bidco_registry`;

  if (!gaps.length) {
    return {
      n: 0, totaltIRegistret: total,
      kommentar: "Inga kompletta par än. Lägg in både registreringsdatum och budets datum.",
    };
  }

  const d = gaps.map(g => g.dagar);
  const sorted = [...d].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  return {
    n: gaps.length,
    totaltIRegistret: total,
    dagarFrånRegistreringTillBud: {
      median: Math.round(median),
      snitt: Math.round(d.reduce((a, b) => a + b, 0) / d.length),
      kortast: Math.min(...d),
      längst: Math.max(...d),
    },
    varningsfönster: {
      andelInom30Dagar: Math.round(d.filter(x => x <= 30).length / d.length * 100),
      andelInom60Dagar: Math.round(d.filter(x => x <= 60).length / d.length * 100),
      andelInom90Dagar: Math.round(d.filter(x => x <= 90).length / d.length * 100),
    },
    tolkning: gaps.length < 10
      ? `Endast ${gaps.length} observationer — för få för slutsatser. Sikta på 20+.`
      : `Med ${gaps.length} observationer börjar mönstret bli meningsfullt. Ett nyregistrerat bidco ` +
        `är en varningssignal med ${Math.round(median)} dagars typiskt försprång.`,
    affärer: gaps,
  };
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
