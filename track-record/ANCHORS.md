# BudRadar — förankring av track record

Varje rad nedan skrivs automatiskt en gång per dygn av GitHub Actions.
`head` är hashen för den senaste raden i BudRadars hash-kedjade flagglogg.
Eftersom varje rad i loggen innehåller föregående rads hash kan ingen flagga
ändras, tas bort eller backdateras utan att alla senare hashar ändras — och
då stämmer de inte längre med raderna här, som git har tidsstämplat.

Verifiera själv: https://budradar.vercel.app/api/system?action=verify

| Tid (UTC) | Rader | Topp-hash | Status |
|---|---|---|---|
| 2026-11-17 12:24 | 34 | `d9fb2d07fcd12289507a5d2a9fe8600d5e52be823670b353aa17812ffb134750` | Omförseglad: Kanonisk hashning v2: v1 bröts av NUMERIC- och jsonb-formatering; inga externa tidsstämplar fanns tidigare |
| 2026-11-18 14:30 | 34 | `d9fb2d07fcd12289507a5d2a9fe8600d5e52be823670b353aa17812ffb134750` | Giltig |
| 2026-11-19 14:39 | 61 | `2db40fad9bf341d83fc214cb50c9bfaa84546fc7f2c4e8febb98ac0fd293dcd5` | Giltig |
