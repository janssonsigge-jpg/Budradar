# Nordiskt budregister — produktplan

## Vad det här är

En maskinläsbar databas över nordiska offentliga uppköpserbjudanden, med
data ingen annan har strukturerat: **bidco-kedjan, ägarstrukturen före budet,
tidslinjen från flaggning till bud, och utfallet.**

Det här är inte appen. Det är tillgången.

---

## Varför det finns ett glapp

| Aktör | Äger | Har INTE |
|---|---|---|
| Modular Finance (Holdings) | Ägardata, IR-verktyg | Strukturerad M&A-historik |
| Börsdata | Fundamenta, screening | Transaktionsdata |
| Quartr | Rapporter, earnings calls | Bud och ägarstrukturer |
| Affärsvärlden | Analys, Uppköpsguiden | Maskinläsbar databas — det är **artiklar** |
| Millistream | Realtidsdistribution | M&A-strukturdata |

Ingen av dem kan svara på: *"vilken premie har PE-fonder betalat i svensk
tech de senaste tre åren, och hur såg ägarbindningen ut före budet?"*

Registret kan det redan med 8 poster.

---

## Vem betalar

**Corporate finance / M&A-rådgivare** — jämförbara transaktioner till pitchmaterial.
Detta är standardarbete inför varje mandat och görs idag manuellt.

**PE-fonder** — vilka premier krävs, vilka strukturer används, vilka bolag
har ägarstrukturer som möjliggör utköp.

**Advokatbyråer** — prejudikat kring budplikt, acceptansgränser, irrevocables.

**Akademiker och journalister** — den enda öppna datakällan för nordisk M&A.

---

## Vad som gör en post värdefull

En rad med bara "vem köpte vad för hur mycket" är värdelös — det står i tidningen.
Värdet ligger i de fält som kräver arbete att gräva fram:

1. **Bidco-kedjan** — `["Brookfield", "Trimco Group Holdings", "Trimco Group (UK)"]`
   Visar hur affären strukturerades, inte bara vem som betalade.

2. **Bidco-registreringsdatum** — från Bolagsverket. Detta är BudRadars kärntes:
   avståndet mellan att skalbolaget registreras och att budet offentliggörs.
   **Ingen annan har detta.**

3. **Ägarstruktur före budet** — vem band sig, med hur mycket kapital *och röster*.
   Nilörn: Traction hade 26,3% av kapitalet men 58,1% av rösterna. Den skillnaden
   avgjorde affären.

4. **Premie mot flera referenspunkter** — senaste kurs, 30d VWAP, 90d VWAP.
   Cint såg ut som 33% mot gårdagen men över 70% mot 90-dagarssnittet.

5. **Tidslinjen** — flaggning → rykte → bud → acceptperiod → utfall.

---

## Så fyller du på

Öppna `api/_registry-data.js`. Använd **Nilörngruppen** som mall — den är
den mest kompletta posten (73%).

### Arbetsgång per bud

1. Hitta pressmeddelandet på MFN (sök bolagsnamn + "uppköpserbjudande")
2. Fyll i: pris, premie, acceptansgräns, villkor
3. **Ägarstrukturen** står nästan alltid i pressmeddelandet under
   "åtaganden" — vem har bundit sig, med vilken andel kapital och röster
4. **Bidcon** står i budgivarens pressmeddelande. Sök namnet på
   `poit.bolagsverket.se` för registreringsdatum
5. Kör `/api/registry?stats=1` och se att siffrorna rör sig rimligt

### Prioritetsordning

Fyll hellre **få poster komplett** än många poster tunt. En komplett post
med ägarstruktur och bidco-datum är värd tio rader med bara pris och premie.

**Mål:** 50 poster med >70% fullständighet slår 300 poster med 30%.

---

## API

```
GET /api/registry                        alla poster
GET /api/registry?bidderType=PE          filtrera
GET /api/registry?sector=Tech
GET /api/registry?from=2025-01-01
GET /api/registry?minPremium=40
GET /api/registry?hasBidco=1             bara med känd bidco-kedja
GET /api/registry?stats=1                aggregerad statistik
GET /api/registry?format=csv             CSV för Excel
```

### Exempel: vad `?stats=1` redan svarar på

Med bara 8 poster:

| Budgivartyp | Antal | Snittpremie |
|---|---|---|
| PE | 4 | **48,3%** |
| Grundare | 1 | 38% |
| Storägare | 1 | 38% |
| Industriell | 2 | **24,5%** |

PE-fonder betalar dubbelt så hög premie som industriella köpare. Det är en
insikt värd att veta om du sitter i en budförhandling — och den blir starkare
för varje post du lägger till.

---

## Vägen till något säljbart

**Fas 1 — trovärdighet (nu):** 30–50 poster, alla bud 2024–2026. Fokus på
fullständighet, inte antal. Källa till varje påstående.

**Fas 2 — djup:** bidco-registreringsdatum från Bolagsverket för samtliga.
Det är den unika datapunkten ingen annan har.

**Fas 3 — bredd:** Norge, Danmark, Finland. "Nordiskt" är ett starkare
säljargument än "svenskt".

**Fas 4 — koppla till signalerna:** när `signal_history` mognat, lägg till
"hur såg BudRadars signaler ut 30/60/90 dagar före varje bud". Då har du
något ingen kan replikera i efterhand.

---

## Ärlig realitetskoll

Registret är värdelöst tills det är **komplett nog att lita på**. Åtta poster
är en demo, inte en produkt. En M&A-rådgivare som hittar ett saknat bud slutar
använda det direkt.

Sätt ett mål: **alla bud på svenska börsen 2024–2026, inga luckor.** Det är
kanske 70–90 affärer. Det är ett par helgers arbete, och det är skillnaden
mellan en leksak och något du kan ta betalt för.
