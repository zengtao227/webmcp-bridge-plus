import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildNativeImage } from '../native/deploy/build-image.js';
import {
  aggregateSourceDigest,
  NATIVE_RUNTIME_ENTRYPOINT,
  NATIVE_RUNTIME_PAYLOAD,
} from '../native/deploy/runtime-payload.js';

const LEGACY_SOURCE_SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const IMAGE_ID = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const BASE_IMAGE = 'node:22-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fixtureFiles() {
  return NATIVE_RUNTIME_PAYLOAD.map((relativePath) => {
    const bytes = Buffer.from(`fixture:${relativePath}\n`, 'utf8');
    return {
      path: relativePath,
      bytes,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

const RUNTIME_SOURCE_SHA256 = aggregateSourceDigest(fixtureFiles());

function fakeSource() {
  return {
    gitCommit: 'c'.repeat(40),
    // inspectSource's legacy snapshot digest intentionally includes file mode.
    // Native image identity must instead match build:native groupSha256.runtime.
    payloadSha256: LEGACY_SOURCE_SHA256,
    files: fixtureFiles(),
  };
}

test('Native image build uses only reviewed Git blobs and persists an image/source pin', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'webmcp-image-source-'));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'webmcp-image-state-'));
  const outputPin = path.join(stateRoot, 'native-image.json');
  let contextRoot = null;
  let cleanChecked = false;
  let inspectChecked = false;
  const calls = [];
  try {
    const result = await buildNativeImage({
      sourceRoot,
      baseImage: BASE_IMAGE,
      outputPin,
      tag: 'webmcp-native:test',
      assertCleanImpl: async (candidate) => {
        cleanChecked = true;
        assert.equal(candidate, sourceRoot);
      },
      inspectSourceImpl: async (options) => {
        inspectChecked = true;
        assert.equal(options.sourceRoot, sourceRoot);
        assert.deepEqual(options.payloadPaths, NATIVE_RUNTIME_PAYLOAD);
        assert.equal(options.entrypoint, NATIVE_RUNTIME_ENTRYPOINT);
        return fakeSource();
      },
      execFileImpl: async (command, args) => {
        calls.push([command, [...args]]);
        if (args[0] === 'build') {
          contextRoot = args.at(-1);
          assert.notEqual(contextRoot, sourceRoot, 'Docker must not receive the whole repository as build context');
          const workspaceSource = path.join(contextRoot, 'native', 'src', 'workspace.js');
          assert.equal(
            await readFile(workspaceSource, 'utf8'),
            'fixture:native/src/workspace.js\n',
          );
          assert.equal((await stat(workspaceSource)).mode & 0o777, 0o644);
          assert.ok(args.includes(`WEBMCP_NODE_IMAGE=${BASE_IMAGE}`));
          assert.ok(args.includes(`WEBMCP_SOURCE_SHA256=${RUNTIME_SOURCE_SHA256}`));
          return { stdout: 'built', stderr: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            stdout: JSON.stringify([{
              Id: IMAGE_ID,
              Config: {
                User: '65532:65532',
                Labels: { 'com.webmcp.native.source-sha256': RUNTIME_SOURCE_SHA256 },
              },
            }]),
            stderr: '',
          };
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.equal(cleanChecked, true);
    assert.equal(inspectChecked, true);
    assert.equal(result.image, IMAGE_ID);
    assert.equal(result.sourceSha256, RUNTIME_SOURCE_SHA256);
    const saved = JSON.parse(await readFile(outputPin, 'utf8'));
    assert.deepEqual(saved, {
      version: 2,
      image: IMAGE_ID,
      sourceSha256: RUNTIME_SOURCE_SHA256,
    });
    assert.equal(calls.filter(([, args]) => args[0] === 'build').length, 1);
    await assert.rejects(access(contextRoot), /ENOENT/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('Native image build refuses a mismatched source label and does not publish a pin', async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'webmcp-image-source-'));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'webmcp-image-state-'));
  const outputPin = path.join(stateRoot, 'native-image.json');
  try {
    await assert.rejects(buildNativeImage({
      sourceRoot,
      baseImage: BASE_IMAGE,
      outputPin,
      assertCleanImpl: async () => {},
      inspectSourceImpl: async () => fakeSource(),
      execFileImpl: async (_command, args) => {
        if (args[0] === 'build') return { stdout: 'built', stderr: '' };
        return {
          stdout: JSON.stringify([{
            Id: IMAGE_ID,
            Config: {
              User: '65532:65532',
              Labels: { 'com.webmcp.native.source-sha256': 'e'.repeat(64) },
            },
          }]),
          stderr: '',
        };
      },
    }), /source label does not match/);
    await assert.rejects(readFile(outputPin, 'utf8'));
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});
