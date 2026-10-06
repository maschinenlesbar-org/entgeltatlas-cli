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
prüfen Sie die Bezeichnungen in jeder zurückgegebenen Zeile. Ein Code, der nicht in seiner
Tabelle steht (z. B. `-r 31`), wird vor jeder Anfrage abgelehnt, von der CLI wie von der
Bibliothek (`DIMENSIONS` enthält die Tabellen), weil die API ihn sonst ignorieren und den
ungefilterten Ausschnitt liefern könnte.

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
| `region.beitragsBemessungsGrenze` | Die Beitragsbemessungsgrenze der Sozialversicherung. Entgelte darüber sind **zensiert**, daher können `entgelt`/`entgeltQ75` am oberen Ende künstlich flach wirken oder als Kennzeichnung `-2` kommen (siehe unten). |

### Unterdrückte Werte (Datenschutz / kleine Fallzahl)

Beruht ein Ausschnitt auf zu wenigen Beobachtungen, werden seine Werte aus
Datenschutzgründen **unterdrückt**. In der am 06.10.2026 live aufgezeichneten Antwort
kennzeichnet die API das mit **negativen Zahlen**, nicht mit `null`: `entgelt`,
`entgeltQ25` und `entgeltQ75` kommen als `-1`, `besetzung` ebenfalls negativ (dort `-42`).
Ein Quartil oberhalb der Beitragsbemessungsgrenze kam als `-2` (`entgeltQ75: -2` neben
einem echten Median): Entgelte oberhalb der Grenze sind nicht bekannt, was die
Webanwendung der BA als „> BBG“ zeigt. Diese Bedeutungen sind aus jener Antwort und den
Hilfetexten der Webanwendung abgeleitet, nicht dokumentiert; die Regel ist daher einfach:
**Jeder negative Wert ist eine Kennzeichnung, kein Betrag** – nie in € angeben, nie
damit eine Lücke oder einen Mittelwert rechnen. Ein **leeres Array** oder **`null`**-Werte
(aus der Community-Spezifikation, live nicht gesehen) bedeuten dasselbe: kein Wert –
**niemals `0`**. Client und CLI geben all das unverändert weiter.

## Begriffe zur Authentifizierung

- **X-API-Key** – der statische Header, über den sich diese API authentifiziert. Sein Wert ist
  die öffentliche **`clientId`**, die die Entgeltatlas-Webanwendung der BA selbst konfiguriert
  (eine Zugangskennung, keine Berechtigung pro Nutzer; ein kurzer Name wie `infosysbub-ega`,
  nicht mehr die UUID `client_id`, die das bundesAPI-README noch nennt – die lehnt das Gateway
  seit 2026 ab). Abrufen mit `entgeltatlas obtain-key`; committen Sie ihn nie – auch nicht den
  öffentlichen Community-Schlüssel. Tests verwenden offensichtliche Dummy-Werte, damit das Repo
  keinerlei echte Zugangsdaten enthält.
- **WAF / 403** – `rest.arbeitsagentur.de` antwortet mit einem **HTTP 403 mit leerem Body**
  bei falschem, veraltetem oder fehlendem Schlüssel und bei einem Netz, das die WAF abweist
  (IP-Adressen aus Rechenzentren, VPNs und Clouds). Die Antwort allein unterscheidet diese
  Fälle nicht. Prüfen Sie zuerst den Schlüssel mit `entgeltatlas obtain-key` – siehe
  [DEVELOPING.md](DEVELOPING.md). Den OAuth-Client-Credentials-Ablauf von Upstream braucht es
  nicht: Der `X-API-Key` funktioniert.

Namensnennung und Bedingungen zur Weiterverwendung: siehe [DATA_LICENSE.md](DATA_LICENSE.md).
