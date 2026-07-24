type StoredR2Object = {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
};

function cloneBytes(bytes: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function toUint8Array(
  value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof value === 'string') {
    return Promise.resolve(cloneBytes(new TextEncoder().encode(value)));
  }

  if (value instanceof Blob) {
    return value.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }

  if (value instanceof ReadableStream) {
    return new Response(value as unknown as BodyInit)
      .arrayBuffer()
      .then((buffer) => new Uint8Array(buffer));
  }

  if (value instanceof ArrayBuffer) {
    return Promise.resolve(new Uint8Array(value));
  }

  return Promise.resolve(
    cloneBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  );
}

async function createEtag(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  )}"`;
}

function createObjectBody(key: string, stored: StoredR2Object): R2ObjectBody {
  return {
    key,
    version: 'test-version',
    size: stored.bytes.byteLength,
    etag: stored.etag,
    httpEtag: stored.etag,
    checksums: {
      toJSON(): R2StringChecksums {
        return {};
      },
    },
    uploaded: stored.uploaded,
    ...(stored.customMetadata ? { customMetadata: stored.customMetadata } : {}),
    storageClass: 'STANDARD',
    get body(): ReadableStream {
      return new Blob([stored.bytes]).stream();
    },
    get bodyUsed(): boolean {
      return false;
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      return stored.bytes.slice().buffer;
    },
    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
      return stored.bytes.slice();
    },
    async text(): Promise<string> {
      return new TextDecoder().decode(stored.bytes);
    },
    async json<T>(): Promise<T> {
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as T;
    },
    async blob(): Promise<Blob> {
      return new Blob([stored.bytes]);
    },
    writeHttpMetadata(_headers: Headers): void {},
  } as R2ObjectBody;
}

export function createMockR2Bucket(initialObjects?: Record<string, string>): R2Bucket {
  const objects = new Map<string, StoredR2Object>();

  if (initialObjects) {
    for (const [key, text] of Object.entries(initialObjects)) {
      objects.set(key, {
        bytes: cloneBytes(new TextEncoder().encode(text)),
        etag: `"seed-${key}"`,
        uploaded: new Date(),
      });
    }
  }

  return {
    async head(key: string): Promise<R2Object | null> {
      const stored = objects.get(key);
      if (!stored) {
        return null;
      }

      return createObjectBody(key, stored);
    },
    async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
      const stored = objects.get(key);
      if (!stored) {
        return null;
      }

      const onlyIf = options?.onlyIf;
      if (
        onlyIf &&
        !(onlyIf instanceof Headers) &&
        'etagMatches' in onlyIf &&
        onlyIf.etagMatches &&
        stored.etag !== onlyIf.etagMatches
      ) {
        return null;
      }

      return createObjectBody(key, stored);
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
      options?: R2PutOptions
    ): Promise<R2Object | null> {
      const onlyIf = options?.onlyIf;
      if (
        onlyIf &&
        !(onlyIf instanceof Headers) &&
        'etagDoesNotMatch' in onlyIf &&
        onlyIf.etagDoesNotMatch === '*' &&
        objects.has(key)
      ) {
        return null;
      }
      if (
        onlyIf &&
        !(onlyIf instanceof Headers) &&
        'etagMatches' in onlyIf &&
        onlyIf.etagMatches &&
        objects.get(key)?.etag !== onlyIf.etagMatches
      ) {
        return null;
      }

      const bytes = await toUint8Array(value);
      const etag = await createEtag(bytes);
      const stored: StoredR2Object = {
        bytes,
        etag,
        uploaded: new Date(),
      };
      if (options?.customMetadata) {
        stored.customMetadata = options.customMetadata;
      }
      objects.set(key, stored);
      return createObjectBody(key, stored) as R2Object;
    },
    async delete(key: string | string[]): Promise<void> {
      for (const entry of Array.isArray(key) ? key : [key]) {
        objects.delete(entry);
      }
    },
    async list(options?: R2ListOptions): Promise<R2Objects> {
      const prefix = options?.prefix ?? '';
      const listed = Array.from(objects.entries())
        .filter(([key]) => key.startsWith(prefix))
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, stored]) => createObjectBody(key, stored) as R2Object);

      return {
        objects: listed,
        truncated: false,
        delimitedPrefixes: [],
      } as R2Objects;
    },
  } as unknown as R2Bucket;
}
