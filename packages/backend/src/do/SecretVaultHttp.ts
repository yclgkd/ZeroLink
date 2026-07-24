import type { AssertionJSON, ChannelRecord } from '@zerolink/shared';
import { CHANNEL_STATE } from '@zerolink/shared';
import { RequestBodyTooLargeError, readJsonBody as readLimitedJsonBody } from '../request-body.ts';
import type {
  ErrorResponse,
  LooseAssertionJson,
  MethodNotAllowedResponse,
  StateTransitionErrorCode,
} from './SecretVaultTypes.ts';
import { RateLimitError, StateTransitionError } from './SecretVaultTypes.ts';

interface ErrorLogContext {
  appEnv: string;
  handler: string;
}

interface StructuredUnexpectedErrorLog {
  event: 'secret_vault.unexpected_error';
  app_env: string;
  handler: string;
  error_name: string;
  stack_fingerprint: string;
  error_message?: string;
  error_stack?: string;
  thrown_value?: string;
}

function isProductionAppEnv(appEnv: string): boolean {
  return appEnv === 'production';
}

const STACK_FRAME_LIMIT = 5;

function fingerprintText(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function stripLineAndColumnSuffix(value: string): string {
  return value.replace(/:\d+:\d+$/u, '').replace(/:\d+$/u, '');
}

function stripQueryAndHash(value: string): string {
  return value.replace(/[?#].*$/u, '');
}

function stripProtocolAndHost(value: string): string {
  return value.replace(/^[a-z]+:\/\/[^/]+/iu, '');
}

function stripBundleHashSegment(value: string): string {
  return value.replace(/-(?:[a-f0-9]{6,}|[A-Za-z0-9_-]{8,})(?=\.[A-Za-z0-9]+$)/u, '');
}

function normalizeLocationToken(location: string): string {
  let normalized = stripProtocolAndHost(
    stripQueryAndHash(stripLineAndColumnSuffix(location.trim()))
  );

  if (normalized.includes('/')) {
    normalized = normalized.split('/').filter(Boolean).slice(-2).join('/');
  }

  normalized = stripBundleHashSegment(normalized);
  return normalized || 'anonymous';
}

function normalizeStackFrame(frame: string): string {
  const trimmed = frame.trim();
  if (trimmed === '') {
    return '';
  }

  const withoutAt = trimmed.replace(/^at\s+/u, '');
  const wrappedLocationMatch = withoutAt.match(/^(.*?) \((.*)\)$/u);
  if (wrappedLocationMatch) {
    const functionName = normalizeWhitespace(wrappedLocationMatch[1] ?? '');
    if (functionName !== '') {
      return functionName;
    }

    return normalizeLocationToken(wrappedLocationMatch[2] ?? '');
  }

  return normalizeLocationToken(withoutAt);
}

function extractNormalizedFrames(stack: string | undefined): string[] {
  if (!stack) {
    return [];
  }

  return stack
    .split('\n')
    .slice(1)
    .map((frame) => normalizeStackFrame(frame))
    .filter((frame) => frame !== '')
    .slice(0, STACK_FRAME_LIMIT);
}

function buildUnexpectedErrorFingerprintSource(error: unknown, context: ErrorLogContext): string {
  if (!(error instanceof Error)) {
    return `${context.handler}|NonErrorThrow|${Object.prototype.toString.call(error)}`;
  }

  const normalizedFrames = extractNormalizedFrames(error.stack);
  const normalizedFrameSignature =
    normalizedFrames.length > 0 ? normalizedFrames.join('|') : 'no-stack';

  return `${context.handler}|${error.name}|${normalizedFrameSignature}`;
}

function buildUnexpectedErrorLog(
  error: unknown,
  context: ErrorLogContext
): StructuredUnexpectedErrorLog {
  const baseLog: StructuredUnexpectedErrorLog = {
    event: 'secret_vault.unexpected_error',
    app_env: context.appEnv,
    handler: context.handler,
    error_name: error instanceof Error ? error.name : 'NonErrorThrow',
    stack_fingerprint: fingerprintText(buildUnexpectedErrorFingerprintSource(error, context)),
  };

  if (isProductionAppEnv(context.appEnv)) {
    return baseLog;
  }

  if (error instanceof Error) {
    return {
      ...baseLog,
      error_message: error.message,
      ...(error.stack ? { error_stack: error.stack } : {}),
    };
  }

  return {
    ...baseLog,
    thrown_value: String(error),
  };
}

// ---------------------------------------------------------------------------
// JSON response helpers
// ---------------------------------------------------------------------------

export function jsonResponse<T extends object>(
  payload: T,
  status: number,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');

  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

export function jsonError(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return jsonResponse<ErrorResponse>({ ok: false, code }, status, extraHeaders);
}

export function methodNotAllowed(): Response {
  return jsonResponse<MethodNotAllowedResponse>({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405, {
    Allow: 'POST',
  });
}

export function notFound(): Response {
  return jsonError('NOT_FOUND', 404);
}

export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await readLimitedJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assertion normalizer
// ---------------------------------------------------------------------------

export function normalizeAssertion(assertion: LooseAssertionJson): AssertionJSON {
  const { userHandle, ...restResponse } = assertion.response;

  if (userHandle === undefined) {
    return {
      ...assertion,
      response: restResponse,
    };
  }

  return {
    ...assertion,
    response: {
      ...restResponse,
      userHandle,
    },
  };
}

// ---------------------------------------------------------------------------
// Error mappers
// ---------------------------------------------------------------------------

export function mapError(error: unknown, context: ErrorLogContext): Response {
  if (error instanceof RequestBodyTooLargeError) {
    return jsonError('PAYLOAD_TOO_LARGE', 413);
  }

  if (error instanceof StateTransitionError) {
    return mapStateTransitionError(error);
  }

  if (error instanceof RateLimitError) {
    return jsonError('RATE_LIMITED', 429, {
      'Retry-After': String(error.retryAfterSeconds),
    });
  }

  // Production logs keep only whitelisted metadata; staging retains raw details for debugging.
  // biome-ignore lint/suspicious/noConsole: intentional error logging for production observability
  console.error(buildUnexpectedErrorLog(error, context));

  return jsonError('INTERNAL_ERROR', 500);
}

export function mapStateTransitionError(error: StateTransitionError): Response {
  const statusByCode: Partial<Record<StateTransitionErrorCode, [string, number]>> = {
    RECORD_NOT_FOUND: ['NOT_FOUND', 404],
    CHALLENGE_INVALID: ['CHALLENGE_INVALID', 401],
    CHALLENGE_CONSUMED: ['CHALLENGE_CONSUMED', 409],
    LOCK_FORBIDDEN: ['LOCK_FORBIDDEN', 403],
    INVALID_TRANSITION: ['LOCK_FORBIDDEN', 403],
    TERMINAL_STATE: ['LOCK_FORBIDDEN', 403],
    VERSION_MISMATCH: ['VERSION_MISMATCH', 409],
    NONCE_REPLAY: ['NONCE_REPLAY', 409],
    TIMESTAMP_OUT_OF_RANGE: ['TIMESTAMP_OUT_OF_RANGE', 400],
    INTENT_HASH_MISMATCH: ['INTENT_HASH_MISMATCH', 400],
    CIPHER_BUNDLE_INVALID: ['CIPHER_BUNDLE_INVALID', 400],
    ASSERTION_INVALID: ['ASSERTION_INVALID', 403],
    ATTESTATION_UNVERIFIABLE: ['ATTESTATION_UNVERIFIABLE', 403],
  };

  const entry = statusByCode[error.code];
  if (entry) {
    return jsonError(entry[0], entry[1]);
  }

  return jsonError('INTERNAL_ERROR', 500);
}

// ---------------------------------------------------------------------------
// State guard helpers
// ---------------------------------------------------------------------------

export function assertNonTerminal(record: ChannelRecord): void {
  if (record.state === CHANNEL_STATE.DELETED || record.state === CHANNEL_STATE.EXPIRED) {
    throw new StateTransitionError(
      'TERMINAL_STATE',
      `operation forbidden for terminal state ${record.state}`
    );
  }
}

export function assertWaitingState(record: ChannelRecord): void {
  if (record.state === CHANNEL_STATE.DELETED || record.state === CHANNEL_STATE.EXPIRED) {
    throw new StateTransitionError(
      'TERMINAL_STATE',
      `lock challenge flow forbidden for terminal state ${record.state}`
    );
  }
  if (record.state !== CHANNEL_STATE.WAITING) {
    throw new StateTransitionError(
      'INVALID_TRANSITION',
      `lock challenge flow requires waiting state, got ${record.state}`
    );
  }
}

export function assertUuidMatch(recordUuid: string, requestUuid: string): void {
  if (recordUuid !== requestUuid) {
    throw new StateTransitionError('LOCK_FORBIDDEN', 'uuid mismatch');
  }
}
