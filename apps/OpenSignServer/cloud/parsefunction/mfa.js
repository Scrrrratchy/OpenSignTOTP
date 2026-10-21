import QRCode from 'qrcode';
import crypto from 'node:crypto';
import { mfaCollection, mfaDb, clearMfaRecord } from '../../utils/mfaStore.js';
import {
  newSecret,
  seal,
  unseal,
  matchCounter,
  recoveryCodes,
  hashCode,
} from '../../utils/totpCrypto.js';

const fail = message => {
  throw new Parse.Error(142, message);
};
const currentToken = request =>
  request.headers?.['x-parse-session-token'] || request.user?.getSessionToken();
async function account(request) {
  if (!request.user) throw new Parse.Error(209, 'Authentication required');
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', request.user);
  query.notEqualTo('IsDisabled', true);
  const ext = await query.first({ useMasterKey: true });
  if (!ext) fail('Account unavailable');
  return ext;
}
async function audit(actor, target, action) {
  await (
    await mfaDb()
  )
    .collection('_OpenSignSecurityAudit')
    .insertOne({ actor, target, action, at: new Date() });
}
async function revoke(userId, keepToken) {
  const db = await mfaDb();
  await db.collection('_Session').deleteMany({
    _p_user: `_User$${userId}`,
    ...(keepToken ? { _session_token: { $ne: keepToken } } : {}),
  });
}
export async function verifyMfa(userId, code) {
  const collection = await mfaCollection();
  const record = await collection.findOne({ _id: userId });
  if (!record?.enabled) return;
  if (!code) fail('MFA_REQUIRED');
  if (record.lockedUntil > new Date()) fail('MFA_LOCKED');
  // Reserve an attempt atomically before checking; this also works across server replicas.
  const attempt = await collection.findOneAndUpdate(
    { _id: userId, enabled: true, attempts: { $lt: 5 } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  );
  if (!attempt) {
    if (record.lockedUntil && record.lockedUntil <= new Date()) {
      await collection.updateOne(
        { _id: userId, lockedUntil: record.lockedUntil },
        { $set: { attempts: 0 }, $unset: { lockedUntil: '' } }
      );
      return verifyMfa(userId, code);
    }
    fail('MFA_LOCKED');
  }
  const counter = matchCounter(unseal(record.secret), code);
  let result;
  if (counter !== null) {
    result = await collection.updateOne(
      {
        _id: userId,
        enabled: true,
        secret: record.secret,
        $or: [{ lastCounter: { $lt: counter } }, { lastCounter: { $exists: false } }],
      },
      { $set: { lastCounter: counter, attempts: 0 }, $unset: { lockedUntil: '' } }
    );
  } else if (typeof code === 'string' && /^[a-fA-F0-9\s-]{16,24}$/.test(code)) {
    result = await collection.updateOne(
      { _id: userId, enabled: true, recovery: hashCode(code) },
      { $pull: { recovery: hashCode(code) }, $set: { attempts: 0 }, $unset: { lockedUntil: '' } }
    );
  } else if (record.legacyRecoveryKey && typeof code === 'string') {
    const normalized = code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (/^[A-Z0-9]{8}$/.test(normalized)) {
      const key = Buffer.from(unseal(record.legacyRecoveryKey), 'hex');
      const hash = crypto.createHmac('sha256', key).update(normalized).digest('hex');
      result = await collection.updateOne(
        { _id: userId, enabled: true, legacyRecovery: hash },
        { $pull: { legacyRecovery: hash }, $set: { attempts: 0 }, $unset: { lockedUntil: '' } }
      );
    }
  }
  if (result?.modifiedCount) return;
  if (attempt.attempts >= 5)
    await collection.updateOne(
      { _id: userId, attempts: { $gte: 5 } },
      { $set: { lockedUntil: new Date(Date.now() + 300000) } }
    );
  fail('MFA_INVALID');
}
export async function beforeLogin(request) {
  const user = request.object;
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', user);
  const ext = await query.first({ useMasterKey: true });
  if (ext?.get('IsDisabled')) fail('Account disabled');
  await verifyMfa(user.id, request.context?.mfaCode);
}
export async function mfaStatus(request) {
  await account(request);
  const record = await (await mfaCollection()).findOne({ _id: request.user.id });
  return {
    enabled: Boolean(record?.enabled),
    recoveryRemaining: (record?.recovery?.length || 0) + (record?.legacyRecovery?.length || 0),
    available: /^[a-fA-F0-9]{64}$/.test(process.env.TOTP_ENCRYPTION_KEY || ''),
  };
}
export async function mfaSetup(request) {
  await account(request);
  const collection = await mfaCollection();
  const secret = newSecret();
  const pending = seal(secret);
  await collection.updateOne(
    { _id: request.user.id },
    { $setOnInsert: { enabled: false, attempts: 0 } },
    { upsert: true }
  );
  const result = await collection.updateOne(
    { _id: request.user.id, enabled: false },
    { $set: { pending, pendingExpires: new Date(Date.now() + 600000), setupAttempts: 0 } }
  );
  if (!result.matchedCount) fail('MFA_ALREADY_ENABLED');
  const issuer = 'OpenSign';
  const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${request.user.get('email')}`)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return { secret, qrCode: await QRCode.toDataURL(uri), uri };
}
export async function mfaEnable(request) {
  await account(request);
  const keepToken = currentToken(request);
  if (!keepToken) fail('Authentication required');
  const collection = await mfaCollection();
  const record = await collection.findOneAndUpdate(
    {
      _id: request.user.id,
      enabled: false,
      pendingExpires: { $gt: new Date() },
      setupAttempts: { $lt: 5 },
    },
    { $inc: { setupAttempts: 1 } },
    { returnDocument: 'after' }
  );
  if (!record) fail('MFA_SETUP_EXPIRED');
  const counter = matchCounter(unseal(record.pending), request.params.code);
  if (counter === null) fail('MFA_INVALID');
  const codes = recoveryCodes();
  const result = await collection.updateOne(
    { _id: request.user.id, enabled: false, pending: record.pending },
    {
      $set: {
        secret: record.pending,
        enabled: true,
        recovery: codes.map(hashCode),
        attempts: 0,
        lastCounter: counter,
      },
      $unset: {
        pending: '',
        pendingExpires: '',
        setupAttempts: '',
        lockedUntil: '',
        legacyRecovery: '',
        legacyRecoveryKey: '',
      },
    }
  );
  if (!result.modifiedCount) fail('MFA_SETUP_EXPIRED');
  await revoke(request.user.id, keepToken);
  await audit(request.user.id, request.user.id, 'mfa.enabled');
  return { recoveryCodes: codes };
}
export async function mfaDisable(request) {
  await account(request);
  const keepToken = currentToken(request);
  if (!keepToken) fail('Authentication required');
  await verifyMfa(request.user.id, request.params.code);
  await clearMfaRecord(request.user.id);
  await revoke(request.user.id, keepToken);
  await audit(request.user.id, request.user.id, 'mfa.disabled');
  return { enabled: false };
}
export async function mfaAdminList(request) {
  const caller = await account(request);
  if (!['contracts_Admin', 'contracts_OrgAdmin'].includes(caller.get('UserRole')))
    fail('Unauthorized');
  const query = new Parse.Query('contracts_Users');
  if (!caller.get('TenantId')?.id) fail('Unauthorized');
  query.equalTo('TenantId', caller.get('TenantId'));
  if (caller.get('UserRole') === 'contracts_OrgAdmin') {
    if (!caller.get('OrganizationId')?.id) fail('Unauthorized');
    query.equalTo('OrganizationId', caller.get('OrganizationId'));
  }
  const users = await query.findAll({ useMasterKey: true });
  const records = await (
    await mfaCollection()
  )
    .find({ _id: { $in: users.map(u => u.get('UserId')?.id).filter(Boolean) } })
    .toArray();
  return users.map(user => ({
    userId: user.get('UserId')?.id,
    name: user.get('Name'),
    email: user.get('Email'),
    role: user.get('UserRole'),
    enabled: Boolean(records.find(r => r._id === user.get('UserId')?.id)?.enabled),
  }));
}
export async function mfaAdminReset(request) {
  const caller = await account(request);
  const users = await mfaAdminList(request);
  const target = users.find(u => u.userId === request.params.userId);
  if (!target || target.userId === request.user.id || target.role === 'contracts_Admin')
    fail('Unauthorized');
  if (caller.get('UserRole') === 'contracts_OrgAdmin' && target.role === 'contracts_OrgAdmin')
    fail('Unauthorized');
  // Require the administrator's own second factor for recovery operations.
  const admin = await (await mfaCollection()).findOne({ _id: request.user.id });
  if (!admin?.enabled) fail('MFA_ADMIN_ENROLL_REQUIRED');
  await verifyMfa(request.user.id, request.params.code);
  await clearMfaRecord(target.userId);
  await revoke(target.userId);
  await audit(request.user.id, target.userId, 'mfa.adminReset');
  return { success: true };
}
