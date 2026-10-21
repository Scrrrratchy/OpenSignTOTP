import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { germanDefault } from '../utils/germanMailDefaults.js';
import emailPlainText from '../utils/emailPlainText.js';
import { encodeMimeSubject } from '../utils/mailHeaders.js';
import {
  renderAutomatedEmailFooter,
  renderComplaintFooter,
  renderDocumentEmail,
} from '../utils/brandContext.js';

test('German document emails retain links and escape supplied names', async () => {
  const { mailTemplate } = await import('../Utils.js');
  const result = mailTemplate({
    senderName: 'Test & Co',
    senderMail: 'test@example.test',
    title: '<script>title</script>',
    organization: '<b>Firma</b>',
    localExpireDate: '21. Oktober 2026',
    note: '<img src=x>',
    signingUrl: 'https://example.test/sign?id=1&code=2',
  });
  assert.match(result.subject, /bittet Sie um die Unterzeichnung/);
  assert.match(result.body, /Jetzt unterzeichnen/);
  assert.match(result.body, /Gültig bis/);
  assert.match(result.body, /Test &amp; Co/);
  assert.ok(!result.body.includes('<script>title</script>'));
  assert.ok(result.body.includes('id=1&amp;code=2'));
});

test('German footer, complaint draft and document shell', () => {
  const context = { productName: 'Test & Co', contacts: { complaintsEmail: 'spam@example.test' } };
  assert.match(renderAutomatedEmailFooter(context, 'sender@example.test'), /Bei Fragen/);
  assert.ok(!renderAutomatedEmailFooter(context).includes('automated email'));
  const complaint = renderComplaintFooter(context, '123', 'sender@example.test');
  assert.match(complaint, /unangemessen oder für Spam/);
  assert.ok(decodeURIComponent(complaint).includes('Guten Tag Support-Team'));
  assert.match(
    renderDocumentEmail({
      context,
      heading: 'Dokument unterzeichnet',
      contentHtml: '<p>Vielen Dank</p>',
    }),
    /lang=['"]de['"]/
  );
});

test('text alternative preserves German characters and clickable link targets', () => {
  const result = emailPlainText(
    '<style>hidden</style><p>Guten Tag M&uuml;ller &amp; Co,</p><p><a href="https://example.test/?a=1&amp;b=2">Jetzt unterzeichnen</a></p>'
  );
  assert.match(result, /Müller & Co/);
  assert.match(result, /Jetzt unterzeichnen \(https:\/\/example.test\/\?a=1&b=2\)/);
  assert.ok(!result.includes('hidden'));
  assert.ok(!result.includes('<p>'));
});

test('Gmail subject encoding preserves umlauts, quotes and long organization names', () => {
  const subject =
    'Müller & Söhne bittet um Unterzeichnung des Dokuments „Jahresabschluss und Prüfungsbericht“';
  const encoded = encodeMimeSubject(subject);
  const decoded = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map(match => Buffer.from(match[1], 'base64').toString('utf8'))
    .join('');
  assert.equal(decoded, subject);
  assert.ok(encoded.split('\r\n ').every(word => word.length <= 75));
  assert.equal(encodeMimeSubject('Einmalcode\r\nInjected: header'), 'Einmalcode Injected: header');
});

test('only unchanged legacy defaults migrate, placeholders and custom content survive', () => {
  assert.equal(
    germanDefault(
      'RequestSubject',
      '{{sender_name}} has requested you to sign "{{document_title}}"'
    ),
    '{{sender_name}} bittet Sie um die Unterzeichnung von {{document_title}}'
  );
  const legacy =
    '<html><body><p>Hi {{sender_name}},</p><p>All parties have successfully signed the document {{document_title}}. Kindly download the document from the attachment.</p><p>Thanks</p><p> Team Meine Firma</p></body></html>';
  const converted = germanDefault('CompletionBody', legacy);
  assert.match(converted, /Guten Tag \{\{sender_name\}\}/);
  assert.match(converted, /Meine Firma/);
  assert.equal(germanDefault('CompletionBody', converted), converted);
  const custom = legacy.replace('All parties', 'Our legal team and all parties');
  assert.equal(germanDefault('CompletionBody', custom), custom);
  assert.equal(
    germanDefault('RequestSubject', 'Please review our custom offer'),
    'Please review our custom offer'
  );
});

test('Parse static emails are German and preserve delivery placeholders', async () => {
  for (const prefix of ['password_reset_email', 'verification_email', 'custom_email']) {
    const html = await fs.readFile(new URL(`../files/${prefix}.html`, import.meta.url), 'utf8');
    const text = await fs.readFile(new URL(`../files/${prefix}.txt`, import.meta.url), 'utf8');
    const subject = await fs.readFile(
      new URL(`../files/${prefix}_subject.txt`, import.meta.url),
      'utf8'
    );
    assert.match(html, /lang="de"/);
    assert.doesNotMatch(
      html + text + subject,
      /Hello!|Welcome!|Click the|Password Reset|Verify email|Account Notice/
    );
    if (prefix !== 'custom_email') {
      assert.ok(html.includes('{{{link}}}'));
      assert.ok(text.includes('{{{link}}}'));
    }
  }
});
