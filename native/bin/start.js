#!/usr/bin/env node
import { createNativeMcpServer } from '../src/server.js';
import { createNativeStdioServer } from '../src/stdio.js';
import { createWorkspaceRuntime, NATIVE_WORKSPACE_ROOT } from '../src/workspace.js';

const runtime = createWorkspaceRuntime({ root: NATIVE_WORKSPACE_ROOT });
const server = createNativeMcpServer(runtime);
const stdio = createNativeStdioServer(server);

stdio.start();
