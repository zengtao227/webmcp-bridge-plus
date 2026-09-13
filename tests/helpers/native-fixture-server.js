import { createNativeMcpServer } from '../../native/src/server.js';
import { createNativeStdioServer } from '../../native/src/stdio.js';
import { createWorkspaceRuntime } from '../../native/src/workspace.js';

const root = process.argv[2];
if (!root) {
  throw new Error('fixture workspace root is required');
}

const runtime = createWorkspaceRuntime({ root, runtimeToken: 'fixture-runtime' });
const server = createNativeMcpServer(runtime, { serverVersion: 'fixture' });
createNativeStdioServer(server).start();
