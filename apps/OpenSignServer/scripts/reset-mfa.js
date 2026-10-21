import 'dotenv/config';
import { mfaDb, closeMfaDb, clearMfaRecord } from '../utils/mfaStore.js';

// Offline recovery for administrators who have lost both device and backup codes.
const args = Object.fromEntries(
  process.argv.slice(2).map(value => {
    const index = value.indexOf('=');
    return [value.slice(0, index), value.slice(index + 1)];
  })
);
const id = args['--user-id'];
if (!id || args['--confirm'] !== id || !args['--reason']?.trim()) {
  console.error(
    'Usage: node scripts/reset-mfa.js --user-id=USER_ID --confirm=USER_ID --reason="Verified identity; lost authenticator"'
  );
  process.exitCode = 1;
} else {
  try {
    const db = await mfaDb();
    if (!(await db.collection('_User').findOne({ _id: id }))) throw new Error('User not found');
    await db.collection('_OpenSignSecurityAudit').insertOne({
      actor: 'server-console',
      target: id,
      action: 'mfa.offlineReset',
      reason: args['--reason'],
      at: new Date(),
    });
    await clearMfaRecord(id);
    await db.collection('_Session').deleteMany({ _p_user: `_User$${id}` });
    console.log('2FA reset. All user sessions revoked. The user must enroll again.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closeMfaDb();
  }
}
