const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const NAMED_SECRET_PATTERN = /("(?:access_token|refresh_token|owner_token|ownerToken|client_secret|password|token)"\s*:\s*")[^"]*(")/gi;
const MIN_LITERAL_LENGTH = 8;

function safeStringify(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unstringifiable]';
  }
}

export function createRedactor(literals = []) {
  const secrets = [...new Set(
    (Array.isArray(literals) ? literals : [literals])
      .filter((value) => typeof value === 'string' && value.length >= MIN_LITERAL_LENGTH),
  )].sort((left, right) => right.length - left.length);

  function redact(value) {
    let text = safeStringify(value);
    for (const secret of secrets) {
      text = text.split(secret).join('[redacted]');
    }
    return text
      .replace(BEARER_PATTERN, '$1[redacted]')
      .replace(JWT_PATTERN, '[redacted-jwt]')
      .replace(NAMED_SECRET_PATTERN, '$1[redacted]$2');
  }

  return {
    redact,
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= MIN_LITERAL_LENGTH && !secrets.includes(secret)) {
        secrets.push(secret);
        secrets.sort((left, right) => right.length - left.length);
      }
    },
  };
}

export function createLogger({ redactor = createRedactor(), write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  function log(event, fields = {}) {
    const entry = { ts: new Date().toISOString(), event, ...fields };
    write(redactor.redact(JSON.stringify(entry)));
  }

  // A credential discovered at run time (a DevSpace access token) must be
  // redacted from every later line, not just the ones we anticipated.
  log.addSecret = (secret) => redactor.addSecret(secret);

  return log;
}
