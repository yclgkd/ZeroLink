import {
  AES_GCM,
  type Base64Url,
  FileFetchResponseSchema,
  type FileUploadCompleteRequest,
  FileUploadCompleteRequestSchema,
  FileUploadInitiateRequestSchema,
  type HexString,
  type MultipartFileRef,
  type UnixMs,
  type UUID,
} from '@zerolink/shared';
import { computeCallerKey } from './commitTokens.ts';
import { resolveFilePolicy, resolveInlineFilePlaintextBytes } from './file-policy.ts';
import {
  buildMultipartChunkStorageKey,
  buildMultipartFileRef,
  buildMultipartFinalStorageKey,
  buildMultipartUploadCompletionMarkerKey,
  createFileDownloadToken,
  createFileUploadId,
  FILE_DOWNLOAD_TTL_MS,
  FILE_UPLOAD_TTL_MS,
  makeFileCompleteResponse,
  makeFileUploadResponse,
  parseFileDownloadToken,
  parseFileUploadId,
} from './file-storage.ts';
import type { Env } from './worker.ts';

const AES_GCM_TAG_BYTES = AES_GCM.TAG_LENGTH_BITS / 8;
const FILE_UPLOAD_INITIATE_RATE_LIMIT_MAX_REQUESTS = 10;
const FILE_UPLOAD_INITIATE_RATE_LIMIT_WINDOW_MS = 60_000;
const MULTIPART_COMPLETION_LEASE_MS = 5 * 60_000;
const MULTIPART_COMPLETION_ACQUIRE_ATTEMPTS = 4;

type MultipartCompletionMarkerState = 'in_progress' | 'completed' | 'released';

interface MultipartCompletionMarkerContext {
  channelUuid: string;
  uploadId: string;
  uploadExpiresAt: number;
  requestFingerprint: HexString;
}

interface MultipartCompletionMarkerMetadata {
  completionState?: string;
  requestFingerprint?: string;
  leaseExpiresAt?: string;
}

type MultipartCompletionMarkerAcquisition =
  | { kind: 'owned'; etag: string }
  | { kind: 'completed' }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

class MultipartCompletionError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'UPLOAD_INCOMPLETE',
    readonly status: 400 | 409,
    message: string
  ) {
    super(message);
  }
}

const fileUploadInitiateRateLimitWindows = new WeakMap<
  Env,
  Map<string, { count: number; windowStart: number }>
>();

async function createMultipartCompletionFingerprint(
  request: FileUploadCompleteRequest
): Promise<HexString> {
  const canonicalRequest = JSON.stringify({
    uploadId: request.uploadId,
    baseIv: request.baseIv,
    encContentKey: request.encContentKey,
    chunkSizeBytes: request.chunkSizeBytes,
    totalPlaintextBytes: request.totalPlaintextBytes,
    totalCiphertextBytes: request.totalCiphertextBytes,
    chunks: [...request.chunks]
      .sort((left, right) => left.index - right.index)
      .map((chunk) => ({
        index: chunk.index,
        etag: chunk.etag,
        ciphertextBytes: chunk.ciphertextBytes,
        ciphertextHash: chunk.ciphertextHash,
      })),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  ) as HexString;
}

function readMultipartCompletionMarker(object: R2Object): {
  state: MultipartCompletionMarkerState;
  requestFingerprint: string;
  leaseExpiresAt: number;
} | null {
  const metadata = object.customMetadata as MultipartCompletionMarkerMetadata | undefined;
  const state = metadata?.completionState;
  const requestFingerprint = metadata?.requestFingerprint;
  const leaseExpiresAt = Number(metadata?.leaseExpiresAt);
  if (
    (state !== 'in_progress' && state !== 'completed' && state !== 'released') ||
    !requestFingerprint ||
    !Number.isFinite(leaseExpiresAt)
  ) {
    return null;
  }
  return { state, requestFingerprint, leaseExpiresAt };
}

function multipartCompletionMarkerBody(
  state: MultipartCompletionMarkerState,
  requestFingerprint: HexString
): string {
  return JSON.stringify({
    state,
    requestFingerprint,
    nonce: crypto.randomUUID(),
  });
}

function multipartCompletionMarkerMetadata(
  context: MultipartCompletionMarkerContext,
  state: MultipartCompletionMarkerState,
  leaseExpiresAt: number
): Record<string, string> {
  return {
    channelUuid: context.channelUuid,
    uploadId: context.uploadId,
    expiresAt: String(context.uploadExpiresAt),
    completionState: state,
    requestFingerprint: context.requestFingerprint,
    leaseExpiresAt: String(leaseExpiresAt),
  };
}

async function writeMultipartCompletionMarker(
  bucket: R2Bucket,
  markerKey: string,
  context: MultipartCompletionMarkerContext,
  state: MultipartCompletionMarkerState,
  onlyIf: R2Conditional
): Promise<R2Object | null> {
  const leaseExpiresAt =
    state === 'in_progress' ? Date.now() + MULTIPART_COMPLETION_LEASE_MS : Date.now();
  return bucket.put(markerKey, multipartCompletionMarkerBody(state, context.requestFingerprint), {
    onlyIf,
    customMetadata: multipartCompletionMarkerMetadata(context, state, leaseExpiresAt),
  });
}

async function acquireMultipartCompletionMarker(
  bucket: R2Bucket,
  markerKey: string,
  context: MultipartCompletionMarkerContext
): Promise<MultipartCompletionMarkerAcquisition> {
  for (let attempt = 0; attempt < MULTIPART_COMPLETION_ACQUIRE_ATTEMPTS; attempt += 1) {
    const existing = await bucket.head(markerKey);
    if (!existing) {
      const created = await writeMultipartCompletionMarker(
        bucket,
        markerKey,
        context,
        'in_progress',
        { etagDoesNotMatch: '*' }
      );
      if (created) {
        return { kind: 'owned', etag: created.etag };
      }
      continue;
    }

    const marker = readMultipartCompletionMarker(existing);
    if (!marker) {
      return { kind: 'in_progress' };
    }
    if (marker.state === 'completed') {
      return marker.requestFingerprint === context.requestFingerprint
        ? { kind: 'completed' }
        : { kind: 'mismatch' };
    }
    if (marker.state === 'in_progress') {
      if (marker.requestFingerprint !== context.requestFingerprint) {
        return { kind: 'mismatch' };
      }
      if (marker.leaseExpiresAt > Date.now()) {
        return { kind: 'in_progress' };
      }
    }

    const claimed = await writeMultipartCompletionMarker(
      bucket,
      markerKey,
      context,
      'in_progress',
      { etagMatches: existing.etag }
    );
    if (claimed) {
      return { kind: 'owned', etag: claimed.etag };
    }
  }

  return { kind: 'in_progress' };
}

async function transitionMultipartCompletionMarker(
  bucket: R2Bucket,
  markerKey: string,
  context: MultipartCompletionMarkerContext,
  ownerETag: string,
  state: 'completed' | 'released'
): Promise<R2Object | null> {
  return writeMultipartCompletionMarker(bucket, markerKey, context, state, {
    etagMatches: ownerETag,
  });
}

function buildHeaders(): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  });
}

function jsonResponse(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = buildHeaders();
  if (extraHeaders) {
    for (const [name, value] of new Headers(extraHeaders).entries()) {
      headers.set(name, value);
    }
  }
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(code: string, status: number, extraHeaders?: HeadersInit): Response {
  return jsonResponse({ ok: false, code }, status, extraHeaders);
}

export async function readRequestBytesUpToLimit(
  request: Request,
  limit: number
): Promise<Uint8Array | null> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }

  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader != null && contentLengthHeader.trim() !== '') {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength) && contentLength > limit) {
      return null;
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function resolveMaxMultipartCiphertextBytes(maxFileBytes: number, chunkCount: number): number {
  return resolveInlineFilePlaintextBytes(maxFileBytes) + chunkCount * AES_GCM_TAG_BYTES;
}

function resolveExpectedChunkCiphertextBytes(
  totalPlaintextBytes: number,
  chunkSizeBytes: number,
  chunkCount: number,
  index: number
): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
    return null;
  }

  if (index < chunkCount - 1) {
    return chunkSizeBytes + AES_GCM_TAG_BYTES;
  }

  const lastChunkPlaintextBytes = totalPlaintextBytes - (chunkCount - 1) * chunkSizeBytes;
  if (lastChunkPlaintextBytes <= 0 || lastChunkPlaintextBytes > chunkSizeBytes) {
    return null;
  }

  return lastChunkPlaintextBytes + AES_GCM_TAG_BYTES;
}

function getFileUploadInitiateRateLimitWindows(
  env: Env
): Map<string, { count: number; windowStart: number }> {
  const existing = fileUploadInitiateRateLimitWindows.get(env);
  if (existing) {
    return existing;
  }

  const created = new Map<string, { count: number; windowStart: number }>();
  fileUploadInitiateRateLimitWindows.set(env, created);
  return created;
}

function sweepExpiredFileUploadInitiateRateLimitWindows(
  windows: Map<string, { count: number; windowStart: number }>,
  now: number
): void {
  for (const [key, window] of windows.entries()) {
    if (now - window.windowStart >= FILE_UPLOAD_INITIATE_RATE_LIMIT_WINDOW_MS) {
      windows.delete(key);
    }
  }
}

function enforceFileUploadInitiateRateLimit(env: Env, subject: string, now: number): number | null {
  const windows = getFileUploadInitiateRateLimitWindows(env);
  sweepExpiredFileUploadInitiateRateLimitWindows(windows, now);

  const existing = windows.get(subject);
  if (!existing || now - existing.windowStart >= FILE_UPLOAD_INITIATE_RATE_LIMIT_WINDOW_MS) {
    windows.set(subject, { count: 1, windowStart: now });
    return null;
  }

  if (existing.count >= FILE_UPLOAD_INITIATE_RATE_LIMIT_MAX_REQUESTS) {
    return Math.max(
      1,
      Math.ceil((existing.windowStart + FILE_UPLOAD_INITIATE_RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
  }

  existing.count += 1;
  return null;
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

interface FilePayloadLookupSuccess {
  fileRef: MultipartFileRef;
  cipherVersion: number;
}

interface FilePayloadLookupError {
  status: number;
  code: string;
}

type FilePayloadLookupResult =
  | {
      ok: true;
      data: FilePayloadLookupSuccess;
    }
  | {
      ok: false;
      error: FilePayloadLookupError;
    };

async function forwardFilePayloadLookup(env: Env, uuid: string): Promise<FilePayloadLookupResult> {
  const durableObjectId = env.SECRET_VAULT.idFromName(uuid);
  const stub = env.SECRET_VAULT.get(durableObjectId);
  const response = await stub.fetch('https://secret-vault.internal/get_file_payload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({}),
  });

  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    code?: string;
    fileRef?: MultipartFileRef;
    payloadTransport?: string;
    cipherVersion?: number;
  } | null;

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      error: {
        status: response.status,
        code:
          typeof payload?.code === 'string' && payload.code.length > 0
            ? payload.code
            : 'INTERNAL_ERROR',
      },
    };
  }
  if (payload.payloadTransport !== 'multipart' || !payload.fileRef) {
    return {
      ok: false,
      error: {
        status: 409,
        code: 'CHANNEL_NOT_MULTIPART',
      },
    };
  }
  const cipherVersion = payload.cipherVersion;
  if (typeof cipherVersion !== 'number' || !Number.isInteger(cipherVersion) || cipherVersion < 0) {
    return {
      ok: false,
      error: {
        status: 500,
        code: 'INTERNAL_ERROR',
      },
    };
  }

  return {
    ok: true,
    data: {
      fileRef: payload.fileRef,
      cipherVersion,
    },
  };
}

async function channelExists(env: Env, uuid: string): Promise<boolean> {
  const durableObjectId = env.SECRET_VAULT.idFromName(uuid);
  const stub = env.SECRET_VAULT.get(durableObjectId);
  const response = await stub.fetch('https://secret-vault.internal/get_public_state', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({}),
  });

  if (response.ok) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }

  throw new Error(`load public state failed with status ${response.status}`);
}

export async function handleFileUploadInitiate(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body == null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = FileUploadInitiateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const policy = resolveFilePolicy(env);
  if (!policy.multipartSupported) {
    return errorResponse('BAD_REQUEST', 400);
  }
  if (parsed.data.chunkCount > policy.maxChunks) {
    return errorResponse('BAD_REQUEST', 400);
  }
  if (
    parsed.data.totalCiphertextBytes >
    resolveMaxMultipartCiphertextBytes(policy.maxFileBytes, parsed.data.chunkCount)
  ) {
    return errorResponse('BAD_REQUEST', 400);
  }
  try {
    if (!(await channelExists(env, parsed.data.channelUuid))) {
      return errorResponse('NOT_FOUND', 404);
    }
  } catch {
    return errorResponse('INTERNAL_ERROR', 500);
  }

  const now = Date.now() as UnixMs;
  const callerKey = await computeCallerKey(
    env.COMMIT_TOKEN_SECRET,
    request.headers.get('CF-Connecting-IP'),
    request.headers.get('User-Agent')
  );
  const retryAfterSeconds = enforceFileUploadInitiateRateLimit(
    env,
    `${parsed.data.channelUuid}:public:${callerKey}`,
    Number(now)
  );
  if (retryAfterSeconds !== null) {
    return errorResponse('RATE_LIMITED', 429, {
      'Retry-After': String(retryAfterSeconds),
    });
  }

  const uploadId = await createFileUploadId(env.COMMIT_TOKEN_SECRET, {
    v: '1',
    channelUuid: parsed.data.channelUuid,
    chunkCount: parsed.data.chunkCount,
    totalCiphertextBytes: parsed.data.totalCiphertextBytes,
    issuedAt: now,
    expiresAt: (Number(now) + FILE_UPLOAD_TTL_MS) as UnixMs,
  });

  return jsonResponse(
    makeFileUploadResponse(uploadId, parsed.data.chunkCount, request.url, parsed.data.channelUuid),
    200
  );
}

export async function handleFileChunkUpload(
  request: Request,
  env: Env,
  uuid: string,
  uploadId: string,
  index: number
): Promise<Response> {
  if (!env.FILE_BUCKET) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const uploadSession = await parseFileUploadId(env.COMMIT_TOKEN_SECRET, uploadId);
  if (!uploadSession || uploadSession.channelUuid !== uuid) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (Number(uploadSession.expiresAt) < Date.now()) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (!Number.isInteger(index) || index < 0 || index >= uploadSession.chunkCount) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const completionMarkerKey = buildMultipartUploadCompletionMarkerKey(uuid, uploadId as Base64Url);
  const completionMarkerObject = await env.FILE_BUCKET.head(completionMarkerKey);
  if (completionMarkerObject) {
    const completionMarker = readMultipartCompletionMarker(completionMarkerObject);
    if (
      !completionMarker ||
      completionMarker.state === 'completed' ||
      (completionMarker.state === 'in_progress' && completionMarker.leaseExpiresAt > Date.now())
    ) {
      return errorResponse('NOT_FOUND', 404);
    }
  }

  const policy = resolveFilePolicy(env);
  const chunkBody = await readRequestBytesUpToLimit(
    request,
    policy.chunkSizeBytes + AES_GCM_TAG_BYTES
  );
  if (chunkBody == null) {
    return errorResponse('BAD_REQUEST', 400);
  }
  const chunkBytes = chunkBody.byteLength;
  if (chunkBytes <= 0 || chunkBytes > policy.chunkSizeBytes + AES_GCM_TAG_BYTES) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const storageKey = buildMultipartChunkStorageKey(uuid, uploadId as Base64Url, index);
  const uploadedObject = await env.FILE_BUCKET.put(storageKey, chunkBody, {
    httpMetadata: {
      contentType: 'application/octet-stream',
    },
    customMetadata: {
      channelUuid: uuid,
      uploadId,
      chunkIndex: String(index),
      expiresAt: String(uploadSession.expiresAt),
    },
  });

  const headers = buildHeaders();
  headers.set('ETag', uploadedObject.etag);
  return new Response(null, { status: 200, headers });
}

export async function handleFileUploadComplete(request: Request, env: Env): Promise<Response> {
  if (!env.FILE_BUCKET) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const body = await readJsonBody(request);
  if (body == null) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const parsed = FileUploadCompleteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const uploadSession = await parseFileUploadId(env.COMMIT_TOKEN_SECRET, parsed.data.uploadId);
  if (!uploadSession) {
    return errorResponse('BAD_REQUEST', 400);
  }
  if (Number(uploadSession.expiresAt) < Date.now()) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const policy = resolveFilePolicy(env);
  if (parsed.data.chunkSizeBytes !== policy.chunkSizeBytes) {
    return errorResponse('BAD_REQUEST', 400);
  }
  if (uploadSession.chunkCount > policy.maxChunks) {
    return errorResponse('BAD_REQUEST', 400);
  }
  if (
    parsed.data.totalPlaintextBytes > resolveInlineFilePlaintextBytes(policy.maxFileBytes) ||
    parsed.data.totalCiphertextBytes !==
      parsed.data.totalPlaintextBytes + uploadSession.chunkCount * AES_GCM_TAG_BYTES
  ) {
    return errorResponse('BAD_REQUEST', 400);
  }

  if (
    uploadSession.chunkCount !== parsed.data.chunks.length ||
    uploadSession.totalCiphertextBytes !== parsed.data.totalCiphertextBytes ||
    parsed.data.chunks.some((chunk, index) => chunk.index !== index)
  ) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const sortedChunks = [...parsed.data.chunks].sort((left, right) => left.index - right.index);
  for (const chunk of sortedChunks) {
    const expectedCiphertextBytes = resolveExpectedChunkCiphertextBytes(
      parsed.data.totalPlaintextBytes,
      parsed.data.chunkSizeBytes,
      uploadSession.chunkCount,
      chunk.index
    );
    if (expectedCiphertextBytes == null || chunk.ciphertextBytes !== expectedCiphertextBytes) {
      return errorResponse('BAD_REQUEST', 400);
    }
  }

  const completionMarkerKey = buildMultipartUploadCompletionMarkerKey(
    uploadSession.channelUuid,
    parsed.data.uploadId as Base64Url
  );
  const markerContext: MultipartCompletionMarkerContext = {
    channelUuid: uploadSession.channelUuid,
    uploadId: parsed.data.uploadId,
    uploadExpiresAt: Number(uploadSession.expiresAt),
    requestFingerprint: await createMultipartCompletionFingerprint(parsed.data),
  };
  const markerAcquisition = await acquireMultipartCompletionMarker(
    env.FILE_BUCKET,
    completionMarkerKey,
    markerContext
  );
  if (markerAcquisition.kind === 'mismatch') {
    return errorResponse('BAD_REQUEST', 400);
  }
  if (markerAcquisition.kind === 'in_progress') {
    return errorResponse('UPLOAD_INCOMPLETE', 409);
  }

  if (markerAcquisition.kind === 'completed') {
    const finalizedChunks: Array<{
      index: number;
      sourceStorageKey: string;
      storageKey: string;
      ciphertextBytes: number;
      ciphertextHash: HexString;
      etag: string;
    }> = [];

    for (const chunk of sortedChunks) {
      const sourceStorageKey = buildMultipartChunkStorageKey(
        uploadSession.channelUuid,
        parsed.data.uploadId as Base64Url,
        chunk.index
      );
      const finalStorageKey = buildMultipartFinalStorageKey(
        uploadSession.channelUuid,
        parsed.data.uploadId as Base64Url,
        chunk.index
      );
      const finalizedObject = await env.FILE_BUCKET.head(finalStorageKey);
      if (!finalizedObject || finalizedObject.size !== chunk.ciphertextBytes) {
        return errorResponse('UPLOAD_INCOMPLETE', 409);
      }

      finalizedChunks.push({
        index: chunk.index,
        sourceStorageKey,
        storageKey: finalStorageKey,
        ciphertextBytes: chunk.ciphertextBytes,
        ciphertextHash: chunk.ciphertextHash,
        etag: chunk.etag,
      });
    }

    return jsonResponse(
      makeFileCompleteResponse(buildMultipartFileRef(uploadSession, parsed.data, finalizedChunks)),
      200
    );
  }

  const completionMarkerETag = markerAcquisition.etag;
  const resolvedChunks: Array<{
    index: number;
    sourceStorageKey: string;
    storageKey: string;
    ciphertextBytes: number;
    ciphertextHash: HexString;
    etag: string;
  }> = [];

  try {
    for (const chunk of sortedChunks) {
      const storageKey = buildMultipartChunkStorageKey(
        uploadSession.channelUuid,
        parsed.data.uploadId as Base64Url,
        chunk.index
      );
      const finalStorageKey = buildMultipartFinalStorageKey(
        uploadSession.channelUuid,
        parsed.data.uploadId as Base64Url,
        chunk.index
      );
      const storedObject = await env.FILE_BUCKET.head(storageKey);
      if (!storedObject) {
        throw new MultipartCompletionError(
          'UPLOAD_INCOMPLETE',
          409,
          `missing multipart chunk: ${storageKey}`
        );
      }
      if (storedObject.size !== chunk.ciphertextBytes) {
        throw new MultipartCompletionError(
          'BAD_REQUEST',
          400,
          `multipart chunk size mismatch: ${storageKey}`
        );
      }
      if (storedObject.etag !== chunk.etag) {
        throw new MultipartCompletionError(
          'UPLOAD_INCOMPLETE',
          409,
          `multipart chunk changed before finalization: ${storageKey}`
        );
      }

      resolvedChunks.push({
        index: chunk.index,
        sourceStorageKey: storageKey,
        storageKey: finalStorageKey,
        ciphertextBytes: chunk.ciphertextBytes,
        ciphertextHash: chunk.ciphertextHash,
        etag: chunk.etag,
      });
    }

    for (const chunk of resolvedChunks) {
      const sourceObject = await env.FILE_BUCKET.get(chunk.sourceStorageKey, {
        onlyIf: {
          etagMatches: chunk.etag,
        },
      });
      if (!sourceObject || !('arrayBuffer' in sourceObject)) {
        throw new MultipartCompletionError(
          'UPLOAD_INCOMPLETE',
          409,
          `multipart chunk changed during finalization: ${chunk.sourceStorageKey}`
        );
      }

      await env.FILE_BUCKET.put(chunk.storageKey, await sourceObject.arrayBuffer(), {
        httpMetadata: {
          contentType: 'application/octet-stream',
        },
        customMetadata: {
          channelUuid: uploadSession.channelUuid,
          uploadId: parsed.data.uploadId,
          chunkIndex: String(chunk.index),
          expiresAt: String(uploadSession.expiresAt),
        },
      });
    }

    const completedMarker = await transitionMultipartCompletionMarker(
      env.FILE_BUCKET,
      completionMarkerKey,
      markerContext,
      completionMarkerETag,
      'completed'
    );
    if (!completedMarker) {
      throw new MultipartCompletionError(
        'UPLOAD_INCOMPLETE',
        409,
        'multipart completion lease was lost'
      );
    }
  } catch (error) {
    await transitionMultipartCompletionMarker(
      env.FILE_BUCKET,
      completionMarkerKey,
      markerContext,
      completionMarkerETag,
      'released'
    ).catch(() => undefined);
    if (error instanceof MultipartCompletionError) {
      return errorResponse(error.code, error.status);
    }
    throw error;
  }

  return jsonResponse(
    makeFileCompleteResponse(buildMultipartFileRef(uploadSession, parsed.data, resolvedChunks)),
    200
  );
}

export async function handleFileFetch(env: Env, uuid: string): Promise<Response> {
  const filePayload = await forwardFilePayloadLookup(env, uuid);
  if (!filePayload.ok) {
    return errorResponse(filePayload.error.code, filePayload.error.status);
  }

  const now = Date.now() as UnixMs;
  const response = FileFetchResponseSchema.parse({
    ok: true,
    chunks: await Promise.all(
      filePayload.data.fileRef.chunks.map(async (chunk) => ({
        index: chunk.index,
        downloadUrl: `/api/file/dl/${uuid}/${chunk.index}?token=${await createFileDownloadToken(
          env.COMMIT_TOKEN_SECRET,
          {
            v: '2',
            channelUuid: uuid as UUID,
            version: filePayload.data.cipherVersion,
            index: chunk.index,
            storageKey: chunk.storageKey,
            ciphertextHash: chunk.ciphertextHash,
            issuedAt: now,
            expiresAt: (Number(now) + FILE_DOWNLOAD_TTL_MS) as UnixMs,
          }
        )}`,
      }))
    ),
  });
  return jsonResponse(response, 200);
}

export async function handleFileDownload(
  request: Request,
  env: Env,
  uuid: string,
  index: number
): Promise<Response> {
  if (!env.FILE_BUCKET || !Number.isInteger(index) || index < 0) {
    return errorResponse('BAD_REQUEST', 400);
  }

  const token = new URL(request.url).searchParams.get('token');
  const downloadSession = token
    ? await parseFileDownloadToken(env.COMMIT_TOKEN_SECRET, token)
    : null;
  if (
    !downloadSession ||
    downloadSession.channelUuid !== uuid ||
    downloadSession.index !== index ||
    Number(downloadSession.expiresAt) < Date.now()
  ) {
    return errorResponse('NOT_FOUND', 404);
  }

  const filePayload = await forwardFilePayloadLookup(env, uuid);
  if (
    !filePayload.ok ||
    (downloadSession.v === '2' && filePayload.data.cipherVersion !== downloadSession.version)
  ) {
    return errorResponse('NOT_FOUND', 404);
  }

  const currentChunk = filePayload.data.fileRef.chunks[downloadSession.index];
  if (
    !currentChunk ||
    currentChunk.storageKey !== downloadSession.storageKey ||
    (downloadSession.v === '2' && currentChunk.ciphertextHash !== downloadSession.ciphertextHash)
  ) {
    return errorResponse('NOT_FOUND', 404);
  }

  const object = await env.FILE_BUCKET.get(currentChunk.storageKey);
  if (!object) {
    return errorResponse('NOT_FOUND', 404);
  }

  const headers = buildHeaders();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, {
    status: 200,
    headers,
  });
}
