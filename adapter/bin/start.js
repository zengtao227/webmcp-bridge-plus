#!/usr/bin/env node
import { loadAdapterConfig, AdapterConfigError } from '../src/config.js';
import { resolveSecretRef, SecretRefError } from '../src/secrets.js';
import { createRedactor, createLogger } from '../src/redact.js';
import { DevSpaceOAuthClient } from '../src/oauth-client.js';
import { createAdapterServer } from '../src/server.js';

async function main() {
  let config;
  try {
    config = loadAdapterConfig(process.env);
  } catch (error) {
    if (error instanceof AdapterConfigError) {
      process.stderr.write(`adapter configuration error [${error.code}]: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  let ownerToken;
  try {
    ownerToken = await resolveSecretRef(config.ownerTokenRef);
  } catch (error) {
    if (error instanceof SecretRefError) {
      process.stderr.write(`adapter secret error [${error.code}]: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const redactor = createRedactor([ownerToken]);
  const log = createLogger({ redactor });

  const oauthClient = new DevSpaceOAuthClient({
    upstreamMcpUrl: config.upstreamMcpUrl,
    resource: config.oauthResource,
    ownerToken,
    clientName: config.clientName,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    refreshSkewSeconds: config.refreshSkewSeconds,
    log,
  });

  const server = createAdapterServer(config, { oauthClient, log });

  server.listen(config.listenPort, config.listenHost, () => {
    log('adapter_listening', {
      host: config.listenHost,
      port: config.listenPort,
      upstream: config.upstreamBaseUrl,
      mcpPath: config.mcpPath,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('adapter_stopping', { signal });
      server.close(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  process.stderr.write(`adapter fatal: ${error?.message ?? 'unknown'}\n`);
  process.exit(1);
});
