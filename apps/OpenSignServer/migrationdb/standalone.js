import { MongoClient } from 'mongodb';
import { databaseUri } from '../utils/databaseConfig.js';
import { migrationLock } from './lock.js';

export async function standaloneMigration(run) {
  const client = new MongoClient(databaseUri());
  try {
    await client.connect();
    await migrationLock(client.db(), assertLock => run(client.db(), assertLock));
  } finally {
    await client.close();
  }
}
