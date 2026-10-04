// Failure that should reach Tony in plain words, tagged with a code the UI can act on.
export class JarvisError extends Error {
  constructor(code, message, { integration = null, hint = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'JarvisError';
    this.code = code;
    this.integration = integration;
    this.hint = hint;
  }
}

// Not a failure: the command is understood but something is missing.
export class NeedsInput extends Error {
  constructor(message, { pending = null } = {}) {
    super(message);
    this.name = 'NeedsInput';
    this.pending = pending;
  }
}

export function describeError(err) {
  if (err instanceof JarvisError) {
    return { code: err.code, message: err.message, integration: err.integration, hint: err.hint };
  }
  return { code: 'INTERNAL', message: err?.message || String(err), integration: null, hint: null };
}
