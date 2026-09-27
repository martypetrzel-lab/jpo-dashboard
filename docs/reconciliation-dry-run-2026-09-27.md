# Produkční dry-run synchronizace zdrojů – 27. 9. 2026

Audit byl spuštěn pouze ke čtení pomocí `node scripts/reconciliation-public-audit.js`. Prošel 2 000 posledních veřejně dostupných záznamů a přímo u zdroje ověřil všechny čtyři události, které FireWatch v okamžiku auditu vedl jako aktivní.

## Navržené opravy

| FireWatch ID | Místo | Stav FireWatch | Stav zdroje | Návrh |
| --- | --- | --- | --- | --- |
| `RSS_FEED_203974` | Ledce | aktivní | ukončená | změnit existující záznam na ukončený |
| `RSS_FEED_203942` | Střemy | aktivní | ukončená | změnit existující záznam na ukončený |
| `RSS_FEED_203416` | Rynholec | aktivní | ukončená | změnit existující záznam na ukončený |

U žádné z těchto položek historická tabulka neposkytla oficiální čas konce. Oprava proto nesmí vyrábět přesnou délku; `duration_min` zůstane `NULL` a UI zobrazí `—`.

## Výslovně ověřené příklady

- Rynholec `RSS_FEED_203416`: oficiální historický záznam uvádí `ukončená`, poslední aktualizaci 21. 9. 2026 16:00 Europe/Prague. FireWatch jej před opravou vedl jako aktivní.
- Rakovník `RSS_FEED_203764`: oficiální historický záznam uvádí `ukončená`, poslední aktualizaci 25. 9. 2026 08:40 Europe/Prague. FireWatch jej už před opravou vedl jako ukončený; nebyla navržena změna provozního stavu.

## Kontroly konzistence

- duplicitní dvojice `source + external_id`: 0
- záznamy bez `external_id` ve vzorku: 0
- nulové nebo záporné délky: 0
- nesoulad `region` a `event_region`: 0
- aktivní záznamy bez ověřitelného detailu: 0

Produkční zápis nebyl během dry-run proveden. Opravy se mají aplikovat až po úspěšném nasazení nové migrace a reconcilačních endpointů.
