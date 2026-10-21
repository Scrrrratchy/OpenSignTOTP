import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { MongoClient } from 'mongodb';
import { MongoCluster } from 'mongodb-runner';
import { startServer } from '../startup.js';
import runDbMigrations from '../migrationdb/index.js';
import { migrationLock } from '../migrationdb/lock.js';
import { databaseUri } from '../utils/databaseConfig.js';
import { closeMfaDb, mfaCollection } from '../utils/mfaStore.js';
import { newSecret, seal, unseal, totp } from '../utils/totpCrypto.js';
import * as mfa from '../cloud/parsefunction/mfa.js';
import loginUser from '../cloud/parsefunction/loginUser.js';
import normalizeUserEmail from '../cloud/parsefunction/normalizeUserEmail.js';
import SessionCache from '../utils/sessionCache.js';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function encryptLegacy(secret, configured) {
  const key = crypto.createHash('sha256').update(configured).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

test('database configuration has no hidden fallback and rejects conflicting targets', () => {
  assert.throws(() => databaseUri({}), /ausdrücklich/);
  assert.throws(
    () => databaseUri({ DATABASE_URI: 'mongodb://a/db', MONGODB_URI: 'mongodb://b/db' }),
    /widersprechen/
  );
  assert.equal(databaseUri({ DATABASE_URI: 'mongodb://a/db' }), 'mongodb://a/db');
  assert.equal(databaseUri({ MONGODB_URI: 'mongodb://a/db' }), 'mongodb://a/db');
});

test(
  'controlled first start and upgrade of existing OpenSign data',
  { timeout: 180000 },
  async t => {
    // Parse installs process-wide log listeners; real services start once, this
    // integration test deliberately creates many instances sequentially.
    const originalListenerLimit = process.getMaxListeners();
    process.setMaxListeners(50);
    const root = path.resolve('.test-data');
    await fs.mkdir(root, { recursive: true });
    let cluster, client, running;
    try {
      cluster = await MongoCluster.start({
        topology: 'standalone',
        version: '8.0.17',
        downloadDir: path.join(root, 'download'),
        tmpDir: root,
        logDir: root,
      });
      const dbUrl = new URL(cluster.connectionString);
      dbUrl.pathname = '/controlled_startup_test';
      const env = {
        DATABASE_URI: dbUrl.toString(),
        TOTP_ENCRYPTION_KEY: 'ab'.repeat(32),
        LEGACY_MFA_ENCRYPTION_KEY: 'legacy-mfa-key-for-upgrade',
        MASTER_KEY: 'startup-test-master-key',
      };
      process.env.DATABASE_URI = env.DATABASE_URI;
      delete process.env.MONGODB_URI;
      process.env.TOTP_ENCRYPTION_KEY = env.TOTP_ENCRYPTION_KEY;
      client = new MongoClient(env.DATABASE_URI);
      await client.connect();
      const db = client.db();
      let base;
      async function boot(overrides = {}) {
        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        const app = express();
        app.get('/', (req, res) => res.send('ready'));
        const config = {
          databaseURI: env.DATABASE_URI,
          appId: 'startup-test',
          masterKey: env.MASTER_KEY,
          serverURL: `${base}/app`,
          allowClientClassCreation: false,
          cacheAdapter: new SessionCache(),
          encodeParseObjectInCloudFunction: true,
          enableInsecureAuthAdapters: false,
          databaseOptions: { allowPublicExplain: false },
          logLevel: 'silent',
          logsFolder: null,
          cloud: () => {
            Parse.Cloud.beforeLogin(mfa.beforeLogin);
            Parse.Cloud.beforeSave(Parse.User, normalizeUserEmail);
            for (const name of ['mfaStatus', 'mfaSetup', 'mfaEnable', 'mfaDisable'])
              Parse.Cloud.define(name, mfa[name]);
            Parse.Cloud.define('loginuser', loginUser);
          },
        };
        return startServer({ config, app, port, host: '127.0.0.1', env, ...overrides });
      }
      async function api(endpoint, body, token, master = false) {
        const response = await fetch(`${base}/app${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Parse-Application-Id': 'startup-test',
            ...(master ? { 'X-Parse-Master-Key': env.MASTER_KEY } : {}),
            ...(token ? { 'X-Parse-Session-Token': token } : {}),
          },
          body: JSON.stringify(body || {}),
        });
        return { status: response.status, body: await response.json() };
      }
      const call = (name, body, token) => api(`/functions/${name}`, body, token);
      const login = (email, code) =>
        call('loginuser', { email, password: 'Test-password-123!', mfaCode: code });

      await t.test(
        'fresh start keeps the public port closed until schemas and indexes are complete',
        async () => {
          let release;
          const gate = new Promise(resolve => {
            release = resolve;
          });
          const starting = boot({
            migrate: async options => {
              await gate;
              return runDbMigrations({
                ...options,
                prepareSchemaServer: async () => {
                  const privateServer = await options.prepareSchemaServer();
                  assert.equal(
                    (await fetch(`${privateServer.url}/schemas/OpenSign_MFA`)).status,
                    403
                  );
                  return privateServer;
                },
              });
            },
          });
          while (!base) await new Promise(resolve => setTimeout(resolve, 1));
          await assert.rejects(fetch(base));
          release();
          running = await starting;
          assert.equal((await fetch(base)).status, 200);
          assert.equal(
            (await db.collection('OpenSign_MFA').indexes()).find(
              index => index.name === 'unique_mfa_user'
            ).unique,
            true
          );
          const schema = await db.collection('_SCHEMA').findOne({ _id: 'Migrationdb' });
          assert.ok(schema);
          assert.ok(
            await db
              .collection('_OpenSignStartupMigrations')
              .findOne({ _id: 'controlled-startup-v1' })
          );
        }
      );

      let native, legacy, nativeCodes, nativeSecret, oldSecret;
      const oldCode = 'ABCD-2345';
      await t.test(
        'new accounts normalize email and MFA classes reject unauthenticated creates',
        async () => {
          native = (
            await api('/users', {
              username: 'native@example.test',
              email: 'native@example.test',
              password: 'Test-password-123!',
            })
          ).body;
          legacy = (
            await api('/users', {
              username: 'legacy@example.test',
              email: 'legacy@example.test',
              password: 'Test-password-123!',
            })
          ).body;
          assert.ok(native.objectId);
          assert.ok(legacy.objectId);
          for (const user of [native, legacy])
            await db.collection('contracts_Users').insertOne({
              _id: `ext-${user.objectId}`,
              _p_UserId: `_User$${user.objectId}`,
              UserRole: 'contracts_User',
              Name: 'Test',
              Email: user.username,
            });
          assert.equal(
            (await db.collection('_User').findOne({ _id: native.objectId })).normalizedEmail,
            'native@example.test'
          );
          for (const className of ['OpenSign_MFA', 'OpenSign_MFAChallenge']) {
            const result = await api(`/classes/${className}`, {
              User: { __type: 'Pointer', className: '_User', objectId: legacy.objectId },
              Enabled: true,
              Secret: 'invalid',
            });
            assert.ok(result.status >= 400);
          }
          const setup = (await call('mfaSetup', {}, native.sessionToken)).body.result;
          nativeSecret = setup.secret;
          const enabled = await call(
            'mfaEnable',
            { code: totp(setup.secret, Math.floor(Date.now() / 30000)) },
            native.sessionToken
          );
          assert.equal(enabled.status, 200, enabled.body.error);
          nativeCodes = enabled.body.result.recoveryCodes;
        }
      );

      await t.test(
        'upgrade preserves native TOTP, imports legacy TOTP and old recovery codes',
        async () => {
          await running.close();
          running = undefined;
          oldSecret = newSecret();
          const oldKey = crypto.createHash('sha256').update(env.LEGACY_MFA_ENCRYPTION_KEY).digest();
          const hash = crypto
            .createHmac('sha256', oldKey)
            .update(oldCode.replace('-', ''))
            .digest('hex');
          await db.collection('OpenSign_MFA').insertOne({
            _id: 'old-mfa',
            _p_User: `_User$${legacy.objectId}`,
            Enabled: true,
            Secret: encryptLegacy(oldSecret, env.LEGACY_MFA_ENCRYPTION_KEY),
            RecoveryCodeHashes: [hash],
            LastUsedTotpStep: 0,
          });
          running = await boot();
          const nativeRecord = await db
            .collection('_OpenSignMfa')
            .findOne({ _id: native.objectId });
          assert.equal(unseal(nativeRecord.secret), nativeSecret);
          const imported = await db.collection('_OpenSignMfa').findOne({ _id: legacy.objectId });
          assert.equal(unseal(imported.secret), oldSecret);
          assert.equal(imported.legacyImportComplete, true);
          assert.equal((await login('legacy@example.test')).body.error, 'MFA_REQUIRED');
          const result = await login('legacy@example.test', oldCode);
          assert.equal(result.status, 200, result.body.error);
          assert.equal((await login('legacy@example.test', oldCode)).body.error, 'MFA_INVALID');
          assert.equal((await login('native@example.test', nativeCodes[0])).status, 200);
          assert.equal(
            await db.collection('_Session').countDocuments({ _session_token: legacy.sessionToken }),
            0
          );
        }
      );

      await t.test('restart does not replenish consumed recovery codes', async () => {
        await running.close();
        running = await boot();
        assert.equal((await login('legacy@example.test', oldCode)).body.error, 'MFA_INVALID');
        assert.equal(
          (await db.collection('_OpenSignMfa').findOne({ _id: legacy.objectId })).legacyRecovery
            .length,
          0
        );
      });

      await t.test('disabling imported MFA remains disabled after a restart', async () => {
        const code = totp(oldSecret, Math.floor(Date.now() / 30000));
        const authenticated = await login('legacy@example.test', code);
        assert.equal(authenticated.status, 200, authenticated.body.error);
        // Use a remaining native-style test recovery code for this management action.
        const backup = '1234567890ABCDEF';
        const { hashCode } = await import('../utils/totpCrypto.js');
        await (
          await mfaCollection()
        ).updateOne({ _id: legacy.objectId }, { $set: { recovery: [hashCode(backup)] } });
        assert.equal(
          (await call('mfaDisable', { code: backup }, authenticated.body.result.sessionToken))
            .status,
          200
        );
        await running.close();
        running = await boot();
        assert.equal((await login('legacy@example.test')).status, 200);
      });

      await t.test('wrong native encryption key aborts startup', async () => {
        await running.close();
        running = undefined;
        const original = env.TOTP_ENCRYPTION_KEY;
        env.TOTP_ENCRYPTION_KEY = 'cd'.repeat(32);
        await assert.rejects(boot(), /TOTP-Schlüssel/);
        await assert.rejects(fetch(base));
        env.TOTP_ENCRYPTION_KEY = original;
      });

      await t.test(
        'backfill repairs stale unique values without deleting or merging accounts',
        async () => {
          await db.collection('_User').insertMany([
            {
              _id: 'backfill-a',
              username: 'backfill-a@example.test',
              email: 'backfill-a@example.test',
              normalizedEmail: 'backfill-b@example.test',
            },
            {
              _id: 'backfill-b',
              username: 'backfill-b@example.test',
              email: 'backfill-b@example.test',
              normalizedEmail: 'backfill-a@example.test',
            },
          ]);
          running = await boot();
          assert.equal(
            (await db.collection('_User').findOne({ _id: 'backfill-a' })).normalizedEmail,
            'backfill-a@example.test'
          );
          assert.equal(
            (await db.collection('_User').findOne({ _id: 'backfill-b' })).normalizedEmail,
            'backfill-b@example.test'
          );
          assert.equal(
            (
              await db
                .collection('_OpenSignMigrationBackup')
                .findOne({ _id: 'email-v2:backfill-a' })
            ).original,
            'backfill-b@example.test'
          );
          await running.close();
          running = undefined;
        }
      );

      await t.test(
        'wrong old MFA key blocks import, retry with the correct key succeeds',
        async () => {
          await db.collection('_User').insertOne({
            _id: 'needs-import',
            username: 'third@example.test',
            email: 'third@example.test',
          });
          const secret = newSecret();
          await db.collection('OpenSign_MFA').insertOne({
            _id: 'third-mfa',
            _p_User: '_User$needs-import',
            Enabled: true,
            Secret: encryptLegacy(secret, env.LEGACY_MFA_ENCRYPTION_KEY),
            RecoveryCodeHashes: [],
          });
          const original = env.LEGACY_MFA_ENCRYPTION_KEY;
          env.LEGACY_MFA_ENCRYPTION_KEY = 'wrong-legacy-encryption-key';
          await assert.rejects(boot(), /Alte TOTP-Einrichtung/);
          assert.equal(
            await db.collection('_OpenSignMfa').countDocuments({ _id: 'needs-import' }),
            0
          );
          env.LEGACY_MFA_ENCRYPTION_KEY = original;
          running = await boot();
          assert.equal(
            unseal((await db.collection('_OpenSignMfa').findOne({ _id: 'needs-import' })).secret),
            secret
          );
          await running.close();
          running = undefined;
        }
      );

      await t.test(
        'duplicate legacy MFA rows stop startup instead of silently picking one',
        async () => {
          await db.collection('OpenSign_MFA').dropIndex('unique_mfa_user');
          await db
            .collection('OpenSign_MFA')
            .insertOne({ _id: 'duplicate-mfa', _p_User: '_User$needs-import', Enabled: false });
          await assert.rejects(boot(), /Mehrere alte TOTP-Einrichtungen/);
          await assert.rejects(fetch(base));
          await db.collection('OpenSign_MFA').deleteOne({ _id: 'duplicate-mfa' });
        }
      );

      await t.test(
        'stale index markers do not prevent repair, pending legacy sessions are revoked',
        async () => {
          const contactIndexes = await db.collection('contracts_Contactbook').indexes();
          const contact = contactIndexes.find(index => index.unique && index.name !== '_id_');
          await db.collection('contracts_Contactbook').dropIndex(contact.name);
          await db.collection('_Session').insertOne({
            _id: 'old-session',
            _p_user: `_User$${legacy.objectId}`,
            _session_token: 'old-session-test-token',
          });
          await db.collection('OpenSign_MFAChallenge').insertOne({
            _id: 'old-challenge',
            _p_User: `_User$${legacy.objectId}`,
            SessionToken: 'old-encrypted-token',
            ExpiresAt: new Date(Date.now() + 300000),
          });
          running = await boot();
          assert.ok(
            (await db.collection('contracts_Contactbook').indexes()).some(
              index => index.name === contact.name
            )
          );
          assert.ok(
            (await db.collection('OpenSign_MFA').indexes()).some(
              index => index.name === 'unique_mfa_user'
            )
          );
          assert.equal(await db.collection('_Session').countDocuments({ _id: 'old-session' }), 0);
          assert.equal(await db.collection('OpenSign_MFAChallenge').countDocuments(), 0);
          await running.close();
          running = undefined;
        }
      );

      await t.test(
        'a unique-index failure aborts startup and preserves conflicting records',
        async () => {
          const indexes = await db.collection('contracts_Contactbook').indexes();
          await db
            .collection('contracts_Contactbook')
            .dropIndex(indexes.find(index => index.unique && index.name !== '_id_').name);
          await db.collection('contracts_Contactbook').insertMany([
            {
              _id: 'contact-conflict-a',
              _p_CreatedBy: '_User$test',
              Email: 'same@example.test',
              IsImported: true,
              IsDeleted: false,
            },
            {
              _id: 'contact-conflict-b',
              _p_CreatedBy: '_User$test',
              Email: 'same@example.test',
              IsImported: true,
              IsDeleted: false,
            },
          ]);
          await assert.rejects(boot(), /Indexmigration contracts_Contactbook fehlgeschlagen/);
          await assert.rejects(fetch(base));
          assert.equal(
            await db
              .collection('contracts_Contactbook')
              .countDocuments({ Email: 'same@example.test' }),
            2
          );
          await db
            .collection('contracts_Contactbook')
            .deleteMany({ _id: { $in: ['contact-conflict-a', 'contact-conflict-b'] } });
        }
      );

      await t.test('duplicate normalized emails abort before account data is changed', async () => {
        await db.collection('_User').insertOne({
          _id: 'email-conflict',
          username: 'conflict-unique',
          email: ' NATIVE@example.test ',
        });
        const before = await db.collection('_User').findOne({ _id: native.objectId });
        await assert.rejects(boot(), /E-Mail-Kollision/);
        await assert.rejects(fetch(base));
        assert.equal(
          (await db.collection('_User').findOne({ _id: native.objectId })).normalizedEmail,
          before.normalizedEmail
        );
        // Verify the actual production entrypoint also exits unsuccessfully and
        // does not publish its readiness endpoint for the broken database.
        const child = spawn(process.execPath, ['index.js'], {
          cwd: path.resolve('.'),
          windowsHide: true,
          env: {
            ...process.env,
            ...env,
            MONGODB_URI: '',
            TESTING: '',
            PORT: new URL(base).port,
            SERVER_URL: `${base}/app`,
            PUBLIC_URL: base,
            USE_LOCAL: 'true',
            SMTP_ENABLE: 'false',
            MAILGUN_API_KEY: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk;
        });
        child.stderr.on('data', chunk => {
          output += chunk;
        });
        const timeout = setTimeout(() => child.kill(), 30000);
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
        clearTimeout(timeout);
        assert.equal(code, 1, output);
        assert.match(output, /E-Mail-Kollision/);
        await assert.rejects(fetch(base));
        await db.collection('_User').deleteOne({ _id: 'email-conflict' });
      });

      await t.test(
        'exclusive migration lock serializes workers and recovers expired leases',
        async () => {
          let active = 0,
            maximum = 0;
          const work = () =>
            migrationLock(
              db,
              async assertLock => {
                active++;
                maximum = Math.max(active, maximum);
                await new Promise(resolve => setTimeout(resolve, 40));
                await assertLock();
                active--;
              },
              { leaseMs: 120, pollMs: 5, waitMs: 1000 }
            );
          await Promise.all([work(), work()]);
          assert.equal(maximum, 1);
          await db
            .collection('_OpenSignMigrationLocks')
            .insertOne({ _id: 'startup', owner: 'crashed', expiresAt: new Date(0) });
          await work();
          assert.equal(await db.collection('_OpenSignMigrationLocks').countDocuments(), 0);
        }
      );
    } finally {
      await running?.close();
      await closeMfaDb();
      await client?.close();
      await cluster?.close();
      process.setMaxListeners(originalListenerLimit);
    }
  }
);
