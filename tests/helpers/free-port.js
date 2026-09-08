import { createServer } from 'node:net';

/**
 * Reserve an ephemeral loopback port for tests that must feed a *real* port
 * through configuration. `ADAPTER_PORT: '0'` is rejected on purpose: an
 * ephemeral bind is never a valid production configuration.
 */
export function reserveLoopbackPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
