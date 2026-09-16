#!/usr/bin/env node
import { lstat } from 'node:fs/promises';
import { createHostRelay } from './relay.js';
import { respondUnavailable } from './unavailable-responder.js';
import {
  ensureNativeContainer,
  removeStaleElevatedContainer,
} from '../deploy/container-controller.js';
import {
  buildElevatedWorkspaceConfig,
  clearElevatedLease,
  defaultElevatedLeasePath,
  getBootSessionId,
  getLoginSessionId,
  loadElevatedLease,
} from '../deploy/elevated-access.js';
import { DEFAULT_IMAGE_PIN } from '../deploy/image-pin.js';
import { DEFAULT_WORKSPACE_CONFIG, loadWorkspaceConfig } from '../deploy/workspace-config.js';

const configPath = process.env.WEBMCP_WORKSPACE_CONFIG ?? DEFAULT_WORKSPACE_CONFIG;
const imagePinPath = process.env.WEBMCP_NATIVE_IMAGE_PIN ?? DEFAULT_IMAGE_PIN;
const leasePath = process.env.WEBMCP_ELEVATED_LEASE ?? defaultElevatedLeasePath();
const containerOptions = {
  configPath,
  imagePinPath,
  gitCredentialPath: process.env.WEBMCP_GIT_CREDENTIAL || null,
  gitKnownHostsPath: process.env.WEBMCP_GIT_KNOWN_HOSTS || null,
};

let relayControl = null;
let expiryTimer = null;
let reverting = false;

function safeDiagnostic(message) {
  process.stderr.write(`${String(message).replace(/[\r\n]+/g, ' ')}\n`);
}

try {
  const normalConfig = await loadWorkspaceConfig(configPath);
  let leasePresent = true;
  try {
    await lstat(leasePath);
  } catch (error) {
    if (error?.code === 'ENOENT') leasePresent = false;
    else throw error;
  }

  let leaseState = Object.freeze({ state: 'absent' });
  if (leasePresent) {
    const bootSessionId = await getBootSessionId();
    const loginSessionId = await getLoginSessionId();
    leaseState = await loadElevatedLease(leasePath, {
      normalConfig,
      bootSessionId,
      loginSessionId,
    });
  }

  if (leaseState.state !== 'active') {
    // A missing, stale, rebooted, expired or malformed lease can never preserve
    // an elevated mount. A positively identified temporary container is removed
    // before the normal policy is ensured; ambiguous container state still fails closed.
    await removeStaleElevatedContainer({ imagePinPath });
    if (leaseState.state !== 'absent') {
      await clearElevatedLease(leasePath);
    }
    await ensureNativeContainer(containerOptions);
    relayControl = createHostRelay().start();
  } else {
    const elevatedConfig = buildElevatedWorkspaceConfig(normalConfig, leaseState.lease.elevatedRoot);
    await ensureNativeContainer({
      ...containerOptions,
      workspaceConfig: elevatedConfig,
      gitCredentialPath: null,
      gitKnownHostsPath: null,
      elevationLeaseId: leaseState.lease.id,
    });

    const restoreNormal = async (reason) => {
      if (reverting) return;
      reverting = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      await relayControl?.close();
      try {
        // Invalidate authority before container cleanup. If later cleanup fails,
        // a restarted host boundary sees no valid lease and cannot re-expose it.
        await clearElevatedLease(leasePath);
        await removeStaleElevatedContainer({
          imagePinPath,
          expectedLeaseId: leaseState.lease.id,
        });
        await ensureNativeContainer(containerOptions);
        relayControl = createHostRelay().start();
        safeDiagnostic(`Temporary elevated access ended: ${reason}. Normal /workspace policy restored.`);
      } catch (error) {
        safeDiagnostic(`Temporary elevated access failed closed during restore: ${error.message}`);
        process.exitCode = 1;
      }
    };

    const delay = Math.max(0, leaseState.lease.expiresAt - Date.now());
    expiryTimer = setTimeout(() => {
      void restoreNormal('absolute lease expiry');
    }, delay);
    expiryTimer.unref?.();

    relayControl = createHostRelay({
      deadlineAt: leaseState.lease.expiresAt,
      onDeadline: () => { void restoreNormal('absolute lease expiry'); },
    }).start();
  }
} catch (error) {
  safeDiagnostic(`Native WebMCP host boundary failed: ${error.message}`);
  process.exitCode = 1;
  respondUnavailable(error.message);
}
