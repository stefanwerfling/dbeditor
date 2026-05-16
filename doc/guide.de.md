# DB Editor — Bedienungsanleitung (DE)

Browser-basierter visueller Editor für relationale Datenbanken. Die Modellierungshälfte von MySQL Workbench, neu aufgesetzt als Projekt-internes Werkzeug: eine JSON-Datei als Source of Truth, automatische SQL-DDL-Generierung beim Speichern, vollständiger Forward-Engineering-Workflow für **MySQL, MariaDB, PostgreSQL und SQLite**.

> **Sprache / Language:** [English](./guide.en.md) · [Deutsch (diese Datei)](./guide.de.md)

---

## Inhaltsverzeichnis

1. [Überblick](#überblick)
2. [Erste Schritte](#erste-schritte)
3. [Projekt-Konfiguration (`dbeditor.json`)](#projekt-konfiguration-dbeditorjson)
4. [Import aus `.mwb`-Datei](#import-aus-mwb-datei)
5. [Die Editor-Oberfläche](#die-editor-oberfläche)
6. [Mit Tabellen arbeiten](#mit-tabellen-arbeiten)
7. [Fremdschlüssel](#fremdschlüssel)
8. [EER-Diagramme](#eer-diagramme)
9. [Views, Enums, Routinen](#views-enums-routinen)
10. [SQL generieren](#sql-generieren)
11. [Live-Sync mit einer Datenbank](#live-sync-mit-einer-datenbank)
12. [Tastenkürzel](#tastenkürzel)
13. [Konfigurations-Referenz](#konfigurations-referenz)

---

## Überblick

![Übersicht](./screenshots/01-overview.png)

Der Screenshot zeigt den Editor mit einem Demo-Schema (`users`, `posts`, `comments`, `categories` plus eine View `active_posts`). Links die **Treeview** mit allen Schema-Objekten, in der Mitte der **Canvas** mit den Beziehungen, oben die **Menüleiste**, unten links das **Warnungs-Panel**.

Alles wird in einer einzigen JSON-Datei persistiert (Schema-Datei, Default `./schemas/database.json`). Generierte SQL-DDL-Dateien landen unter `output.destinationPath`. Beide werden bei `autoGenerate: true` bei jedem Save neu geschrieben.

## Erste Schritte

```bash
# in deinem Projekt
npm install --save-dev git+https://github.com/stefanwerfling/dbeditor.git
node ./node_modules/.bin/dbeditor          # oder: npm run dev (wenn verdrahtet)
```

Beim ersten Start legt dbeditor eine Default-`dbeditor.json` im aktuellen Verzeichnis an, falls keine existiert, und öffnet den Editor unter `http://localhost:5274` (Default-Port).

Direkt aus dem Repo:

```bash
git clone https://github.com/stefanwerfling/dbeditor.git
cd dbeditor
npm install
node ./cli/dev.js
```

## Projekt-Konfiguration (`dbeditor.json`)

Die vollständige Referenz steht unten. Ein minimales Beispiel:

```jsonc
{
  "projects": [{
    "name": "MyDatabase",
    "schemaPath": "./schemas/database.json",
    "dialect": "mysql",             // mysql | mariadb | postgres | sqlite
    "output": {
      "mode": "ddl-files",          // ddl-files | migrations
      "destinationPath": "./schemas/sql"
    },
    "autoGenerate": false
  }],
  "server":  { "port": 5274 },
  "browser": { "open": false }
}
```

Du kannst `dbeditor.json` direkt editieren oder über **Project → Add project / Edit project / Project info** in der Menüleiste verwalten. Der Dev-Server startet bei Änderungen automatisch neu.

## Import aus `.mwb`-Datei

Über **File → Import .mwb…** liest du eine bestehende MySQL-Workbench-Datei ein. Der Dialog fragt, ob **Append** (zum bestehenden Schema hinzufügen) oder **Replace** (gesamtes Schema überschreiben).

Was importiert wird:

- Schemata und deren Default-Charset / Collation
- Tabellen, Spalten (PK / NN / AI / UNSIGNED / UNIQUE / Default / Comment), Indizes, Foreign Keys
- Views inkl. `SELECT`-Body und ihre Canvas-Position (`ViewFigure`)
- Routinen (Procedures, Functions) und Trigger (tabellenintern)
- Canvas-Positionen für Tabellen, die in irgendeinem Workbench-Diagramm eine `TableFigure` hatten
- EER-Diagramme (Workbench "Layers") mit Tabellen-Zuordnung pro Diagramm
- **Mehrfach-Zugehörigkeit von Tabellen** — eine Tabelle, die auf mehreren Workbench-Diagrammen platziert ist, wird in jedem Diagramm Mitglied und behält dort ihre eigene Position

Die Erfolgsmeldung zählt das Ergebnis auf (`Placed N of M tables and K of L views`, `Also: ... N tables on multiple diagrams`).

Roundtrip-relevante Felder, die Workbench braucht, dbeditor aber nicht modelliert, werden opak mitgeschleppt und beim Export wieder herausgeschrieben — so kannst du `.mwb` öffnen → editieren → zurückspeichern ohne Datenverlust. Das Sample unter `sample/example.mwb` ist ein kleines Demo-Schema, das die Roundtrip-Tests benutzen.

## Die Editor-Oberfläche

### Menüleiste

Die obere Zeile trägt den App-Namen + Version, die sieben Menüs, inline **Undo / Redo**-Buttons, die Zoom-Steuerung und den Auto-Save-Indikator.

- **File** — Import / Export `.mwb`, Reload config
- **Edit** — Undo / Redo, Bulk rename, Assign to EER diagram (Shortcut `L`)
- **Insert** — Add Table, Add Enum, Add EER diagram
- **View** — Zoom-Steuerung, Fit to view (`F`), N:N-Umschalter
- **Generate** — SQL generieren, ausgewähltes SQL kopieren, Markdown-Docs generieren / Vorschau
- **Project** — Project info, Project settings, Add / Edit / Remove project
- **Help** — Keyboard shortcuts, About

Die Undo / Redo-Pfeile neben der Zoom-Steuerung spiegeln die Edit-Menü-Einträge; sie werden ausgegraut, wenn der aktive Projekt-Stack leer ist.

![Insert-Menü mit "Add EER diagram"](./screenshots/08-menubar-insert.png)

Das Generate-Menü:

![Generate-Menü](./screenshots/06-menubar-generate.png)

Das Project-Menü:

![Project-Menü](./screenshots/04-menubar-project.png)

### Treeview

Das linke Panel gruppiert alles unter jeder Datenbank in zusammenklappbare Buckets: **EER diagrams**, **Tables**, **Views**, **Enums**, **Routines**. Das Filter-Feld oben blendet nicht-passende Zeilen aus, hält aber deren Eltern sichtbar. Leere Buckets zeigen einen blassen **+ Add &lt;Kind&gt;**-Hinweis, der denselben Anlege-Dialog wie das `⋯`-Menü des Containers öffnet.

Über dem Baum schaltet ein **Modell / Live**-Toggle zwischen der Design-Ansicht (Modell) und einem read-only Live-Snapshot der konfigurierten Datenbank (Live) um. Der Live-Tab trägt ein kleines Badge mit der Anzahl der Datenbanken, für die eine Connection konfiguriert ist — ist es leer, gibt es nichts umzuschalten.

Klick auf eine Zeile macht sie zum **aktiven Container** (der Canvas zeigt nur deren Inhalt). Klick auf eine EER-Diagramm-Zeile scoped den Canvas auf nur dieses Diagramm — der Rest wird ausgeblendet und der Diagramm-Name erscheint als Sticky-Banner über dem Canvas:

![Canvas auf ein EER-Diagramm gescoped](./screenshots/03-eer-diagram-scoped.png)

Jede Zeile hat ein nur-bei-Hover sichtbares `⋯`-Menü mit zeilen-passenden Aktionen (inline umbenennen, Kind hinzufügen, löschen, …). Das Menü der Datenbank-Zeile ist der Einstieg für fast alles:

![Datenbank-Zeile Kontextmenü](./screenshots/02-treeview-database-menu.png)

### Canvas

Tabellen, Views und EER-Diagramm-Hintergründe liegen auf dem Canvas. Karte ziehen verschiebt sie; SE-Ecke eines Diagramm-Hintergrunds zieht ihn größer/kleiner; Doppelklick auf den Titel-Bereich erlaubt Inline-Rename.

Foreign Keys werden als ER-Style-Linien mit Crow's-Foot- oder One-Bar-Terminierungen gezeichnet. Gestrichelte Linie heißt nullable; die Kardinalität ergibt sich automatisch aus PK / UNIQUE / NOT NULL der Spalten. N:N-Beziehungen über eine Junction-Tabelle bekommen eine zusätzliche gestrichelte Linie direkt zwischen den Außen-Tabellen (Sichtbarkeit umschaltbar über **View → N:N**).

Wenn du eine FK-Linie überfährst, werden beide Endpunkt-Spalten in einem Teal-Ton hervorgehoben; umgekehrt — fährst du über eine Spaltenzeile, werden alle FK-Partner-Spalten markiert (und die überfahrene Zeile selbst). Bei einem PK mit vielen eingehenden Referenzen sieht man so auf einen Blick, wie viele Tabellen davon abhängen.

### Warnungs-Panel

Unter der Treeview listet das Warnungs-Panel Schema-Validierungs-Probleme (Tabelle ohne PK, AI ohne PK, hängende FK-Referenzen, …). Klick auf eine Warnung springt zur betroffenen Datenbank.

## Mit Tabellen arbeiten

Jede Karte hat ein nur-bei-Hover sichtbares `⋯`-Menü im Header:

![Tabellen-Karten-Aktionen](./screenshots/07-table-card-menu.png)

- **Rename table** — Inline-Rename des Tabellennamens
- **Table options…** — Engine, Charset, Collation, Tablespace, Comment
- **Assign to EER diagram…** — Single-Table Multi-Select-Dialog (Tabelle kann in mehreren Diagrammen sein)
- **Remove from "&lt;Diagramm&gt;"** — nur wenn der Canvas auf ein einzelnes EER-Diagramm gescoped ist; entfernt die Tabelle aus genau diesem Diagramm, ohne sie aus dem Schema zu löschen
- **Duplicate** — Deep-Clone mit `_copy`-Suffix
- **Delete table** — löscht die Tabelle und kaskadiert auf FKs in anderen Tabellen

### Spalten

Jede Spaltenzeile hat ihr eigenes Hover-`⋯`-Menü (edit, als Primary Key setzen, Auto-Increment, löschen). Klick auf `+ add column` unten in der Spaltenliste fügt eine hinzu.

Eine Spaltenzeile per Drag nach oben/unten ziehen **sortiert** sie um (4px-Schwelle, damit Single-/Double-Klicks weiter funktionieren). Am rechten Rand jeder Zeile erscheint bei Hover ein kleiner grüner Punkt — das ist der **FK-Quell-Griff**; von dort auf eine Spalte einer anderen Tabelle ziehen erstellt einen Foreign Key.

### Indizes

Der `INDEXES`-Bereich unter den Spalten listet jeden Nicht-Primary-Index. `+` fügt einen hinzu; Klick auf einen Eintrag öffnet den Editor (Typ / Spaltenliste mit ASC/DESC + Präfix-Länge / Partial-Index `WHERE`-Klausel, soweit der Dialekt das unterstützt).

### Fremdschlüssel

Zwei Wege:

1. **Vom grünen Griff ziehen** auf einer Spaltenzeile zu einer Spalte einer anderen Tabelle. Der neue FK öffnet inline einen Editor — ON DELETE / ON UPDATE / Constraint-Name anpassen.
2. **Klick** auf eine bestehende FK-Linie auf dem Canvas öffnet den Editor; Endpunkte ziehen route neu.

Composite Foreign Keys werden als eine Linie pro Spalten-Paar gezeichnet, damit jede Verbindung sichtbar bleibt. N:N-Junction-Tabellen (Composite-PK gleich Union zweier FKs zu zwei Außen-Tabellen) bekommen zusätzlich eine gestrichelte `N:N via <junction>`-Linie zwischen den Außen-Tabellen; umschaltbar über **View → N:N**.

## EER-Diagramme

EER-Diagramme sind visuelle Gruppierungs-Rechtecke für eine Teilmenge deiner Tabellen. Ein einzelnes Schema kann beliebig viele Diagramme haben; Tabellen können einem oder mehreren Diagrammen angehören, jeweils mit eigener Position pro Diagramm.

### Diagramm erstellen

Drei Wege:

1. Treeview → Datenbank-Zeile `⋯` → **Add EER diagram** (Screenshot oben)
2. Menüleiste **Insert → Add EER diagram**
3. **Alt + drag** auf leerem Canvas zieht das Bounding-Rectangle, Name beim Loslassen

### Tabellen zu einem Diagramm hinzufügen

Vier Wege:

1. **Tabellen-Karte** auf das Diagramm-Rechteck auf dem Canvas droppen. Wenn die Drop-Position innerhalb des Rechtecks landet, wird die Tabelle Mitglied (primärer `layerUnid` wird gesetzt, falls leer, sonst kommt eine zusätzliche Placement-Entry dazu).
2. **Treeview-Tabellenzeile** auf eine Treeview-EER-Diagramm-Zeile ziehen (blaue Drop-Target-Hervorhebung).
3. **Tabellen-Karten-`⋯`-Menü → Assign to EER diagram…** öffnet einen Checkbox-Dialog. Jedes Diagramm anhaken, in dem die Tabelle erscheinen soll. Erstes angehaktes wird primäres Diagramm; Rest werden zusätzliche Placements mit unabhängigen Positionen.
4. **Taste `L`** mit einer oder mehreren markierten Tabellen.

### Multi-Diagramm-Positionen

Eine Tabelle, die in zwei Diagrammen ist, kann in jedem eine andere Position haben. Im Diagramm-Scope (du hast auf eine Diagramm-Treeview-Zeile geklickt) schreibt das Ziehen einer Karte in die Placement-Position dieses Diagramms. Außerhalb jedes Scopes schreibt das Ziehen in die "Home-Position" der Tabelle, die im unscoped View benutzt wird.

## Views, Enums, Routinen

- **Views** — View-Dialog öffnen (Treeview-Doppelklick oder Canvas-`⋯` → Edit body); Felder: Name + Raw-SELECT-Body in Monospace-Textfeld + `MATERIALIZED`-Flag (nur Postgres). Jede View kann über das Karten-`⋯ → Assign to EER diagram…` einem einzelnen EER-Diagramm zugeordnet werden; im Diagramm-Scope erscheinen nur Views, die zu diesem Diagramm gehören.
- **Enums** — Name + Werte-Liste mit Inline-Edit. Der Dialog diffed deine Änderungen gegen den aktuellen Stand und feuert die passenden API-Calls.
- **Routinen** — Procedures, Functions und Trigger. Body ist Raw-SQL; der Editor parst keine Parameter.

## SQL generieren

Zwei Output-Modi (`output.mode` in `dbeditor.json`):

- **`ddl-files`** — eine `<tabelle>.sql` pro Tabelle, plus `<view>.view.sql`, plus `_enums.sql` (Postgres) und eine `_foreign_keys.sql` als letzte (damit alphabetisches Laden nicht crasht). Default.
- **`migrations`** — ein zeitgestempeltes `*.up.sql` / `*.down.sql`-Paar pro Generate-Lauf.

Generierung über **Generate → Generate SQL**. **Copy selected SQL** (`Strg+Shift+C`) legt das DDL für die aktuell markierten Karten in die Zwischenablage, ohne auf Platte zu schreiben. **Generate docs (Markdown)** schreibt pro Datenbank eine `.md`-Datei nach `<destinationPath>/docs/`; **Preview docs** macht das Gleiche in einem Dialog ohne zu schreiben.

Für einen Preview-Run begrenzt auf eine Datenbank oder Tabelle ohne das Output-Verzeichnis anzufassen: Treeview-Zeile-`⋯`-Menü → **Generate SQL (this DB)…** / **Generate SQL (this table)…** — beide öffnen einen Dialog mit Datei-Liste + Inhalten.

Bei `autoGenerate: true` schreibt jeder Save sowohl Schema-JSON als auch SQL-Output.

## Live-Sync mit einer Datenbank

Der Sync-Workflow ist `Modell → Live`: das Schema-File ist die Wahrheit, dbeditor berechnet das DDL, um eine Live-Datenbank passend dazu zu machen.

### Connection einrichten

Connection in `dbeditor.json` eintragen:

```jsonc
{
  "projects": [{
    "name": "MyDatabase",
    "dialect": "mariadb",
    "connections": [{
      "databaseUnid": "<die unid eines database-Containers im Schema>",
      "host": "${DB_HOST:-localhost}",
      "port": 3306,
      "user": "${DB_USER}",
      "password": "${DB_PASSWORD}",
      "database": "myappdb",
      "ssl": false,
      "readOnly": false
    }]
  }]
}
```

Die `${VAR}` und `${VAR:-default}` Platzhalter werden beim Server-Boot aus `.env` substituiert — Credentials müssen also nicht im JSON stehen.

Auch über die UI editierbar: **Project → Project info** listet Connections mit Test / Edit / Rebind / Remove. **+ Add connection…** legt eine neue an. **Rebind** tauscht die `databaseUnid` einer Connection, wenn ein Schema-Reload die UUIDs neu generiert hat — Credentials bleiben erhalten.

### Diff-Vorschau

**Treeview → Datenbank-`⋯` → Sync with DB…** (der Eintrag erscheint nur, wenn für die Datenbank eine Connection konfiguriert ist). Der Sync-Dialog:

- Status-Zeile oben zeigt, wie viele Änderungen der Diff gefunden hat
- Linke Liste zeigt jede Änderung mit Severity-Badge (`+` add, `~` modify, `!` destructive) und Checkbox
- Rechtes Panel hat zwei Tabs: **SQL** (zusammengesetztes DDL für die selektierten Änderungen, kopierbar via `Copy SQL`) und **Diff** (Live vs. Modell Side-by-Side-Karte für die fokussierte Änderung)
- Footer: **Test connection**, **Ignore settings…**, **Refresh**, **Copy SQL**, **History…**, **Reverse apply…**, **Test run…**, **Apply…**

Rename-Paare lassen sich manuell verkoppeln: das `⋯`-Menü einer `tableDropped`-Zeile listet alle `tableAdded`-Kandidaten als "Mark as rename → newname". Der Diff collapsed das Paar zu einem einzigen `tableRenamed`. Gleiches gilt für Spalten innerhalb einer ungeänderten Tabelle.

### Test-Run (dump → apply → restore)

Der sichere Weg, einen Change-Set vor dem produktiven Apply zu validieren. **Test run…** klicken, im Dialog bestätigen, dann:

1. Server dumpt die Live-DB nach `<destinationPath>/sync-tests/<timestamp>__<dbname>.sql`
2. Führt jedes selektierte Statement gegen die Live-DB aus
3. Restored IMMER aus dem Dump (auch bei vollem Erfolg)
4. Berichtet das Ergebnis im Dialog

Drei Ausgänge:

- **Alles grün** — jedes Statement lief sauber durch; DB ist wieder im Pre-Test-Zustand; das SQL-Panel enthält genau das, was du in eine TypeORM-Migration packen würdest
- **Apply ist sauber gescheitert** — ein Statement failte; DB wurde restored; das Log zeigt welches und warum
- **KRITISCH — Restore gescheitert** — Sticky-Red-Banner mit Dump-Pfad und manuellem `mysql -h … < <dump>` Recovery-Befehl; die Live-DB ist möglicherweise inkonsistent und braucht manuelle Wiederherstellung

Voraussetzungen: `mysqldump` und `mysql` Binaries auf PATH; der Connection-User braucht `RELOAD`, `LOCK TABLES`, `SELECT` (Dump) plus `DROP`, `CREATE`, `ALTER`, `INSERT` (Restore). Aktuell nur MySQL/MariaDB — Postgres/SQLite geben 501 Not Implemented zurück.

### Apply

**Apply…** ist die produktive Aktion: führt jedes selektierte Statement gegen die Live-DB aus, schreibt ein Migration-Paar (`*.up.sql` + `*.down.sql`) nach `<destinationPath>/migrations/`, und legt einen History-Eintrag an. Mit Bestätigung; destruktive Änderungen färben den Dialog rot.

**Dry-run** (Checkbox im Dialog) wickelt den Batch in `BEGIN; … ROLLBACK;` — Best-Effort, weil das meiste MySQL-DDL implizit committed.

### Reverse-Apply

Die Gegenrichtung: **Reverse apply…** mutiert das Modell, um für die selektierten Änderungen den Live-DB-Zustand zu übernehmen. Es läuft KEIN SQL gegen die Live-DB. Nützlich, wenn auf dem Server manuell etwas geändert wurde und du dein Modell wieder in Sync bringen willst.

### History

**History…** öffnet eine chronologisch-rückwärtige Liste jedes Apply / Test-Run / Reverse-Apply-Laufs. Jede Zeile zeigt Modus, Zeitstempel, Change-Zusammenfassung (`tableAdded ×2 · columnDropped ×1`) und Erfolg / Fehler / KRITISCH-Status. Klick auf eine Zeile → Detail-Panel mit:

- Metadata (Status, Dauer, Migrations-Datei-Pfade, Dump-Info, ggf. Restore-Fehler)
- **Combined SQL**-Block mit allen Statements zusammengeführt für One-Click-Copy → portierbar in TypeORM / Doctrine / was auch immer
- Pro-Statement-Log mit Status-Icon + SQL + Dauer

Liegt unter `<schema dir>/sync-history.json`. Newest-first, append-only.

## Tastenkürzel

![Shortcuts-Dialog](./screenshots/09-shortcuts-help.png)

Aufrufbar über **Help → Keyboard shortcuts** oder `?`. Auszug:

| Tasten | Aktion |
|---|---|
| `Strg/Cmd + Z` | Undo |
| `Strg/Cmd + Shift + Z` | Redo |
| `Strg/Cmd + K` oder `Strg/Cmd + P` | Suche (Tabellen, Spalten, Diagramme) |
| `Strg/Cmd + Shift + C` | SQL für markierte Tabellen kopieren |
| `R` | Umbenennen markierter (inline bei 1, Bulk-Pattern bei 2+) |
| `O` | Optionen editieren markierter (1 = voll, 2+ = sparse Patch) |
| `L` | Markierte Tabelle(n) einem EER-Diagramm zuweisen |
| `F` | Canvas an View anpassen |
| `Entf` / `Backspace` | Markierte löschen |
| `Alt + drag` (leerer Canvas) | Neues EER-Diagramm sketchen |
| `Shift / Strg + Klick` | Additive / Toggle-Auswahl |
| `Drag` (leerer Canvas) | Rubber-Band-Selektion |
| `?` | Diesen Hilfe-Dialog |

## Konfigurations-Referenz

Vollständige Form von `dbeditor.json` (autoritativ: `Config/Config.ts`):

```jsonc
{
  "projects": [{
    "name": "MyDatabase",
    "schemaPath": "./schemas/database.json",
    "dialect": "mysql",                         // mysql | mariadb | postgres | sqlite
    "output": {
      "mode": "ddl-files",                      // ddl-files | migrations
      "destinationPath": "./schemas/sql",
      "destinationClear": false,                // Verzeichnis vor Generierung leeren
      "sqlComment": true,                       // -- Kommentare emittieren
      "sqlIndent": "    ",
      "statementTerminator": ";",
      "migrationFilenamePattern": "{timestamp}__{name}"
    },
    "scripts": {
      "before_generate": [{"script": "echo vor", "path": "."}],
      "after_generate":  [{"script": "echo nach", "path": "."}]
    },
    "autoGenerate": false,
    "connections": [{
      "databaseUnid": "uuid-einer-datenbank-im-schema",
      "host": "${DB_HOST:-localhost}",
      "port": 3306,
      "user": "${DB_USER}",
      "password": "${DB_PASSWORD}",
      "database": "myappdb",
      "schema": "public",                       // nur Postgres
      "ssl": false,
      "readOnly": false
    }],
    "sync": {
      "ignoreTables": ["temp_logs"],
      "ignoreColumnAttributes": ["comment"]
    }
  }],
  "server":  { "port": 5274, "limit": "10mb" },
  "browser": { "open": false }
}
```

- `dbeditor.json`, `schemas/` und `.env` sind per Default in `.gitignore` — sie sind pro Benutzer.
- Projekt-Identität ist eine Runtime-UUID (bei jedem Boot neu generiert). Das `databaseUnid` in `connections[]` muss zu einem Database-Container in deinem Schema-File passen.
- `${VAR}` / `${VAR:-default}` Platzhalter werden nach dem JSON-Parsing aus `process.env` aufgelöst.
- `output.destinationPath` ist relativ zum Projekt-Root (das Verzeichnis mit `dbeditor.json`).