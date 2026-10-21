# Deutsche E-Mails

Die Standard-E-Mails dieser lokalen OpenSign-Version sind auf Deutsch umgestellt:

- Einladungen und erneut versendete Signaturanfragen, auch aus Vorlagen und Stapelverarbeitung
- Benachrichtigungen über einzelne Unterschriften, vollständigen Abschluss und Ablehnung
- Weitergeleitete Dokumentkopien und Stapelversand-Zusammenfassungen
- Einmalcodes sowie Bestätigungen zur Kontolöschung
- Passwort-Reset, E-Mail-Verifizierung und allgemeine Kontobenachrichtigung
- Automatische Fußzeilen und der vorbefüllte Text zur Spam-Meldung
- Standardvorlagen im einfachen und visuellen E-Mail-Editor

Textalternativen enthalten nun den lesbaren Inhalt und die Linkziele der
HTML-Nachricht. Gmail-Betreffzeilen werden bei Umlauten und anderen
Nicht-ASCII-Zeichen MIME-konform kodiert. Platzhalter, Organisationsnamen,
Dokumenttitel und eingegebene Nachrichten werden als Nutzerdaten erhalten.

Beim ersten Serverstart mit dieser Version ersetzt die Migration
`germanDefaultEmails_v1` bereits gespeicherte, **unveränderte einfache englische
Standardvorlagen und Standardbetreffzeilen** in Mandanten, Benutzerprofilen,
Dokumenten und Vorlagen. Sie sichert die geänderten Originalfelder in der
internen Collection `_OpenSignMailMigrationBackup`.

Individuell angepasste Vorlagen – einschließlich bereits gespeicherter visueller
HTML-Layouts – werden nicht automatisch überschrieben oder frei übersetzt.
Englische eigene Texte können unter Einstellungen → E-Mail sowie in den
betroffenen Dokument-/Vorlagen-Einstellungen bearbeitet werden. Neue
Standardlayouts des visuellen Editors sind ebenfalls deutsch.

Die Änderungen wurden lokal umgesetzt. Damit sie auf dem On-Premise-Server
wirksam werden, die lokalen Images wie in `ONPREM-2FA.md` beschrieben neu bauen
und bereitstellen. Vorher Datenbank und Dateien sichern.

Prüfung: `npm run test:mail` und `npm run test:mfa` im Server-Verzeichnis;
`npx vite build` im Client-Verzeichnis. Es werden keine echten E-Mails versendet.
