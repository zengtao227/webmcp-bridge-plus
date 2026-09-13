import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'native', 'menubar', 'main.swift');
const PLIST_PATH = path.join(REPO_ROOT, 'native', 'menubar', 'Info.plist');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-menubar.sh');
const TEST_SCRIPT = path.join(REPO_ROOT, 'scripts', 'test-menubar.sh');

test('Menu Bar controller is a thin native AppKit surface over the immutable elevation CLI', async () => {
  const source = await readFile(SOURCE_PATH, 'utf8');

  assert.match(source, /NSStatusBar\.system\.statusItem/);
  assert.match(source, /NSOpenPanel\(\)/);
  assert.match(source, /\.local\/share\/webmcp\/host-runtime\/current\/native\/deploy\/installer\.js/);
  assert.match(source, /\["elevate-status"\]/);
  assert.match(source, /\["elevate-stop"\]/);
  assert.match(source, /"elevate"/);
  assert.doesNotMatch(source, /auth\.json|runtime-api-key|tunnel-client\s+runtimes|docker\s+/i);
});

test('Menu Bar UX exposes broad home access, folder selection, bounded duration, and one-click revoke', async () => {
  const source = await readFile(SOURCE_PATH, 'utf8');

  assert.match(source, /Grant Full Working Access/);
  assert.match(source, /beginElevation\(root: client\.home\)/);
  assert.match(source, /Choose Folder…/);
  assert.match(source, /30 minutes/);
  assert.match(source, /1 hour/);
  assert.match(source, /minimumDurationMinutes = 1/);
  assert.match(source, /maximumDurationMinutes = 60/);
  assert.match(source, /Stop Elevated Access/);
  assert.match(source, /\.withFractionalSeconds/);
  assert.match(source, /Applications\/Docker\.app\/Contents\/Resources\/bin/);
  assert.match(source, /environment\["PATH"\] = hostPath\(environment: environment\)/);
  assert.match(source, /self\.showLocalError\(error\.localizedDescription\)/);
});

test('Menu Bar Launch at Login uses only native ServiceManagement and exposes approval state', async () => {
  const [source, buildScript] = await Promise.all([
    readFile(SOURCE_PATH, 'utf8'),
    readFile(BUILD_SCRIPT, 'utf8'),
  ]);

  assert.match(source, /import ServiceManagement/);
  assert.match(source, /Launch at Login/);
  assert.match(source, /SMAppService\.mainApp/);
  assert.match(source, /service\.register\(\)/);
  assert.match(source, /service\.unregister\(\)/);
  assert.match(source, /SMAppService\.openSystemSettingsLoginItems\(\)/);
  assert.match(source, /case \.requiresApproval:/);
  assert.match(buildScript, /-framework ServiceManagement/);
  assert.doesNotMatch(source, /LaunchAgent|launchctl|SMLoginItemSetEnabled/);
});

test('Menu Bar app stays accessory-only and macOS-local with executable build/self-test scripts', async () => {
  const [plist, testScript, buildInfo, testInfo] = await Promise.all([
    readFile(PLIST_PATH, 'utf8'),
    readFile(TEST_SCRIPT, 'utf8'),
    stat(BUILD_SCRIPT),
    stat(TEST_SCRIPT),
  ]);

  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(plist, /<string>13\.0<\/string>/);
  assert.match(testScript, /APP_DIR="\$\("\$ROOT\/scripts\/build-menubar\.sh"\)"/);
  assert.notEqual(buildInfo.mode & 0o111, 0);
  assert.notEqual(testInfo.mode & 0o111, 0);
});
