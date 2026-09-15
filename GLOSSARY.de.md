# Glossar

Begriffe des Entgeltatlas und das Vokabular, das diese CLI verwendet. Die API beantwortet eine
Frage: *Was verdient man in einem bestimmten Beruf?* – als **Median des
Bruttomonatsentgelts**, aufgeschlüsselt nach fünf Dimensionen.

## Berufe

| Begriff | Bedeutung |
|---|---|
| **KldB 2010** | *Klassifikation der Berufe 2010* – die Berufssystematik der BA. Pflichtargument des Befehls `entgelte`. Codes haben 3–5 Ziffern (z. B. `84304` = „Berufe in der Hochschullehre und -forschung – hoch komplexe Tätigkeiten“). Wird als **String** geführt (führende Nullen zählen). |
| **Name → Code** | Diese API hat **keine Namenssuche**. Einen Berufsnamen lösen Sie über die verwandten APIs BERUFENET / DKZ oder den [Klassifikationsserver](https://www.klassifikationsserver.de/) in seinen KldB-Code auf. |

## Die fünf Dimensionen

Jede Dimension wird als numerischer Code übergeben; die vollständigen Tabellen liefert
`entgeltatlas codes`. Der Code `1` ist nur bei `-g`, `-a` und `-b` der Gesamtwert `Gesamt`:
Bei `-l` steht er für `Helfer` (ein Gesamt-Niveau gibt es nicht), bei `-r` für `Deutschland`.
Lassen Sie ein Flag weg, wird kein Parameter gesendet und der Server wählt den Ausschnitt;
das ist gegen die Live-API nicht geprüft. Übergeben Sie die gewünschten Dimensionen und
prüfen Sie die Bezeichnungen in jeder zurückgegebenen Zeile.

| Flag | Parameter | Dimension | Codes |
|---|---|---|---|
| `-l` | `l` | **Anforderungsniveau** | 1 Helfer · 2 Fachkraft · 3 Spezialist · 4 Experte |
| `-r` | `r` | **Region** | 1 Deutschland · 2 Ost · 3 West · 4–19 die 16 Länder · 20–30 elf Städte (**unregelmäßig** – nicht 1..16) |
| `-g` | `g` | **Geschlecht** | 1 Gesamt · 2 Männer · 3 Frauen |
| `-a` | `a` | **Alter** | 1 Gesamt · 2 unter 25 · 3 25 bis unter 55 · 4 ab 55 |
| `-b` | `b` | **Branche** (Wirtschaftszweig) | 1 Gesamt … 11 (siehe `codes`) |

## Die Zahlen lesen

| Feld | Bedeutung |
|---|---|
| `entgelt` | **Median** des Bruttomonatsentgelts in EUR, Vollzeit. **Nicht** das arithmetische Mittel – die BA berechnet bewusst keinen Mittelwert (Entgelte oberhalb der Bemessungsgrenze sind unbekannt). |
| `entgeltQ25` / `entgeltQ75` | Unteres / oberes Quartil (25. / 75. Perzentil), EUR. |
| `besetzung` | Die Zahl der Beschäftigten, auf der die Werte beruhen – eine **Personenzahl, kein Entgelt**. |
| `region.beitragsBemessungsGrenze` | Die Beitragsbemessungsgrenze der Sozialversicherung. Entgelte darüber sind **zensiert**, daher können `entgelt`/`entgeltQ75` am oberen Ende künstlich flach wirken. |

### Unterdrückte Werte (Datenschutz / kleine Fallzahl)

Beruht ein Ausschnitt auf zu wenigen Beobachtungen, wird der Wert aus Datenschutzgründen
**unterdrückt**: Die Antwort ist ein **leeres Array**, oder die numerischen Felder kommen als
**`null`** zurück. Das bedeutet **„nicht verfügbar / n zu klein“ – niemals `0`**. Client
und CLI geben `null` unverändert weiter; werten Sie es nicht als Entgelt von null.

## Begriffe zur Authentifizierung

- **X-API-Key** – der statische Header, über den sich diese API authentifiziert. Sein Wert ist
  die von der BA veröffentlichte Community-UUID **`client_id`** (eine Zugangskennung, keine
  Berechtigung pro Nutzer). Abrufen mit `npm run fetch-key`; committen Sie ihn nie – auch nicht
  den öffentlichen Community-Schlüssel. Tests verwenden eine offensichtliche Dummy-UUID
  (`00000000-0000-4000-8000-000000000000`), damit das Repo keinerlei echte Zugangsdaten enthält.
- **WAF / 403** – `rest.arbeitsagentur.de` liegt hinter einer Akamai-WAF, die IP-Adressen aus
  Rechenzentren, VPNs und Clouds mit einem **HTTP 403 mit leerem Body** blockiert, selbst bei
  gültigem Schlüssel. Ein falscher oder fehlender Schlüssel erhält denselben 403 mit leerem
  Body; die Antwort allein unterscheidet eine IP-Sperre also nicht von einem
  Authentifizierungsfehler. Prüfen Sie zuerst den Schlüssel und versuchen Sie es dann aus einem
  anderen Netz – siehe [DEVELOPING.md](DEVELOPING.md).

Namensnennung und Bedingungen zur Weiterverwendung: siehe [DATA_LICENSE.md](DATA_LICENSE.md).
