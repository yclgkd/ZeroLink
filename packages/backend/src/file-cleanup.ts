import type { MultipartFileRef } from '@zerolink/shared';
import { FILE_UPLOAD_TTL_MS } from './file-storage.ts';

const FILE_CHUNK_KEY_PATTERN = /^files\/([^/]+)\/([^/]+)\/(?:(?:final\/)?\d{4}\.bin|complete)$/u;
const FILE_LIST_BATCH_SIZE = 1000;
const FILE_DELETE_BATCH_SIZE = 1000;

interface FileCleanupEnv {
  FILE_BUCKET?: R2Bucket;
  SECRET_VAULT: DurableObjectNamespace;
}

interface ListedChunkObject {
  key: string;
  channelUuid: string;
  uploadedAtMs: number;
}

export interface MultipartOrphanCleanupSummary {
  scannedChannels: number;
  scannedObjects: number;
  deletedObjects: number;
  keptActiveObjects: number;
  skippedFreshObjects: number;
  skippedMalformedObjects: number;
  skippedLookupErrorObjects: number;
}

function createEmptySummary(): MultipartOrphanCleanupSummary {
  return {
    scannedChannels: 0,
    scannedObjects: 0,
    deletedObjects: 0,
    keptActiveObjects: 0,
    skippedFreshObjects: 0,
    skippedMalformedObjects: 0,
    skippedLookupErrorObjects: 0,
  };
}

function parseChunkObject(object: R2Object): ListedChunkObject | null {
  const match = object.key.match(FILE_CHUNK_KEY_PATTERN);
  if (!match) {
    return null;
  }

  return {
    key: object.key,
    channelUuid: match[1] ?? '',
    uploadedAtMs: object.uploaded.getTime(),
  };
}

async function listChunkObjects(bucket: R2Bucket): Promise<{
  chunkObjects: ListedChunkObject[];
  malformedObjects: number;
}> {
  const chunkObjects: ListedChunkObject[] = [];
  let malformedObjects = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await bucket.list({
      prefix: 'files/',
      limit: FILE_LIST_BATCH_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (const object of page.objects) {
      const parsedObject = parseChunkObject(object);
      if (!parsedObject) {
        malformedObjects += 1;
        continue;
      }

      chunkObjects.push(parsedObject);
    }

    if (!page.truncated) {
      break;
    }

    const nextCursor = 'cursor' in page ? page.cursor : undefined;
    if (!nextCursor) {
      break;
    }
    cursor = nextCursor;
  }

  return { chunkObjects, malformedObjects };
}

async function loadActiveMultipartFileRef(
  env: FileCleanupEnv,
  channelUuid: string
): Promise<MultipartFileRef | null> {
  const durableObjectId = env.SECRET_VAULT.idFromName(channelUuid);
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
    fileRef?: MultipartFileRef;
    payloadTransport?: string;
  } | null;
  if (
    !response.ok ||
    !payload?.ok ||
    payload.payloadTransport !== 'multipart' ||
    !payload.fileRef
  ) {
    return null;
  }

  return payload.fileRef;
}

async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += FILE_DELETE_BATCH_SIZE) {
    await bucket.delete(keys.slice(start, start + FILE_DELETE_BATCH_SIZE));
  }
}

export async function cleanupOrphanMultipartChunks(
  env: FileCleanupEnv,
  now: number = Date.now()
): Promise<MultipartOrphanCleanupSummary> {
  const summary = createEmptySummary();
  if (!env.FILE_BUCKET) {
    return summary;
  }

  const { chunkObjects, malformedObjects } = await listChunkObjects(env.FILE_BUCKET);
  summary.scannedObjects = chunkObjects.length + malformedObjects;
  summary.skippedMalformedObjects = malformedObjects;

  const staleBeforeMs = now - FILE_UPLOAD_TTL_MS;
  const objectsByChannel = new Map<string, ListedChunkObject[]>();

  for (const object of chunkObjects) {
    const channelObjects = objectsByChannel.get(object.channelUuid);
    if (channelObjects) {
      channelObjects.push(object);
      continue;
    }
    objectsByChannel.set(object.channelUuid, [object]);
  }

  summary.scannedChannels = objectsByChannel.size;

  const keysToDelete: string[] = [];

  for (const [channelUuid, channelObjects] of objectsByChannel) {
    const staleChannelObjects = channelObjects.filter(
      (object) => object.uploadedAtMs <= staleBeforeMs
    );
    if (staleChannelObjects.length === 0) {
      summary.skippedFreshObjects += channelObjects.length;
      continue;
    }

    let activeStorageKeys = new Set<string>();
    try {
      const activeFileRef = await loadActiveMultipartFileRef(env, channelUuid);
      if (activeFileRef) {
        activeStorageKeys = new Set(activeFileRef.chunks.map((chunk) => chunk.storageKey));
      }
    } catch {
      summary.skippedLookupErrorObjects += channelObjects.length;
      continue;
    }

    for (const object of channelObjects) {
      if (activeStorageKeys.has(object.key)) {
        summary.keptActiveObjects += 1;
        continue;
      }

      if (object.uploadedAtMs > staleBeforeMs) {
        summary.skippedFreshObjects += 1;
        continue;
      }

      keysToDelete.push(object.key);
    }
  }

  if (keysToDelete.length > 0) {
    await deleteObjects(env.FILE_BUCKET, keysToDelete);
    summary.deletedObjects = keysToDelete.length;
  }

  return summary;
}
