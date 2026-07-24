import {
  CompoundBeginRequestSchema,
  CompoundCommitRequestSchema,
  CreateBeginRequestSchema,
  CreateFinishRequestSchema,
  LockBeginRequestSchema,
  LockCommitRequestSchema,
  SoftkeyCompoundCommitRequestSchema,
} from '@zerolink/shared';
import {
  buildCommitSetCookieHeaders,
  type CommitCookieKind,
  computeCallerKey,
  extractCookieValue,
  getCommitCookieName,
  INTERNAL_CALLER_KEY_HEADER,
  INTERNAL_COMMIT_TOKEN_HEADER,
  readInternalCommitCookieSignal,
} from './commitTokens.ts';
import { cleanupOrphanMultipartChunks } from './file-cleanup.ts';
import { toFilePolicyResponse } from './file-policy.ts';
import {
  handleFileChunkUpload,
  handleFileDownload,
  handleFileFetch,
  handleFileUploadComplete,
  handleFileUploadInitiate,
} from './file-routes.ts';
import { RequestBodyTooLargeError, readJsonBody } from './request-body.ts';
import { applySecurityHeaders } from './security-headers.ts';

export interface Env {
  SECRET_VAULT: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_ENV: string;
  COMMIT_TOKEN_SECRET: string;
  RP_ID: string;
  RP_ORIGIN: string;
  FILE_MAX_BYTES?: string | number;
  FILE_MULTIPART_THRESHOLD_BYTES?: string | number;
  FILE_CHUNK_SIZE_BYTES?: string | number;
  FILE_MAX_CHUNKS?: string | number;
  FILE_MULTIPART_SUPPORTED?: string | boolean;
  FILE_BUCKET?: R2Bucket;
}

const UUID_REGEX = /^[A-Za-z0-9_-]{21}$/u;

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function normalizeOrigin(value: string | null): string {
  if (!value) {
    return '';
  }

  try {
    return new URL(value).origin;
  } catch {
    return value.trim().replace(/\/+$/u, '');
  }
}

function isAllowedWebSocketOrigin(request: Request, env: Env): boolean {
  const requestOrigin = normalizeOrigin(request.headers.get('Origin'));
  const allowedOrigin = normalizeOrigin(env.RP_ORIGIN);
  return requestOrigin.length > 0 && allowedOrigin.length > 0 && requestOrigin === allowedOrigin;
}

type ApiMethod = 'GET' | 'POST' | 'PUT';

interface ApiRoute {
  method: ApiMethod;
  pattern: RegExp;
}

const API_PREFIX = '/api';
const ALLOW_METHODS = 'GET,POST,PUT,OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization';
const CORS_ALLOW_ORIGIN = '*';
const CREATE_BEGIN_RATE_LIMIT_MAX_REQUESTS = 10;
const CREATE_BEGIN_RATE_LIMIT_WINDOW_MS = 60_000;

const createBeginRateLimitWindows = new WeakMap<
  Env,
  Map<string, { count: number; windowStart: number }>
>();

function getCreateBeginRateLimitWindows(
  env: Env
): Map<string, { count: number; windowStart: number }> {
  const existing = createBeginRateLimitWindows.get(env);
  if (existing) {
    return existing;
  }

  const created = new Map<string, { count: number; windowStart: number }>();
  createBeginRateLimitWindows.set(env, created);
  return created;
}

function enforceCreateBeginRateLimit(env: Env, subject: string, now: number): number | null {
  const windows = getCreateBeginRateLimitWindows(env);

  for (const [key, window] of windows.entries()) {
    if (now - window.windowStart >= CREATE_BEGIN_RATE_LIMIT_WINDOW_MS) {
      windows.delete(key);
    }
  }

  const existing = windows.get(subject);
  if (!existing || now - existing.windowStart >= CREATE_BEGIN_RATE_LIMIT_WINDOW_MS) {
    windows.set(subject, { count: 1, windowStart: now });
    return null;
  }

  if (existing.count >= CREATE_BEGIN_RATE_LIMIT_MAX_REQUESTS) {
    return Math.max(
      1,
      Math.ceil((existing.windowStart + CREATE_BEGIN_RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
  }

  existing.count += 1;
  return null;
}
const LOCK_BEGIN_PATH = /^\/api\/lock_begin\/([^/]+)$/u;
const LOCK_COMMIT_PATH = /^\/api\/lock_commit\/([^/]+)$/u;
const COMPOUND_BEGIN_PATH = /^\/api\/manage\/compound_begin\/([^/]+)$/u;
const COMPOUND_COMMIT_PATH = /^\/api\/manage\/compound_commit\/([^/]+)$/u;
const DELETE_COMMIT_PATH = /^\/api\/delete_commit\/([^/]+)$/u;
const PUBLIC_STATUS_PATH = /^\/api\/public\/([^/]+)$/u;
const DECRYPT_FETCH_PATH = /^\/api\/decrypt_fetch\/([^/]+)$/u;
const WS_SUBSCRIBE_PATH = /^\/api\/ws\/([^/]+)$/u;
const FILE_POLICY_PATH = '/api/file_policy';
const FILE_UPLOAD_INITIATE_PATH = '/api/file/initiate';
const FILE_UPLOAD_COMPLETE_PATH = '/api/file/complete';
const FILE_FETCH_PATH = /^\/api\/file\/fetch\/([^/]+)$/u;
const FILE_CHUNK_PATH = /^\/api\/file\/chunk\/([^/]+)\/([^/]+)\/(\d+)$/u;
const FILE_DOWNLOAD_PATH = /^\/api\/file\/dl\/([^/]+)\/(\d+)$/u;

const API_ROUTES: readonly ApiRoute[] = [
  { method: 'POST', pattern: /^\/api\/create_begin\/[^/]+$/u },
  { method: 'POST', pattern: /^\/api\/create_finish\/[^/]+$/u },
];

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function buildApiHeaders(): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': CORS_ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  });
}

function jsonApiResponse(payload: unknown, status: number, headers?: HeadersInit): Response {
  const resolvedHeaders = new Headers(headers ?? buildApiHeaders());
  resolvedHeaders.set('Content-Type', 'application/json; charset=utf-8');

  return new Response(JSON.stringify(payload), {
    status,
    headers: resolvedHeaders,
  });
}

function errorResponse(code: string, status: number, headers?: HeadersInit): Response {
  return jsonApiResponse(
    {
      ok: false,
      code,
    },
    status,
    headers
  );
}

function notImplemented(): Response {
  return errorResponse('NOT_IMPLEMENTED', 501);
}

function notFound(): Response {
  return errorResponse('NOT_FOUND', 404);
}

function methodNotAllowed(allowedMethod: ApiMethod): Response {
  const headers = buildApiHeaders();
  headers.set('Allow', `${allowedMethod}, OPTIONS`);

  return errorResponse('METHOD_NOT_ALLOWED', 405, headers);
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: buildApiHeaders(),
  });
}

function toJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

async function forwardToSecretVault(
  env: Env,
  sourceRequest: Request,
  uuid: string,
  path:
    | '/lock_begin'
    | '/lock_commit'
    | '/compound_begin'
    | '/compound_commit'
    | '/create_begin'
    | '/create_finish'
    | '/get_public_state'
    | '/get_decrypt_payload'
    | '/get_file_payload',
  payload: Record<string, unknown>
): Promise<Response> {
  try {
    const durableObjectId = env.SECRET_VAULT.idFromName(uuid);
    const stub = env.SECRET_VAULT.get(durableObjectId);
    const requestHeaders = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
    });
    const commitCookieKind = resolveCommitCookieKind(path);

    if (shouldAttachCallerKey(path)) {
      const callerKey = await computeCallerKey(
        env.COMMIT_TOKEN_SECRET,
        sourceRequest.headers.get('CF-Connecting-IP'),
        sourceRequest.headers.get('User-Agent')
      );
      requestHeaders.set(INTERNAL_CALLER_KEY_HEADER, callerKey);
    }

    if (commitCookieKind) {
      const token = extractCookieValue(
        sourceRequest.headers.get('Cookie'),
        getCommitCookieName(commitCookieKind)
      );
      if (token) {
        requestHeaders.set(INTERNAL_COMMIT_TOKEN_HEADER, token);
      }
    }

    const vaultResponse = await stub.fetch(`https://secret-vault.internal${path}`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(payload),
    });
    const bodyText = await vaultResponse.text();
    const body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    const jsonBody = toJsonObject(body);

    if (!jsonBody) {
      return errorResponse('INTERNAL_ERROR', 500);
    }

    const responseHeaders = buildApiHeaders();
    const retryAfter = vaultResponse.headers.get('Retry-After');
    if (retryAfter) {
      responseHeaders.set('Retry-After', retryAfter);
    }
    const cookieSignal = readInternalCommitCookieSignal(vaultResponse.headers);
    if (cookieSignal) {
      const secure = new URL(sourceRequest.url).protocol === 'https:';
      for (const cookie of buildCommitSetCookieHeaders(cookieSignal, uuid, secure)) {
        responseHeaders.append('Set-Cookie', cookie);
      }
    }

    return jsonApiResponse(jsonBody, vaultResponse.status, responseHeaders);
  } catch {
    return errorResponse('INTERNAL_ERROR', 500);
  }
}

function shouldAttachCallerKey(
  path:
    | '/lock_begin'
    | '/lock_commit'
    | '/compound_begin'
    | '/compound_commit'
    | '/create_begin'
    | '/create_finish'
    | '/get_public_state'
    | '/get_decrypt_payload'
    | '/get_file_payload'
): boolean {
  return (
    path === '/lock_begin' ||
    path === '/lock_commit' ||
    path === '/compound_begin' ||
    path === '/compound_commit'
  );
}

function resolveCommitCookieKind(
  path:
    | '/lock_begin'
    | '/lock_commit'
    | '/compound_begin'
    | '/compound_commit'
    | '/create_begin'
    | '/create_finish'
    | '/get_public_state'
    | '/get_decrypt_payload'
    | '/get_file_payload'
): CommitCookieKind | null {
  if (path === '/lock_commit') {
    return 'lock';
  }

  if (path === '/compound_commit') {
    return 'compound';
  }

  return null;
}

async function handleLockBegin(
  request: Request,
  env: Env,
  pathnameUuid: string
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = LockBeginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (parsed.data.uuid !== pathnameUuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  return forwardToSecretVault(env, request, pathnameUuid, '/lock_begin', parsed.data);
}

async function handleLockCommit(
  request: Request,
  env: Env,
  pathnameUuid: string
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = LockCommitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (parsed.data.uuid !== pathnameUuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  return forwardToSecretVault(env, request, pathnameUuid, '/lock_commit', parsed.data);
}

async function handleCreateBegin(
  request: Request,
  env: Env,
  pathnameUuid: string
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = CreateBeginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (parsed.data.uuid !== pathnameUuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  // Limit channel creation per caller at ingress so rotating UUIDs cannot bypass the bucket.
  const callerKey = await computeCallerKey(
    env.COMMIT_TOKEN_SECRET,
    request.headers.get('CF-Connecting-IP'),
    request.headers.get('User-Agent')
  );
  const retryAfterSeconds = enforceCreateBeginRateLimit(env, callerKey, Date.now());
  if (retryAfterSeconds !== null) {
    return errorResponse('RATE_LIMITED', 429, {
      'Retry-After': String(retryAfterSeconds),
    });
  }

  return forwardToSecretVault(env, request, pathnameUuid, '/create_begin', parsed.data);
}

async function handleCreateFinish(
  request: Request,
  env: Env,
  pathnameUuid: string
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = CreateFinishRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (parsed.data.uuid !== pathnameUuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  return forwardToSecretVault(env, request, pathnameUuid, '/create_finish', parsed.data);
}

async function handleCompoundBegin(
  request: Request,
  env: Env,
  pathnameUuid: string
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = CompoundBeginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (parsed.data.uuid !== pathnameUuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  return forwardToSecretVault(env, request, pathnameUuid, '/compound_begin', parsed.data);
}

async function handleCompoundCommit(
  request: Request,
  env: Env,
  pathnameUuid: string,
  deleteOnly: boolean
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsedWebAuthn = CompoundCommitRequestSchema.safeParse(body);
  const parsedSoftkey = SoftkeyCompoundCommitRequestSchema.safeParse(body);
  const parsedData = parsedSoftkey.success
    ? parsedSoftkey.data
    : parsedWebAuthn.success
      ? parsedWebAuthn.data
      : null;
  if (!parsedData) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (parsedData.uuid !== pathnameUuid || parsedData.intent.uuid !== pathnameUuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (deleteOnly && parsedData.intent.op !== 'delete') {
    return errorResponse('BAD_REQUEST', 400);
  }

  return forwardToSecretVault(env, request, pathnameUuid, '/compound_commit', parsedData);
}

async function forwardWebSocketUpgrade(
  env: Env,
  uuid: string,
  request: Request
): Promise<Response> {
  const durableObjectId = env.SECRET_VAULT.idFromName(uuid);
  const stub = env.SECRET_VAULT.get(durableObjectId);
  return stub.fetch('https://secret-vault.internal/ws', {
    headers: request.headers,
  });
}

async function handleApiRequest(request: Request, pathname: string, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return preflight();
  }

  if (pathname === FILE_POLICY_PATH) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return jsonApiResponse(toFilePolicyResponse(env), 200);
  }

  if (pathname === FILE_UPLOAD_INITIATE_PATH) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleFileUploadInitiate(request, env);
  }

  if (pathname === FILE_UPLOAD_COMPLETE_PATH) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return handleFileUploadComplete(request, env);
  }

  const fileChunkMatch = pathname.match(FILE_CHUNK_PATH);
  if (fileChunkMatch) {
    if (request.method !== 'PUT') return methodNotAllowed('PUT');
    const uuid = fileChunkMatch[1] ?? '';
    const uploadId = fileChunkMatch[2] ?? '';
    const index = Number(fileChunkMatch[3] ?? '');
    if (!isValidUuid(uuid) || !Number.isInteger(index) || index < 0) {
      return errorResponse('BAD_REQUEST', 400);
    }
    return handleFileChunkUpload(request, env, uuid, uploadId, index);
  }

  const fileFetchMatch = pathname.match(FILE_FETCH_PATH);
  if (fileFetchMatch) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const uuid = fileFetchMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleFileFetch(env, uuid);
  }

  const fileDownloadMatch = pathname.match(FILE_DOWNLOAD_PATH);
  if (fileDownloadMatch) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const uuid = fileDownloadMatch[1] ?? '';
    const index = Number(fileDownloadMatch[2] ?? '');
    if (!isValidUuid(uuid) || !Number.isInteger(index) || index < 0) {
      return errorResponse('BAD_REQUEST', 400);
    }
    return handleFileDownload(request, env, uuid, index);
  }

  const wsMatch = pathname.match(WS_SUBSCRIBE_PATH);
  if (wsMatch) {
    const uuid = wsMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return errorResponse('BAD_REQUEST', 426);
    }
    if (!isAllowedWebSocketOrigin(request, env)) {
      return errorResponse('NOT_ALLOWED', 403);
    }
    return forwardWebSocketUpgrade(env, uuid, request);
  }

  const lockBeginMatch = pathname.match(LOCK_BEGIN_PATH);
  if (lockBeginMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = lockBeginMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleLockBegin(request, env, uuid);
  }

  const lockCommitMatch = pathname.match(LOCK_COMMIT_PATH);
  if (lockCommitMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = lockCommitMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleLockCommit(request, env, uuid);
  }

  const compoundBeginMatch = pathname.match(COMPOUND_BEGIN_PATH);
  if (compoundBeginMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = compoundBeginMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleCompoundBegin(request, env, uuid);
  }

  const compoundCommitMatch = pathname.match(COMPOUND_COMMIT_PATH);
  if (compoundCommitMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = compoundCommitMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleCompoundCommit(request, env, uuid, false);
  }

  const createBeginMatch = pathname.match(/^\/api\/create_begin\/([^/]+)$/u);
  if (createBeginMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = createBeginMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleCreateBegin(request, env, uuid);
  }

  const createFinishMatch = pathname.match(/^\/api\/create_finish\/([^/]+)$/u);
  if (createFinishMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = createFinishMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleCreateFinish(request, env, uuid);
  }

  const deleteCommitMatch = pathname.match(DELETE_COMMIT_PATH);
  if (deleteCommitMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const uuid = deleteCommitMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return handleCompoundCommit(request, env, uuid, true);
  }

  const publicStatusMatch = pathname.match(PUBLIC_STATUS_PATH);
  if (publicStatusMatch) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const uuid = publicStatusMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return forwardToSecretVault(env, request, uuid, '/get_public_state', {});
  }

  const decryptFetchMatch = pathname.match(DECRYPT_FETCH_PATH);
  if (decryptFetchMatch) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const uuid = decryptFetchMatch[1] ?? '';
    if (!isValidUuid(uuid)) return errorResponse('BAD_REQUEST', 400);
    return forwardToSecretVault(env, request, uuid, '/get_decrypt_payload', {});
  }

  const route = API_ROUTES.find((candidate) => candidate.pattern.test(pathname));
  if (!route) {
    return notFound();
  }

  if (route.method !== request.method) {
    return methodNotAllowed(route.method);
  }

  return notImplemented();
}

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (!isApiPath(url.pathname)) {
        const assetResponse = await env.ASSETS.fetch(request);
        return applySecurityHeaders(assetResponse, url.pathname);
      }

      return await handleApiRequest(request, url.pathname, env);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return errorResponse('PAYLOAD_TOO_LARGE', 413);
      }
      return errorResponse('INTERNAL_ERROR', 500);
    }
  },
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const summary = await cleanupOrphanMultipartChunks(env, controller.scheduledTime);
          // biome-ignore lint/suspicious/noConsole: intentional operational signal for scheduled cleanup
          console.info('[file-cleanup] scheduled_orphan_scan_complete', summary);
        } catch (error) {
          // biome-ignore lint/suspicious/noConsole: intentional operational signal for scheduled cleanup
          console.error('[file-cleanup] scheduled_orphan_scan_failed', error);
          throw error;
        }
      })()
    );
  },
};

export default worker;
