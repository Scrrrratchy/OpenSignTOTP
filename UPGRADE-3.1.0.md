# OpenSign On-Premise: 3.0.0 → 3.1.0

Basis ist der vollständige offizielle Release `OpenSignLabs/OpenSign` v3.1.0,
Commit `322e8f5d7393fd8d61cc06559a3106982d89cffc`. Die beigefügte ZIP-Datei
enthielt nur 17 Dateien; diese stimmen mit dem Release überein. Die fehlenden
Dateien wurden aus dem offiziellen Git-Tag ergänzt.

Unsere veröffentlichte 3.0.0 ist unverändert als Ausgangsstand erhalten:
Commit `0a5ee07cb25b07d31a1fdf7fd8869cdbe4f0c651`. Die Änderungen des offiziellen
Releases wurden gegen diese Version zusammengeführt. `release.json` dokumentiert
die Zuordnung.

## Übernommene Funktionen

- TOTP mit verschlüsselten Geheimnissen, Wiederherstellungscodes, Schutz gegen
  Wiederverwendung und administrativem Zurücksetzen.
- On-Premise-Administration mit Rollen-, Organisations- und Mandantengrenzen.
- Deutsche Standardmails einschließlich Textalternativen und korrekt kodierter
  Betreffzeilen. Individuelle Mailvorlagen bleiben erhalten.
- Der Dashboard-Tour-Abschluss wird mit dem Sitzungsschlüssel gespeichert.
  Parallele Tour-Abschlüsse bleiben durch eine atomare Aktualisierung erhalten.
- Die neuen 3.1.0-Funktionen: Rückgängig/Wiederholen, Mehrfachauswahl und Löschen
  von Feldern sowie die Korrektur beim Kopieren von Feldern im Selbstsignieren.
- Der neue lokale QA-Modus bleibt auf lokale Entwicklungsstarts beschränkt.

## Datenbank und erster Start

Der offizielle Unterschied zwischen 3.0.0 und 3.1.0 enthält **keine neuen
Datenbankschemamigrationen**. Eine zusätzliche, künstliche Datenkonvertierung ist
deshalb nicht notwendig. Unsere kontrollierte Startmigration bleibt aktiv:

1. Datenbankadresse und Schlüssel prüfen; kein stiller Entwicklungs-Fallback.
2. Datenbanksperre übernehmen und Schemata anhand des vorhandenen Journals prüfen.
3. MFA-Berechtigungen, normalisierte E-Mails, bestehende TOTP-Daten und Indizes prüfen.
4. Eventuell noch ausstehende ältere Migrationen wiederholbar abschließen.
5. Erst nach erfolgreichem Abschluss den öffentlichen Serverport öffnen.

Bereits ausgeführte 3.0.0-Migrationen werden anhand ihrer Marker erkannt.
Bei einer falschen TOTP-Verschlüsselung oder widersprüchlichen Daten bleibt
der Server geschlossen und beendet sich mit Exit-Code 1. Die bestehenden
Sicherungen und Fehlerhinweise stehen in [UPDATE-MIGRATION.md](UPDATE-MIGRATION.md).

## Vor dem produktiven Update

1. Die bisherige Anwendung einschließlich aller schreibenden Replikate stoppen.
2. Eine vollständige Sicherung von MongoDB und gespeicherten Dateien erstellen.
3. Dieselbe Datenbankadresse, dieselben Volumes und den **unveränderten**
   `TOTP_ENCRYPTION_KEY` weiterverwenden. Auch andere bestehende Secrets nicht ändern.
4. Client und Server gemeinsam auf die zusammengehörigen Images mit Tag `v3.1.0`
   umstellen. Die bisherigen `v3.0.0`-Images werden nicht überschrieben.
5. Auf die Bereitschaftsmeldung nach erfolgreicher Migration warten.

Es ist keine erneute Einrichtung der Authenticator-App nötig. Benutzer mit
vollständig übernommenem 3.0.0-TOTP benötigen keinen alten Legacy-MFA-Schlüssel
erneut; für noch nicht importierte Altbestände gilt weiterhin UPDATE-MIGRATION.md.

Der lokale 3.0.0-Quellordner bleibt erhalten. Die vollständig aktualisierte
Version befindet sich im benachbarten Ordner `OpenSign-3.1.0`.

## Prüfung

Der neue `test:upgrade` startet zuerst den **tatsächlichen 3.0.0-Server** mit einer
isolierten Testdatenbank. Er legt Konten, Rollen, TOTP, Wiederherstellungscodes,
Tour-Abschlüsse, individuelle Mailvorlagen, Dokumente und Vorlagen an. Danach
startet er die 3.1.0 gegen dieselbe Datenbank und prüft Erhalt, Anmeldung,
Administration, den Abbruch bei falschem Schlüssel und einen erneuten Start.
Produktive Datenbanken werden für die Tests nicht verwendet.

Zusätzlich laufen die bisherigen Start-, MFA- und Mailtests sowie die
Oberflächentests für die Tour, die neuen Feldfunktionen und die QA-Begrenzung.

In `apps/OpenSignServer`:

```sh
npm ci
npm run test:totp
npm run test:mail
npm run test:mfa
npm run test:startup
# OPENSIGN_UPGRADE_FROM zeigt auf den separaten 3.0.0-Serverquellordner.
npm run test:upgrade
```

In `apps/OpenSign`:

```sh
npm ci
npm run test:tour
```

Die Dockerfiles installieren die Linux-Bibliotheken passend zum vorhandenen
Lockfile. Ihre Node-22-Basis wurde auf einen geprüften aktuellen Image-Digest
angehoben, weil eine neue Upstream-Entwicklungsabhängigkeit mindestens Node
22.15 benötigt. Die Veröffentlichung läuft erst nach allen erfolgreichen Tests.
