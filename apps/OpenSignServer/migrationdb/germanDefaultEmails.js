/* eslint-disable no-await-in-loop */
// Migration phases, backups, and lease checks deliberately execute in order.
import { MongoClient } from 'mongodb';
import { germanDefault, mailFields } from '../utils/germanMailDefaults.js';
import { databaseUri } from '../utils/databaseConfig.js';

export default async function germanDefaultEmails(database, assertLock = async () => {}) {
  const client = database ? null : new MongoClient(databaseUri());
  try {
    if (client) await client.connect();
    const db = database || client.db();
    const name = 'germanDefaultEmails_v1';
    if (await db.collection('Migrationdb').findOne({ name })) return;
    for (const collectionName of [
      'partners_Tenant',
      'contracts_Users',
      'contracts_Document',
      'contracts_Template',
    ]) {
      const collection = db.collection(collectionName);
      const cursor = collection.find(
        { $or: mailFields.map(field => ({ [field]: { $type: 'string' } })) },
        { projection: Object.fromEntries(mailFields.map(field => [field, 1])) }
      );
      for await (const row of cursor) {
        await assertLock();
        const changes = Object.fromEntries(
          mailFields
            .filter(field => germanDefault(field, row[field]) !== row[field])
            .map(field => [field, germanDefault(field, row[field])])
        );
        if (!Object.keys(changes).length) continue;
        const originals = Object.fromEntries(
          Object.keys(changes).map(field => [field, row[field]])
        );
        await db.collection('_OpenSignMailMigrationBackup').updateOne(
          { _id: `${collectionName}:${row._id}` },
          {
            $setOnInsert: {
              collection: collectionName,
              objectId: row._id,
              originals,
              at: new Date(),
            },
          },
          { upsert: true }
        );
        await collection.updateOne({ _id: row._id, ...originals }, { $set: changes });
      }
    }
    await assertLock();
    await db
      .collection('Migrationdb')
      .updateOne({ name }, { $set: { executedAt: new Date() } }, { upsert: true });
    console.log('Unveränderte englische Standard-Mailvorlagen auf Deutsch umgestellt.');
  } finally {
    await client?.close();
  }
}
