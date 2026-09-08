#!/usr/bin/env node
// Adapter entrypoint.
//
// Transport selection is the security decision, so it lives here and nowhere
// else:
//
//   stdio (default)  tunnel-client spawns us and speaks MCP over stdin/stdout.
//                    There is no port and no socket, so no other local process
//                    can reach the adapter at all.
//   unix             0600 socket created under a restrictive umask. Filesystem
//                    permissions are the boundary.
//   http             Loopback TCP. Requires a bearer token, because loopback is
//                    not identity: every process on this machine can reach a
//                    loopback port. Missing token means we refuse to start.

import { unlink, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadAdapterConfig, AdapterConfigError } from '../src/config.js';
import { resolveSecretRef, SecretRefError } from '../src/secrets.js';
import { createRedactor, createLogger } from '../src/redact.js';
import { DevSpaceOAuthClient } from '../src/oauth-client.js';
import { createAdapterCore } from '../src/core.js';
import { createStdioAdapter } from '../src/stdio.js';
import { createAdapterServer, createTokenVerifier } from '../src/server.js';

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Bind a Unix socket that is 0600 from the instant it exists.
 *
 * chmod after listen is not enough: between bind and chmod the socket is
 * reachable with the default mode. Tightening the umask around the bind closes
 * that window.
 */
async function listenUnix(server, socketPath, log) {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    await unlink(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const previousUmask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } finally {
    process.umask(previousUmask);
  }
  await chmod(socketPath, 0o600);
  return server;
}

async function main() {
  let config;
  try {
    config = loadAdapterConfig(process.env);
  } catch (error) {
    if (error instanceof AdapterConfigError) {
      fail(2, `adapter configuration error [${error.code}]: ${error.message}`);
    }
    throw error;
  }

  let ownerToken;
  try {
    ownerToken = await resolveSecretRef(config.ownerTokenRef);
  } catch (error) {
    if (error instanceof SecretRefError) {
      fail(2, `adapter secret error [${error.code}]: ${error.message}`);
    }
    throw error;
  }

  const redactor = createRedactor([ownerToken]);
  // stdout is the MCP wire in stdio mode. A single log line there corrupts the
  // protocol, so diagnostics must use stderr for this transport.
  const log = createLogger({
    redactor,
    write: config.transport === 'stdio'
      ? (line) => process.stderr.write(`${line}\n`)
      : undefined,
  });

  const oauthClient = new DevSpaceOAuthClient({
    upstreamMcpUrl: config.upstreamMcpUrl,
    resource: config.oauthResource,
    ownerToken,
    clientName: config.clientName,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    refreshSkewSeconds: config.refreshSkewSeconds,
    timeoutMs: config.oauthTimeoutMs,
    log,
  });

  const core = createAdapterCore(config, { oauthClient, log });

  if (config.transport === 'stdio') {
    const stdio = createStdioAdapter(core, config, { log });
    const handle = stdio.start();

    const stop = () => {
      log('adapter_stopping', { transport: 'stdio' });
      handle.close().finally(() => process.exit(0));
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, stop);
    }
    return;
  }

  let verifyToken = null;
  let requireToken = false;
  if (config.transport === 'http') {
    let httpToken;
    try {
      httpToken = await resolveSecretRef(config.httpTokenRef);
    } catch (error) {
      if (error instanceof SecretRefError) {
        fail(2, `adapter secret error [${error.code}]: ${error.message}`);
      }
      throw error;
    }
    redactor.addSecret(httpToken);
    verifyToken = createTokenVerifier(httpToken);
    requireToken = true;
  }

  const server = createAdapterServer(core, config, { log, verifyToken, requireToken });

  if (config.transport === 'unix') {
    await listenUnix(server, config.socketPath, log);
    log('adapter_listening', {
      transport: 'unix',
      socket: config.socketPath,
      mode: '0600',
      upstream: config.upstreamBaseUrl,
      mcpPath: config.mcpPath,
    });
  } else {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.listenPort, config.listenHost, resolve);
    });
    log('adapter_listening', {
      transport: 'http',
      host: config.listenHost,
      port: config.listenPort,
      tokenRequired: true,
      upstream: config.upstreamBaseUrl,
      mcpPath: config.mcpPath,
    });
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('adapter_stopping', { transport: config.transport });
      server.close(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  process.stderr.write(`adapter fatal: ${error?.message ?? 'unknown'}\n`);
  process.exit(1);
});
