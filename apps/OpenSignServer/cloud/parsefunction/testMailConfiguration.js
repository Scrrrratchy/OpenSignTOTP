import sendSystemMail from './sendSystemMail.js';

export default async function testMailConfiguration(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', { __type: 'Pointer', className: '_User', objectId: request.user.id });
  const extUser = await query.first({ useMasterKey: true });
  if (!['contracts_Admin', 'contracts_OrgAdmin'].includes(extUser?.get('UserRole'))) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Administrator access is required.');
  }

  const recipient = request.user.get('email');
  const result = await sendSystemMail({
    params: {
      recipient,
      from: process.env.appName || 'OpenSign',
      subject: 'OpenSign mail configuration test',
      text: 'Your OpenSign mail configuration is working.',
      html: '<p>Your OpenSign mail configuration is working.</p>',
    },
  });
  if (result?.status !== 'success') {
    throw new Parse.Error(502, 'The mail provider did not accept the test message.');
  }
  return { status: 'success', recipient };
}
