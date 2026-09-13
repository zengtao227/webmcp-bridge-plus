const HOST_ID_PATTERN = /^host_[0-9a-f]{32}$/;

export class RouteDecisionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RouteDecisionError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new RouteDecisionError(message, code);
}

export function resolveProjectRoute(registry, projectReference, { requestedHostId = null } = {}) {
  if (!registry || typeof registry.resolveProject !== 'function') {
    fail('A validated Plus host registry is required.', 'REGISTRY_REQUIRED');
  }
  if (requestedHostId !== null && !HOST_ID_PATTERN.test(requestedHostId)) {
    return Object.freeze({ status: 'invalid_host' });
  }

  const resolved = registry.resolveProject(projectReference);
  if (resolved.status !== 'unique') {
    return Object.freeze({ status: resolved.status });
  }

  const hostId = resolved.host.hostId;
  if (requestedHostId !== null && requestedHostId !== hostId) {
    return Object.freeze({
      status: 'wrong_host',
      projectId: resolved.project.projectId,
      registeredHostId: hostId,
    });
  }

  return Object.freeze({
    status: 'unique',
    projectId: resolved.project.projectId,
    hostId,
  });
}
