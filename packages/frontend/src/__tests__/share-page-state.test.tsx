// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Base64UrlSchema, HexStringSchema, SECURITY_PROFILE } from '@zerolink/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lockChannelMock, decryptDeliveredMock, syncHarness } = vi.hoisted(() => ({
  lockChannelMock: vi.fn(),
  decryptDeliveredMock: vi.fn(),
  syncHarness: {
    latestOptions: null as {
      onStateChange: (update: {
        state: string;
        version: number;
        adminMode: string;
        securityProfile: string;
        receiverPubFpr?: string;
      }) => void;
      onChannelClosed: (reason: string) => void;
    } | null,
  },
}));

vi.mock('../crypto/orchestrator', async () => {
  return {
    cryptoOrchestrator: {
      lockChannel: lockChannelMock,
      decryptDelivered: decryptDeliveredMock,
    },
  };
});

vi.mock('../sync/use-channel-sync.ts', async () => {
  return {
    useChannelSync: (
      uuid: string | undefined,
      options: {
        onStateChange: (update: {
          state: string;
          version: number;
          adminMode: string;
          securityProfile: string;
          receiverPubFpr?: string;
        }) => void;
        onChannelClosed: (reason: string) => void;
      }
    ) => {
      syncHarness.latestOptions = uuid ? options : null;
      return { connectionMode: 'offline' as const };
    },
  };
});

import { createIndexedDbReceiverKeyStorage, type ReceiverKeyEnvelope } from '../crypto/storage';
import { SharePage } from '../pages/SharePage';
import { useDecryptStore } from '../stores/decrypt-store';
import { useLockStore } from '../stores/lock-store';

const originalFetch = globalThis.fetch;
const VALID_UUID = 'aaaaaaaaaaaaaaaaaaaaa';
const VALID_HEX = HexStringSchema.parse(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
);
const VALID_B64U = Base64UrlSchema.parse('bW9ja19iYXNlNjR1cmw');
const VALID_LOCK_SECRET = 'bW9ja19sb2NrX3NlY3JldA';
const MOCK_TIMESTAMP = 1_700_000_000_000;
const RECEIVER_STORAGE_UUIDS = [
  VALID_UUID,
  'uuidaaaaaaaaaaaaaaaaa',
  'uuidbbbbbbbbbbbbbbbbb',
] as const;

function getFetchSpy(): ReturnType<typeof vi.fn> {
  if (!vi.isMockFunction(globalThis.fetch)) {
    throw new Error('global fetch is not mocked');
  }

  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

async function waitForDeliveredDecryptPanel() {
  expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
  return screen.findByTestId('share-decrypt-panel');
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
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

async function saveReceiverEnvelopesForDeliveredTests(): Promise<void> {
  await Promise.all([
    saveReceiverEnvelope(VALID_UUID),
    saveReceiverEnvelope('uuidaaaaaaaaaaaaaaaaa'),
    saveReceiverEnvelope('uuidbbbbbbbbbbbbbbbbb'),
  ]);
}

async function clearReceiverKeyStorage(): Promise<void> {
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

function mockLockSuccessWithStoreSideEffects(): void {
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

function mockDecryptSuccessWithStoreSideEffects(): void {
  decryptDeliveredMock.mockImplementation(async ({ passphrase }: { passphrase: string }) => {
    const plaintext = `decrypted:${passphrase}`;
    useDecryptStore.getState().setPlaintext(plaintext);
    return {
      ok: true,
      data: {
        plaintext,
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
      },
    };
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

let replaceStateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await clearReceiverKeyStorage();
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  window.sessionStorage.clear();
  replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
  useLockStore.getState().resetLockStore();
  useDecryptStore.getState().resetDecryptStore();
  syncHarness.latestOptions = null;
  vi.clearAllMocks();
  mockLockSuccessWithStoreSideEffects();
  mockDecryptSuccessWithStoreSideEffects();
});

afterEach(async () => {
  cleanup();
  await clearReceiverKeyStorage();
  window.sessionStorage.clear();
  replaceStateSpy.mockRestore();

  if (originalFetch) {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  } else {
    Reflect.deleteProperty(globalThis, 'fetch');
  }
});

describe('SharePage – navigation + stale state transitions', () => {
  it('resets decrypt pending when navigating to another delivered uuid mid-request', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/public/uuidaaaaaaaaaaaaaaaaa') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }
      if (url === '/api/public/uuidbbbbbbbbbbbbbbbbb') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const deferred = createDeferred<{
      ok: true;
      data: {
        plaintext: string;
        deliveredAt: number;
        receiverPubFpr: string;
      };
    }>();
    decryptDeliveredMock.mockReturnValueOnce(deferred.promise);

    const router = createMemoryRouter(
      [
        {
          path: '/s/:uuid',
          element: <SharePage />,
        },
      ],
      {
        initialEntries: ['/s/uuidaaaaaaaaaaaaaaaaa'],
      }
    );

    render(<RouterProvider router={router} />);

    await waitForDeliveredDecryptPanel();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'first-passphrase' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));

    await waitFor(() => {
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypting…');
    });

    await router.navigate('/s/uuidbbbbbbbbbbbbbbbbb');

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/public/uuidbbbbbbbbbbbbbbbbb');
    });
    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();

    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'second-passphrase' },
    });

    await waitFor(() => {
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(false);
      expect(decryptButton.textContent).toBe('Decrypt');
    });

    deferred.resolve({
      ok: true,
      data: {
        plaintext: 'decrypted:first-passphrase',
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
      },
    });
  });

  it('ignores stale decrypt failure after navigating to a new delivered uuid', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/public/uuidaaaaaaaaaaaaaaaaa') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }
      if (url === '/api/public/uuidbbbbbbbbbbbbbbbbb') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const deferred = createDeferred<{
      ok: false;
      error: {
        ok: false;
        code: 'KEY_STORAGE_ERROR';
        stage: 'decrypt.load-key';
      };
    }>();
    decryptDeliveredMock.mockReturnValueOnce(deferred.promise);

    const router = createMemoryRouter(
      [
        {
          path: '/s/:uuid',
          element: <SharePage />,
        },
      ],
      {
        initialEntries: ['/s/uuidaaaaaaaaaaaaaaaaa'],
      }
    );

    render(<RouterProvider router={router} />);

    await waitForDeliveredDecryptPanel();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'first-passphrase' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));

    await router.navigate('/s/uuidbbbbbbbbbbbbbbbbb');
    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();
    expect(screen.queryByTestId('share-decrypt-error')).toBeNull();

    deferred.resolve({
      ok: false,
      error: {
        ok: false,
        code: 'KEY_STORAGE_ERROR',
        stage: 'decrypt.load-key',
      },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('share-decrypt-error')).toBeNull();
      expect(screen.getByTestId('share-step-delivered')).toBeTruthy();
    });
  });

  it('does not clear current pending when stale decrypt response resolves', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    const uuidBPublic = createDeferred<Response>();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/public/uuidaaaaaaaaaaaaaaaaa') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }
      if (url === '/api/public/uuidbbbbbbbbbbbbbbbbb') {
        return uuidBPublic.promise;
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const deferredA = createDeferred<{
      ok: true;
      data: {
        plaintext: string;
        deliveredAt: number;
        receiverPubFpr: string;
      };
    }>();
    const deferredB = createDeferred<{
      ok: true;
      data: {
        plaintext: string;
        deliveredAt: number;
        receiverPubFpr: string;
      };
    }>();

    decryptDeliveredMock
      .mockImplementationOnce(() => deferredA.promise)
      .mockImplementationOnce(() => deferredB.promise);

    const router = createMemoryRouter(
      [
        {
          path: '/s/:uuid',
          element: <SharePage />,
        },
      ],
      {
        initialEntries: ['/s/uuidaaaaaaaaaaaaaaaaa'],
      }
    );

    render(<RouterProvider router={router} />);

    await waitForDeliveredDecryptPanel();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'first-passphrase' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));

    await router.navigate('/s/uuidbbbbbbbbbbbbbbbbb');
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/public/uuidbbbbbbbbbbbbbbbbb');
    });
    uuidBPublic.resolve(
      jsonResponse({
        ok: true,
        state: 'delivered',
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
      })
    );
    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'second-passphrase' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));

    await waitFor(() => {
      expect(decryptDeliveredMock).toHaveBeenCalledTimes(2);
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypting…');
    });

    deferredA.resolve({
      ok: true,
      data: {
        plaintext: 'decrypted:first-passphrase',
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
      },
    });

    await waitFor(() => {
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypting…');
    });

    deferredB.resolve({
      ok: true,
      data: {
        plaintext: 'decrypted:second-passphrase',
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
      },
    });

    await waitFor(() => {
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypt');
      expect((screen.getByTestId('passphrase-input-field') as HTMLInputElement).value).toBe('');
    });
  });

  it('does not clear current pending when stale decrypt throws', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    const uuidBPublic = createDeferred<Response>();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/public/uuidaaaaaaaaaaaaaaaaa') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }
      if (url === '/api/public/uuidbbbbbbbbbbbbbbbbb') {
        return uuidBPublic.promise;
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const deferredA = createDeferred<{
      ok: true;
      data: {
        plaintext: string;
        deliveredAt: number;
        receiverPubFpr: string;
      };
    }>();
    const deferredB = createDeferred<{
      ok: true;
      data: {
        plaintext: string;
        deliveredAt: number;
        receiverPubFpr: string;
      };
    }>();

    decryptDeliveredMock
      .mockImplementationOnce(() => deferredA.promise)
      .mockImplementationOnce(() => deferredB.promise);

    const router = createMemoryRouter(
      [
        {
          path: '/s/:uuid',
          element: <SharePage />,
        },
      ],
      {
        initialEntries: ['/s/uuidaaaaaaaaaaaaaaaaa'],
      }
    );

    render(<RouterProvider router={router} />);

    await waitForDeliveredDecryptPanel();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'first-passphrase' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));

    await router.navigate('/s/uuidbbbbbbbbbbbbbbbbb');
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/public/uuidbbbbbbbbbbbbbbbbb');
    });
    uuidBPublic.resolve(
      jsonResponse({
        ok: true,
        state: 'delivered',
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
      })
    );
    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'second-passphrase' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));

    await waitFor(() => {
      expect(decryptDeliveredMock).toHaveBeenCalledTimes(2);
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypting…');
    });

    deferredA.reject(new Error('stale decrypt failure'));

    await waitFor(() => {
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypting…');
      expect(screen.queryByTestId('share-decrypt-error')).toBeNull();
    });

    deferredB.resolve({
      ok: true,
      data: {
        plaintext: 'decrypted:second-passphrase',
        deliveredAt: MOCK_TIMESTAMP,
        receiverPubFpr: VALID_HEX,
      },
    });

    await waitFor(() => {
      const decryptButton = screen.getByTestId('share-decrypt-button') as HTMLButtonElement;
      expect(decryptButton.disabled).toBe(true);
      expect(decryptButton.textContent).toBe('Decrypt');
      expect((screen.getByTestId('passphrase-input-field') as HTMLInputElement).value).toBe('');
    });
  });

  it('shows loading and does not leak old plaintext while uuid route changes', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    const uuidBPublic = createDeferred<Response>();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/public/uuidaaaaaaaaaaaaaaaaa') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'delivered',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }
      if (url === '/api/public/uuidbbbbbbbbbbbbbbbbb') {
        return uuidBPublic.promise;
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const router = createMemoryRouter(
      [
        {
          path: '/s/:uuid',
          element: <SharePage />,
        },
      ],
      {
        initialEntries: ['/s/uuidaaaaaaaaaaaaaaaaa'],
      }
    );

    render(<RouterProvider router={router} />);

    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Receiver#Pass1234' },
    });
    fireEvent.click(screen.getByTestId('share-decrypt-button'));
    expect(await screen.findByTestId('share-decrypt-plaintext')).toBeTruthy();

    await router.navigate('/s/uuidbbbbbbbbbbbbbbbbb');

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/public/uuidbbbbbbbbbbbbbbbbb');
    });
    const loading = screen.getByTestId('share-step-loading');
    expect(loading).toBeTruthy();
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.getAttribute('aria-live')).toBe('polite');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('share-decrypt-plaintext')).toBeNull();

    uuidBPublic.resolve(
      jsonResponse({
        ok: true,
        state: 'waiting',
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
      })
    );

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
    expect(screen.queryByTestId('share-decrypt-plaintext')).toBeNull();
  });

  it('resets lock step and passphrase after leaving and returning to same uuid', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/public/${VALID_UUID}`) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'waiting',
            adminMode: 'webauthn',
            securityProfile: SECURITY_PROFILE.SECURE,
          })
        );
      }

      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const router = createMemoryRouter(
      [
        {
          path: '/s/:uuid',
          element: <SharePage />,
        },
        {
          path: '/m/:uuid',
          element: <div data-testid="manage-page-stub">Manage</div>,
        },
      ],
      {
        initialEntries: [`/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`],
      }
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-continue-button'));

    const passphraseInput = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(passphraseInput, {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    expect(passphraseInput.value).toBe('Strong#Pass1234XYZ');

    await router.navigate(`/m/${VALID_UUID}`);
    expect(await screen.findByTestId('manage-page-stub')).toBeTruthy();

    await router.navigate(`/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);
    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

    fireEvent.click(screen.getByTestId('share-continue-button'));
    const returnPassphraseInput = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    expect(returnPassphraseInput.value).toBe('');
  });
});
