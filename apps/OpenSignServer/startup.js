import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { ParseServer } from 'parse-server';
import runDbMigrations from './migrationdb/index.js';
import { databaseUri } from './utils/databaseConfig.js';

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
const close = server =>
  new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));

export async function startServer({
  config,
  app,
  port = 8080,
  host = '0.0.0.0',
  mountPath = '/app',
  env = process.env,
  migrate = runDbMigrations,
}) {
  const uri = databaseUri(env);
  if (!config.masterKey || config.databaseURI !== uri)
    throw new Error(
      'Server und Migration müssen dieselbe Datenbank und einen Master-Key verwenden.'
    );
  let parseServer, privateListener;
  const httpServer = http.createServer(app);
  httpServer.keepAliveTimeout = 100000;
  httpServer.headersTimeout = 100000;
  try {
    await migrate({
      appId: config.appId,
      masterKey: config.masterKey,
      env,
      prepareSchemaServer: async () => {
        parseServer = new ParseServer(config);
        await parseServer.start();
        const privateApp = express();
        privateApp.use((req, res, next) => {
          const supplied = Buffer.from(String(req.headers['x-parse-master-key'] || ''));
          const expected = Buffer.from(config.masterKey);
          if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
            return res.sendStatus(403);
          next();
        });
        privateApp.use(mountPath, parseServer.app);
        privateListener = http.createServer(privateApp);
        await listen(privateListener, 0, '127.0.0.1');
        return {
          url: `http://127.0.0.1:${privateListener.address().port}${mountPath}`,
          close: async () => {
            await close(privateListener);
            privateListener = undefined;
          },
        };
      },
    });
    if (!parseServer) throw new Error('Migrationsablauf hat keinen Parse-Server initialisiert.');
    app.use(mountPath, parseServer.app);
    // No public port, health check, or application route is reachable before this line.
    await listen(httpServer, port, host);
    parseServer.server = httpServer;
    return { httpServer, parseServer, close: () => parseServer.handleShutdown() };
  } catch (error) {
    if (privateListener?.listening) await close(privateListener);
    if (httpServer.listening) await close(httpServer);
    await parseServer?.config?.databaseController?.adapter?.handleShutdown();
    throw error;
  }
}
