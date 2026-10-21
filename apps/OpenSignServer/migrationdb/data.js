/* eslint-disable no-await-in-loop */
// Migration phases, backups, and lease checks deliberately execute in order.
import { accountEmail } from '../utils/normalizeEmail.js';

export async function normalizeExistingEmails(db, assertLock) {
  const changes = [];
  const seen = new Map();
  const cursor = db
    .collection('_User')
    .find({}, { projection: { email: 1, username: 1, normalizedEmail: 1 } });
  for await (const user of cursor) {
    const normalized = accountEmail(user);
    if (normalized && seen.has(normalized))
      throw new Error(
        `E-Mail-Kollision bei den Benutzer-IDs ${seen.get(normalized)} und ${user._id}. Keine Konten wurden zusammengeführt. Bitte die E-Mail-Adressen vor dem erneuten Start korrigieren.`
      );
    if (normalized) seen.set(normalized, user._id);
    if (
      (normalized && normalized !== user.normalizedEmail) ||
      (!normalized && Object.hasOwn(user, 'normalizedEmail'))
    )
      changes.push({ user, normalized });
  }
  // Validate every account first. Backups precede all writes; unsetting changed
  // values also makes interrupted migrations and stale/swapped index values safe.
  for (const { user } of changes) {
    await assertLock();
    await db.collection('_OpenSignMigrationBackup').updateOne(
      { _id: `email-v2:${user._id}` },
      {
        $setOnInsert: {
          kind: 'normalizedEmail',
          userId: user._id,
          existed: Object.hasOwn(user, 'normalizedEmail'),
          original: user.normalizedEmail ?? null,
          at: new Date(),
        },
      },
      { upsert: true }
    );
  }
  for (const { user } of changes) {
    await assertLock();
    await db.collection('_User').updateOne({ _id: user._id }, { $unset: { normalizedEmail: '' } });
  }
  for (const { user, normalized } of changes) {
    await assertLock();
    if (normalized)
      await db
        .collection('_User')
        .updateOne({ _id: user._id }, { $set: { normalizedEmail: normalized } });
  }
  await db
    .collection('Migrationdb')
    .updateOne(
      { name: 'normalizedEmailBackfill_2' },
      { $set: { executedAt: new Date(), details: 'Existing account normalization validated' } },
      { upsert: true }
    );
}

export async function requiredIndexes(db, assertLock, markers) {
  const steps = [
    {
      collection: 'contracts_Contactbook',
      keys: { _p_CreatedBy: 1, Email: 1, IsImported: 1 },
      options: {
        unique: true,
        partialFilterExpression: {
          IsImported: { $eq: true },
          $or: [{ IsDeleted: false }, { IsDeleted: { $eq: false } }],
        },
      },
      marker: 'contactIndex_1',
    },
    {
      collection: 'contracts_Document',
      keys: { _p_CreatedBy: 1, _updated_at: -1 },
      options: {
        name: 'idx_docs_by_creator_recent_completed',
        partialFilterExpression: { IsCompleted: true },
      },
      marker: 'documentIndex_1',
    },
    {
      collection: 'contracts_Document',
      keys: { Signers: 1, _updated_at: -1 },
      options: {
        name: 'idx_docs_by_signer_recent_completed',
        partialFilterExpression: { IsCompleted: true },
      },
      marker: 'documentIndex_1',
    },
    {
      collection: '_User',
      keys: { normalizedEmail: 1 },
      options: { unique: true, sparse: true },
      marker: 'normalizedEmailUnique_1',
    },
    {
      collection: 'OpenSign_MFA',
      keys: { _p_User: 1 },
      options: { unique: true, name: 'unique_mfa_user' },
      marker: 'opensignMfaIndexes_1',
    },
    {
      collection: 'OpenSign_MFAChallenge',
      keys: { ExpiresAt: 1 },
      options: { expireAfterSeconds: 0, name: 'expire_mfa_challenges' },
      marker: 'opensignMfaIndexes_1',
    },
  ];
  const selected = markers ? steps.filter(step => markers.includes(step.marker)) : steps;
  for (const step of selected) {
    await assertLock();
    try {
      await db.collection(step.collection).createIndex(step.keys, step.options);
    } catch (error) {
      throw new Error(
        `Indexmigration ${step.collection} fehlgeschlagen (MongoDB-Code ${error.code}). Vorhandene Duplikate oder widersprüchliche Indexoptionen müssen vor dem Start geklärt werden.`
      );
    }
  }
  // Completion is recorded only after every index has actually been verified.
  for (const marker of new Set(selected.map(step => step.marker))) {
    await db.collection('Migrationdb').updateOne(
      { name: marker },
      {
        $set: {
          executedAt: new Date(),
          details: 'Indexes verified by controlled startup migration',
        },
      },
      { upsert: true }
    );
  }
}
