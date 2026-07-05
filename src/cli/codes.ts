// Static tables of the Entgeltatlas dimension codes (l/r/g/a/b), transcribed from
// the API documentation. Used by the `codes` command so the numeric codes are
// discoverable offline — including the `l` (performance level) dimension, which
// has no reference endpoint. The live `regionen`/`geschlechter`/`alter`/`branchen`
// commands hit the API for the authoritative lists.

export interface CodeEntry {
  id: number;
  bezeichnung: string;
}

export interface Dimension {
  /** The query-parameter letter (l/r/g/a/b). */
  param: string;
  /** The CLI flag name. */
  flag: string;
  /** German name of the dimension. */
  label: string;
  values: CodeEntry[];
}

export const DIMENSIONS: Dimension[] = [
  {
    param: "l",
    flag: "--level",
    label: "Anforderungsniveau (Leistungsgruppe)",
    values: [
      { id: 1, bezeichnung: "Helfer" },
      { id: 2, bezeichnung: "Fachkraft" },
      { id: 3, bezeichnung: "Spezialist" },
      { id: 4, bezeichnung: "Experte" },
    ],
  },
  {
    param: "r",
    flag: "--region",
    label: "Region (Bund/Ost/West, Länder, Städte)",
    values: [
      { id: 1, bezeichnung: "Deutschland" },
      { id: 2, bezeichnung: "Ostdeutschland" },
      { id: 3, bezeichnung: "Westdeutschland" },
      { id: 4, bezeichnung: "Schleswig-Holstein" },
      { id: 5, bezeichnung: "Hamburg" },
      { id: 6, bezeichnung: "Niedersachsen" },
      { id: 7, bezeichnung: "Bremen" },
      { id: 8, bezeichnung: "Nordrhein-Westfalen" },
      { id: 9, bezeichnung: "Hessen" },
      { id: 10, bezeichnung: "Rheinland-Pfalz" },
      { id: 11, bezeichnung: "Baden-Württemberg" },
      { id: 12, bezeichnung: "Bayern" },
      { id: 13, bezeichnung: "Saarland" },
      { id: 14, bezeichnung: "Berlin" },
      { id: 15, bezeichnung: "Brandenburg" },
      { id: 16, bezeichnung: "Mecklenburg-Vorpommern" },
      { id: 17, bezeichnung: "Sachsen" },
      { id: 18, bezeichnung: "Sachsen-Anhalt" },
      { id: 19, bezeichnung: "Thüringen" },
      { id: 20, bezeichnung: "Dresden" },
      { id: 21, bezeichnung: "Düsseldorf" },
      { id: 22, bezeichnung: "Dortmund" },
      { id: 23, bezeichnung: "Essen" },
      { id: 24, bezeichnung: "Frankfurt am Main" },
      { id: 25, bezeichnung: "Nürnberg" },
      { id: 26, bezeichnung: "Hannover" },
      { id: 27, bezeichnung: "Köln" },
      { id: 28, bezeichnung: "Leipzig" },
      { id: 29, bezeichnung: "München" },
      { id: 30, bezeichnung: "Stuttgart" },
    ],
  },
  {
    param: "g",
    flag: "--gender",
    label: "Geschlecht",
    values: [
      { id: 1, bezeichnung: "Gesamt" },
      { id: 2, bezeichnung: "Männer" },
      { id: 3, bezeichnung: "Frauen" },
    ],
  },
  {
    param: "a",
    flag: "--age",
    label: "Alter",
    values: [
      { id: 1, bezeichnung: "Gesamt" },
      { id: 2, bezeichnung: "unter 25 Jahre" },
      { id: 3, bezeichnung: "25 bis unter 55 Jahre" },
      { id: 4, bezeichnung: "55 Jahre und älter" },
    ],
  },
  {
    param: "b",
    flag: "--branch",
    label: "Branche (Wirtschaftszweig)",
    values: [
      { id: 1, bezeichnung: "Gesamt" },
      { id: 2, bezeichnung: "Land- und Forstwirtschaft, Fischerei" },
      { id: 3, bezeichnung: "Produzierendes Gewerbe ohne Baugewerbe" },
      { id: 4, bezeichnung: "Baugewerbe" },
      { id: 5, bezeichnung: "Handel, Verkehr und Lagerei, Gastgewerbe" },
      { id: 6, bezeichnung: "Information und Kommunikation" },
      { id: 7, bezeichnung: "Finanz- und Versicherungsdienstleistungen" },
      { id: 8, bezeichnung: "Grundstücks- und Wohnungswesen" },
      { id: 9, bezeichnung: "Erbringung von wirtschaftlichen Dienstleistungen" },
      { id: 10, bezeichnung: "Öffentliche Verwaltung, Schul-, Gesundheits- und Sozialwesen" },
      { id: 11, bezeichnung: "Sonstige Dienstleistungen" },
    ],
  },
];
