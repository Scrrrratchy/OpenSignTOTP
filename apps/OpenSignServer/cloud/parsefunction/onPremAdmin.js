import { mfaDb } from '../../utils/mfaStore.js';

const deny = () => {
  throw new Parse.Error(119, 'Unauthorized');
};
async function scope(request) {
  if (!request.user) deny();
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', request.user);
  query.notEqualTo('IsDisabled', true);
  const caller = await query.first({ useMasterKey: true });
  if (
    !caller ||
    !['contracts_Admin', 'contracts_OrgAdmin'].includes(caller.get('UserRole')) ||
    !caller.get('TenantId')?.id
  )
    deny();
  if (caller.get('UserRole') === 'contracts_OrgAdmin' && !caller.get('OrganizationId')?.id) deny();
  return caller;
}
async function organizations(caller) {
  const query = new Parse.Query('contracts_Organizations');
  query.equalTo('TenantId', caller.get('TenantId'));
  if (caller.get('UserRole') === 'contracts_OrgAdmin')
    query.equalTo('objectId', caller.get('OrganizationId').id);
  return query.findAll({ useMasterKey: true });
}
export async function adminOverview(request) {
  const caller = await scope(request);
  const orgs = await organizations(caller);
  const teams = new Parse.Query('contracts_Teams');
  teams.containedIn('OrganizationId', orgs);
  const users = new Parse.Query('contracts_Users');
  users.equalTo('TenantId', caller.get('TenantId'));
  if (caller.get('UserRole') === 'contracts_OrgAdmin')
    users.equalTo('OrganizationId', caller.get('OrganizationId'));
  const [teamRows, userRows] = await Promise.all([
    teams.findAll({ useMasterKey: true }),
    users.findAll({ useMasterKey: true }),
  ]);
  return {
    role: caller.get('UserRole'),
    organizations: orgs.map(o => ({ id: o.id, name: o.get('Name') })),
    teams: teamRows.map(o => ({
      id: o.id,
      name: o.get('Name'),
      organizationId: o.get('OrganizationId')?.id,
      active: o.get('IsActive') !== false,
    })),
    users: userRows.map(o => ({
      id: o.id,
      userId: o.get('UserId')?.id,
      name: o.get('Name'),
      email: o.get('Email'),
      role: o.get('UserRole'),
      organizationId: o.get('OrganizationId')?.id,
      disabled: o.get('IsDisabled') === true,
    })),
  };
}
export async function adminSave(request) {
  const caller = await scope(request);
  const orgs = await organizations(caller);
  const { kind, id, name, organizationId, role, disabled } = request.params;
  const org = orgs.find(o => o.id === organizationId);
  let object;
  if (kind === 'organization') {
    if (caller.get('UserRole') !== 'contracts_Admin') deny();
    object = id ? orgs.find(o => o.id === id) : new Parse.Object('contracts_Organizations');
    if (!object) deny();
    object.set('TenantId', caller.get('TenantId'));
    object.set('IsActive', true);
  } else if (kind === 'team') {
    if (!org) deny();
    object = id
      ? await new Parse.Query('contracts_Teams').get(id, { useMasterKey: true })
      : new Parse.Object('contracts_Teams');
    if (id && !orgs.some(o => o.id === object.get('OrganizationId')?.id)) deny();
    object.set('OrganizationId', org);
    object.set('IsActive', request.params.active !== false);
  } else if (kind === 'user') {
    object = await new Parse.Query('contracts_Users').get(id, { useMasterKey: true });
    if (
      object.get('TenantId')?.id !== caller.get('TenantId').id ||
      object.get('UserId')?.id === request.user.id ||
      object.get('UserRole') === 'contracts_Admin'
    )
      deny();
    const allowed =
      caller.get('UserRole') === 'contracts_Admin'
        ? ['contracts_OrgAdmin', 'contracts_Editor', 'contracts_User']
        : ['contracts_Editor', 'contracts_User'];
    if (
      !allowed.includes(role) ||
      (caller.get('UserRole') === 'contracts_OrgAdmin' &&
        (object.get('OrganizationId')?.id !== caller.get('OrganizationId').id ||
          object.get('UserRole') === 'contracts_OrgAdmin'))
    )
      deny();
    if (typeof disabled !== 'boolean') throw new Parse.Error(142, 'Invalid disabled flag');
    object.set('UserRole', role);
    object.set('IsDisabled', disabled);
  } else throw new Parse.Error(142, 'Invalid operation');
  if (kind !== 'user') {
    if (typeof name !== 'string' || !name.trim() || name.length > 120)
      throw new Parse.Error(142, 'Invalid name');
    object.set('Name', name.trim());
    if (!id) object.set('CreatedBy', request.user);
  }
  await object.save(null, { useMasterKey: true });
  const db = await mfaDb();
  if (kind === 'user')
    await db.collection('_Session').deleteMany({ _p_user: `_User$${object.get('UserId').id}` });
  await db
    .collection('_OpenSignSecurityAudit')
    .insertOne({
      actor: request.user.id,
      target: object.id,
      action: `admin.${kind}.saved`,
      tenantId: caller.get('TenantId').id,
      at: new Date(),
    });
  return { success: true };
}
