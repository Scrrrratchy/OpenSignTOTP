import { MongoClient } from 'mongodb';
import { databaseUri } from '../utils/databaseConfig.js';
import { migrationLock } from './lock.js';
import { historicalSchemas, protectMigrationSchemas } from './schema.js';
import { normalizeExistingEmails, requiredIndexes } from './data.js';
import { upgradeMfa } from './mfaUpgrade.js';
import germanDefaultEmails from './germanDefaultEmails.js';

export default async function runDbMigrations({
  appId,
  masterKey,
  prepareSchemaServer,
  env = process.env,
  lockOptions,
} = {}) {
  if (!appId || !masterKey || !prepareSchemaServer)
    throw new Error(
      'Der kontrollierte Migrationsstart benötigt App-ID, Master-Key und einen privaten Schemaserver.'
    );
  const client = new MongoClient(databaseUri(env));
  try {
    await client.connect();
    const db = client.db();
    await migrationLock(
      db,
      async assertLock => {
        const schemaServer = await prepareSchemaServer();
        try {
          const options = { db, assertLock, appId, masterKey, url: schemaServer.url };
          await historicalSchemas(options);
          await protectMigrationSchemas(options);
          await normalizeExistingEmails(db, assertLock);
          await upgradeMfa(db, assertLock, env);
          await requiredIndexes(db, assertLock);
          await germanDefaultEmails(db, assertLock);
          await assertLock();
          await db
            .collection('_OpenSignStartupMigrations')
            .updateOne(
              { _id: 'controlled-startup-v1' },
              { $set: { completedAt: new Date() } },
              { upsert: true }
            );
        } finally {
          await schemaServer.close();
        }
      },
      lockOptions
    );
  } finally {
    await client.close();
  }
}
