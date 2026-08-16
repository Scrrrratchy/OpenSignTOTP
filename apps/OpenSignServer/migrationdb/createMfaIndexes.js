import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { generateId } from '../Utils.js';

dotenv.config({ quiet: true });

export default async function createMfaIndexes() {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/dev');
  try {
    await client.connect();
    const database = client.db();
    const migrations = database.collection('Migrationdb');
    const migrationName = 'opensignMfaIndexes_1';
    if (await migrations.findOne({ name: migrationName })) return;

    await database.collection('OpenSign_MFA').createIndex(
      { _p_User: 1 },
      { unique: true, name: 'unique_mfa_user' },
    );
    await database.collection('OpenSign_MFAChallenge').createIndex(
      { ExpiresAt: 1 },
      { expireAfterSeconds: 0, name: 'expire_mfa_challenges' },
    );
    await migrations.insertOne({
      _id: generateId(10),
      name: migrationName,
      _created_at: new Date(),
      _updated_at: new Date(),
      executedAt: new Date(),
      details: 'Created MFA user and challenge expiry indexes',
    });
    console.log(' SUCCESS  MFA indexes created.');
  } catch (error) {
    console.log(' ERROR  Running MFA index migration:', error);
  } finally {
    await client.close();
  }
}
