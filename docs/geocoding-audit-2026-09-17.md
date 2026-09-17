# Audit umístění zásahů – 17. 9. 2026

## Příčina

Původní lokální fallback hledal jména jako podřetězce celého dotazu. Obsahoval i body okresů Praha-východ (50.1073, 14.7250) a Praha-západ (49.9833, 14.3333). Neznámá obec převzala bod svého okresu. Ve vzorku posledních 2 000 veřejných událostí před změnou mělo tyto body 422 záznamů, například Nupaky, Struhařov, Hrusice, Klecany, Kunice, Průhonice, Vrané nad Vltavou a Dolní Břežany. Nejde o počet celé databáze.

Nominatim vybíral prvního kandidáta bez kontroly shody obce, okresu a typu výsledku; regionální kontrola byla standardně vypnutá. Cache obsahovala i dotazy bez okresu a body bez údaje o přesnosti. Ingest volal `updateEventCoords` bez explicitního zdroje, jehož výchozí hodnota je `manual`. Některé staré automatické body tedy mohou být označené jako ruční. Bez auditní historie je nelze bezpečně odlišit od skutečné ruční opravy, proto zůstávají chráněné.

RSS popis obsahuje stav, ukončení, případné místo, obec a okres. Parser dříve první místní řádek považoval za obec: kilometr D8 tak zastínil následující Postřižín. Nový parser zachovává místo samostatně a obec získává z posledního místního řádku. Význam závorek, pomlček a částí obcí nemaže.

## Validace a přesnost

Dotazy postupují od místa / části obce k obci, vždy s krajem a státem nebo známým okresem a státem. Známý okres se při fallbacku nikdy nezahodí. Stejné varianty se neposílají vícekrát. Praha Východ / Praha-východ a Praha Západ / Praha-západ se normalizují na celý název okresu.

Kandidát musí mít český kód země, očekávaný kraj, známý okres a přesně shodný normalizovaný název obce. Souřadnice musí ležet v konzervativním regionálním obdélníku; nejde o přesný správní polygon. Typ okres, kraj nebo nesouvisející administrativní oblast se odmítá. Vyhodnocují se všichni vrácení kandidáti. Nerozhodnutelná shoda více bodů je selhání.

| Přesnost | Skóre aplikace | Použití |
| --- | --- | --- |
| exact | 95 | Odpovídající pojmenovaný bod nebo adresa s číslem domu |
| locality | 85 | Odpovídající část obce, viditelně přibližná |
| municipality | 70 | Správná obec, vždy „Přibližná poloha – střed obce“ |
| district / region / failed | 0 | Bez markeru |

Skóre nejsou kalibrovaná pravděpodobnost. Kilometr dálnice se nevydává za přesnou polohu středu silnice. Malý lokální slovník používá jen celé názvy vybraných známých obcí s okresy, nikdy podřetězce ani okresní body.

## Data, cache a ochrana

Opakovatelná aditivní migrace přidává `geo_precision`, `geo_confidence`, `geo_query`, `geo_display_name`, `geo_verified`, `geo_failure_reason`, `geo_context_key`. Historické souřadnice nepřepisuje ani nenuluje. `geocode_cache_v2` má kontextový klíč obec | část obce | okres | kraj | stát | detail, JSON výsledek a expiraci: úspěch 30 dní, nenalezeno 24 hodin, dočasná chyba 5 minut. Stará cache zůstává uložená pro rollback, ale její neověřené výsledky se nepřebírají.

Ingest používá rychlou cache nebo známý přibližný střed obce. Neznámé NULL polohy zpracuje omezená fronta na pozadí, aby RSS import nečekal na geokodér. Selhání uloží důvod a dotaz, žádný fallback bod. Historické neprázdné souřadnice do fronty nevstupují. Ruční a ověřené polohy jsou chráněné; ostatní kvalitní body může automatika nahradit jen vyšší přesností a při shodném kontextu.

## Veřejný geokodér

**Veřejný Nominatim má omezenou kapacitu a pravidelné geokódování se nedoporučuje.** Dodržujte [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/): jedna instance služby, sériové dotazy, při pravidelném provozu nejvýše čtyři požadavky za minutu, identifikující User-Agent a cache. Neprovádějte plošné dohledávání archivu. Pro větší objem nebo více Railway replik použijte vlastní či smluvní Nominatim kompatibilní službu přes `GEOCODE_URL`; změna nevyžaduje úpravu kódu. Produkční konfigurace se tímto úkolem nemění.

Interval alespoň 15 sekund se rezervuje v PostgreSQL pro společný limit RSS i admin požadavků. Timeout 9 sekund pokrývá i čtení těla. Jeden dotaz má nejvýše dva pokusy pouze pro síťové chyby, 429 a 5xx. Trvalé HTTP chyby a nenalezení se okamžitě neopakují. Parametry vycházejí z [oficiální dokumentace Search](https://nominatim.org/release-docs/latest/api/Search/). Více dotazů může trvat déle než minutu; UI po dobu lookupu čeká.

## Administrace

Admin → Události bez souřadnic → Diagnostika podezřelých poloh. Seznam označí chybějící původ, starý neověřený bod, okresní fallback, nízkou přesnost a různé obce na jednom bodě. Čte nejvýše 5 000 nejnovějších záznamů, uvádí počet kontrolovaných a příznak úplnosti; zobrazuje prvních 200 podezřelých.

Vyberte událost a „Náhled nového geokódování“. Zkontrolujte obec, okres, dotaz, přesnost a důvod odmítnutí. Potvrzení se týká jediného ID, původních souřadnic i konkrétního návrhu. Změněný náhled se odmítne. Uložení a audit jsou v jedné transakci. Chráněné ruční body lze změnit jen explicitním ručním formulářem; checkbox označí polohu za ověřenou.

Hromadné mazání se neprovádí. `/api/admin/fix-geocode` podporuje pouze read-only preview; individuální `/api/admin/geocode-repair/:id` má `dry_run=true` jako výchozí stav. Diagnostika a opravy vyžadují admin relaci, nikoli ingest klíč.

## Mapa, testy a návrat

Veřejný přehled počítá nespolehlivé polohy, které zůstávají v tabulce a detailu. API zachovává raw souřadnice pro kompatibilitu a přidává `geo_reliable`, popisek, obec, okres a bezpečný důvod. Klient tyto body nepoužije na mapě. Legitimní shodné body mají jeden marker s počtem a seznam všech zásahů, stavy, časem, důvěryhodným koncem/délkou a tlačítkem detailu. Souřadnice se neposouvají a filtry mapy odpovídají tabulce.

Automatické testy používají pouze mock provider a izolovaný PostgreSQL/PGlite. Ověřují validaci kandidátů, cache, retry, ochranu ručních i přesnějších bodů, společné markery, dry-run, změněný náhled, audit a opakovanou migraci. Produkční výsledky a počty jsou v závěrečném reportu po nasazení.

Rollback: nasaďte předchozí commit, nové sloupce a tabulky ponechte. Žádná historická data se nemazala.

Mobilní popup má omezenou šířku i výšku, zůstává uvnitř mapy a nad ovládáním zoomu. Automatické obnovení zachovává otevřenou skupinu i posunutí jejího seznamu; filtr odstraněné skupiny popup zavře.
