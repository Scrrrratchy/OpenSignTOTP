# Automatische Migration beim Update

Diese Version führt die Migration vor der Freigabe der Anwendung aus. Es gibt
keinen parallelen `parse-dbtool`-Prozess mehr. Der öffentliche HTTP-Port bleibt
geschlossen, bis Schemata, Berechtigungen, Datenübernahme und Indizes erfolgreich
geprüft wurden. Ein Fehler beendet den Serverprozess mit Exit-Code 1.

## Vor dem ersten Start

1. Die alte Anwendung und alle ihre schreibenden Replikate stoppen. Der erste
   Wechsel von einem alten Image erfolgt im Wartungsfenster, nicht als gemischter
   Rolling-Update-Betrieb mit gleichzeitig weiterlaufenden Altversionen.
2. MongoDB und gespeicherte Dateien vollständig sichern.
3. Genau eine Datenbankadresse konfigurieren: `DATABASE_URI` oder `MONGODB_URI`.
   Sind beide gesetzt, müssen die Werte identisch sein. Es gibt keinen stillen
   Fallback auf eine Entwicklungsdatenbank mehr.
4. Schlüssel wie unten beschrieben bereitstellen. Bestehende Schlüssel nicht
   ersetzen, nur weil ein neues Image gebaut wird.
5. Die neuen lokalen Images bauen und bereitstellen, beispielsweise über
   `docker-compose.onprem.yml`. Das veröffentlichte Image
   `scrrrratchy/totp-opensign-server:v2.41.0` wird dadurch nicht verändert.

## TOTP-Schlüssel und Übernahme

**Bei Verwendung unserer bisherigen lokalen TOTP-Version:** Den vorhandenen
`TOTP_ENCRYPTION_KEY` unverändert behalten. Die Daten in `_OpenSignMfa` werden
weiterverwendet und vor dem Start auf Entschlüsselbarkeit geprüft.

**Beim Wechsel vom geprüften Image v2.41.0:**

- `TOTP_ENCRYPTION_KEY` ist der dauerhafte Schlüssel der neuen Version: genau
  64 Hex-Zeichen. Falls es bisher keinen solchen Schlüssel gibt, einmalig
  erzeugen und sicher sichern.
- In `LEGACY_MFA_ENCRYPTION_KEY` den tatsächlich für die alten TOTP-Einrichtungen
  verwendeten Schlüssel hinterlegen: den alten `MFA_ENCRYPTION_KEY`, oder – wenn
  dieser nicht gesetzt war – den alten `MASTER_KEY`. Die Variable gehört in die
  Serverumgebung, bei Compose beispielsweise in `.env.prod`, nicht in den Client.
- Alternativ werden für den ersten Import `MFA_ENCRYPTION_KEY` und danach
  `MASTER_KEY` als alte Schlüsselquelle berücksichtigt. Ein ausdrücklich
  gesetzter `LEGACY_MFA_ENCRYPTION_KEY` hat Vorrang.

Bestätigte Einrichtungen aus `OpenSign_MFA` werden in das interne Datenmodell
übernommen und mit `TOTP_ENCRYPTION_KEY` verschlüsselt. Die Authenticator-App
muss nicht neu eingerichtet werden. Bisherige Wiederherstellungscodes bleiben
einmalig nutzbar; ihre alten Prüfwerte und der dazu nötige Verifikationsschlüssel
werden geschützt übernommen. Neue Einrichtungen verwenden das neue Codeformat.

Aktive Sitzungen importierter Konten und noch offene alte Login-Challenges
werden ungültig. Benutzer melden sich erneut mit Passwort und zweitem Faktor
an. Unbestätigte alte Einrichtungen müssen neu begonnen werden.

Importe werden pro Konto festgehalten. Verwendete Wiederherstellungscodes werden
bei einem Neustart nicht erneut importiert. Nach einer bewussten Deaktivierung
oder einem administrativen Reset verhindert ein interner Importvermerk, dass
die alte Einrichtung beim nächsten Start wieder aktiviert wird.

Nach vollständig erfolgreichem Import ist der alte Schlüssel nicht mehr als
Umgebungsvariable notwendig. `TOTP_ENCRYPTION_KEY` bleibt dauerhaft erforderlich.
Die alten Quelldatensätze bleiben zur Nachvollziehbarkeit erhalten und sind
über vollständig gesperrte Parse-Klassenberechtigungen vor Clientzugriffen
geschützt. Ein direkter Rückwechsel auf das alte Image ist kein unterstützter
Rollback; dafür das vollständige Backup verwenden.

## Ablauf und Wiederholbarkeit

- Eine Datenbanksperre serialisiert gleichzeitig startende neue Instanzen.
  Die Sperre wird erneuert; nach einem Prozessabbruch kann eine neue Instanz
  den abgelaufenen Lease übernehmen. Wartet eine Instanz länger als fünf Minuten
  auf eine aktive Migration, bricht ihr Start ab und kann erneut versucht werden.
- Historische Schemamigrationen werden unter Berücksichtigung vorhandener Felder
  und Indizes abgeglichen. Ein Versionsfingerabdruck kennzeichnet den
  abgeschlossenen Schemaabgleich. Teilweise erledigte Läufe lassen sich erneut
  ausführen. Abweichende Feldtypen werden nicht automatisch konvertiert.
- Die Klassen `OpenSign_MFA`, `OpenSign_MFAChallenge`, `Migration` und `Migrationdb`
  erhalten gesperrte Client-Berechtigungen.
- Bestehende Konten erhalten ein einheitliches `normalizedEmail`. Vor den
  Änderungen werden alle Zielwerte auf Kollisionen geprüft. Auch Neuanlagen und
  spätere E-Mail-Änderungen verwenden dieselbe Normalisierung.
- Benötigte Indizes werden tatsächlich erstellt bzw. geprüft, auch wenn ein
  alter Migrationsmarker bereits vorhanden ist. Neue Abschlussmarker werden erst
  nach den erfolgreichen Schritten geschrieben.
- Die Umstellung unveränderter englischer Standard-Mailvorlagen läuft ebenfalls
  vor der Freigabe des Servers.

Die Migration verändert vorhandene Daten schrittweise und wiederholbar; sie ist
keine einzelne atomare Transaktion über alle Collections und Schemaoperationen.
Vorherige vollständige Backups bleiben deshalb erforderlich.

## Wenn der Start abbricht

- **E-Mail-Kollision:** Die angegebenen Benutzer-IDs prüfen und unterschiedliche
  korrekte E-Mail-Adressen hinterlegen. Keine Konten werden automatisch gelöscht
  oder zusammengeführt.
- **Mehrere/ungültige alte MFA-Einträge:** Identität, Herkunft und richtige
  Einrichtung anhand der betroffenen IDs prüfen. Manipulierte Einträge aus der
  vorher offenen Klasse müssen manuell geklärt werden.
- **Falscher/fehlender Schlüssel:** Den ursprünglichen Schlüssel wiederherstellen.
  Der Server fällt nicht auf Passwort-only-Anmeldung zurück.
- **Indexkonflikt:** Duplikate oder widersprüchliche Indexoptionen nach Prüfung
  bereinigen. Fehler werden nicht mehr als erfolgreicher Start behandelt.

Nach der Korrektur den Server erneut starten. Bereits erfolgreich erledigte
Teilschritte können wiederholt werden.

Interne Sicherungen geänderter Schema-/E-Mail-Normalisierungs-/MFA-Werte liegen
in `_OpenSignMigrationBackup`; Mailvorlagen haben zusätzlich ihre eigene
Sicherung in `_OpenSignMailMigrationBackup`. Diese Sicherungen enthalten
schützenswerte Daten und gehören in das geschützte Datenbankbackup.

## Tests

Im Verzeichnis `apps/OpenSignServer`:

```sh
npm run test:startup
npm run test:mfa
npm run test:mail
npm run test:totp
```

Der Starttest verwendet eine isolierte temporäre MongoDB und prüft auch den
tatsächlichen Serverprozess: Bei einer fehlerhaften Migration muss er mit
Exit-Code 1 enden und darf keinen öffentlichen Port freigeben.
