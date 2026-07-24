import type {
  Base64Url,
  FileUploadCompleteRequest,
  FileUploadCompleteResponse,
  FileUploadInitiateResponse,
  HexString,
  MultipartFileRef,
  MultipartFileRefChunk,
  UnixMs,
  UUID,
} from '@zerolink/shared';
import {
  constantTimeEqual,
  decodeBase64Url,
  encodeBase64Url,
  getCryptoApi,
  toArrayBufferBytes,
} from './crypto/bytes.ts';

export interface FileUploadSession {
  v: '1';
  channelUuid: UUID;
  chunkCount: number;
  totalCiphertextBytes: number;
  issuedAt: UnixMs;
  expiresAt: UnixMs;
}

export interface FileDownloadSession {
  v: '1' | '2';
  channelUuid: UUID;
  version?: number;
  index: number;
  storageKey: string;
  ciphertextHash?: HexString;
  issuedAt: UnixMs;
  expiresAt: UnixMs;
}

export interface MultipartChunkUploadResult {
  storageKey: string;
  ciphertextBytes: number;
  ciphertextHash: HexString;
  etag: string;
}

interface SerializedFileUploadSessionRecord {
  v: unknown;
  channelUuid: unknown;
  chunkCount: unknown;
  totalCiphertextBytes: unknown;
  issuedAt: unknown;
  expiresAt: unknown;
}

interface SerializedFileDownloadSessionRecord {
  v: unknown;
  channelUuid: unknown;
  version: unknown;
  index: unknown;
  storageKey: unknown;
  ciphertextHash: unknown;
  issuedAt: unknown;
  expiresAt: unknown;
}

const FILE_CHUNK_PREFIX = 'files';
const FILE_CHUNK_SUFFIX = 'bin';
const FILE_UPLOAD_TOKEN_DOMAIN = 'zl-file-upload-v1\0';
const FILE_DOWNLOAD_TOKEN_DOMAIN = 'zl-file-download-v1\0';
export const FILE_UPLOAD_TTL_MS = 15 * 60 * 1000;
export const FILE_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const HEX_64_REGEX = /^[a-f0-9]{64}$/u;

function serializeFileUploadSession(session: FileUploadSession): string {
  return JSON.stringify({
    v: session.v,
    channelUuid: session.channelUuid,
    chunkCount: session.chunkCount,
    totalCiphertextBytes: session.totalCiphertextBytes,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  });
}

function serializeFileDownloadSession(session: FileDownloadSession): string {
  return JSON.stringify({
    v: session.v,
    channelUuid: session.channelUuid,
    version: session.version,
    index: session.index,
    storageKey: session.storageKey,
    ciphertextHash: session.ciphertextHash,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  });
}

function parseFileUploadSession(value: unknown): FileUploadSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as SerializedFileUploadSessionRecord;
  const v = record.v;
  const channelUuid = record.channelUuid;
  const chunkCount = record.chunkCount;
  const totalCiphertextBytes = record.totalCiphertextBytes;
  const issuedAt = record.issuedAt;
  const expiresAt = record.expiresAt;

  if (
    v !== '1' ||
    typeof channelUuid !== 'string' ||
    channelUuid.length === 0 ||
    typeof chunkCount !== 'number' ||
    !Number.isInteger(chunkCount) ||
    chunkCount <= 0 ||
    typeof totalCiphertextBytes !== 'number' ||
    !Number.isInteger(totalCiphertextBytes) ||
    totalCiphertextBytes <= 0 ||
    typeof issuedAt !== 'number' ||
    !Number.isInteger(issuedAt) ||
    issuedAt < 0 ||
    typeof expiresAt !== 'number' ||
    !Number.isInteger(expiresAt) ||
    expiresAt < 0
  ) {
    return null;
  }

  return {
    v: '1',
    channelUuid: channelUuid as UUID,
    chunkCount: chunkCount as number,
    totalCiphertextBytes: totalCiphertextBytes as number,
    issuedAt: issuedAt as UnixMs,
    expiresAt: expiresAt as UnixMs,
  };
}

function parseFileDownloadSession(value: unknown): FileDownloadSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as SerializedFileDownloadSessionRecord;
  const v = record.v;
  const channelUuid = record.channelUuid;
  const version = record.version;
  const index = record.index;
  const storageKey = record.storageKey;
  const ciphertextHash = record.ciphertextHash;
  const issuedAt = record.issuedAt;
  const expiresAt = record.expiresAt;

  if (
    (v !== '1' && v !== '2') ||
    typeof channelUuid !== 'string' ||
    channelUuid.length === 0 ||
    typeof index !== 'number' ||
    !Number.isInteger(index) ||
    index < 0 ||
    typeof storageKey !== 'string' ||
    storageKey.length === 0 ||
    typeof issuedAt !== 'number' ||
    !Number.isInteger(issuedAt) ||
    issuedAt < 0 ||
    typeof expiresAt !== 'number' ||
    !Number.isInteger(expiresAt) ||
    expiresAt < 0
  ) {
    return null;
  }

  if (v === '2') {
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 0 ||
      typeof ciphertextHash !== 'string' ||
      !HEX_64_REGEX.test(ciphertextHash)
    ) {
      return null;
    }

    return {
      v: '2',
      channelUuid: channelUuid as UUID,
      version,
      index,
      storageKey,
      ciphertextHash: ciphertextHash as HexString,
      issuedAt: issuedAt as UnixMs,
      expiresAt: expiresAt as UnixMs,
    };
  }

  return {
    v: '1',
    channelUuid: channelUuid as UUID,
    index,
    storageKey,
    issuedAt: issuedAt as UnixMs,
    expiresAt: expiresAt as UnixMs,
  };
}

async function signHmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const cryptoApi = getCryptoApi();
  const key = await cryptoApi.subtle.importKey(
    'raw',
    toArrayBufferBytes(new TextEncoder().encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await cryptoApi.subtle.sign(
    'HMAC',
    key,
    toArrayBufferBytes(new TextEncoder().encode(payload))
  );
  return new Uint8Array(signature);
}

export function buildMultipartChunkStorageKey(
  channelUuid: string,
  uploadId: Base64Url,
  index: number
): string {
  return `${FILE_CHUNK_PREFIX}/${channelUuid}/${uploadId}/${String(index).padStart(4, '0')}.${FILE_CHUNK_SUFFIX}`;
}

export function buildMultipartFinalStorageKey(
  channelUuid: string,
  uploadId: Base64Url,
  index: number
): string {
  return `${FILE_CHUNK_PREFIX}/${channelUuid}/${uploadId}/final/${String(index).padStart(4, '0')}.${FILE_CHUNK_SUFFIX}`;
}

export function buildMultipartUploadCompletionMarkerKey(
  channelUuid: string,
  uploadId: Base64Url
): string {
  return `${FILE_CHUNK_PREFIX}/${channelUuid}/${uploadId}/complete`;
}

export async function createFileUploadId(
  secret: string,
  session: FileUploadSession
): Promise<Base64Url> {
  const payload = serializeFileUploadSession(session);
  const payloadBytes = new TextEncoder().encode(payload);
  const signature = await signHmacSha256(secret, `${FILE_UPLOAD_TOKEN_DOMAIN}${payload}`);
  const tokenBytes = new Uint8Array(payloadBytes.byteLength + 1 + signature.byteLength);
  tokenBytes.set(payloadBytes, 0);
  tokenBytes[payloadBytes.byteLength] = 0;
  tokenBytes.set(signature, payloadBytes.byteLength + 1);
  return encodeBase64Url(tokenBytes);
}

export async function createFileDownloadToken(
  secret: string,
  session: FileDownloadSession
): Promise<Base64Url> {
  const payload = serializeFileDownloadSession(session);
  const payloadBytes = new TextEncoder().encode(payload);
  const signature = await signHmacSha256(secret, `${FILE_DOWNLOAD_TOKEN_DOMAIN}${payload}`);
  const tokenBytes = new Uint8Array(payloadBytes.byteLength + 1 + signature.byteLength);
  tokenBytes.set(payloadBytes, 0);
  tokenBytes[payloadBytes.byteLength] = 0;
  tokenBytes.set(signature, payloadBytes.byteLength + 1);
  return encodeBase64Url(tokenBytes);
}

export async function parseFileUploadId(
  secret: string,
  uploadId: string
): Promise<FileUploadSession | null> {
  let tokenBytes: Uint8Array;
  try {
    tokenBytes = decodeBase64Url(uploadId);
  } catch {
    return null;
  }

  const separatorIndex = tokenBytes.indexOf(0);
  if (separatorIndex <= 0 || separatorIndex >= tokenBytes.byteLength - 1) {
    return null;
  }

  const payloadBytes = tokenBytes.slice(0, separatorIndex);
  const signatureBytes = tokenBytes.slice(separatorIndex + 1);
  const payload = new TextDecoder().decode(payloadBytes);
  const expectedSignature = await signHmacSha256(secret, `${FILE_UPLOAD_TOKEN_DOMAIN}${payload}`);
  if (!constantTimeEqual(encodeBase64Url(signatureBytes), encodeBase64Url(expectedSignature))) {
    return null;
  }

  try {
    return parseFileUploadSession(JSON.parse(payload));
  } catch {
    return null;
  }
}

export async function parseFileDownloadToken(
  secret: string,
  token: string
): Promise<FileDownloadSession | null> {
  let tokenBytes: Uint8Array;
  try {
    tokenBytes = decodeBase64Url(token);
  } catch {
    return null;
  }

  const separatorIndex = tokenBytes.indexOf(0);
  if (separatorIndex <= 0 || separatorIndex >= tokenBytes.byteLength - 1) {
    return null;
  }

  const payloadBytes = tokenBytes.slice(0, separatorIndex);
  const signatureBytes = tokenBytes.slice(separatorIndex + 1);
  const payload = new TextDecoder().decode(payloadBytes);
  const expectedSignature = await signHmacSha256(secret, `${FILE_DOWNLOAD_TOKEN_DOMAIN}${payload}`);
  if (!constantTimeEqual(encodeBase64Url(signatureBytes), encodeBase64Url(expectedSignature))) {
    return null;
  }

  try {
    return parseFileDownloadSession(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function buildMultipartFileRef(
  fileUpload: Pick<FileUploadSession, 'channelUuid' | 'chunkCount' | 'totalCiphertextBytes'>,
  request: FileUploadCompleteRequest,
  chunkResults: MultipartChunkUploadResult[]
): MultipartFileRef {
  return {
    storageBackend: 'r2',
    chunkSizeBytes: request.chunkSizeBytes,
    chunkCount: fileUpload.chunkCount,
    totalPlaintextBytes: request.totalPlaintextBytes,
    totalCiphertextBytes: fileUpload.totalCiphertextBytes,
    baseIv: request.baseIv,
    encContentKey: request.encContentKey,
    chunks: chunkResults.map<MultipartFileRefChunk>((chunk, index) => ({
      index,
      storageKey: chunk.storageKey,
      ciphertextBytes: chunk.ciphertextBytes,
      ciphertextHash: chunk.ciphertextHash,
    })),
  };
}

export async function assertMultipartChunksExist(
  bucket: R2Bucket,
  fileRef: MultipartFileRef
): Promise<void> {
  for (const chunk of fileRef.chunks) {
    const object = await bucket.head(chunk.storageKey);
    if (!object) {
      throw new Error(`missing multipart chunk: ${chunk.storageKey}`);
    }
    if (object.size !== chunk.ciphertextBytes) {
      throw new Error(`multipart chunk size mismatch: ${chunk.storageKey}`);
    }
  }
}

export async function deleteMultipartChunks(
  bucket: R2Bucket | undefined,
  fileRef: MultipartFileRef | undefined
): Promise<void> {
  if (!bucket || !fileRef || fileRef.chunks.length === 0) {
    return;
  }

  await bucket.delete(fileRef.chunks.map((chunk) => chunk.storageKey));
}

export function makeFileUploadResponse(
  uploadId: Base64Url,
  chunkCount: number,
  requestUrl: string,
  channelUuid: UUID
): FileUploadInitiateResponse {
  return {
    ok: true,
    uploadId,
    chunks: Array.from({ length: chunkCount }, (_unused, index) => ({
      index,
      uploadUrl: new URL(
        `/api/file/chunk/${channelUuid}/${uploadId}/${index}`,
        requestUrl
      ).toString(),
    })),
  };
}

export function makeFileCompleteResponse(fileRef: MultipartFileRef): FileUploadCompleteResponse {
  return { ok: true, fileRef };
}
