/**
 * Stable error codes returned to MCP clients. Upstream error bodies, tokens and
 * request headers never travel inside these; only the code, a short message and
 * small structured details.
 */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'LOGIN_IN_PROGRESS'
  | 'LOGIN_TIMEOUT'
  | 'LOGIN_CANCELLED'
  | 'BROWSER_NOT_FOUND'
  | 'ACCOUNT_CHANGED'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'UNAVAILABLE'
  | 'FORMAT_CHANGED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_URL'
  | 'EXTERNAL_RESOURCE'
  | 'FILE_TOO_LARGE'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_CHANGED'
  | 'CONFIRMATION_REQUIRED'
  | 'OUTCOME_UNKNOWN'
  | 'NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class AhError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AhError';
  }
}

export interface SafeError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function toSafeError(error: unknown): SafeError {
  if (error instanceof AhError) {
    return error.details
      ? { code: error.code, message: error.message, details: error.details }
      : { code: error.code, message: error.message };
  }
  return {
    code: 'INTERNAL_ERROR',
    message:
      'The operation failed unexpectedly. Run "albertheijn-mcp status" to check connectivity and sign-in state.',
  };
}

export function isAuthError(error: unknown): boolean {
  return error instanceof AhError && error.code === 'AUTH_REQUIRED';
}
