import { render, screen } from '@testing-library/react';
import { SECURITY_PROFILE } from '@zerolink/shared';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, vi } from 'vitest';
import { createIndexedDbReceiverKeyStorage, type ReceiverKeyEnvelope } from '../../crypto/storage';
import { SharePage } from '../../pages/SharePage';
import { useDecryptStore } from '../../stores/decrypt-store';
import { useLockStore } from '../../stores/lock-store';
import { VALID_B64U, VALID_HEX, VALID_UUID } from './orchestrator-fixtures';

export const MOCK_TIMESTAMP = 1_700_000_000_000;
export { VALID_B64U, VALID_HEX, VALID_UUID } from './orchestrator-fixtures';

const RECEIVER_STORAGE_UUIDS = [
  VALID_UUID,
  'uuidaaaaaaaaaaaaaaaaa',
  'uuidbbbbbbbbbbbbbbbbb',
] as const;

export type SharePageChannelSyncOptions = {
  onStateChange: (update: {
    state: string;
    version: number;
    adminMode: string;
    securityProfile: string;
    receiverPubFpr?: string;
  }) => void;
  onChannelClosed: (reason: string) => void;
};

export type SharePageChannelSyncHarness = {
  latestOptions: SharePageChannelSyncOptions | null;
};

export function getFetchSpy(): ReturnType<typeof vi.fn> {
  if (!vi.isMockFunction(globalThis.fetch)) {
    throw new Error('global fetch is not mocked');
  }

  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

export function renderSharePage(routePath = '/s/:uuid', initialPath = '/s/demo-channel-shell') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<SharePage />} path={routePath} />
      </Routes>
    </MemoryRouter>
  );
}

export async function waitForDeliveredDecryptPanel() {
  expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
  return screen.findByTestId('share-decrypt-panel');
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export function mockPublicState(
  fetchSpy: ReturnType<typeof vi.fn>,
  state: 'waiting' | 'locked' | 'delivered',
  options?: { receiverPubFpr?: string | null }
) {
  const receiverPubFpr =
    options && 'receiverPubFpr' in options
      ? options.receiverPubFpr
      : state === 'locked' || state === 'delivered'
        ? VALID_HEX
        : null;

  fetchSpy.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      state,
      adminMode: 'webauthn',
      securityProfile: SECURITY_PROFILE.SECURE,
      ...(receiverPubFpr ? { receiverPubFpr } : {}),
    })
  );
}

function createReceiverEnvelope(
  uuid: string = VALID_UUID,
  receiverPubFpr: string = VALID_HEX
): ReceiverKeyEnvelope {
  return {
    uuid,
    receiverPubFpr,
    wrappedPrivateKey: {
      encryptedKey: VALID_B64U,
      iv: VALID_B64U,
      kdf: {
        kdfType: 'argon2id',
        version: 19,
        m: 65_536,
        t: 3,
        p: 1,
        salt: VALID_B64U,
      },
    },
    updatedAt: MOCK_TIMESTAMP,
  };
}

async function saveReceiverEnvelope(
  uuid: string = VALID_UUID,
  receiverPubFpr: string = VALID_HEX
): Promise<void> {
  const receiverKeyStorage = createIndexedDbReceiverKeyStorage();
  await receiverKeyStorage.save(createReceiverEnvelope(uuid, receiverPubFpr));
}

export async function saveReceiverEnvelopesForDeliveredTests(): Promise<void> {
  await Promise.all([
    saveReceiverEnvelope(VALID_UUID),
    saveReceiverEnvelope('uuidaaaaaaaaaaaaaaaaa'),
    saveReceiverEnvelope('uuidbbbbbbbbbbbbbbbbb'),
  ]);
}

export async function clearReceiverKeyStorage(): Promise<void> {
  const receiverKeyStorage = createIndexedDbReceiverKeyStorage();
  const failures: string[] = [];

  await Promise.all(
    RECEIVER_STORAGE_UUIDS.map(async (uuid) => {
      try {
        await receiverKeyStorage.remove(uuid);
      } catch (error: unknown) {
        failures.push(`${uuid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );

  if (failures.length > 0) {
    throw new Error(
      `Failed to clear receiver key storage for test isolation:\n${failures.join('\n')}`
    );
  }
}

export function mockLockSuccessWithStoreSideEffects(
  lockChannelMock: ReturnType<typeof vi.fn>
): void {
  lockChannelMock.mockImplementation(async () => {
    useLockStore.getState().setSafetyCode({
      emoji: {
        type: 'emoji',
        emojis: ['🔥', '🌲', '🚀', '🔮', '💎', '🎯', '⚡', '🌙'],
      },
      color: {
        type: 'color',
        cells: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      },
      shortFpr: 'a1b2c3d4e5f6...f1e2d3c4b5a6',
      fullFpr: VALID_HEX,
    });
    useLockStore.getState().markLocked();

    return {
      ok: true,
      data: {
        receiverPubJwk: {
          kty: 'RSA',
          alg: 'RSA-OAEP-256',
          n: VALID_B64U,
          e: 'AQAB',
          ext: true,
          key_ops: ['encrypt'],
        },
        receiverPubFpr: VALID_HEX,
      },
    };
  });
}

export function mockDecryptSuccessWithStoreSideEffects(
  decryptDeliveredMock: ReturnType<typeof vi.fn>,
  cipherVersion = 0
): void {
  decryptDeliveredMock.mockImplementation(async ({ passphrase }: { passphrase: string }) => {
    const plaintext = `decrypted:${passphrase}`;
    useDecryptStore.getState().setPlaintext(plaintext);
    return {
      ok: true,
      data: {
        payload: {
          kind: 'text',
          text: plaintext,
        },
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
        cipherVersion,
      },
    };
  });
}

export function mockDecryptFileSuccessWithStoreSideEffects(
  decryptDeliveredMock: ReturnType<typeof vi.fn>
): void {
  decryptDeliveredMock.mockImplementation(async () => {
    const file = {
      kind: 'file' as const,
      fileName: 'secret.bin',
      mediaType: 'application/octet-stream',
      size: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
    };
    useDecryptStore.getState().setFile(file);
    return {
      ok: true,
      data: {
        payload: file,
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
        cipherVersion: 0,
      },
    };
  });
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

export function getLatestChannelSyncOptions(syncHarness: SharePageChannelSyncHarness) {
  if (!syncHarness.latestOptions) {
    throw new Error('useChannelSync options were not captured');
  }

  return syncHarness.latestOptions;
}
