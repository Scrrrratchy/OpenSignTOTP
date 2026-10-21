import { MongoClient } from 'mongodb';
import { databaseUri } from './databaseConfig.js';

let connection;
let client;
export async function mfaDb() {
  if (!connection) {
    client = new MongoClient(databaseUri());
    connection = client
      .connect()
      .then(() => client.db())
      .catch(error => {
        connection = undefined;
        throw error;
      });
  }
  return connection;
}
// Reserved names are inaccessible as custom classes through the Parse API.
export async function mfaCollection() {
  return (await mfaDb()).collection('_OpenSignMfa');
}
export async function closeMfaDb() {
  await client?.close();
  connection = undefined;
  client = undefined;
}

export async function clearMfaRecord(userId) {
  const collection = await mfaCollection();
  const record = await collection.findOne({ _id: userId });
  // Keep an import tombstone, otherwise a deliberately disabled enrollment
  // would be imported from the retained legacy data on the next restart.
  if (record?.legacySourceId) {
    await collection.replaceOne(
      { _id: userId },
      {
        _id: userId,
        enabled: false,
        legacySourceId: record.legacySourceId,
        legacyImportComplete: true,
      }
    );
  } else await collection.deleteOne({ _id: userId });
}
