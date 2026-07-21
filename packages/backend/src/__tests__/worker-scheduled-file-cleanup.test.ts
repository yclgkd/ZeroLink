import type { Base64Url, HexString, MultipartFileRef } from '@zerolink/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMultipartChunkStorageKey,
  buildMultipartFinalStorageKey,
  buildMultipartUploadCompletionMarkerKey,
  FILE_UPLOAD_TTL_MS,
} from '../file-storage.ts';
import type { Env } from '../index.ts';
import { createMockR2Bucket } from './helpers/r2-fixtures.ts';
import { dispatchScheduled, OTHER_UUID, VALID_UUID } from './helpers/worker-fixtures.ts';

function createScheduledCleanupEnv(activeFileRefs: Map<string, MultipartFileRef>): Env {
  const fileBucket = createMockR2Bucket();
  const namespace = {
    idFromName(name: string): DurableObjectId {
      return { toString: () => name } as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const channelUuid = id.toString();
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const request =
            input instanceof Request
              ? input
              : new Request(typeof input === 'string' ? input : input.toString(), init);
          const pathname = new URL(request.url).pathname;
          if (pathname !== '/get_file_payload') {
            return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
          }

          const fileRef = activeFileRefs.get(channelUuid);
          if (!fileRef) {
            return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND' }), { status: 404 });
          }

          return new Response(
            JSON.stringify({
              ok: true,
              payloadTransport: 'multipart',
              fileRef,
            }),
            { status: 200 }
          );
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;

  const assets = {
    async fetch(_request: Request): Promise<Response> {
      return new Response('<html>ZeroLink</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  } as unknown as Fetcher;

  return {
    SECRET_VAULT: namespace,
    ASSETS: assets,
    FILE_BUCKET: fileBucket,
    APP_ENV: 'test',
    COMMIT_TOKEN_SECRET: 'commit-token-secret',
    RP_ID: 'zerolink.test',
    RP_ORIGIN: 'https://zerolink.test',
  };
}

describe('backend worker scheduled cleanup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes stale orphan multipart chunks and preserves active or fresh objects', async () => {
    vi.useFakeTimers();

    const activeUploadId = 'active-upload' as Base64Url;
    const orphanUploadId = 'orphan-upload' as Base64Url;
    const freshUploadId = 'fresh-upload' as Base64Url;
    const foreignUploadId = 'foreign-upload' as Base64Url;

    const activeChunkKey = buildMultipartFinalStorageKey(VALID_UUID, activeUploadId, 0);
    const orphanChunkKey = buildMultipartChunkStorageKey(VALID_UUID, orphanUploadId, 0);
    const orphanCompletionMarkerKey = buildMultipartUploadCompletionMarkerKey(
      VALID_UUID,
      orphanUploadId
    );
    const freshChunkKey = buildMultipartChunkStorageKey(VALID_UUID, freshUploadId, 0);
    const foreignChunkKey = buildMultipartChunkStorageKey(OTHER_UUID, foreignUploadId, 0);

    const activeBody = 'active-body';
    const activeFileRef: MultipartFileRef = {
      storageBackend: 'r2',
      chunkSizeBytes: 8,
      chunkCount: 1,
      totalPlaintextBytes: 8,
      totalCiphertextBytes: activeBody.length,
      baseIv: 'base_iv' as Base64Url,
      encContentKey: 'enc_content_key' as Base64Url,
      chunks: [
        {
          index: 0,
          storageKey: activeChunkKey,
          ciphertextBytes: activeBody.length,
          ciphertextHash: 'a'.repeat(64) as HexString,
        },
      ],
    };

    const env = createScheduledCleanupEnv(new Map([[VALID_UUID, activeFileRef]]));
    if (!env.FILE_BUCKET) {
      throw new Error('expected FILE_BUCKET to be configured');
    }

    const nowMs = Date.parse('2026-04-02T08:00:00.000Z');
    const staleMs = nowMs - FILE_UPLOAD_TTL_MS - 1_000;
    const freshMs = nowMs - FILE_UPLOAD_TTL_MS + 60_000;

    vi.setSystemTime(staleMs);
    await env.FILE_BUCKET.put(activeChunkKey, activeBody);
    await env.FILE_BUCKET.put(orphanChunkKey, 'orphan-body');
    await env.FILE_BUCKET.put(orphanCompletionMarkerKey, '');
    await env.FILE_BUCKET.put(foreignChunkKey, 'foreign-body');

    vi.setSystemTime(freshMs);
    await env.FILE_BUCKET.put(freshChunkKey, 'fresh-body');

    vi.setSystemTime(nowMs);
    await dispatchScheduled(env, nowMs);

    expect(await env.FILE_BUCKET.head(activeChunkKey)).not.toBeNull();
    expect(await env.FILE_BUCKET.head(freshChunkKey)).not.toBeNull();
    expect(await env.FILE_BUCKET.head(orphanChunkKey)).toBeNull();
    expect(await env.FILE_BUCKET.head(orphanCompletionMarkerKey)).toBeNull();
    expect(await env.FILE_BUCKET.head(foreignChunkKey)).toBeNull();
  });
});
