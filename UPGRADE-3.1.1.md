# OpenSign On-Premise: Update auf 3.1.1

Basis ist der offizielle Tag `OpenSignLabs/OpenSign` v3.1.1,
Commit `8373f6de133fceb494722b35c9e43ec288c399a2`.
Der bereitgestellte Quellordner wurde vollständig abgeglichen: Alle 536 Dateien
stimmen mit diesem Tag überein.

## Tatsächlicher Unterschied zum vorherigen Release

Der Vergleich der offiziellen Tags v3.1.0 und v3.1.1 ergibt ausschließlich
Änderungen in `README.md`. Anwendungscode, Paketdefinitionen, Lockfiles und
Datenbankschemata sind zwischen diesen Tags identisch. Obwohl die Release-Notiz
Textfeldkorrekturen und aktualisierte Abhängigkeiten erwähnt, enthält der
veröffentlichte Tag dafür keine zusätzlichen Quelländerungen gegenüber v3.1.0.
Es wurden deshalb keine ungeprüften Änderungen aus einem Entwicklungszweig ergänzt.

Unsere vollständige On-Premise-Version 3.1.0 bleibt die Grundlage. TOTP,
Wiederherstellungscodes, Administration mit Mandanten- und Organisationsgrenzen,
deutsche Mails, Branding und die dauerhaft gespeicherte Dashboard-Tour bleiben
erhalten. Die 3.1.0-Feldfunktionen einschließlich Rückgängig/Wiederholen und
Mehrfachauswahl bleiben ebenfalls enthalten. Versionsanzeige, Release-Metadaten
und Veröffentlichung verwenden jetzt `v3.1.1`.

## Migration

Es ist keine neue Datenkonvertierung oder Schemaänderung erforderlich. Die
kontrollierte Startmigration prüft weiterhin Datenbankkonfiguration, Schemata,
Berechtigungen, E-Mail-Normalisierung, TOTP-Schlüssel und tatsächliche Indizes.
Ausstehende ältere Migrationen werden abgeschlossen, bevor der Server seinen
öffentlichen Port öffnet. Falsche Schlüssel oder Datenkonflikte verhindern den Start.

Die Integrationsprüfung startet getrennt die tatsächlich veröffentlichten
Versionen 3.0.0 und 3.1.0, legt jeweils Konten mit TOTP, Rollen, Dokumenten,
Vorlagen und Tour-Abschlüssen in isolierten MongoDB-Datenbanken an und startet
danach 3.1.1 gegen dieselben Daten. Geprüft werden Datenerhalt, Berechtigungen,
Wiederherstellungscodes, der Abbruch mit falschem Schlüssel und erneute Starts.
Die Veröffentlichung setzt beide erfolgreichen Upgrade-Prüfungen sowie sämtliche
bisherigen Server- und Oberflächentests voraus.

## Produktives Update

1. Alte Anwendung und schreibende Replikate stoppen; MongoDB und Dateien sichern.
2. Bestehende Datenbankadresse, Volumes, Secrets und insbesondere den
   `TOTP_ENCRYPTION_KEY` **unverändert** weiterverwenden.
3. Beide zusammengehörigen Images verwenden:
   - `scrrrratchy/totp-opensign-client:v3.1.1`
   - `scrrrratchy/totp-opensign-server:v3.1.1`
4. Images neu ziehen, Container neu erstellen und auf die Bereitschaftsmeldung
   nach Abschluss der Startmigration warten. Anschließend die Browserseite neu laden.

Eine erneute Einrichtung der Authenticator-App ist nicht erforderlich.
Die bisherigen Tags v3.0.0 und v3.1.0 werden nicht überschrieben. Ein Rollback
nach Datenänderungen erfordert gegebenenfalls die vollständige Sicherung.

Für ältere Ausgangsversionen und die Erklärung der Schlüssel siehe
[UPDATE-MIGRATION.md](UPDATE-MIGRATION.md) und [UPGRADE-3.1.0.md](UPGRADE-3.1.0.md).

Der Quellordner `OpenSign-3.1.0` bleibt erhalten; der aktualisierte Stand liegt
im benachbarten Ordner `OpenSign-3.1.1`. Eine produktive Datenbank wird für die
Prüfungen nicht verwendet.
