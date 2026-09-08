export class DevSpaceOAuthError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'DevSpaceOAuthError';
    this.code = code;
    this.status = options.status ?? null;
  }
}
