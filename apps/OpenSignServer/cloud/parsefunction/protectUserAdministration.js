// ACLs let users edit their own profile. Authority and tenant membership must
// only be changed by the server's authorized administration functions.
export default function protectUserAdministration(request) {
  if (request.master) return;
  const protectedFields = [
    'UserId',
    'UserRole',
    'TenantId',
    'OrganizationId',
    'TeamIds',
    'IsDisabled',
    'CreatedBy',
    'ACL',
  ];
  if (!request.original || request.object.dirtyKeys().some(key => protectedFields.includes(key))) {
    throw new Parse.Error(119, 'Use an authorized administration function');
  }
}
