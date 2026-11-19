import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { MongoCluster } from 'mongodb-runner';
import { totp } from '../utils/totpCrypto.js';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function schemaDefinitions(rows) {
  return rows.map(row => {
    const copy = structuredClone(row);
    // Parse refreshes this cache from MongoDB on restart. Check the actual
    // MongoDB index definitions separately, together with fields and permissions.
    if (copy._metadata) {
      delete copy._metadata.indexes;
      if (!Object.keys(copy._metadata).length) delete copy._metadata;
    }
    return copy;
  });
}

const baselineVersion = process.env.OPENSIGN_UPGRADE_VERSION || '3.1.0';
const targetVersion = '3.1.1';

test(
  `upgrade the released on-premise ${baselineVersion} database with the actual ${targetVersion} server`,
  { timeout: 240000 },
  async t => {
    const previous = path.resolve(
      process.env.OPENSIGN_UPGRADE_FROM || '../../../OpenSign-3.1.0/apps/OpenSignServer'
    );
    assert.notEqual(
      previous,
      path.resolve('.'),
      `The baseline must be the separate released ${baselineVersion} source`
    );
    await fs.access(path.join(previous, 'index.js'));
    const root = path.resolve('.test-data');
    await fs.mkdir(root, { recursive: true });
    let cluster, mongo, running;
    const masterKey = crypto.randomBytes(32).toString('hex');
    const encryptionKey = crypto.randomBytes(32).toString('hex');
    const appId = 'opensign-upgrade-test';
    let db, databaseUri, base;

    async function stop() {
      if (running && running.exitCode === null && running.signalCode === null) {
        const exited = once(running, 'exit');
        running.kill();
        await exited;
      }
      running = undefined;
    }

    async function boot(directory, key = encryptionKey, failure = false) {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['index.js'], {
        cwd: directory,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DATABASE_URI: databaseUri,
          MONGODB_URI: '',
          MASTER_KEY: masterKey,
          TOTP_ENCRYPTION_KEY: key,
          APP_ID: appId,
          TESTING: '',
          PORT: String(port),
          PARSE_MOUNT: '/app',
          SERVER_URL: `${base}/app`,
          INTERNAL_SERVER_URL: `${base}/app`,
          PUBLIC_URL: base,
          USE_LOCAL: 'true',
          SMTP_ENABLE: 'false',
          MAILGUN_API_KEY: '',
        },
      });
      running = child;
      let output = '';
      child.stdout.on('data', chunk => {
        output = (output + chunk).slice(-12000);
      });
      child.stderr.on('data', chunk => {
        output = (output + chunk).slice(-12000);
      });
      let spawnError;
      child.on('error', error => {
        spawnError = error;
      });
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) {
          assert.equal(failure, true, output);
          assert.equal(child.exitCode, 1, output);
          assert.match(output, /Migrationsfehlers/);
          await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1000) }));
          return;
        }
        let ready = false;
        try {
          const response = await fetch(base, { signal: AbortSignal.timeout(500) });
          ready = response.ok;
        } catch {}
        if (ready) {
          assert.equal(failure, false, 'Server must remain unavailable after a failed migration');
          return;
        }
        await delay(100);
      }
      throw new Error(`Server did not finish startup: ${output}`);
    }

    async function api(endpoint, body, token, master = false, method = 'POST') {
      const response = await fetch(`${base}/app${endpoint}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Parse-Application-Id': appId,
          ...(token ? { 'X-Parse-Session-Token': token } : {}),
          ...(master ? { 'X-Parse-Master-Key': masterKey } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
        signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    }
    const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });
    const call = (name, body, token) => api(`/functions/${name}`, body, token);
    let admin,
      member,
      setup,
      recoveryCodes,
      beforeMfa,
      originalDocument,
      originalTemplate,
      schemaMarkers,
      schemaDocuments,
      upgradedSchemaMarkers,
      originalIndexes;
    try {
      cluster = await MongoCluster.start({
        topology: 'standalone',
        version: '8.0.17',
        downloadDir: path.join(root, 'download'),
        tmpDir: root,
        logDir: root,
      });
      const url = new URL(cluster.connectionString);
      url.pathname = '/opensign_released_upgrade_test';
      databaseUri = url.toString();
      mongo = new MongoClient(databaseUri);
      await mongo.connect();
      db = mongo.db();

      await t.test(
        `create real accounts, MFA, administration and content with the released ${baselineVersion} process`,
        async () => {
          await boot(previous);
          const tenantId = (
            await api(
              '/classes/partners_Tenant',
              {
                TenantName: 'Upgrade test',
                RequestBody: '<p>Unsere individuelle deutsche Einladung {{document_title}}</p>',
              },
              null,
              true
            )
          ).body.objectId;
          const orgId = (
            await api(
              '/classes/contracts_Organizations',
              { Name: 'Upgrade organization', TenantId: pointer('partners_Tenant', tenantId) },
              null,
              true
            )
          ).body.objectId;
          async function account(email, role) {
            const created = await api('/users', {
              username: email,
              email,
              password: 'Upgrade-password-123!',
            });
            assert.equal(created.status, 201, JSON.stringify(created.body));
            const user = created.body;
            const profile = await api(
              '/classes/contracts_Users',
              {
                Name: email,
                Email: email,
                UserId: pointer('_User', user.objectId),
                TenantId: pointer('partners_Tenant', tenantId),
                OrganizationId: pointer('contracts_Organizations', orgId),
                UserRole: role,
                ACL: { [user.objectId]: { read: true, write: true } },
                TourStatus: [{ loginTour: true }, { templateReport: true }],
              },
              null,
              true
            );
            assert.equal(profile.status, 201, JSON.stringify(profile.body));
            return { ...user, email, profileId: profile.body.objectId };
          }
          admin = await account('upgrade-admin@example.test', 'contracts_Admin');
          member = await account('upgrade-member@example.test', 'contracts_User');
          setup = (await call('mfaSetup', {}, member.sessionToken)).body.result;
          assert.ok(setup.secret);
          const enabled = await call(
            'mfaEnable',
            { code: totp(setup.secret, Math.floor(Date.now() / 30000)) },
            member.sessionToken
          );
          assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
          recoveryCodes = enabled.body.result.recoveryCodes;
          beforeMfa = await db.collection('_OpenSignMfa').findOne({ _id: member.objectId });
          originalDocument = {
            _id: 'upgrade-document',
            Name: 'Bestandsdokument',
            URL: 'https://example.test/existing.pdf',
            Placeholders: [
              {
                Id: 'signer',
                placeHolder: [
                  {
                    pageNumber: 1,
                    pos: [
                      { key: 'signature-one', type: 'signature', xPosition: 20, yPosition: 45 },
                    ],
                  },
                ],
              },
            ],
            RequestBody: '<p>Individueller Text</p>',
            _p_ExtUserPtr: `contracts_Users$${member.profileId}`,
          };
          originalTemplate = {
            ...originalDocument,
            _id: 'upgrade-template',
            Name: 'Bestehende Vorlage',
          };
          await db.collection('contracts_Document').insertOne(originalDocument);
          await db.collection('contracts_Template').insertOne(originalTemplate);
          schemaMarkers = await db
            .collection('_OpenSignStartupMigrations')
            .find({ _id: /^schemas:/ })
            .toArray();
          assert.equal(schemaMarkers.length, 1);
          schemaDocuments = await db.collection('_SCHEMA').find({}).sort({ _id: 1 }).toArray();
          originalIndexes = {};
          for (const collection of [
            '_User',
            'contracts_Contactbook',
            'contracts_Document',
            'OpenSign_MFA',
            'OpenSign_MFAChallenge',
          ]) {
            originalIndexes[collection] = await db.collection(collection).listIndexes().toArray();
          }
          assert.equal((await call('adminOverview', {}, admin.sessionToken)).status, 200);
          await stop();
        }
      );

      await t.test(
        `a wrong key stops the ${targetVersion} process and leaves the existing MFA data untouched`,
        async () => {
          await boot(path.resolve('.'), 'ff'.repeat(32), true);
          assert.deepEqual(
            await db.collection('_OpenSignMfa').findOne({ _id: member.objectId }),
            beforeMfa
          );
          await stop();
        }
      );

      await t.test(
        `${targetVersion} starts against the ${baselineVersion} database and preserves documents, templates, roles and tour status`,
        async () => {
          await boot(path.resolve('.'));
          assert.deepEqual(
            await db.collection('contracts_Document').findOne({ _id: originalDocument._id }),
            originalDocument
          );
          assert.deepEqual(
            await db.collection('contracts_Template').findOne({ _id: originalTemplate._id }),
            originalTemplate
          );
          assert.deepEqual(
            await db.collection('_OpenSignMfa').findOne({ _id: member.objectId }),
            beforeMfa
          );
          upgradedSchemaMarkers = await db
            .collection('_OpenSignStartupMigrations')
            .find({ _id: /^schemas:/ })
            .sort({ _id: 1 })
            .toArray();
          // The original Windows source and Git/Linux archives can have different
          // line endings and therefore different source fingerprints. An idempotent
          // reconciliation is allowed; existing journals and schema data must survive.
          for (const marker of schemaMarkers) {
            assert.deepEqual(
              upgradedSchemaMarkers.find(row => row._id === marker._id),
              marker
            );
          }
          assert.deepEqual(
            schemaDefinitions(await db.collection('_SCHEMA').find({}).sort({ _id: 1 }).toArray()),
            schemaDefinitions(schemaDocuments)
          );
          for (const [collection, indexes] of Object.entries(originalIndexes)) {
            assert.deepEqual(await db.collection(collection).listIndexes().toArray(), indexes);
          }
          const profile = (await call('getUserDetails', {}, member.sessionToken)).body.result;
          assert.deepEqual(profile.TourStatus, [{ loginTour: true }, { templateReport: true }]);
          const overview = await call('adminOverview', {}, admin.sessionToken);
          assert.equal(overview.status, 200, JSON.stringify(overview.body));
          assert.equal(overview.body.result.users.length, 2);
          assert.ok((await call('adminOverview', {}, member.sessionToken)).status >= 400);
          assert.match(
            (await db.collection('partners_Tenant').findOne({})).RequestBody,
            /individuelle deutsche Einladung/
          );
        }
      );

      await t.test(
        'existing TOTP and one-time recovery codes still work and password-only login stays blocked',
        async () => {
          const login = code =>
            call('loginuser', {
              email: member.email,
              password: 'Upgrade-password-123!',
              mfaCode: code,
            });
          assert.equal((await login()).body.error, 'MFA_REQUIRED');
          assert.equal(
            (await login(totp(setup.secret, Math.floor(Date.now() / 30000) + 1))).status,
            200
          );
          assert.equal((await login(recoveryCodes[0])).status, 200);
          assert.equal((await login(recoveryCodes[0])).body.error, 'MFA_INVALID');
          await stop();
          await boot(path.resolve('.'));
          assert.deepEqual(
            await db
              .collection('_OpenSignStartupMigrations')
              .find({ _id: /^schemas:/ })
              .sort({ _id: 1 })
              .toArray(),
            upgradedSchemaMarkers
          );
          assert.equal((await login(recoveryCodes[0])).body.error, 'MFA_INVALID');
          assert.equal((await login(recoveryCodes[1])).status, 200);
          assert.deepEqual(
            await db.collection('contracts_Document').findOne({ _id: originalDocument._id }),
            originalDocument
          );
          assert.equal(
            (await db.collection('_OpenSignMfa').findOne({ _id: member.objectId })).recovery.length,
            recoveryCodes.length - 2
          );
        }
      );
    } finally {
      await stop();
      await mongo?.close();
      await cluster?.close();
    }
  }
);
