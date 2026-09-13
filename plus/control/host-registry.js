import { lstat, readFile } from 'node:fs/promises';

const MAX_REGISTRY_BYTES = 256 * 1024;
const HOST_ID_PATTERN = /^host_[0-9a-f]{32}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_HOSTS = 128;
const MAX_PROJECTS = 4096;
const MAX_LABEL_LENGTH = 128;

export class HostRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HostRegistryError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new HostRegistryError(message, code);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function boundedLabel(value, field) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    fail(`${field} must be a bounded non-empty string.`, 'INVALID_REGISTRY_ENTRY');
  }
  return value;
}

export function parseHostRegistry(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) {
    fail('Host registry must be bounded UTF-8 JSON.', 'REGISTRY_TOO_LARGE');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('Host registry must be valid JSON.', 'INVALID_REGISTRY_SYNTAX');
  }

  if (!isPlainObject(raw) || !exactKeys(raw, ['version', 'hosts', 'projects'])) {
    fail('Host registry must contain exactly version, hosts, and projects.', 'INVALID_REGISTRY_SCHEMA');
  }
  if (raw.version !== 1 || !Array.isArray(raw.hosts) || !Array.isArray(raw.projects)) {
    fail('Host registry version or collections are invalid.', 'INVALID_REGISTRY_SCHEMA');
  }
  if (raw.hosts.length === 0 || raw.hosts.length > MAX_HOSTS || raw.projects.length > MAX_PROJECTS) {
    fail('Host registry collection sizes are invalid.', 'INVALID_REGISTRY_SCHEMA');
  }

  const hosts = new Map();
  for (const entry of raw.hosts) {
    if (!isPlainObject(entry) || !exactKeys(entry, ['hostId', 'label'])) {
      fail('Each host entry must contain exactly hostId and label.', 'INVALID_HOST_ENTRY');
    }
    if (!HOST_ID_PATTERN.test(entry.hostId)) {
      fail('Host registry contains an invalid hostId.', 'INVALID_HOST_ENTRY');
    }
    if (hosts.has(entry.hostId)) {
      fail(`Duplicate hostId '${entry.hostId}'.`, 'DUPLICATE_HOST_ID');
    }
    hosts.set(entry.hostId, Object.freeze({
      hostId: entry.hostId,
      label: boundedLabel(entry.label, 'Host label'),
    }));
  }

  const projects = new Map();
  for (const entry of raw.projects) {
    if (!isPlainObject(entry) || !exactKeys(entry, ['projectId', 'hostId'])) {
      fail('Each project entry must contain exactly projectId and hostId.', 'INVALID_PROJECT_ENTRY');
    }
    if (!PROJECT_ID_PATTERN.test(entry.projectId) || !HOST_ID_PATTERN.test(entry.hostId) || !hosts.has(entry.hostId)) {
      fail('Project registry entry has an invalid projectId or unknown hostId.', 'INVALID_PROJECT_ENTRY');
    }
    if (projects.has(entry.projectId)) {
      fail(`Duplicate projectId '${entry.projectId}'.`, 'DUPLICATE_PROJECT_ID');
    }
    projects.set(entry.projectId, Object.freeze({
      projectId: entry.projectId,
      hostId: entry.hostId,
    }));
  }

  const registry = {
    version: 1,
    hostCount: hosts.size,
    projectCount: projects.size,
    listHosts() {
      return Object.freeze([...hosts.values()]);
    },
    listProjects() {
      return Object.freeze([...projects.values()]);
    },
    resolveProject(reference) {
      if (typeof reference !== 'string' || !PROJECT_ID_PATTERN.test(reference)) {
        return Object.freeze({ status: 'invalid' });
      }
      const project = projects.get(reference);
      if (!project) return Object.freeze({ status: 'missing' });
      return Object.freeze({
        status: 'unique',
        project,
        host: hosts.get(project.hostId),
      });
    },
  };

  return Object.freeze(registry);
}

export async function loadHostRegistry(filePath) {
  let info;
  let text;
  try {
    info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('Host registry must be a regular non-symlink file.', 'REGISTRY_UNAVAILABLE');
    }
    if (info.size > MAX_REGISTRY_BYTES) {
      fail('Host registry exceeds the maximum size.', 'REGISTRY_TOO_LARGE');
    }
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof HostRegistryError) throw error;
    fail('Host registry is unavailable.', 'REGISTRY_UNAVAILABLE');
  }
  return parseHostRegistry(text);
}
