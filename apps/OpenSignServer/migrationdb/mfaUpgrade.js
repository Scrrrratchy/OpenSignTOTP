/* eslint-disable no-await-in-loop */
// Migration phases, backups, and lease checks deliberately execute in order.
import crypto from 'node:crypto';
import { seal, unseal } from '../utils/totpCrypto.js';

function legacyKey(env) {
  const configured = env.LEGACY_MFA_ENCRYPTION_KEY || env.MFA_ENCRYPTION_KEY || env.MASTER_KEY;
  if (!configured || configured.length < 12)
    throw new Error(
      'Der bisherige MFA_ENCRYPTION_KEY (bzw. bisherige MASTER_KEY) ist für die TOTP-Übernahme erforderlich. Als LEGACY_MFA_ENCRYPTION_KEY konfigurieren.'
    );
  return crypto.createHash('sha256').update(configured).digest();
}
function decryptLegacy(value, key) {
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (parts.length !== 3) throw new Error('Ungültiges altes TOTP-Verschlüsselungsformat.');
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'));
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}

export async function upgradeMfa(db, assertLock, env = process.env) {
  const canonical = db.collection('_OpenSignMfa');
  const plans = [];
  const seen = new Set();
  // Existing native enrollments must remain decryptable; never start password-only
  // just because an administrator accidentally replaced their encryption key.
  for await (const record of canonical.find({ enabled: true })) {
    try {
      unseal(record.secret, env.TOTP_ENCRYPTION_KEY);
      if (record.legacyRecoveryKey) unseal(record.legacyRecoveryKey, env.TOTP_ENCRYPTION_KEY);
    } catch {
      throw new Error(
        `TOTP-Schlüssel für Benutzer ${record._id} fehlt oder ist ungültig. Bestehenden TOTP_ENCRYPTION_KEY wiederherstellen.`
      );
    }
  }
  for await (const source of db.collection('OpenSign_MFA').find()) {
    await assertLock();
    if (typeof source._id !== 'string')
      throw new Error('Ungültige Objekt-ID in OpenSign_MFA. Manuelle Prüfung erforderlich.');
    const pointer = source._p_User;
    if (typeof pointer !== 'string' || !pointer.startsWith('_User$') || !pointer.slice(6))
      throw new Error(
        `Ungültiger Benutzerverweis in OpenSign_MFA, Datensatz ${source._id}. Manuelle Prüfung erforderlich.`
      );
    const userId = pointer.slice(6);
    if (seen.has(userId))
      throw new Error(
        `Mehrere alte TOTP-Einrichtungen für Benutzer ${userId}. Keine Einrichtung wurde automatisch ausgewählt.`
      );
    seen.add(userId);
    if (!(await db.collection('_User').findOne({ _id: userId }, { projection: { _id: 1 } })))
      throw new Error(`Verwaiste TOTP-Einrichtung ${source._id}. Vor dem Start prüfen.`);
    const existing = await canonical.findOne({ _id: userId });
    if (existing?.legacySourceId === source._id) {
      if (!existing.legacyImportComplete) plans.push({ source, userId, resume: true });
      continue;
    }
    if (source.Enabled !== true) continue; // Unconfirmed setup can safely be restarted.
    let secret, key;
    try {
      key = legacyKey(env);
      secret = decryptLegacy(source.Secret, key);
      if (!/^[A-Z2-7]{16,128}$/.test(secret)) throw new Error('Invalid base32 secret');
      if (existing?.enabled && unseal(existing.secret, env.TOTP_ENCRYPTION_KEY) !== secret)
        throw new Error('Conflicting enrollment');
    } catch {
      throw new Error(
        `Alte TOTP-Einrichtung für Benutzer ${userId} kann nicht eindeutig übernommen werden. Alten MFA-Schlüssel und den Datensatz prüfen; 2FA bleibt gesperrt.`
      );
    }
    const hashes = source.RecoveryCodeHashes || [];
    if (!Array.isArray(hashes) || hashes.some(hash => !/^[a-f0-9]{64}$/i.test(hash)))
      throw new Error(`Ungültige Wiederherstellungscodes für Benutzer ${userId}.`);
    const counter = source.LastUsedTotpStep || 0;
    if (!Number.isSafeInteger(counter) || counter < 0)
      throw new Error(`Ungültiger TOTP-Zeitstand für Benutzer ${userId}.`);
    // Prepare encrypted values before any writes; this also validates the new key.
    const update = {
      enabled: true,
      secret: existing?.enabled ? existing.secret : seal(secret, env.TOTP_ENCRYPTION_KEY),
      attempts: 0,
      lastCounter: Math.max(counter, existing?.lastCounter || 0),
      legacyRecovery: [...new Set(hashes.map(hash => hash.toLowerCase()))],
      legacyRecoveryKey: seal(key.toString('hex'), env.TOTP_ENCRYPTION_KEY),
      legacySourceId: source._id,
      legacyImportComplete: false,
    };
    plans.push({ source, userId, update });
  }
  for (const plan of plans) {
    await assertLock();
    if (!plan.resume) {
      await db
        .collection('_OpenSignMigrationBackup')
        .updateOne(
          { _id: `mfa-import:${plan.source._id}` },
          { $setOnInsert: { kind: 'mfa', original: plan.source, at: new Date() } },
          { upsert: true }
        );
      await canonical.updateOne(
        { _id: plan.userId },
        { $set: plan.update, $setOnInsert: { recovery: [] } },
        { upsert: true }
      );
    }
    await db.collection('_Session').deleteMany({ _p_user: `_User$${plan.userId}` });
    await canonical.updateOne({ _id: plan.userId }, { $set: { legacyImportComplete: true } });
    await db.collection('_OpenSignSecurityAudit').insertOne({
      actor: 'startup-migration',
      target: plan.userId,
      action: 'mfa.imported',
      at: new Date(),
    });
  }
  // Outstanding legacy login challenges cannot be used by the new login flow.
  // Revoke the associated old sessions before removing their temporary challenges.
  for await (const challenge of db.collection('OpenSign_MFAChallenge').find()) {
    await assertLock();
    if (typeof challenge._p_User === 'string')
      await db.collection('_Session').deleteMany({ _p_user: challenge._p_User });
    await db.collection('OpenSign_MFAChallenge').deleteOne({ _id: challenge._id });
  }
}
