import { smtpenable } from '../../Utils.js';
import {
  buildCanonicalBrandUrl,
  escapeHtml,
  resolveBrandContext,
} from '../../utils/brandContext.js';

export const errHtml = err => {
  return `<html lang="de"><head><meta http-equiv="Content-Type" content="text/html;charset=UTF-8" /><title>Reset Password</title></head>
  <body><h1 style="color:#1a5fa0; margin-bottom:16px;">${err}</h1></body></html>`;
};
const sendDeleteUserMail = async req => {
  if (!req.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  try {
    const { userId } = req.params;
    if (!userId) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing userId parameter.');
    }

    const userPointer = { __type: 'Pointer', className: '_User', objectId: userId };

    const createdByPointer = { __type: 'Pointer', className: '_User', objectId: req.user.id };

    const userCondition = new Parse.Query('contracts_Users');
    userCondition.equalTo('UserId', userPointer);

    const userAndCreatorCondition = new Parse.Query('contracts_Users');
    userAndCreatorCondition.equalTo('UserId', userPointer);
    userAndCreatorCondition.equalTo('CreatedBy', createdByPointer);

    const mainQuery = Parse.Query.or(userCondition, userAndCreatorCondition);
    mainQuery.include('TenantId');

    const result = await mainQuery.first({ useMasterKey: true });
    if (!result) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found.');
    }
    const brand = resolveBrandContext({ tenant: result.get('TenantId') });
    const app = brand.productName;
    const username = result.get('Email')?.toLowerCase()?.replace(/\s/g, '');
    const name = result?.get('Name') ? `<b>${escapeHtml(result.get('Name'))}</b>` : '';
    const isAdmin = result?.get('UserRole') === 'contracts_Admin';
    if (!isAdmin) {
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        'This action is not permitted. Kindly contact your administrator to request account deletion.'
      );
    }

    const legacyServerUrl = process.env?.SERVER_URL?.replace(/\/app\/?$/, '/');
    const needsApiPrefix = process?.env?.SERVER_URL?.includes?.('api');
    const apiPrefix = needsApiPrefix ? '/api' : '';
    const deleteUrl =
      buildCanonicalBrandUrl(brand, `${apiPrefix}/delete-account/${encodeURIComponent(userId)}`) ||
      (brand.isOpenSign && legacyServerUrl
        ? `${legacyServerUrl}delete-account/${encodeURIComponent(userId)}`
        : '');
    if (!deleteUrl) {
      throw new Parse.Error(
        Parse.Error.SCRIPT_FAILED,
        'Canonical application URL is not configured.'
      );
    }
    const safeApp = escapeHtml(app);
    const safeUsername = escapeHtml(username);
    const safeDeleteUrl = escapeHtml(deleteUrl);
    const supportLine = brand.contacts.supportEmail
      ? ` Wenden Sie sich bitte an <a href="mailto:${escapeHtml(brand.contacts.supportEmail)}">${escapeHtml(brand.contacts.supportEmail)}</a>.`
      : '';
    const mailsender = smtpenable ? process.env.SMTP_USER_EMAIL : process.env.MAILGUN_SENDER;
    // Render a simple HTML form. In production, consider using a templating engine.

    await Parse.Cloud.sendEmail({
      sender: brand.senderName + ' <' + mailsender + '>',
      recipient: username,
      subject: `Anfrage zur Löschung des Kontos ${username} – ${app}`,
      text: `Guten Tag,\n\nSie haben die dauerhafte Löschung Ihres ${app}-Kontos (${username}) angefordert.\n\nBestätigen Sie die Kontolöschung über diesen Link: ${deleteUrl}\n\nWenn Sie diese Anfrage nicht gestellt haben, ignorieren Sie diese E-Mail. Die bestätigte Löschung kann nicht rückgängig gemacht werden.`,
      html: `<html lang="de">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Anfrage zur Kontolöschung – ${safeApp}</title>
</head>
<body style="margin:0; padding:0; font-family:Arial, sans-serif; background-color:#f4f4f4; color:#333;">
    <div
        style="max-width:600px; margin:50px auto; padding:30px; background-color:#ffffff; border:1px solid #e0e0e0; border-radius:8px;">
        <h2 style="color:#d9534f;">Anfrage zur Löschung Ihres Kontos</h2>
        <p style="font-size:16px; line-height:1.5;">
            Guten Tag ${name},
        </p>
        <p style="font-size:16px; line-height:1.5;">
            Wir haben eine Anfrage erhalten, Ihr <b>${safeApp}</b>-Konto mit der E-Mail-Adresse <b>${safeUsername}</b> dauerhaft zu löschen.
        </p>
        <p style="font-size:16px; line-height:1.5;">
            Wenn Sie diese Anfrage nicht gestellt haben, ignorieren Sie diese E-Mail. Um die Löschung zu bestätigen, klicken Sie auf die folgende Schaltfläche.
        </p>
        <p style="text-align:center; margin:30px 0;">
            <a href="${safeDeleteUrl}"
                style="background-color:#d9534f; color:#ffffff; padding:12px 24px; border-radius:5px; text-decoration:none; font-size:16px;">
                Kontolöschung bestätigen
            </a>
        </p>
        <p style="font-size:16px; line-height:1.5;">
            Falls die Schaltfläche nicht funktioniert, kopieren Sie den folgenden Link und öffnen Sie ihn in Ihrem Browser.
        </p> 
        <p style="font-size:16px; text-align:center; margin:0px 0px 30px 0px;">
          <a href="${safeDeleteUrl}">${safeDeleteUrl}</a>
        </p>
        <p style="font-size:14px; color:#777;">
            Hinweis: Diese Aktion kann nicht rückgängig gemacht werden. Alle Ihre Daten werden dauerhaft aus unseren Systemen entfernt.
        </p>
        <hr style="margin:30px 0; border:none; border-top:1px solid #eee;">
        <p style="font-size:12px; color:#999;">
            Bei Fragen oder wenn Sie Hilfe benötigen, wenden Sie sich bitte an unseren Support.${supportLine}
        </p>
        <p style="font-size:12px; color:#999;">
            &copy; ${new Date().getFullYear()} ${safeApp}. Alle Rechte vorbehalten.
        </p>
    </div>
</body>
</html>`,
    });
    return 'mail sent.';
  } catch (err) {
    console.log('Err in sending delete user email ', err);
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, err.message);
  }
};
export default sendDeleteUserMail;
