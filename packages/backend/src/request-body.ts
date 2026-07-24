export const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the configured limit');
    this.name = 'RequestBodyTooLargeError';
  }
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
        await reader.cancel().catch(() => undefined);
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

export async function readJsonBody(
  request: Request,
  limit: number = MAX_JSON_BODY_BYTES
): Promise<unknown | null> {
  const bytes = await readRequestBytesUpToLimit(request, limit);
  if (bytes === null) {
    throw new RequestBodyTooLargeError();
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
