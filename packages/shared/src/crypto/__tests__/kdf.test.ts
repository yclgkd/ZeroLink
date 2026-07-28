import { afterEach, describe, expect, it, vi } from 'vitest';

import { AES_GCM, ARGON2ID, ECDSA } from '../../constants.ts';
import type { WrappedPrivateKey } from '../../types.ts';
import type { Argon2idKdfParams } from '../kdf.ts';
import { unwrapEcdsaPrivateKey, unwrapPrivateKey, wrapPrivateKey } from '../kdf.ts';
import { generateReceiverKeyPair, unwrapContentKey, wrapContentKey } from '../rsa.ts';

const TEST_TIMEOUT_MS = 30_000;
const FAST_TEST_ARGON2ID_KDF_PARAMS: Argon2idKdfParams = {
  m: 1_024,
  t: 1,
  p: 1,
  version: 19,
};

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function tamperBase64Url(value: string): string {
  const firstChar = value[0];
  const replacement = firstChar === 'A' ? 'B' : 'A';
  return `${replacement}${value.slice(1)}`;
}

function wrapPrivateKeyFast(privateKey: CryptoKey, password: string) {
  return wrapPrivateKey({
    privateKey,
    password,
    kdfParams: FAST_TEST_ARGON2ID_KDF_PARAMS,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('wrapPrivateKey', () => {
  it(
    'wraps and unwraps an RSA private key with Argon2id-derived AES key',
    async () => {
      const password = 'correct horse battery staple';
      const keyPair = await generateReceiverKeyPair();

      const wrapped = await wrapPrivateKey({
        privateKey: keyPair.privateKey,
        password,
      });

      expect(wrapped.kdf).toMatchObject({
        kdfType: 'argon2id',
        version: 19,
        m: ARGON2ID.MEMORY_COST_KB,
        t: ARGON2ID.TIME_COST,
        p: ARGON2ID.PARALLELISM,
      });
      expect(typeof wrapped.kdf.salt).toBe('string');
      expect(wrapped.kdf.salt.length).toBeGreaterThan(0);
      expect(wrapped.iv.length).toBeGreaterThan(0);
      expect(wrapped.encryptedKey.length).toBeGreaterThan(0);

      const unwrappedPrivateKey = await unwrapPrivateKey({
        wrapped,
        password,
      });
      expect(unwrappedPrivateKey.extractable).toBe(false);
      const contentKey = randomBytes(32);
      const wrappedContentKey = await wrapContentKey({
        receiverPublicKey: keyPair.publicKey,
        contentKey,
      });
      const unwrappedContentKey = await unwrapContentKey({
        receiverPrivateKey: unwrappedPrivateKey,
        wrappedKey: wrappedContentKey,
      });

      expect(unwrappedContentKey).toEqual(contentKey);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'throws when WebCrypto is unavailable',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      vi.stubGlobal('crypto', undefined);

      await expect(
        wrapPrivateKey({
          privateKey: keyPair.privateKey,
          password: 'password',
        })
      ).rejects.toThrow('WebCrypto is not available');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'rejects empty passwords',
    async () => {
      const keyPair = await generateReceiverKeyPair();

      await expect(wrapPrivateKeyFast(keyPair.privateKey, '')).rejects.toThrow(
        'password must not be empty'
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails wrapping when privateKey is invalid for pkcs8 export',
    async () => {
      const keyPair = await generateReceiverKeyPair();

      await expect(
        wrapPrivateKey({
          privateKey: keyPair.publicKey,
          password: 'password',
        })
      ).rejects.toThrow('Private key wrap failed');
    },
    TEST_TIMEOUT_MS
  );
});

describe('unwrapPrivateKey', () => {
  it(
    'rejects empty passwords',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');

      await expect(unwrapPrivateKey({ wrapped, password: '' })).rejects.toThrow(
        'password must not be empty'
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails unwrap with wrong password',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');

      await expect(unwrapPrivateKey({ wrapped, password: 'wrong-password' })).rejects.toThrow(
        'Private key unwrap failed'
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails unwrap when wrapped encrypted key is tampered',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');
      const tamperedWrapped: WrappedPrivateKey = {
        ...wrapped,
        encryptedKey: tamperBase64Url(wrapped.encryptedKey) as WrappedPrivateKey['encryptedKey'],
      };

      await expect(
        unwrapPrivateKey({ wrapped: tamperedWrapped, password: 'password' })
      ).rejects.toThrow('Private key unwrap failed');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails unwrap for unsupported kdfType',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');
      const unsupportedWrapped = {
        ...wrapped,
        kdf: {
          kdfType: 'pbkdf2',
          iterations: 600_000,
          salt: wrapped.kdf.salt,
        },
      } as unknown as WrappedPrivateKey;

      await expect(
        unwrapPrivateKey({ wrapped: unsupportedWrapped, password: 'password' })
      ).rejects.toThrow('Unsupported kdfType for unwrap');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails unwrap for invalid base64url encoding',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');
      const malformedWrapped: WrappedPrivateKey = {
        ...wrapped,
        iv: 'not+valid' as WrappedPrivateKey['iv'],
      };

      await expect(
        unwrapPrivateKey({ wrapped: malformedWrapped, password: 'password' })
      ).rejects.toThrow('Invalid wrapped private key encoding');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails unwrap for invalid salt and IV lengths',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');
      const invalidSaltWrapped = {
        ...wrapped,
        kdf: {
          ...wrapped.kdf,
          salt: 'AA',
        },
      } as WrappedPrivateKey;
      const invalidIvWrapped = {
        ...wrapped,
        iv: 'AA',
      } as WrappedPrivateKey;

      await expect(
        unwrapPrivateKey({ wrapped: invalidSaltWrapped, password: 'password' })
      ).rejects.toThrow('Invalid wrapped private key encoding');
      await expect(
        unwrapPrivateKey({ wrapped: invalidIvWrapped, password: 'password' })
      ).rejects.toThrow('Invalid wrapped private key encoding');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'throws when WebCrypto is unavailable',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');
      vi.stubGlobal('crypto', undefined);

      await expect(unwrapPrivateKey({ wrapped, password: 'password' })).rejects.toThrow(
        'WebCrypto is not available'
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'stores IV with AES-GCM expected length',
    async () => {
      const keyPair = await generateReceiverKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'password');
      const decodedIvLength = atob(wrapped.iv.replaceAll('-', '+').replaceAll('_', '/')).length;

      expect(decodedIvLength).toBe(AES_GCM.IV_LENGTH);
    },
    TEST_TIMEOUT_MS
  );
});

describe('unwrapEcdsaPrivateKey', () => {
  async function generateEcdsaKeyPair(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey(
      { name: ECDSA.ALGORITHM_NAME, namedCurve: ECDSA.CURVE },
      true,
      [...ECDSA.KEY_USAGES_SIGN, ...ECDSA.KEY_USAGES_VERIFY]
    );
  }

  it(
    'wraps and unwraps an ECDSA private key with Argon2id-derived AES key',
    async () => {
      const password = 'softkey-passphrase';
      const keyPair = await generateEcdsaKeyPair();

      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, password);
      const unwrapped = await unwrapEcdsaPrivateKey({ wrapped, password });
      expect(unwrapped.extractable).toBe(false);

      const payload = crypto.getRandomValues(new Uint8Array(32));
      const sig = await crypto.subtle.sign(
        { name: ECDSA.ALGORITHM_NAME, hash: ECDSA.HASH_ALGORITHM },
        unwrapped,
        payload
      );
      const verified = await crypto.subtle.verify(
        { name: ECDSA.ALGORITHM_NAME, hash: ECDSA.HASH_ALGORITHM },
        keyPair.publicKey,
        sig,
        payload
      );

      expect(verified).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'fails unwrap with wrong password',
    async () => {
      const keyPair = await generateEcdsaKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'correct');

      await expect(unwrapEcdsaPrivateKey({ wrapped, password: 'wrong' })).rejects.toThrow(
        'ECDSA private key unwrap failed'
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'rejects empty password',
    async () => {
      const keyPair = await generateEcdsaKeyPair();
      const wrapped = await wrapPrivateKeyFast(keyPair.privateKey, 'pw');

      await expect(unwrapEcdsaPrivateKey({ wrapped, password: '' })).rejects.toThrow(
        'password must not be empty'
      );
    },
    TEST_TIMEOUT_MS
  );
});
