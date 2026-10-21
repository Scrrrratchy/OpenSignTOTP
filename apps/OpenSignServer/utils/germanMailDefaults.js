const escape = value =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const compact = value => value.replace(/\s/g, '').replaceAll('"', '');
const requestLegacy =
  'Hi {{receiver_name}}, We hope this email finds you well. {{sender_name}} has requested you to review and sign {{document_title}}. Your signature is crucial to proceed with the next steps as it signifies your agreement and authorization. Sign here If you have any questions or need further clarification regarding the document or the signing process, please contact the sender.';
const completionLegacy =
  'Hi {{sender_name}}, All parties have successfully signed the document {{document_title}}. Kindly download the document from the attachment.';

// Only recognize the complete, unchanged legacy defaults. Never rewrite custom copy.
export function germanDefault(field, value) {
  if (typeof value !== 'string') return value;
  if (field.endsWith('Subject')) {
    if (/^\{\{sender_name\}\} has requested you to sign "?\{\{document_title\}\}"?$/.test(value))
      return '{{sender_name}} bittet Sie um die Unterzeichnung von {{document_title}}';
    if (/^Document "?\{\{document_title\}\}"? has been signed by all parties$/.test(value))
      return 'Das Dokument „{{document_title}}“ wurde von allen Beteiligten unterzeichnet';
    return value;
  }
  const plain = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = plain.match(/^(.*?)\s*Thanks\s+Team\s+(.+)$/);
  if (!parts) return value;
  const brand = escape(parts[2]);
  if (field === 'RequestBody' && compact(parts[1]) === compact(requestLegacy)) {
    return `<html lang="de"><body><p>Guten Tag {{receiver_name}},</p><p>{{sender_name}} bittet Sie, das Dokument <strong>{{document_title}}</strong> zu prüfen und zu unterzeichnen.</p><p>Bitte prüfen Sie das Dokument sorgfältig und unterzeichnen Sie es über den folgenden Link.</p><p><a href="{{signing_url}}" rel="noopener noreferrer" target="_blank">Jetzt unterzeichnen</a></p><p>Bei Fragen zum Dokument oder zum Unterzeichnungsprozess wenden Sie sich bitte an den Absender.</p><p>Vielen Dank</p><p>Team ${brand}</p></body></html>`;
  }
  if (field === 'CompletionBody' && compact(parts[1]) === compact(completionLegacy)) {
    return `<html lang="de"><body><p>Guten Tag {{sender_name}},</p><p>Alle Beteiligten haben das Dokument <strong>{{document_title}}</strong> erfolgreich unterzeichnet. Sie finden das Dokument im Anhang dieser E-Mail.</p><p>Vielen Dank</p><p>Team ${brand}</p></body></html>`;
  }
  return value;
}

export const mailFields = ['RequestSubject', 'RequestBody', 'CompletionSubject', 'CompletionBody'];
