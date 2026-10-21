import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import { ParseServer } from 'parse-server';
import { MongoCluster } from 'mongodb-runner';
import { mfaCollection, mfaDb, closeMfaDb } from '../utils/mfaStore.js';
import { totp } from '../utils/totpCrypto.js';
import SessionCache from '../utils/sessionCache.js';
import germanDefaultEmails from '../migrationdb/germanDefaultEmails.js';

test(
  'Parse + MongoDB: TOTP login, recovery, replay, throttling and administration',
  { timeout: 300000 },
  async t => {
    const root = path.resolve('.test-data');
    await fs.mkdir(root, { recursive: true });
    let cluster, server, listener;
    try {
      cluster = await MongoCluster.start({
        topology: 'standalone',
        version: '8.0.17',
        downloadDir: path.join(root, 'download'),
        tmpDir: root,
        logDir: root,
      });
      const databaseUrl = new URL(cluster.connectionString);
      databaseUrl.pathname = '/opensign_mfa_test';
      process.env.DATABASE_URI = databaseUrl.toString();
      process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
      const app = express();
      listener = app.listen(0, '127.0.0.1');
      await new Promise(resolve => listener.once('listening', resolve));
      const url = `http://127.0.0.1:${listener.address().port}/app`;
      process.env.SERVER_URL = url;
      server = new ParseServer({
        databaseURI: process.env.DATABASE_URI,
        appId: 'mfa-test',
        masterKey: 'test-master-key',
        serverURL: url,
        allowClientClassCreation: false,
        cacheAdapter: new SessionCache(),
        encodeParseObjectInCloudFunction: true,
        enableInsecureAuthAdapters: false,
        databaseOptions: { allowPublicExplain: false },
        logLevel: 'silent',
        logsFolder: null,
        cloud: () => import('../cloud/main.js'),
      });
      await server.start();
      app.use('/app', server.app);
      async function api(endpoint, body, token, master = false, method = 'POST', context) {
        const response = await fetch(url + endpoint, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Parse-Application-Id': 'mfa-test',
            ...(token ? { 'X-Parse-Session-Token': token } : {}),
            ...(master ? { 'X-Parse-Master-Key': 'test-master-key' } : {}),
            ...(context ? { 'X-Parse-Cloud-Context': JSON.stringify(context) } : {}),
          },
          ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}),
        });
        return { status: response.status, body: await response.json() };
      }
      const pointer = (className, objectId) => ({ __type: 'Pointer', className, objectId });
      const tenant = (await api('/classes/partners_Tenant', { TenantName: 'Test' }, null, true))
        .body.objectId;
      const tenant2 = (await api('/classes/partners_Tenant', { TenantName: 'Other' }, null, true))
        .body.objectId;
      const org = (
        await api(
          '/classes/contracts_Organizations',
          { Name: 'A', TenantId: pointer('partners_Tenant', tenant) },
          null,
          true
        )
      ).body.objectId;
      const org2 = (
        await api(
          '/classes/contracts_Organizations',
          { Name: 'B', TenantId: pointer('partners_Tenant', tenant) },
          null,
          true
        )
      ).body.objectId;
      async function user(email, role, tenantId = tenant, orgId = org) {
        const result = await api('/users', {
          username: email,
          email,
          password: 'Test-password-123!',
        });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const account = result.body;
        const ext = await api(
          '/classes/contracts_Users',
          {
            Name: email,
            Email: email,
            UserId: pointer('_User', account.objectId),
            UserRole: role,
            TenantId: pointer('partners_Tenant', tenantId),
            OrganizationId: pointer('contracts_Organizations', orgId),
            IsDisabled: false,
          },
          null,
          true
        );
        return { ...account, extId: ext.body.objectId, email };
      }
      const admin = await user('admin@example.test', 'contracts_Admin');
      const member = await user('member@example.test', 'contracts_User');
      const orgAdmin = await user('orgadmin@example.test', 'contracts_OrgAdmin');
      const other = await user('other@example.test', 'contracts_User', tenant2);
      const otherOrg = await user('otherorg@example.test', 'contracts_User', tenant, org2);
      const call = (name, body, token = member.sessionToken) =>
        api(`/functions/${name}`, body, token);
      const login = (mfaCode, email = member.email) =>
        api('/functions/loginuser', { email, password: 'Test-password-123!', mfaCode });
      let setup, codes;
      await t.test('secrets are private and setup must be confirmed', async () => {
        assert.equal((await call('mfaSetup', {}, null)).status, 400);
        setup = (await call('mfaSetup')).body.result;
        assert.match(setup.qrCode, /^data:image\/png;base64,/);
        assert.equal((await call('mfaEnable', { code: 'wrong' })).body.error, 'MFA_INVALID');
        assert.equal((await call('mfaStatus')).body.result.enabled, false);
        const result = await call('mfaEnable', {
          code: totp(setup.secret, Math.floor(Date.now() / 30000)),
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        codes = result.body.result.recoveryCodes;
        assert.equal(codes.length, 10);
        assert.equal((await call('mfaStatus')).body.result.enabled, true);
        assert.equal(
          (await api('/classes/_OpenSignMfa', null, member.sessionToken, false, 'GET')).status >=
            400,
          true
        );
      });
      await t.test('both Cloud login and direct REST login require second factor', async () => {
        assert.equal((await login()).body.error, 'MFA_REQUIRED');
        assert.equal(
          (await api('/login', { username: member.email, password: 'Test-password-123!' })).body
            .error,
          'MFA_REQUIRED'
        );
        const result = await login(codes[0]);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.ok(result.body.result.sessionToken);
        assert.equal((await login(codes[0])).body.error, 'MFA_INVALID');
      });
      await t.test('a TOTP code is accepted once even with concurrent requests', async () => {
        await (
          await mfaCollection()
        ).updateOne({ _id: member.objectId }, { $set: { lastCounter: 0, attempts: 0 } });
        const code = totp(setup.secret, Math.floor(Date.now() / 30000));
        const results = await Promise.all([login(code), login(code)]);
        assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results));
      });
      await t.test(
        'direct REST login accepts a second factor and never reveals MFA for wrong passwords',
        async () => {
          const result = await api(
            '/login',
            {
              username: member.email,
              password: 'Test-password-123!',
            },
            null,
            false,
            'POST',
            { mfaCode: codes[2] }
          );
          assert.equal(result.status, 200, result.body.error);
          assert.ok(result.body.sessionToken);
          const invalid = await api('/login', {
            username: member.email,
            password: 'wrong-password',
          });
          assert.notEqual(invalid.body.error, 'MFA_REQUIRED');
          assert.ok(invalid.status >= 400);
        }
      );
      await t.test('expired setup cannot enable 2FA', async () => {
        const pending = (await call('mfaSetup', {}, other.sessionToken)).body.result;
        await (
          await mfaCollection()
        ).updateOne(
          { _id: other.objectId },
          { $set: { pendingExpires: new Date(Date.now() - 1) } }
        );
        assert.equal(
          (
            await call(
              'mfaEnable',
              { code: totp(pending.secret, Math.floor(Date.now() / 30000)) },
              other.sessionToken
            )
          ).body.error,
          'MFA_SETUP_EXPIRED'
        );
      });
      await t.test('five invalid codes cause a timed lock', async () => {
        await (
          await mfaCollection()
        ).updateOne({ _id: member.objectId }, { $set: { attempts: 0 } });
        for (let i = 0; i < 5; i++)
          assert.equal((await login('invalid')).body.error, 'MFA_INVALID');
        assert.equal((await login(codes[1])).body.error, 'MFA_LOCKED');
        await (
          await mfaCollection()
        ).updateOne({ _id: member.objectId }, { $set: { lockedUntil: new Date(Date.now() - 1) } });
        assert.equal((await login(codes[1])).status, 200);
      });
      await t.test('user and organization boundaries are enforced on administration', async () => {
        assert.equal(
          (
            await api(
              `/classes/contracts_Users/${member.extId}`,
              { UserRole: 'contracts_Admin' },
              member.sessionToken,
              false,
              'PUT'
            )
          ).status,
          400
        );
        assert.equal(
          (
            await api(
              '/classes/contracts_Users',
              { UserRole: 'contracts_Admin', UserId: pointer('_User', member.objectId) },
              member.sessionToken
            )
          ).status,
          400
        );
        assert.equal((await call('adminOverview')).status, 400);
        const list = (await call('mfaAdminList', {}, admin.sessionToken)).body.result;
        assert.ok(list.some(u => u.userId === member.objectId));
        assert.ok(!list.some(u => u.userId === other.objectId));
        assert.equal(
          (
            await call(
              'adminSave',
              { kind: 'user', id: otherOrg.extId, role: 'contracts_User', disabled: true },
              orgAdmin.sessionToken
            )
          ).status,
          400
        );
        assert.equal(
          (await call('mfaAdminReset', { userId: member.objectId }, orgAdmin.sessionToken)).body
            .error,
          'MFA_ADMIN_ENROLL_REQUIRED'
        );
        assert.equal(
          (await call('adminSave', { kind: 'organization', name: 'New' }, orgAdmin.sessionToken))
            .status,
          400
        );
        assert.equal(
          (
            await call(
              'adminSave',
              { kind: 'team', name: 'Team B', organizationId: org },
              admin.sessionToken
            )
          ).status,
          200
        );
        assert.equal(
          (
            await call(
              'adminSave',
              { kind: 'user', id: other.extId, role: 'contracts_User', disabled: true },
              admin.sessionToken
            )
          ).status,
          400
        );
      });
      await t.test(
        'admin recovery revokes target sessions and records an audit event',
        async () => {
          const aSetup = (await call('mfaSetup', {}, admin.sessionToken)).body.result;
          const aCodes = (
            await call(
              'mfaEnable',
              { code: totp(aSetup.secret, Math.floor(Date.now() / 30000)) },
              admin.sessionToken
            )
          ).body.result.recoveryCodes;
          assert.equal(
            (
              await call(
                'mfaAdminReset',
                { userId: other.objectId, code: aCodes[0] },
                admin.sessionToken
              )
            ).status,
            400
          );
          const resetResult = await call(
            'mfaAdminReset',
            { userId: member.objectId, code: aCodes[0] },
            admin.sessionToken
          );
          assert.equal(resetResult.status, 200, resetResult.body.error);
          assert.ok((await call('mfaStatus')).status >= 400);
          assert.equal((await login()).status, 200);
          const events = await (
            await mfaDb()
          )
            .collection('_OpenSignSecurityAudit')
            .find({ action: 'mfa.adminReset' })
            .toArray();
          assert.equal(events.length, 1);
          assert.equal(events[0].target, member.objectId);
          const disabled = await call('mfaDisable', { code: aCodes[1] }, admin.sessionToken);
          assert.equal(disabled.status, 200, disabled.body.error);
          assert.equal(
            (await call('mfaStatus', {}, admin.sessionToken)).body.result.enabled,
            false
          );
        }
      );
      await t.test(
        'disabling users invalidates sessions and rejects subsequent login',
        async () => {
          assert.equal(
            (
              await call(
                'adminSave',
                { kind: 'user', id: member.extId, role: 'contracts_Editor', disabled: true },
                admin.sessionToken
              )
            ).status,
            200
          );
          assert.equal((await login()).body.error, 'Account disabled');
        }
      );
      await t.test(
        'stored default mail templates migrate with a backup and preserve custom text',
        async () => {
          const db = await mfaDb();
          const collection = db.collection('partners_Tenant');
          const original = '{{sender_name}} has requested you to sign {{document_title}}';
          const custom = '<p>Our individually configured company template.</p>';
          await collection.updateOne(
            { _id: tenant },
            { $set: { RequestSubject: original, RequestBody: custom } }
          );
          await germanDefaultEmails();
          const migrated = await collection.findOne({ _id: tenant });
          assert.equal(
            migrated.RequestSubject,
            '{{sender_name}} bittet Sie um die Unterzeichnung von {{document_title}}'
          );
          assert.equal(migrated.RequestBody, custom);
          const backup = await db
            .collection('_OpenSignMailMigrationBackup')
            .findOne({ _id: `partners_Tenant:${tenant}` });
          assert.equal(backup.originals.RequestSubject, original);
          await germanDefaultEmails();
          assert.equal(await db.collection('_OpenSignMailMigrationBackup').countDocuments(), 1);
        }
      );
    } finally {
      await server?.config?.databaseController?.adapter?.handleShutdown();
      await closeMfaDb();
      await new Promise(resolve => (listener ? listener.close(resolve) : resolve()));
      await cluster?.close();
    }
  }
);
