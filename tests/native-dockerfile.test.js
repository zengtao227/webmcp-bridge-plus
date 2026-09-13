import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dockerfile = await readFile(new URL('../native/Dockerfile', import.meta.url), 'utf8');

test('Native Dockerfile requires immutable build inputs and records the reviewed source digest', () => {
  assert.match(dockerfile, /^ARG WEBMCP_NODE_IMAGE$/m);
  assert.match(dockerfile, /^FROM \$\{WEBMCP_NODE_IMAGE\}$/m);
  assert.match(dockerfile, /^ARG WEBMCP_SOURCE_SHA256$/m);
  assert.match(dockerfile, /^LABEL com\.webmcp\.native\.source-sha256="\$\{WEBMCP_SOURCE_SHA256\}"$/m);
  assert.doesNotMatch(dockerfile, /^FROM\s+node:[^$]/m);
});

test('Native image is non-root by default and contains only the container-side runtime policy', () => {
  assert.match(dockerfile, /^USER 65532:65532$/m);
  assert.match(dockerfile, /COPY native\/src/);
  assert.match(dockerfile, /COPY native\/bin/);
  assert.match(dockerfile, /COPY gateway\/path-policy/);
  assert.doesNotMatch(dockerfile, /COPY native\/host/);
  assert.doesNotMatch(dockerfile, /COPY native\/deploy/);
  assert.doesNotMatch(dockerfile, /docker\.sock/);
});

test('Native development image has only the basic tools needed by current coding workflows', () => {
  for (const dependency of ['git', 'jq', 'openssh-client', 'python3', 'python3-pip', 'ripgrep']) {
    assert.match(dockerfile, new RegExp(`\\b${dependency}\\b`));
  }
  for (const unnecessary of ['less', 'procps', 'sudo']) {
    assert.doesNotMatch(dockerfile, new RegExp(`\\b${unnecessary}\\b`));
  }
});
