import crypto from 'node:crypto';
import QRCode from 'qrcode';
import speakeasy from 'speakeasy';
import { appName } from '../../Utils.js';

const MFA_CLASS = 'OpenSign_MFA';
const CHALLENGE_CLASS = 'OpenSign_MFAChallenge';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SETUP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function encryptionKey() {
  const configured = process.env.MFA_ENCRYPTION_KEY || process.env.MASTER_KEY;
  if (!configured || configured.length < 12) {
    throw new Parse.Error(500, 'MFA_ENCRYPTION_KEY must contain at least 12 characters.');
  }
  return crypto.createHash('sha256').update(configured).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decrypt(value) {
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function userPointer(userId) {
  return { __type: 'Pointer', className: '_User', objectId: userId };
}

async function findMfa(userId) {
  const query = new Parse.Query(MFA_CLASS);
  query.equalTo('User', userPointer(userId));
  return query.first({ useMasterKey: true });
}

function requireUser(request) {
  if (!request.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  return request.user;
}

function normalizeCode(code) {
  return String(code || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function hashRecoveryCode(code) {
  return crypto.createHmac('sha256', encryptionKey()).update(normalizeCode(code)).digest('hex');
}

function generateRecoveryCodes() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => {
    const bytes = crypto.randomBytes(8);
    const raw = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

function verifiedTotpStep(secret, token) {
  if (!/^\d{6}$/.test(String(token || ''))) return null;
  const result = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token: String(token),
    step: 30,
    window: 1,
  });
  return result ? Math.floor(Date.now() / 30000) + result.delta : null;
}

function verifyTotp(secret, token) {
  return verifiedTotpStep(secret, token) !== null;
}

function consumeRecoveryCode(mfa, code) {
  const hashes = mfa.get('RecoveryCodeHashes') || [];
  const supplied = hashRecoveryCode(code);
  const index = hashes.findIndex(hash => {
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(supplied, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (index === -1) return false;
  mfa.set('RecoveryCodeHashes', hashes.filter((_, itemIndex) => itemIndex !== index));
  return true;
}

async function verifyMfaCode(mfa, token, recoveryCode) {
  if (recoveryCode) {
    const valid = consumeRecoveryCode(mfa, recoveryCode);
    if (valid) await mfa.save(null, { useMasterKey: true });
    return valid;
  }
  const step = verifiedTotpStep(decrypt(mfa.get('Secret')), token);
  if (step === null || step <= (mfa.get('LastUsedTotpStep') || 0)) return false;
  mfa.set('LastUsedTotpStep', step);
  await mfa.save(null, { useMasterKey: true });
  return true;
}

export async function isMfaEnabledForUser(userId) {
  const mfa = await findMfa(userId);
  return Boolean(mfa?.get('Enabled') && mfa?.get('Secret'));
}

export async function createMfaLoginChallenge(user) {
  const challenge = new Parse.Object(CHALLENGE_CLASS);
  challenge.setACL(new Parse.ACL());
  challenge.set('User', userPointer(user.id));
  challenge.set('SessionToken', encrypt(user.getSessionToken()));
  challenge.set('ExpiresAt', new Date(Date.now() + CHALLENGE_TTL_MS));
  challenge.set('Attempts', 0);
  await challenge.save(null, { useMasterKey: true });
  return challenge.id;
}

export async function getMfaStatus(request) {
  const user = requireUser(request);
  const mfa = await findMfa(user.id);
  return {
    enabled: Boolean(mfa?.get('Enabled') && mfa?.get('Secret')),
    recoveryCodesRemaining: mfa?.get('RecoveryCodeHashes')?.length || 0,
  };
}

export async function beginMfaSetup(request) {
  const user = requireUser(request);
  let mfa = await findMfa(user.id);
  if (mfa?.get('Enabled')) {
    throw new Parse.Error(409, 'Disable the existing two-factor authentication first.');
  }

  const email = user.get('email') || user.get('username');
  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${appName}:${email}`,
    issuer: appName,
  });
  if (!mfa) mfa = new Parse.Object(MFA_CLASS);
  mfa.setACL(new Parse.ACL());
  mfa.set('User', userPointer(user.id));
  mfa.set('PendingSecret', encrypt(secret.base32));
  mfa.set('PendingExpiresAt', new Date(Date.now() + SETUP_TTL_MS));
  mfa.set('Enabled', false);
  await mfa.save(null, { useMasterKey: true });

  return {
    secret: secret.base32,
    qrCode: await QRCode.toDataURL(secret.otpauth_url, { width: 240, margin: 1 }),
  };
}

export async function confirmMfaSetup(request) {
  const user = requireUser(request);
  const mfa = await findMfa(user.id);
  const expiresAt = mfa?.get('PendingExpiresAt');
  if (!mfa || !expiresAt || expiresAt.getTime() < Date.now()) {
    throw new Parse.Error(410, 'The two-factor setup has expired. Start again.');
  }

  const secret = decrypt(mfa.get('PendingSecret'));
  if (!verifyTotp(secret, request.params.token)) {
    throw new Parse.Error(400, 'Invalid authentication code.');
  }

  const recoveryCodes = generateRecoveryCodes();
  mfa.set('Secret', encrypt(secret));
  mfa.set('RecoveryCodeHashes', recoveryCodes.map(hashRecoveryCode));
  mfa.set('Enabled', true);
  mfa.set('LastUsedTotpStep', Math.floor(Date.now() / 30000));
  mfa.unset('PendingSecret');
  mfa.unset('PendingExpiresAt');
  await mfa.save(null, { useMasterKey: true });
  return { enabled: true, recoveryCodes };
}

export async function disableMfa(request) {
  const user = requireUser(request);
  const mfa = await findMfa(user.id);
  if (!mfa?.get('Enabled')) return { enabled: false };
  const valid = await verifyMfaCode(mfa, request.params.token, request.params.recoveryCode);
  if (!valid) throw new Parse.Error(400, 'Invalid authentication or recovery code.');
  await mfa.destroy({ useMasterKey: true });
  return { enabled: false };
}

export async function verifyMfaLogin(request) {
  const challengeId = request.params.challengeId;
  const query = new Parse.Query(CHALLENGE_CLASS);
  const challenge = await query.get(challengeId, { useMasterKey: true });
  if (challenge.get('ExpiresAt').getTime() < Date.now()) {
    await challenge.destroy({ useMasterKey: true });
    throw new Parse.Error(410, 'The two-factor challenge has expired.');
  }
  const attempts = challenge.get('Attempts') || 0;
  if (attempts >= MAX_ATTEMPTS) {
    await challenge.destroy({ useMasterKey: true });
    throw new Parse.Error(429, 'Too many authentication attempts.');
  }

  const userId = challenge.get('User').id;
  const mfa = await findMfa(userId);
  const valid = mfa?.get('Enabled') && await verifyMfaCode(
    mfa,
    request.params.token,
    request.params.recoveryCode,
  );
  if (!valid) {
    challenge.increment('Attempts');
    await challenge.save(null, { useMasterKey: true });
    throw new Parse.Error(400, 'Invalid authentication or recovery code.');
  }

  const sessionToken = decrypt(challenge.get('SessionToken'));
  const userQuery = new Parse.Query(Parse.User);
  const user = await userQuery.get(userId, { useMasterKey: true });
  await challenge.destroy({ useMasterKey: true });
  return { ...user.toJSON(), sessionToken };
}

async function requireAdministrator(request) {
  const user = requireUser(request);
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', userPointer(user.id));
  query.include('OrganizationId');
  const extUser = await query.first({ useMasterKey: true });
  const role = extUser?.get('UserRole');
  if (!['contracts_Admin', 'contracts_OrgAdmin'].includes(role)) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Administrator access is required.');
  }
  return extUser;
}

async function getManagedUser(admin, targetUserId) {
  const query = new Parse.Query('contracts_Users');
  query.equalTo('UserId', userPointer(targetUserId));
  const organization = admin.get('OrganizationId');
  if (organization) query.equalTo('OrganizationId', organization);
  const target = await query.first({ useMasterKey: true });
  if (!target) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'User not found in this organization.');
  return target;
}

export async function getMfaAdminStatus(request) {
  const admin = await requireAdministrator(request);
  const userIds = Array.isArray(request.params.userIds) ? request.params.userIds.slice(0, 200) : [];
  const status = {};
  await Promise.all(userIds.map(async userId => {
    await getManagedUser(admin, userId);
    status[userId] = await isMfaEnabledForUser(userId);
  }));
  return status;
}

export async function adminResetMfa(request) {
  const admin = await requireAdministrator(request);
  const targetUserId = request.params.userId;
  await getManagedUser(admin, targetUserId);
  const mfa = await findMfa(targetUserId);
  if (mfa) await mfa.destroy({ useMasterKey: true });
  return { enabled: false };
}

export async function enforceMfaLogin(request) {
  if (request.master) return;
  const user = request.object || request.user;
  if (user?.id && await isMfaEnabledForUser(user.id)) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Use the two-factor login flow.');
  }
}
