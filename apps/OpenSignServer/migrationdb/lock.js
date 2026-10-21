/* eslint-disable no-await-in-loop */
// Migration phases, backups, and lease checks deliberately execute in order.
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function migrationLock(
  db,
  run,
  { leaseMs = 120000, waitMs = 300000, pollMs = 1000 } = {}
) {
  const locks = db.collection('_OpenSignMigrationLocks');
  const owner = crypto.randomUUID();
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      const result = await locks.findOneAndUpdate(
        { _id: 'startup', expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + leaseMs) } },
        { upsert: true, returnDocument: 'after' }
      );
      acquired = result?.owner === owner;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    if (!acquired) {
      if (Date.now() - started >= waitMs)
        throw new Error(
          'Eine andere Instanz migriert noch. Start wegen Zeitüberschreitung abgebrochen.'
        );
      await delay(pollMs);
    }
  }
  let lost;
  let renewing = Promise.resolve();
  const renew = async () => {
    if (lost) return;
    try {
      const result = await locks.updateOne(
        { _id: 'startup', owner, expiresAt: { $gt: new Date() } },
        { $set: { expiresAt: new Date(Date.now() + leaseMs) } }
      );
      if (!result.matchedCount) throw new Error('Migrationssperre wurde verloren.');
    } catch (error) {
      lost = error;
    }
  };
  const timer = setInterval(
    () => {
      renewing = renewing.then(renew);
    },
    Math.max(10, Math.floor(leaseMs / 4))
  );
  const assertLock = async () => {
    await renewing;
    if (lost) throw lost;
    await renew();
    if (lost) throw lost;
  };
  try {
    const result = await run(assertLock);
    await assertLock();
    return result;
  } finally {
    clearInterval(timer);
    await renewing;
    await locks.deleteOne({ _id: 'startup', owner });
  }
}
