import { standaloneMigration } from './standalone.js';
import { requiredIndexes, normalizeExistingEmails } from './data.js';

export default async function migrate() {
  await standaloneMigration(async (db, assertLock) => {
    await normalizeExistingEmails(db, assertLock);
    await requiredIndexes(db, assertLock, ['normalizedEmailUnique_1']);
  });
}
