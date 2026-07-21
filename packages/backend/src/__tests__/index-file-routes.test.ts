import type { Base64Url, HexString, MultipartFileRef, UnixMs, UUID } from '@zerolink/shared';
import { describe, expect, it } from 'vitest';
import { resolveInlineFilePlaintextBytes } from '../file-policy.ts';
import { readRequestBytesUpToLimit } from '../file-routes.ts';
import { createFileDownloadToken, createFileUploadId } from '../file-storage.ts';
import { createMockEnv, dispatch, VALID_UUID } from './helpers/worker-fixtures.ts';

function asBase64Url(value: string): Base64Url {
  return value as Base64Url;
}

function makeCiphertextHash(char: string): HexString {
  return char.repeat(64) as HexString;
}

function buildMultipartFileRef(
  storageKey: string,
  ciphertextHash: HexString,
  ciphertextBytes = 24
): MultipartFileRef {
  return {
    storageBackend: 'r2',
    chunkSizeBytes: 8,
    chunkCount: 1,
    totalPlaintextBytes: 8,
    totalCiphertextBytes: ciphertextBytes,
    baseIv: asBase64Url('base_iv'),
    encContentKey: asBase64Url('enc_content_key'),
    chunks: [
      {
        index: 0,
        storageKey,
        ciphertextBytes,
        ciphertextHash,
      },
    ],
  };
}

describe('backend worker routing — file upload and fetch routes', () => {
  it('handles multipart initiate, chunk upload, completion, fetch, and download', async () => {
    let currentFileRef: MultipartFileRef | null = null;
    let currentCipherVersion = 0;
    const { env, calls } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({
            ok: true,
            state: 'locked',
            securityProfile: 'secure',
          }),
          { status: 200 }
        );
      }

      if (request.url.endsWith('/get_file_payload')) {
        if (!currentFileRef) {
          return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND' }), {
            status: 404,
          });
        }

        return new Response(
          JSON.stringify({
            ok: true,
            payloadTransport: 'multipart',
            fileRef: currentFileRef,
            cipherVersion: currentCipherVersion,
          }),
          { status: 200 }
        );
      }

      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), {
        status: 500,
      });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 32;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    const initiateResponse = await dispatch(env, '/api/file/initiate', 'POST', {
      channelUuid: VALID_UUID,
      chunkCount: 2,
      totalCiphertextBytes: 48,
    });
    const initiatePayload = (await initiateResponse.json()) as {
      ok: true;
      uploadId: string;
      chunks: Array<{ index: number; uploadUrl: string }>;
    };

    expect(initiateResponse.status).toBe(200);
    expect(initiatePayload.chunks).toHaveLength(2);
    expect(initiatePayload.chunks[0]?.uploadUrl).toContain(
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/0`
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/get_public_state');

    const chunk0Body = 'a'.repeat(24);
    const chunk1Body = 'b'.repeat(24);

    const chunk0Response = await dispatch(
      env,
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/0`,
      'PUT',
      chunk0Body,
      true
    );
    const chunk1Response = await dispatch(
      env,
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/1`,
      'PUT',
      chunk1Body,
      true
    );

    expect(chunk0Response.status).toBe(200);
    expect(chunk1Response.status).toBe(200);
    const chunk0Etag = chunk0Response.headers.get('ETag');
    const chunk1Etag = chunk1Response.headers.get('ETag');
    expect(chunk0Etag).toBeTruthy();
    expect(chunk1Etag).toBeTruthy();

    const completeResponse = await dispatch(env, '/api/file/complete', 'POST', {
      uploadId: initiatePayload.uploadId,
      baseIv: 'base_iv',
      encContentKey: 'enc_content_key',
      chunkSizeBytes: 8,
      totalPlaintextBytes: 16,
      totalCiphertextBytes: 48,
      chunks: [
        {
          index: 0,
          etag: chunk0Etag,
          ciphertextBytes: chunk0Body.length,
          ciphertextHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          index: 1,
          etag: chunk1Etag,
          ciphertextBytes: chunk1Body.length,
          ciphertextHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    });
    const completePayload = (await completeResponse.json()) as {
      ok: true;
      fileRef: MultipartFileRef;
    };

    expect(completeResponse.status).toBe(200);
    expect(completePayload.fileRef.storageBackend).toBe('r2');
    expect(completePayload.fileRef.chunks).toHaveLength(2);
    expect(completePayload.fileRef.chunks[0]?.storageKey).toContain('/final/');
    expect(completePayload.fileRef.chunks[1]?.storageKey).toContain('/final/');

    const lateChunkResponse = await dispatch(
      env,
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/0`,
      'PUT',
      'late',
      true
    );
    expect(lateChunkResponse.status).toBe(404);

    currentFileRef = completePayload.fileRef;
    currentCipherVersion = 0;

    const fetchResponse = await dispatch(env, `/api/file/fetch/${VALID_UUID}`, 'GET');
    const fetchPayload = (await fetchResponse.json()) as {
      ok: true;
      chunks: Array<{ index: number; downloadUrl: string }>;
    };

    expect(fetchResponse.status).toBe(200);
    expect(fetchPayload.chunks).toHaveLength(2);
    const firstDownloadUrl = new URL(
      fetchPayload.chunks[0]?.downloadUrl ?? '',
      'https://example.test'
    );
    const secondDownloadUrl = new URL(
      fetchPayload.chunks[1]?.downloadUrl ?? '',
      'https://example.test'
    );
    expect(firstDownloadUrl.pathname).toBe(`/api/file/dl/${VALID_UUID}/0`);
    expect(secondDownloadUrl.pathname).toBe(`/api/file/dl/${VALID_UUID}/1`);
    expect(firstDownloadUrl.searchParams.get('token')).toBeTruthy();
    expect(secondDownloadUrl.searchParams.get('token')).toBeTruthy();

    const downloadResponse = await dispatch(
      env,
      `${firstDownloadUrl.pathname}${firstDownloadUrl.search}`,
      'GET'
    );
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe(chunk0Body);

    expect(calls).toHaveLength(3);
    expect(calls[1]?.pathname).toBe('/get_file_payload');
    expect(calls[2]?.pathname).toBe('/get_file_payload');
  });

  it('rejects initiate requests that exceed deployment max file policy', async () => {
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          {
            status: 200,
          }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 32;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    const response = await dispatch(env, '/api/file/initiate', 'POST', {
      channelUuid: VALID_UUID,
      chunkCount: 1,
      totalCiphertextBytes: resolveInlineFilePlaintextBytes(32) + 17,
    });
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
  });

  it('rejects initiate requests that exceed deployment max chunks', async () => {
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          {
            status: 200,
          }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 16;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 2;

    const response = await dispatch(env, '/api/file/initiate', 'POST', {
      channelUuid: VALID_UUID,
      chunkCount: 3,
      totalCiphertextBytes: 48,
    });
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
  });

  it('rate limits initiate requests per caller and channel', async () => {
    const { env, calls } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          {
            status: 200,
          }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 32;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    const sharedHeaders = {
      'CF-Connecting-IP': '198.51.100.42',
      'User-Agent': 'curl/8.7.1',
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await dispatch(
        env,
        '/api/file/initiate',
        'POST',
        {
          channelUuid: VALID_UUID,
          chunkCount: 1,
          totalCiphertextBytes: 24,
        },
        false,
        sharedHeaders
      );
      expect(response.status).toBe(200);
    }

    const limitedResponse = await dispatch(
      env,
      '/api/file/initiate',
      'POST',
      {
        channelUuid: VALID_UUID,
        chunkCount: 1,
        totalCiphertextBytes: 24,
      },
      false,
      sharedHeaders
    );
    const limitedPayload = (await limitedResponse.json()) as { ok: false; code: string };

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('Retry-After')).toBeTruthy();
    expect(limitedPayload.code).toBe('RATE_LIMITED');

    const otherCallerResponse = await dispatch(
      env,
      '/api/file/initiate',
      'POST',
      {
        channelUuid: VALID_UUID,
        chunkCount: 1,
        totalCiphertextBytes: 24,
      },
      false,
      {
        'CF-Connecting-IP': '198.51.100.43',
        'User-Agent': 'curl/8.7.1',
      }
    );

    expect(otherCallerResponse.status).toBe(200);
    expect(calls).toHaveLength(12);
  });

  it('does not rate limit initiate requests for unknown channels', async () => {
    const { env, calls } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND' }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 32;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await dispatch(
        env,
        '/api/file/initiate',
        'POST',
        {
          channelUuid: VALID_UUID,
          chunkCount: 1,
          totalCiphertextBytes: 24,
        },
        false,
        {
          'CF-Connecting-IP': '198.51.100.42',
          'User-Agent': 'curl/8.7.1',
        }
      );
      const payload = (await response.json()) as { ok: false; code: string };

      expect(response.status).toBe(404);
      expect(payload.code).toBe('NOT_FOUND');
    }

    expect(calls).toHaveLength(11);
  });

  it('rejects chunk uploads larger than deployment chunk size', async () => {
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          {
            status: 200,
          }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 64;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    const initiateResponse = await dispatch(env, '/api/file/initiate', 'POST', {
      channelUuid: VALID_UUID,
      chunkCount: 1,
      totalCiphertextBytes: 24,
    });
    const initiatePayload = (await initiateResponse.json()) as {
      ok: true;
      uploadId: string;
    };

    const oversizedChunkResponse = await dispatch(
      env,
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/0`,
      'PUT',
      'x'.repeat(25),
      true
    );
    const payload = (await oversizedChunkResponse.json()) as { ok: false; code: string };

    expect(oversizedChunkResponse.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
  });

  it('stops reading stream bodies once the configured limit is exceeded', async () => {
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode('a'.repeat(8)));
          return;
        }
        if (pullCount === 2) {
          controller.enqueue(new TextEncoder().encode('b'.repeat(17)));
          return;
        }

        controller.error(new Error('reader consumed beyond limit'));
      },
    });
    const request = {
      headers: new Headers(),
      body: stream,
    } as unknown as Request;

    const bytes = await readRequestBytesUpToLimit(request, 24);

    expect(bytes).toBeNull();
    expect(pullCount).toBe(2);
  });

  it('rejects expired upload sessions on complete', async () => {
    const { env } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 64;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    const uploadId = await createFileUploadId(env.COMMIT_TOKEN_SECRET, {
      v: '1',
      channelUuid: VALID_UUID as UUID,
      chunkCount: 1,
      totalCiphertextBytes: 24,
      issuedAt: 1_700_000_000_000 as UnixMs,
      expiresAt: 1_700_000_000_001 as UnixMs,
    });

    const response = await dispatch(env, '/api/file/complete', 'POST', {
      uploadId,
      baseIv: 'YmFzZV9pdg',
      encContentKey: 'ZW5jX2NvbnRlbnRfa2V5',
      chunkSizeBytes: 8,
      totalPlaintextBytes: 8,
      totalCiphertextBytes: 24,
      chunks: [
        {
          index: 0,
          etag: 'etag-0',
          ciphertextBytes: 24,
          ciphertextHash: makeCiphertextHash('a'),
        },
      ],
    });
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
  });

  it('rejects invalid final chunk boundaries on complete', async () => {
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          {
            status: 200,
          }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    env.FILE_MULTIPART_SUPPORTED = 'true';
    env.FILE_MAX_BYTES = 128;
    env.FILE_MULTIPART_THRESHOLD_BYTES = 16;
    env.FILE_CHUNK_SIZE_BYTES = 8;
    env.FILE_MAX_CHUNKS = 4;

    const initiateResponse = await dispatch(env, '/api/file/initiate', 'POST', {
      channelUuid: VALID_UUID,
      chunkCount: 2,
      totalCiphertextBytes: 40,
    });
    const initiatePayload = (await initiateResponse.json()) as {
      ok: true;
      uploadId: string;
    };

    const chunk0Response = await dispatch(
      env,
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/0`,
      'PUT',
      'a'.repeat(24),
      true
    );
    const chunk1Response = await dispatch(
      env,
      `/api/file/chunk/${VALID_UUID}/${initiatePayload.uploadId}/1`,
      'PUT',
      'b'.repeat(16),
      true
    );

    const response = await dispatch(env, '/api/file/complete', 'POST', {
      uploadId: initiatePayload.uploadId,
      baseIv: 'YmFzZV9pdg',
      encContentKey: 'ZW5jX2NvbnRlbnRfa2V5',
      chunkSizeBytes: 8,
      totalPlaintextBytes: 8,
      totalCiphertextBytes: 40,
      chunks: [
        {
          index: 0,
          etag: chunk0Response.headers.get('ETag'),
          ciphertextBytes: 24,
          ciphertextHash: makeCiphertextHash('a'),
        },
        {
          index: 1,
          etag: chunk1Response.headers.get('ETag'),
          ciphertextBytes: 16,
          ciphertextHash: makeCiphertextHash('b'),
        },
      ],
    });
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
  });

  it('invalidates old download tokens after a file replacement', async () => {
    let currentFileRef = buildMultipartFileRef(
      'files/original-upload/0000.bin',
      makeCiphertextHash('a')
    );
    let currentCipherVersion = 0;
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_file_payload')) {
        return new Response(
          JSON.stringify({
            ok: true,
            payloadTransport: 'multipart',
            fileRef: currentFileRef,
            cipherVersion: currentCipherVersion,
          }),
          { status: 200 }
        );
      }
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    const originalChunk = currentFileRef.chunks[0];
    expect(originalChunk).toBeDefined();
    if (!originalChunk) {
      throw new Error('expected original chunk');
    }
    await env.FILE_BUCKET?.put(originalChunk.storageKey, 'original-chunk');

    const fetchResponse = await dispatch(env, `/api/file/fetch/${VALID_UUID}`, 'GET');
    const fetchPayload = (await fetchResponse.json()) as {
      ok: true;
      chunks: Array<{ index: number; downloadUrl: string }>;
    };
    const initialChunk = fetchPayload.chunks[0];
    expect(initialChunk).toBeDefined();
    if (!initialChunk) {
      throw new Error('expected initial download target');
    }
    const oldDownloadUrl = new URL(initialChunk.downloadUrl, 'https://example.test');

    currentFileRef = buildMultipartFileRef(
      'files/replaced-upload/0000.bin',
      makeCiphertextHash('b')
    );
    currentCipherVersion = 1;
    await env.FILE_BUCKET?.delete('files/original-upload/0000.bin');
    const replacedChunk = currentFileRef.chunks[0];
    expect(replacedChunk).toBeDefined();
    if (!replacedChunk) {
      throw new Error('expected replaced chunk');
    }
    await env.FILE_BUCKET?.put(replacedChunk.storageKey, 'replaced-chunk');

    const oldDownloadResponse = await dispatch(
      env,
      `${oldDownloadUrl.pathname}${oldDownloadUrl.search}`,
      'GET'
    );
    const oldPayload = (await oldDownloadResponse.json()) as { ok: false; code: string };

    expect(oldDownloadResponse.status).toBe(404);
    expect(oldPayload.code).toBe('NOT_FOUND');
  });

  it('invalidates old download tokens after channel deletion', async () => {
    let currentFileRef: MultipartFileRef | null = buildMultipartFileRef(
      'files/deleted-upload/0000.bin',
      makeCiphertextHash('c')
    );
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_file_payload')) {
        if (!currentFileRef) {
          return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND' }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            payloadTransport: 'multipart',
            fileRef: currentFileRef,
            cipherVersion: 0,
          }),
          { status: 200 }
        );
      }
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    const deletedChunk = currentFileRef.chunks[0];
    expect(deletedChunk).toBeDefined();
    if (!deletedChunk) {
      throw new Error('expected deleted-channel chunk');
    }
    await env.FILE_BUCKET?.put(deletedChunk.storageKey, 'deleted-chunk');

    const fetchResponse = await dispatch(env, `/api/file/fetch/${VALID_UUID}`, 'GET');
    const fetchPayload = (await fetchResponse.json()) as {
      ok: true;
      chunks: Array<{ index: number; downloadUrl: string }>;
    };
    const deletedDownloadTarget = fetchPayload.chunks[0];
    expect(deletedDownloadTarget).toBeDefined();
    if (!deletedDownloadTarget) {
      throw new Error('expected deleted-channel download target');
    }
    const oldDownloadUrl = new URL(deletedDownloadTarget.downloadUrl, 'https://example.test');

    currentFileRef = null;
    await env.FILE_BUCKET?.delete('files/deleted-upload/0000.bin');

    const oldDownloadResponse = await dispatch(
      env,
      `${oldDownloadUrl.pathname}${oldDownloadUrl.search}`,
      'GET'
    );
    const oldPayload = (await oldDownloadResponse.json()) as { ok: false; code: string };

    expect(oldDownloadResponse.status).toBe(404);
    expect(oldPayload.code).toBe('NOT_FOUND');
  });

  it('rejects download tokens whose storage binding does not match the current fileRef', async () => {
    const currentFileRef = buildMultipartFileRef(
      'files/current-upload/0000.bin',
      makeCiphertextHash('d')
    );
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_file_payload')) {
        return new Response(
          JSON.stringify({
            ok: true,
            payloadTransport: 'multipart',
            fileRef: currentFileRef,
            cipherVersion: 0,
          }),
          { status: 200 }
        );
      }
      if (request.url.endsWith('/get_public_state')) {
        return new Response(
          JSON.stringify({ ok: true, state: 'locked', securityProfile: 'secure' }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    const boundChunk = currentFileRef.chunks[0];
    expect(boundChunk).toBeDefined();
    if (!boundChunk) {
      throw new Error('expected bound chunk');
    }
    await env.FILE_BUCKET?.put(boundChunk.storageKey, 'bound-chunk');

    const forgedToken = await createFileDownloadToken(env.COMMIT_TOKEN_SECRET, {
      v: '2',
      channelUuid: VALID_UUID as UUID,
      version: 0,
      index: 0,
      storageKey: 'files/forged-upload/0000.bin',
      ciphertextHash: boundChunk.ciphertextHash,
      issuedAt: 1_730_000_000_000 as UnixMs,
      expiresAt: 4_730_000_000_000 as UnixMs,
    });

    const response = await dispatch(
      env,
      `/api/file/dl/${VALID_UUID}/0?token=${forgedToken}`,
      'GET'
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(404);
    expect(payload.code).toBe('NOT_FOUND');
  });

  it('preserves upstream not-found errors instead of masking them as multipart mismatches', async () => {
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_file_payload')) {
        return new Response(JSON.stringify({ ok: false, code: 'NOT_FOUND' }), { status: 404 });
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    const response = await dispatch(env, `/api/file/fetch/${VALID_UUID}`, 'GET');
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(404);
    expect(payload.code).toBe('NOT_FOUND');
  });

  it('returns CHANNEL_NOT_MULTIPART only when the delivered payload is actually inline', async () => {
    const { env } = createMockEnv(async (request) => {
      if (request.url.endsWith('/get_file_payload')) {
        return new Response(
          JSON.stringify({
            ok: true,
            payloadTransport: 'inline',
            cipherVersion: 1,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), { status: 500 });
    });

    const response = await dispatch(env, `/api/file/fetch/${VALID_UUID}`, 'GET');
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(409);
    expect(payload.code).toBe('CHANNEL_NOT_MULTIPART');
  });
});
