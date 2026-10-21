# On-Premise-Erweiterung: TOTP und Administration

Für Updates und die Übernahme aus `scrrrratchy/totp-opensign-server:v2.41.0`
zuerst [UPDATE-MIGRATION.md](UPDATE-MIGRATION.md) beachten. Die Migration läuft
jetzt vor Freigabe des öffentlichen Ports; bei Fehlern startet der Server nicht.

## Bereitstellung

Die Änderungen befinden sich im lokalen Quellcode. Das ursprüngliche
`docker-compose.yml` verwendet fertige Upstream-Images. Zum Betrieb dieser
Erweiterung müssen beide lokalen Images gebaut werden:

1. Datenbank und Dateien sichern.
2. Einmalig einen Schlüssel erzeugen:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Den Wert als `TOTP_ENCRYPTION_KEY` in der Compose-Umgebung (`.env` neben den
   Compose-Dateien oder exportierte Umgebungsvariable) hinterlegen. Alternativ
   `docker compose --env-file .env.prod ...` verwenden und den Schlüssel in
   `.env.prod` ergänzen. Die übrigen Server-Einstellungen bleiben in `.env.prod`.
   Dieser Schlüssel muss auf allen Server-Replikaten identisch bleiben und
   zusammen mit dem Datenbank-Backup sicher gesichert werden. Er gehört niemals
   in die Frontend-Konfiguration. Bei Verlust können vorhandene TOTP-Secrets
   nicht entschlüsselt werden.
4. Im Projektverzeichnis starten:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.onprem.yml up -d --build
   ```

HTTPS, funktionierende Serverzeit/NTP und persistente MongoDB-Daten voraussetzen.
Ohne Schlüssel bleibt die Anmeldung für bisher nicht eingeschriebene Konten
möglich; die Oberfläche zeigt, dass TOTP noch nicht konfiguriert ist.

## Bedienung

Unter **Einstellungen → Sicherheit** die Einrichtung starten, den QR-Code mit
einer TOTP-App scannen und den aktuellen sechsstelligen Code bestätigen. Der
manuelle Schlüssel ist ebenfalls verfügbar. Die Einrichtung ist zehn Minuten
gültig und erlaubt fünf Bestätigungsversuche.

Nach Bestätigung werden zehn Wiederherstellungscodes einmalig angezeigt und
können als Textdatei gespeichert werden. Jeder Code ist einmal gültig. Andere
bestehende Sitzungen werden beendet. Die nächste Anmeldung verlangt Passwort
und Authenticator- oder Wiederherstellungscode. Für erneute Aktionen muss ein
neuer, noch nicht benutzter Code verwendet werden.

Unter **Einstellungen → Administration** stehen Rollenänderungen, Sperren und
Entsperren von Konten sowie Anlegen/Umbenennen von Organisationen und Teams zur
Verfügung. Neue Benutzer werden über die vorhandene Benutzerverwaltung angelegt.
Rollenänderungen und Kontosperren beenden alle Sitzungen des betroffenen Kontos.
Ein Konto kann sich hier nicht selbst sperren oder seine eigene Rolle ändern.

Mandanten-Administratoren verwalten ihren Mandanten. Organisations-Administratoren
verwalten ihre eigene Organisation und dürfen keine weiteren Administratoren
befördern oder verändern. Die Berechtigungen werden auf dem Server geprüft.

Im Sicherheitstab sehen Administratoren den 2FA-Status der ihnen zugeordneten
Konten. Zum Zurücksetzen eines fremden Kontos muss die eigene 2FA aktiviert sein
und ein eigener gültiger Code eingegeben werden. Vorher die Identität der Person
prüfen. Alle Sitzungen des Zielkontos werden beendet. Mandanten-Administratoren
lassen sich über diese Oberfläche nicht zurücksetzen.

## Notfallwiederherstellung

Wenn ein Mandanten-Administrator Gerät und Wiederherstellungscodes verloren hat,
kann die Serveradministration nach Identitätsprüfung im Servercontainer bzw.
Server-Verzeichnis Folgendes ausführen:

```sh
node scripts/reset-mfa.js --user-id=USER_OBJECT_ID --confirm=USER_OBJECT_ID --reason="Identität geprüft; Authenticator verloren"
```

Das Skript nutzt ausschließlich die konfigurierte Datenbank, löscht die
2FA-Einrichtung dieses Kontos, beendet dessen Sitzungen und protokolliert den
Vorgang. Danach erneut anmelden und 2FA neu einrichten. Für neue
Wiederherstellungscodes 2FA mit einem noch gültigen Code deaktivieren und neu
einrichten.

## Sicherheitsverhalten

- TOTP: SHA-1, sechs Ziffern, 30 Sekunden, Zeitabweichung maximal ±30 Sekunden.
- Prüfung vor Sitzungsvergabe über Parse `beforeLogin`, auch für direkte
  REST-Passwortanmeldung und Auth-Provider-Anmeldung. Alternative Anmeldung per
  E-Mail-Code wird ebenfalls geprüft. Bestehende Konten erhalten über öffentliche
  Registrierungsfunktionen keine Master-Key-Anmeldesitzung mehr.
- Bereits verwendete TOTP-Zeitfenster werden atomar gesperrt;
  Wiederherstellungscodes werden atomar verbraucht. Das funktioniert auch bei
  mehreren Serverinstanzen.
- Nach fünf falschen Codes fünf Minuten Sperre; ein abgelaufener Sperrzeitraum
  erlaubt neue Versuche. Ohne korrektes Passwort entsteht keine 2FA-Abfrage.
- Secrets werden mit AES-256-GCM verschlüsselt; Wiederherstellungscodes nur als
  SHA-256-Hashes gespeichert. Reservierte interne MongoDB-Collections sind keine
  öffentlich lesbaren Parse-Klassen.
- Interne Collections: `_OpenSignMfa`, `_OpenSignSecurityAudit`. Sie müssen im
  Datenbankbackup enthalten sein. Das Audit enthält keine Codes oder Secrets.
- Der Parse-Authentifizierungscache wird für Sitzungen bewusst nicht verwendet.
  Damit wirken Sitzungswiderrufe auf allen Replikaten sofort. Das erzeugt eine
  zusätzliche Datenbankabfrage pro authentifiziertem Request. Automatische
  Cloud-Function-Logs mit vollständigen Eingaben/Ergebnissen sind deaktiviert,
  damit QR-Secrets und Wiederherstellungscodes nicht in Serverlogs geraten.
- Die Erweiterung führt keine verpflichtende 2FA-Richtlinie für alle Benutzer
  ein. 2FA wird pro Konto aktiviert. Externe IdP-Anmeldemasken benötigen die
  Übergabe von `context.mfaCode`, sobald ein Konto TOTP aktiviert hat.
  Bei direkter REST-Anmeldung den Header
  `X-Parse-Cloud-Context: {"mfaCode":"123456"}` senden;
  der Cloud-Endpunkt `loginuser` akzeptiert `mfaCode` direkt neben E-Mail/Passwort.

## Umfang der Features

Die vorliegende Community-Version enthält **keine aktiven Abo-/Lizenzprüfungen**
für ihre vorhandenen Benutzer-, Team-, Organisations-, Dokument-, Vorlagen-,
E-Mail-Vorlagen- und Widgetfunktionen. Übersetzungen enthalten zusätzlich Texte
zu kommerziellen Features, die im ausführbaren Quellcode fehlen. Es werden keine
Abonnements vorgetäuscht und Benutzer werden nicht pauschal zu Administratoren.

| Bereich | Stand dieser lokalen Version |
| --- | --- |
| Dokumente, Vorlagen, Drive, Signatur-Widgets | Vorhandene Community-Funktionen ohne zusätzliche Plansperre |
| Benutzer anlegen, Passwort zurücksetzen | Vorhanden; Organisationsgrenzen beim Passwortreset und Benutzerabruf korrigiert |
| Rollen und Kontosperren | Neue Verwaltungsansicht mit serverseitiger Prüfung und Sitzungswiderruf |
| Organisationen/Teams | Neue Verwaltungsansicht zum Anlegen und Umbenennen |
| E-Mail-Vorlagen | Vorhandener Editor; Schreiben bleibt auf Administratoren beschränkt |
| SMTP und Dateiablage | Über vorhandene Server-Umgebungsvariablen konfigurierbar |
| TOTP und Wiederherstellung | Neu implementiert, einschließlich Administrations- und Notfallablauf |
| Public API/API-Key-Verwaltung, Webhooks, Bulk-Send-Oberfläche | In diesem Quellstand nicht vollständig enthalten; keine vollständige Freischaltung behauptet |
| Passkeys, öffentliche Profile, Cloud-Integrationen | Konfigurationsreste sind keine vollständige Implementierung; keine Freischaltung durch bloßes Setzen eines Flags |

Eine vollständige funktionale Gleichheit mit nicht mitgelieferten kommerziellen
Modulen ist damit nicht gegeben. Bestehende Rechte- und Mandantengrenzen bleiben
wirksam.

## Prüfung

Im Server-Verzeichnis:

```sh
npm run test:totp
npm run test:mfa
```

Der Integrationstest startet eine isolierte temporäre MongoDB und benötigt beim
ersten Lauf Internetzugriff für deren Binärdatei. Er prüft Parse-Endpunkte,
Code-Wiederverwendung, parallele Anmeldung, Sperrzeit, Mandanten-/Organisationsgrenzen,
Admin-Reset, Sitzungswiderruf und gesperrte Benutzer. Er verwendet keine produktive
Datenbank. Im Client-Verzeichnis kann die Oberfläche mit `npx vite build` gebaut
werden.
