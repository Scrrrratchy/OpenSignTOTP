import { standaloneMigration } from './standalone.js';
import { requiredIndexes } from './data.js';

export default async function migrate() {
  await standaloneMigration(async (db, assertLock) => {
    await requiredIndexes(db, assertLock, ['documentIndex_1']);
  });
}
