import createContactIndex from './createContactIndex.js';
import createDocumentIndex from './createDocumentIndex.js';
import createNormalizedEmailUnique from './createNormalizedEmailUnqiue.js';
import createMfaIndexes from './createMfaIndexes.js';

export default async function runDbMigrations() {
  await createContactIndex();
  await createDocumentIndex();
  await createNormalizedEmailUnique();
  await createMfaIndexes();
}
