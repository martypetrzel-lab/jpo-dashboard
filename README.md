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
RSS_CONNECT_TIMEOUT_MS=30000
RSS_TIMEOUT_MS=30000
RSS_MAX_RESPONSE_BYTES=2097152
```

- `RSS_ENABLED=0` worker úplně vypne.
- Prázdné `RSS_URL` použije `https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml`.
- `RSS_INTERVAL_MS` má minimum 30000 ms.
- `RSS_MAX_ITEMS` je omezeno na bezpečné rozmezí 1–200.
- `RSS_RUN_ON_START=1` načte feed ihned po startu; hodnota `0` čeká na první interval.
- Prázdné `RSS_PROXY_URL` používá přímé připojení. Pokud je nastavené, pouze RSS požadavky jsou směrovány přes HTTP/HTTPS proxy. URL může obsahovat přihlašovací údaje a nikdy se nevypisuje do logu ani diagnostiky.
- `RSS_CONNECT_TIMEOUT_MS` nastavuje navázání přímého TCP/TLS spojení přes vlastní `undici.Agent` (výchozí 30000 ms, rozsah 5000–120000 ms). Dispatcher se vždy bezpečně zavře, také v proxy režimu.
- Stažení má nejvýše dva pokusy s prodlevou 1500 ms při síťové chybě, timeoutu nebo HTTP 5xx. HTTP 4xx, neplatné XML a překročení limitu odpovědi se neopakují. `RSS_TIMEOUT_MS` zůstává samostatným celkovým limitem jednoho pokusu, včetně stažení těla; celý cyklus se dvěma pokusy může trvat déle.
- Diagnostika rozlišuje `connect_timeout` (`UND_ERR_CONNECT_TIMEOUT`), `timeout` (celkový limit) a `connection_refused` (`ECONNREFUSED`), bez zveřejnění proxy URL nebo přihlašovacích údajů.
- Volitelně lze nastavit `RSS_TIMEOUT_MS` (výchozí 20000) a `RSS_MAX_RESPONSE_BYTES` (výchozí 2097152).

Pro Railway se doporučují výše uvedené hodnoty (včetně samostatného celkového timeoutu 30000 ms) a platné `DATABASE_URL`. Žádný API klíč worker nepotřebuje, protože nevolá veřejný endpoint vlastní aplikace.

## Ověření a provoz

Po přihlášení administrátora otevřete existující endpoint `GET /api/admin/ingest-diagnostics`. Odpověď obsahuje objekt `rssWorker` s posledním během, chybou, počty položek a celkovým počtem cyklů. Ingest logy mají pro worker `source_kind: "rss"`. Základní průběh je také v Railway logu pod prefixem `[rss-worker]`.

Ruční bezpečný test připojení lze spustit jako administrátor přes `POST /api/admin/rss-test`. Vrací pouze úspěšnost, HTTP status, velikost odpovědi, počet RSS položek, délku požadavku a bezpečnou kategorii chyby. Proxy URL ani jiné tajné proměnné endpoint nevrací.

Při ukončení přes `SIGTERM` nebo `SIGINT` se zruší další naplánovaný cyklus. Chyba stažení, HTTP status, neplatné XML nebo chyba položky neshodí celý server.

## Návrat k ESP32

Nastavte `RSS_ENABLED=0` a znovu nasaďte službu. Původní `POST /api/ingest` s hlavičkou `X-API-Key` zůstává funkční, takže lze fyzické ESP32 kdykoli znovu zapnout. Serverový worker a ESP32 mohou fungovat i současně; kompatibilní stabilní ID a databázový upsert zabrání vzniku duplicit.

## Testy

Spusťte `npm test`. Testy používají vestavěný `node:test` a pokrývají běžnou RSS položku, HTML entity, chybějící volitelné hodnoty, stabilní ID, duplicitu, neplatné XML, přímý Agent a jeho connect timeout, skutečný proxy tunel přes ProxyAgent, bezpečné zavírání dispatcherů, retry a jeho vyloučení pro HTTP 4xx a neplatné XML, celkový timeout při čtení těla a vypnutý worker.

---

# Záložní RSS import přes GitHub Actions

Workflow `.github/workflows/rss-ingest.yml` zpracuje nezávisle středočeský RSS, pražský Atom feed a RSS HZS Pardubického kraje. Přes existující `POST /api/ingest` posílá nejvýše 100 položek na zdroj. Selhání jednoho kroku neblokuje ostatní; závěrečný krok přesto označí běh jako neúspěšný, pokud některý import selhal. ESP32 není potřeba.

## Nastavení GitHub Secrets

1. Otevřete repozitář `martypetrzel-lab/jpo-dashboard` na GitHubu.
2. Přejděte do **Settings → Secrets and variables → Actions → Repository secrets**.
3. Přes **New repository secret** přidejte přesně tyto dva Secrets:

   | Name | Secret |
   | --- | --- |
   | `FIREWATCH_INGEST_URL` | `https://firewatchcz.cz/api/ingest` |
   | `FIREWATCH_API_KEY` | Přesná současná hodnota Railway proměnné `API_KEY` serveru FireWatch. |

API klíč zjistíte v Railway u služby FireWatch v **Variables → API_KEY**. Nepoužívejte GitHub token ani administrátorské heslo a klíč nevkládejte do repozitáře. Pokud `API_KEY` na Railway nemáte nastavený, nastavte vlastní klíč, nasaďte službu a stejnou hodnotu vložte do GitHub Secret. Skutečný klíč se v tomto návodu nevytváří ani nezveřejňuje. Pokud provozujete jinou doménu, nastavte `FIREWATCH_INGEST_URL` na její přímou HTTPS adresu `/api/ingest` bez přesměrování.

## Ruční test a spuštění plánu

1. Otevřete **Actions → RSS ingest**. Pokud GitHub nabízí povolení Actions, nejprve je povolte.
2. Klikněte **Run workflow**, vyberte větev **main** a potvrďte **Run workflow**.
3. Otevřete kroky **Import Středočeský RSS into FireWatch**, **Import Praha Atom into FireWatch** a **Import Pardubický RSS and details into FireWatch**. Středočeský výstup obsahuje `RSS items=…`, `accepted`, `inserted`, `updated`, `skipped` a `skipped_older`. Pražský výstup obsahuje `found`, HTTP status, `new`, `updated`, `unchanged`, `skipped_old`, `errors` a `duration_ms`. Pardubický krok vypíše `found`, `details`, `new`, `updated_candidates`, `status_changed`, `unchanged`, `skipped_old`, `detail_errors`, `geocode_errors` a `duration_ms`. Žádný krok nevypisuje API klíč ani cílovou URL.
4. Ověřte události na webu a v admin diagnostice příjmu dat vyhledejte `source: github_actions_rss`. Zelený běh s `RSS items=0` jen bezpečně přeskočil prázdný feed, nepotvrzuje funkčnost ingestu.
5. Plán `*/5 * * * *` na výchozí větvi automaticky žádá spuštění každých 5 minut. GitHub může plánované běhy zpozdit; nejde o přesnou časovou garanci. Společná concurrency skupina brání souběhu ručního a plánovaného importu.

Skript má pro RSS connect timeout 30000 ms a celkový timeout jednoho pokusu 30000 ms; pro ingest connect timeout 30000 ms a celkový timeout 60000 ms. Každá fáze má maximálně dva pokusy s prodlevou 1500 ms při síťové chybě, timeoutu nebo HTTP 5xx. HTTP 4xx, přesměrování, neplatné XML a neplatná odpověď ingestu se neopakují. Chyba vypíše pouze fázi, bezpečnou kategorii a případný HTTP status a skončí nenulovým návratovým kódem. Klíč, cílová URL ani text chybové odpovědi se nelogují. Timeout při ingestu může nastat i po uložení části položek; opakovaný POST používá stejná ID.

**Railway worker zatím ponechte zapnutý.** Teprve po úspěšném ručním testu s neprázdným feedem a ověření plánovaných importů nastavte na Railway `RSS_ENABLED=0` a znovu nasaďte službu. Workflow ani skript tuto proměnnou nemění a worker nemažou.

### Pardubický kraj

`scripts/pardubicky-push.js` načítá `https://www.hzspa.cz/vyjezdy/rss-aktualni-vyjezdy.php` a pro novou nebo stále otevřenou událost následně načte oficiální detail. Z detailu strukturálně čte popis, ohlášený čas, typ, podtyp, okres, obec, ulici, jednotky a autoritativní stav. Stabilní ID má tvar `pardubicky:<číselné-id>` a odkaz se ukládá bez sledovacích fragmentů. První import přijímá dnešní položky; včerejší jen tehdy, když detail stále uvádí otevřený stav. Starší uzavřené položky se nevkládají a chybějící položky se nemažou.

Bezpečný síťový test bez zápisu lze spustit `PARDUBICKY_DRY_RUN=1 node scripts/pardubicky-push.js`. V tomto režimu nejsou potřeba GitHub Secrets. Běžný běh používá stejné Secrets `FIREWATCH_INGEST_URL` a `FIREWATCH_API_KEY` jako ostatní zdroje. Detail jedné položky může selhat bez zablokování ostatních; chyba je uvedena jen bezpečnou kategorií. RSS čas ohlášení se ukládá jako zdrojový údaj, nevydává se automaticky za přesný začátek ani konec zásahu.

### Kraje, stanice a srovnání

Událost má oddělený kraj, zdroj, výslovně uvedené jednotky a případné přiřazení stanice. Automatické přiřazení stanice je povolené pouze uvnitř stejného kraje a z ověřené polohy. Současná databáze stanic obsahuje jen Středočeský kraj; pro Prahu a Pardubický kraj proto UI uvádí „Stanice není v databázi“ a nic geograficky nedohaduje. Explicitní jednotky z pardubického detailu zůstávají zachované jako zdrojová data.

Sekce **Porovnání krajů** nabízí dnešek, včerejšek, 7/30 dní, kalendářní měsíc a vlastní rozsah. Odděluje zásahy HZS/JPO od všech evidovaných krizových událostí, protože pražský zdroj zahrnuje i poruchy vody a elektřiny. Výsledky uvádějí dostupnost zdroje a upozornění, že nejde o úplnou oficiální statistiku HZS ČR.

Lokálně lze se stejnými dvěma proměnnými prostředí spustit `npm ci` a `node scripts/rss-push.js`. `npm test` zahrnuje payload, limit 100 položek, autentizaci ingestu, timeout/retry, HTTP chyby, neplatné XML, prázdný feed, bezpečné logování a návratový kód skriptu.

Pokud původní server odmítne síť GitHub Actions, importer automaticky použije veřejnou bránu rss2json. Volitelný GitHub Secret `RSS2JSON_API_KEY` zapne požadavek na až 100 nejnovějších položek (`count=100`, řazení podle data sestupně). Bez tohoto klíče brána vrací posledních 10 položek. URL zdroje obsahuje pětiminutový cache bucket, aby brána nevracela dlouhodobě zastaralý výsledek. Stabilní ID a databázový upsert zajistí, že nové zásahy vzniknou jednou a dříve uložené zásahy se pouze aktualizují.

Příjem RSS je omezen na aktuální kalendářní den v časovém pásmu `Europe/Prague`. Ze starších dnů se nově přijmou jen výslovně otevřené zásahy, které pokračují přes půlnoc. Již známý přesah lze následným RSS během aktualizovat nebo ukončit; neznámé starší ukončené události se nevkládají. Pohled „dnes“ zobrazuje dnešní zásahy a všechny stále otevřené přesahy.
## Pražský Atom feed

Druhý zdroj používá `https://bezpecnost.praha.eu/Intens.CrisisPortalInfrastructureApp/events/rss`. Parser čte Atom prvky `entry`, `id`, `link[href]`, `updated`, `title`, `summary` a `author/name`. Stabilní identita je dvojice `source=praha` + původní `external_id` ve tvaru `urn:uuid:…`; technické ID události má tvar `praha:urn:uuid:…`. Středočeské identity se tím nemění a oba zdroje se nemohou navzájem přepsat.

První pražský import přijme pouze neznámé položky aktualizované během posledních 24 hodin. Historické položky ve feedu se vykážou jako `skipped_old` a nevytvoří se z nich historie. Již známé ID se kontroluje i po překročení 24 hodin, aby se mohla propsat změna souhrnu nebo stavu. Shodný obsah pouze posune `last_seen_at`; změna `updated`, názvu, souhrnu, odkazu nebo odvozeného stavu provede update. Stáří lze pro provozní potřeby omezit proměnnou `PRAHA_MAX_AGE_HOURS` v rozsahu 1–168, workflow používá 24.

Pražský zdroj obecně neposkytuje jistý začátek ani konec. Stav proto zůstává **stav neupřesněn**, případně se zobrazí jako **pravděpodobně probíhá/ukončeno**, pouze když text obsahuje jednoznačnou formulaci. Tyto odhady nevytvářejí čas zahájení, ukončení ani délku zásahu. Události výslovně spojené s HZS jsou zahrnuté do statistik JPO/HZS; voda, elektřina, doprava a jiné obecné krize jsou vedené odděleně. Filtr **Oblast / zdroj** přepíná všechny zdroje, Středočeský kraj a Prahu. Zdroj je uveden také v detailu, mapě a exportech.

Pražské geokódování zkouší postupně úplnou adresu, ulici s městskou částí, čtvrť s Prahou a městskou část. Přijme jen český výsledek uvnitř pražského výřezu a s odpovídající pražskou správní oblastí. Neshodný nebo příliš obecný výsledek nevytvoří marker; neúspěšná událost zůstane v tabulce a může se dohledat později.

Bezpečný lokální test bez zápisu do FireWatch lze spustit s běžnými GitHub Secrets v prostředí:

```powershell
$env:PRAHA_DRY_RUN='1'
node scripts/praha-push.js
```

Dry-run stáhne živý feed, ale nevolá ingest. Vypíše pouze `found`, `eligible`, `skipped_old`, bezpečný počet chyb a dobu běhu. Automatické testy používají uložený fixture `test/fixtures/praha-atom.xml` a nejsou závislé na dostupnosti živého zdroje.

`initDb()` opakovatelně přidává sloupce `source`, `external_id`, `source_url`, `region`, `content_hash`, `raw_payload`, `is_jpo_event` a unikátní index `(source, external_id)`. Existující záznamy dostanou `source=stredocesky` a původní `id` jako `external_id`; data, stabilní ID ani souřadnice se nemažou. Návrat na předchozí verzi aplikace je možný ponecháním přidaných sloupců a indexu v databázi. Není potřeba destruktivní rollback SQL.

## Audit a změny spolehlivosti (17. 9. 2026)

Architektura, výchozí stav a priority jsou v `docs/audit-2026-09-17.md`. Stack zůstává Express, PostgreSQL a klasický JavaScript; RSS worker i GitHub Actions/RSS2JSON zůstávají zachované.

- `/api/ingest` vyžaduje nastavenou Railway proměnnou `API_KEY`; pokud chybí, vrací bezpečně 503. Již nastavený klíč se nemění. Limit je 200 položek a 2 MB, GitHub import nadále posílá nejvýše 100. Odpověď navíc obsahuje `skipped` a `skipped_older`.
- Časy událostí a ruční formuláře používají `Europe/Prague`, včetně sekund a přechodů letního času. Prázdné `ukončení:` neuzavírá aktivní zásah. Při RSS aktualizaci se zachovává původní začátek a ručně opravená poloha. Automatické uzavírání po neaktivitě je omezené na ESP zdroj.
- `GET /api/events` přidává pouze veřejné `data_status.last_success` a `last_attempt`. Neobsahují IP, uživatele, text chyby ani přístupové údaje. Výpadek obnovení se zobrazuje jako chyba s časem posledního úspěšného načtení.
- `GET /api/reports` podporuje `type=day|week|month`, `year`, `month`, `from`, `to`, `q`, `include_empty=true|false`, `limit` (výchozí 30, nejvýše 100) a `offset`. Vrací `reports`, `total`, `limit`, `offset` a měsíční `groups`. Seznam neobsahuje velké `data_json`. Příklad: `/api/reports?type=day&include_empty=false&limit=30&offset=0`.
- Prázdné souhrny zůstávají uložené pro kontinuitu, ve výchozím zobrazení jsou skryté. Kombinace typu a období je už chráněná PostgreSQL unikátností a upsertem. Detail a PDF chybějícího souhrnu vrátí 404; čtení už nic nevytváří. Generování a spuštění automatiky vyžaduje relaci s oprávněním `canCreateReports` (editor/admin ve výchozím nastavení). Starý servisní `/api/admin/fix-geocode` nyní vyžaduje admin relaci; ingest klíč není admin přihlášení.
- FireWatch Talk má nejvýše šest pokusů o obnovení s rostoucí prodlevou, poté ruční připojení. Mikrofon se otevírá až při PTT a uvolní po skončení, ztrátě sítě či změně místnosti. PCM protokol `/ops-radio` zůstává kompatibilní. WebSocket payload je omezen na 64 KiB a browser musí mít stejný Origin jako host služby.
- `TRUST_PROXY_HOPS` určuje počet důvěryhodných proxy před Express (výchozí 1 pro Railway). Pro přímý lokální provoz nastavte 0; pro jinou infrastrukturu nastavte skutečný počet proxy. Login/register mají omezené počty pokusů a omezenou paměť limiteru. Více replik vyžaduje sdílený limiter na edge nebo v Redis.

### Databázová změna a návrat

`initDb()` opakovatelně přidává do `ingest_log` dvě číselné metriky `skipped_count` a `skipped_older_count`, výchozí 0. Historie se nemaže a nová tabulka se nevytváří. PostgreSQL při `ALTER TABLE` krátce vyžaduje zámek; proveďte běžný restart nasazení v klidnějším provozu. Návrat: nasaďte předchozí commit, sloupce bezpečně ponechte. Není potřeba ruční SQL ani mazání dat.

### Ověření

`npm test` spouští původní RSS unit testy, testy mapových pravidel a reconnectu a integrační testy proti izolovanému PostgreSQL (PGlite). Nepoužívají produkční `DATABASE_URL`, API klíč ani relace. PGlite je pouze vývojová závislost. Před nasazením spusťte `npm ci`, `npm test` a `npm audit --omit=dev`. Vizuální a produkční výsledky jsou v dokončeném auditním reportu.


## Spolehlivé umístění zásahů na mapě

Podrobná příčina chybných okresních bodů a pravidla oprav jsou v [auditu geokódování](docs/geocoding-audit-2026-09-17.md). RSS zachovává obec odděleně od detailu místa. Geokodér kontroluje stát, kraj, známý okres, obec a typ kandidáta; okresní a krajské fallbacky odmítá. Střed správné obce se vždy zobrazuje jako **Přibližná poloha – střed obce**. Události bez spolehlivé polohy zůstávají v tabulce a veřejný přehled ukazuje jejich počet. Společný legitimní bod má marker s počtem a seznam všech událostí bez náhodného posouvání.

Admin panel → Události bez souřadnic → **Diagnostika podezřelých poloh**. Vyberte jedno ID, použijte **Náhled nového geokódování**, zkontrolujte obec/okres, přesnost, dotaz a důvod odmítnutí. **Potvrdit opravu jedné události** je dostupné pouze pro bezpečné zlepšení. Náhled je dry-run; při potvrzení se ověří nezměněné původní souřadnice i návrh a změna se audituje v jedné transakci. Ruční a ověřené body se automaticky nepřepisují. Checkbox **Poloha ověřena administrátorem** je součást ručního formuláře. Historické souřadnice ani stará cache se hromadně nemažou.

Migrace přidává sedm geo metadat a dvě tabulky pro kontextovou cache a rate limit. Je opakovatelná a zachovává existující data. Nová cache odděluje stejnojmenné obce podle okresu; negativní výsledek expiruje za 24 hodin, dočasná chyba za 5 minut. RSS ingest nečeká na síťové geokódování: NULL polohy zpracovává omezená fronta na pozadí.

**Veřejný Nominatim není určen k pravidelnému hromadnému geokódování.** Dodržujte [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/): jedna instance služby, sériové dotazy, cache, identifikující User-Agent, při pravidelném provozu nejvýše čtyři požadavky za minutu. Aplikace rezervuje interval alespoň 15 sekund v databázi; více variant může trvat přes minutu. Nespouštějte plošné dohledávání archivu. Pro větší objem nebo více replik použijte vlastní / smluvní Nominatim kompatibilní endpoint přes volitelnou proměnnou `GEOCODE_URL` (výchozí `https://nominatim.openstreetmap.org/search`). Produkční proměnné není potřeba měnit. Testy používají pouze mock provider a izolovanou databázi.

### Časový model RSS

RSS RFC datum s `+0000`, ISO se `Z` i RSS2JSON `YYYY-MM-DD HH:mm:ss` znamenají v tomto importu UTC. Časy `zahájení:` a `ukončení:` v českém popisu jsou místní `Europe/Prague`, včetně zimního/letního času. Neexistující jarní hodina je odmítnuta; opakovaná podzimní hodina používá první výskyt.

`pub_date` zůstává kompatibilním údajem pro stávající filtry dne a přesahů. `source_updated_at` samostatně uchovává RSS datum zdroje; nesmí garantovat začátek zásahu. Zdrojová tabulka tento údaj výslovně označuje jako „Poslední aktualizace dat“. UI proto čas RSS označuje „Poslední aktualizace zdroje“, skutečný začátek bez dokladu zůstává neznámý. `start_time_iso` má původ `rss_description`, `explicit`, `esp` nebo `manual`; konec z popisu má `end_time_source=rss_description`. Přesná délka vzniká jen z doloženého začátku a konce. U nových událostí, které FireWatch poprvé viděl výslovně otevřené, může `first_seen_at` vytvořit bezpečně označený odhad (`duration_is_estimate=true`); `source_updated_at` do něj nikdy nevstupuje. Starší události bez doloženého prvního stavu zůstávají `NULL` / `—`. Ruční a dříve doložený začátek nový RSS čas nepřepíše. Pozorovací údaje `first_seen_at`, `last_seen_at` a `created_at` zůstávají oddělené. UI a export explicitně zobrazují `Europe/Prague`; PostgreSQL spojení explicitně používá UTC, nezávisle na Railway `TZ`.

Diagnostika bez zápisu: `node scripts/rss-time-audit.js` (veřejný vzorek maximálně 2000 záznamů) nebo přihlášený správce `GET /api/admin/time-diagnostics` (nejnovějších maximálně 5000; prvních 200 návrhů, bezpečné údaje o session timezone a `TZ`). Nejednoznačné historické ISO hodnoty nelze opravit přičtením dvou hodin. Při příštím skutečném importu stejných ID se datum opraví podle aktuálního RSS, původní časy/délka se jednou zachovají v `time_original_values`, včetně času zálohy. `time_model_version` a tato záloha umožňují opakování i individuální návrat po kontrole správcem. Migrace pouze přidává metadata, neposouvá historii hromadně. Staré archivní snapshoty se automaticky nepřepočítávají; nové souhrny a exporty vylučují neprokázané délky.

U starší ručně upravované události, jejíž původ času už nelze doložit, se původní začátek uchová jako `legacy_manual_unverified` (případně obnoví z uložené zálohy při stejném RSS ID). Ve veřejném API a UI zůstává tento začátek neznámý a délka `—`; ruční ověření jej může výslovně potvrdit. Tím se neztrácí možná ruční oprava ani se nevydává neověřený údaj za přesný.
