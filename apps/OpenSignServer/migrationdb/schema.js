/* eslint-disable no-await-in-loop */
// Migration phases, backups, and lease checks deliberately execute in order.
import Parse from 'parse/node';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const closedClp = Object.fromEntries(
  ['get', 'find', 'count', 'create', 'update', 'delete', 'addField'].map(name => [name, {}])
);

// Schema operations use a private loopback listener and a master key. The public
// listener and the SDK's application URL remain untouched until migration ends.
export function schemaApi({ url, appId, masterKey, db, assertLock, revision = 'startup' }) {
  async function request(className, method, body) {
    await assertLock();
    const response = await fetch(`${url}/schemas/${encodeURIComponent(className)}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': appId,
        'X-Parse-Master-Key': masterKey,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok && !(method === 'GET' && result.code === 103))
      throw new Error(`Schema ${className}: ${result.error || response.status}`);
    return response.ok ? result : null;
  }
  class MigrationSchema extends Parse.Schema {
    async save() {
      return this.apply();
    }
    async update() {
      return this.apply();
    }
    async get() {
      return request(this.className, 'GET');
    }
    async apply() {
      const existing = await request(this.className, 'GET');
      const fields = {};
      for (const [name, definition] of Object.entries(this._fields)) {
        if (definition.__op === 'Delete')
          throw new Error(`Destruktive Feldänderung verweigert: ${this.className}.${name}`);
        const old = existing?.fields?.[name];
        if (
          old &&
          (old.type !== definition.type ||
            (old.targetClass && old.targetClass !== definition.targetClass))
        )
          throw new Error(`Unvereinbarer Feldtyp: ${this.className}.${name}`);
        if (!old) fields[name] = definition;
      }
      const indexes = {};
      for (const [name, definition] of Object.entries(this._indexes)) {
        const old = existing?.indexes?.[name];
        if (old && JSON.stringify(old) !== JSON.stringify(definition))
          throw new Error(`Unvereinbarer Index: ${this.className}.${name}`);
        if (!old) indexes[name] = definition;
      }
      const permissionsChanged =
        this._clp && JSON.stringify(existing?.classLevelPermissions) !== JSON.stringify(this._clp);
      if (
        !existing ||
        Object.keys(fields).length ||
        Object.keys(indexes).length ||
        permissionsChanged
      ) {
        await db.collection('_OpenSignMigrationBackup').updateOne(
          { _id: `schema:${revision}:${this.className}` },
          {
            $setOnInsert: {
              kind: 'schema',
              className: this.className,
              original: existing,
              at: new Date(),
            },
          },
          { upsert: true }
        );
        await request(this.className, existing ? 'PUT' : 'POST', {
          className: this.className,
          fields,
          indexes,
          ...(this._clp ? { classLevelPermissions: this._clp } : {}),
        });
      }
      this._fields = {};
      this._indexes = {};
    }
  }
  return { Schema: MigrationSchema };
}

export async function historicalSchemas(options) {
  const directory = new URL('../databases/migrations/', import.meta.url);
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.cjs')).sort();
  const hash = crypto.createHash('sha256').update('idempotent-schemas-v1');
  for (const file of files) hash.update(file).update(await fs.readFile(new URL(file, directory)));
  const revision = hash.digest('hex');
  const journal = options.db.collection('_OpenSignStartupMigrations');
  if (await journal.findOne({ _id: `schemas:${revision}` })) return;
  const api = schemaApi({ ...options, revision });
  for (const file of files) {
    await options.assertLock();
    const migration = require(fileURLToPath(new URL(file, directory)));
    try {
      await migration.up(api);
    } catch (error) {
      throw new Error(`Schemamigration ${file} fehlgeschlagen: ${error.message}`);
    }
    await options.db.collection('Migration').updateOne(
      { name: file },
      {
        $setOnInsert: {
          _id: crypto.randomUUID(),
          name: file,
          _created_at: new Date(),
          _updated_at: new Date(),
        },
      },
      { upsert: true }
    );
  }
  await journal.insertOne({ _id: `schemas:${revision}`, completedAt: new Date() });
}

export async function protectMigrationSchemas(options) {
  const api = schemaApi(options);
  const definitions = {
    Migration: { name: 'String' },
    Migrationdb: { name: 'String', executedAt: 'Date', details: 'String' },
    OpenSign_MFA: {
      User: 'Pointer',
      Secret: 'String',
      PendingSecret: 'String',
      Enabled: 'Boolean',
      RecoveryCodeHashes: 'Array',
      LastUsedTotpStep: 'Number',
      PendingExpiresAt: 'Date',
    },
    OpenSign_MFAChallenge: {
      User: 'Pointer',
      SessionToken: 'String',
      ExpiresAt: 'Date',
      Attempts: 'Number',
    },
  };
  for (const [name, fields] of Object.entries(definitions)) {
    const schema = new api.Schema(name);
    for (const [field, type] of Object.entries(fields)) {
      if (type === 'Pointer') schema.addPointer(field, '_User');
      else schema[`add${type}`](field);
    }
    schema.setCLP(closedClp);
    await schema.update();
  }
}
