🔥 Firewatch CZ – představení projektu

Firewatch CZ je nezávislý komunitní projekt zaměřený na přehledné sledování zásahů jednotek požární ochrany v České republice.
Cílem je proměnit veřejně dostupná data v srozumitelný, vizuální a užitečný přehled, který pomůže jak dobrovolným a profesionálním hasičům, tak i široké veřejnosti.

Projekt nabízí:

🗺️ interaktivní mapu výjezdů

📊 statistiky a přehledy zásahů

🏙️ žebříčky měst a obcí

⏱️ vyhodnocení délky zásahů

📁 export dat (CSV / PDF)

Firewatch CZ klade důraz na jednoduchost, přehlednost a technickou čistotu.
Nejde o oficiální systém HZS, ale o doplňkový nástroj, který pomáhá lépe chápat dění v terénu a dlouhodobé trendy.

👨‍🚒 Bio – autor / provozovatel

Firewatch CZ vzniká z iniciativy aktivního hasiče a technického nadšence, který kombinuje:

zkušenosti z reálných zásahů

zájem o automatizaci, IoT a datovou analytiku

snahu vytvářet smysluplné nástroje pro komunitu

Projekt je vyvíjen nezávisle, postupně a s důrazem na reálné použití v praxi.
Veškerý vývoj probíhá s respektem k otevřeným datům a s cílem nezkreslovat ani nehodnotit zásahy, ale pouze je transparentně zobrazovat.

# Serverový RSS worker

Aplikace umí načítat RSS zásahů přímo na Railway, takže pro běžný provoz již není nutné fyzické ESP32. Worker se spustí až po inicializaci databáze a HTTP serveru. RSS stahuje s timeoutem a limitem velikosti odpovědi, parsuje XML knihovnou `fast-xml-parser` a položky předává přímo stejné interní ingest logice jako endpoint `/api/ingest`. Díky tomu zůstává společné vyhodnocení stavu, času, typu, obce, geokódování, `upsertEvent()` i deduplikace podle stabilního ID.

Worker používá PostgreSQL advisory lock po dobu každého cyklu. Při více Railway replikách tedy RSS zpracuje jen jedna z nich; ostatní cyklus bezpečně přeskočí. Cykly jsou plánované pomocí `setTimeout` až po dokončení předchozího cyklu.

## Railway Variables

```env
RSS_ENABLED=1
RSS_URL=
RSS_INTERVAL_MS=60000
RSS_MAX_ITEMS=35
RSS_RUN_ON_START=1
RSS_PROXY_URL=
```

- `RSS_ENABLED=0` worker úplně vypne.
- Prázdné `RSS_URL` použije `https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml`.
- `RSS_INTERVAL_MS` má minimum 30000 ms.
- `RSS_MAX_ITEMS` je omezeno na bezpečné rozmezí 1–200.
- `RSS_RUN_ON_START=1` načte feed ihned po startu; hodnota `0` čeká na první interval.
- Prázdné `RSS_PROXY_URL` používá přímé připojení. Pokud je nastavené, pouze RSS požadavky jsou směrovány přes HTTP/HTTPS proxy. URL může obsahovat přihlašovací údaje a nikdy se nevypisuje do logu ani diagnostiky.
- Volitelně lze nastavit `RSS_TIMEOUT_MS` (výchozí 20000) a `RSS_MAX_RESPONSE_BYTES` (výchozí 2097152).

Pro Railway se doporučují výše uvedené výchozí hodnoty a platné `DATABASE_URL`. Žádný API klíč worker nepotřebuje, protože nevolá veřejný endpoint vlastní aplikace.

## Ověření a provoz

Po přihlášení administrátora otevřete existující endpoint `GET /api/admin/ingest-diagnostics`. Odpověď obsahuje objekt `rssWorker` s posledním během, chybou, počty položek a celkovým počtem cyklů. Ingest logy mají pro worker `source_kind: "rss"`. Základní průběh je také v Railway logu pod prefixem `[rss-worker]`.

Ruční bezpečný test připojení lze spustit jako administrátor přes `POST /api/admin/rss-test`. Vrací pouze úspěšnost, HTTP status, velikost odpovědi, počet RSS položek, délku požadavku a bezpečnou kategorii chyby. Proxy URL ani jiné tajné proměnné endpoint nevrací.

Při ukončení přes `SIGTERM` nebo `SIGINT` se zruší další naplánovaný cyklus. Chyba stažení, HTTP status, neplatné XML nebo chyba položky neshodí celý server.

## Návrat k ESP32

Nastavte `RSS_ENABLED=0` a znovu nasaďte službu. Původní `POST /api/ingest` s hlavičkou `X-API-Key` zůstává funkční, takže lze fyzické ESP32 kdykoli znovu zapnout. Serverový worker a ESP32 mohou fungovat i současně; kompatibilní stabilní ID a databázový upsert zabrání vzniku duplicit.

## Testy

Spusťte `npm test`. Testy používají vestavěný `node:test` a pokrývají běžnou RSS položku, HTML entity, chybějící volitelné hodnoty, stabilní ID, duplicitu, neplatné XML, timeout a vypnutý worker.

---
