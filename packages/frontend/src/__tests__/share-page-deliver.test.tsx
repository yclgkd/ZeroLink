// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Base64UrlSchema, HexStringSchema, SECURITY_PROFILE } from '@zerolink/shared';
import { MemoryRouter, Route, Routes } from 'react-router';
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

import * as storageModule from '../crypto/storage';
import { createIndexedDbReceiverKeyStorage, type ReceiverKeyEnvelope } from '../crypto/storage';
import { SharePage } from '../pages/SharePage';
import { useDecryptStore } from '../stores/decrypt-store';
import { useLockStore } from '../stores/lock-store';

const originalFetch = globalThis.fetch;
const VALID_UUID = 'aaaaaaaaaaaaaaaaaaaaa';
const VALID_HEX = HexStringSchema.parse(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
);
const OTHER_VALID_HEX = HexStringSchema.parse(
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
);
const VALID_B64U = Base64UrlSchema.parse('bW9ja19iYXNlNjR1cmw');
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

function renderSharePage(routePath = '/s/:uuid', initialPath = '/s/demo-channel-shell') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<SharePage />} path={routePath} />
      </Routes>
    </MemoryRouter>
  );
}

async function waitForDeliveredDecryptPanel() {
  expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
  return screen.findByTestId('share-decrypt-panel');
}

async function waitForSafetyUnavailableTitle(title: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('share-safety-unavailable').textContent).toContain(title);
  });
}

async function waitForDecryptUnavailableTitle(title: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('share-decrypt-unavailable').textContent).toContain(title);
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function mockPublicState(
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

function getLatestChannelSyncOptions() {
  if (!syncHarness.latestOptions) {
    throw new Error('useChannelSync options were not captured');
  }

  return syncHarness.latestOptions;
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

describe('SharePage – delivered state + safety code', () => {
  it('renders safety code when locked state matches this device receiver key after refresh', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelope();
    mockPublicState(fetchSpy, 'locked');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    expect(screen.getByText('Receiver channel is locked')).toBeTruthy();
    expect(
      screen.getByText(
        'This receiver channel is locked. This page updates automatically, but only the device that created the lock can verify the Safety Code shown below.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText(
        'The Safety Code can only be verified on the device that locked this channel.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('Confirm and verify the Safety Code with the sender over another channel.')
    ).toBeTruthy();
    expect(
      screen.getByText(
        'This page will refresh automatically when the sender delivers the ciphertext.'
      )
    ).toBeTruthy();
    expect(await screen.findByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('share-safety-unavailable')).toBeNull();
  });

  it('shows a security warning when locked state is present but this device has no receiver key', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    await waitFor(
      () => {
        expect(screen.getByTestId('share-safety-unavailable').textContent).toContain(
          'This device cannot verify the Safety Code.'
        );
      },
      { timeout: 5_000 }
    );
    const warning = screen.getByTestId('share-safety-unavailable');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    await waitFor(() => {
      expect(warning.textContent).toContain(
        'No matching receiver key was found on this device. Do not confirm the Safety Code from here. If you expected to be the receiver, ask the sender to recreate the channel.'
      );
    });
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('shows a mismatch warning when local receiver identity does not match the locked channel', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelope(VALID_UUID, OTHER_VALID_HEX);
    mockPublicState(fetchSpy, 'locked');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    expect(await screen.findByText('Receiver identity mismatch detected.')).toBeTruthy();
    const warning = screen.getByTestId('share-safety-unavailable');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.getAttribute('aria-live')).toBe('assertive');
    expect(
      screen.getByText(
        'This device has different local receiver key material than the key currently locked on the channel. Treat this link as unsafe and ask the sender to recreate the channel.'
      )
    ).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('shows the generic fallback when locked state is missing receiver fingerprint', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelope();
    mockPublicState(fetchSpy, 'locked', { receiverPubFpr: null });

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    await waitForSafetyUnavailableTitle('Safety Code unavailable right now.');
    const warning = screen.getByTestId('share-safety-unavailable');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(
      screen.getByText(
        'Receiver fingerprint is missing from the current channel state, so the Safety Code cannot be verified here.'
      )
    ).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('renders delivered decrypt panel with locally verified safety code and does not fetch /api/decrypt_fetch directly', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    mockPublicState(fetchSpy, 'delivered');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();
    expect(screen.getByText('Decrypt Delivered Secret')).toBeTruthy();
    expect(
      screen.getByText(
        'If this device created the receiver lock, enter that passphrase to decrypt the secret locally.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Channel Delivered')).toBeTruthy();
    expect(
      screen.getByText(
        'The encrypted secret has been delivered. Decryption still requires the device that created the receiver lock.'
      )
    ).toBeTruthy();
    expect(await screen.findByTestId('safety-code-root')).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(`/api/public/${VALID_UUID}`);
    expect(fetchSpy).not.toHaveBeenCalledWith(`/api/decrypt_fetch/${VALID_UUID}`);
  });

  it('keeps local decrypt available when delivered state is missing receiver fingerprint but this device has the receiver key', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelopesForDeliveredTests();
    mockPublicState(fetchSpy, 'delivered', { receiverPubFpr: null });

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await waitForDeliveredDecryptPanel()).toBeTruthy();
    await waitForSafetyUnavailableTitle('Safety Code unavailable right now.');
    expect(screen.getByText('Safety Code unavailable right now.')).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
    expect(screen.queryByTestId('share-decrypt-unavailable')).toBeNull();
  });

  it('shows a security warning and blocks decrypt when delivered state has no local receiver key on this device', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'delivered');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
    expect(screen.queryByTestId('share-decrypt-panel')).toBeNull();
    expect(screen.getByTestId('share-decrypt-unavailable')).toBeTruthy();
    expect(await screen.findByText('This device cannot verify the Safety Code.')).toBeTruthy();
    await waitForDecryptUnavailableTitle('Decrypt unavailable on this device.');
    await waitFor(() => {
      expect(screen.getByTestId('share-decrypt-unavailable').textContent).toContain(
        'This device does not have the receiver key that locked the channel, so local decrypt is blocked here.'
      );
    });
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('blocks decrypt when delivered state receiver identity does not match this device', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelope(VALID_UUID, OTHER_VALID_HEX);
    mockPublicState(fetchSpy, 'delivered');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
    expect(await screen.findByText('Receiver identity mismatch detected.')).toBeTruthy();
    expect(screen.queryByTestId('share-decrypt-panel')).toBeNull();
    expect(screen.getByTestId('share-decrypt-unavailable')).toBeTruthy();
    expect(screen.getByText('Decrypt blocked on this device.')).toBeTruthy();
    expect(
      screen.getByText(
        'The receiver key stored on this device does not match the key currently locked on the channel. Treat this link as unsafe and ask the sender to recreate the channel.'
      )
    ).toBeTruthy();
  });

  it('does not render safety code after a realtime locked update if this device lacks the local receiver key', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'locked',
        version: 1,
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
        receiverPubFpr: VALID_HEX,
      });
    });

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    expect(await screen.findByText('This device cannot verify the Safety Code.')).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('renders safety code after a realtime locked update when this device has the matching receiver key', async () => {
    const fetchSpy = getFetchSpy();
    await saveReceiverEnvelope();
    mockPublicState(fetchSpy, 'waiting');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'locked',
        version: 1,
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
        receiverPubFpr: VALID_HEX,
      });
    });

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    expect(await screen.findByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('share-safety-unavailable')).toBeNull();
  });

  it('shows a storage-error warning when IndexedDB read fails in locked state', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(storageModule, 'createIndexedDbReceiverKeyStorage').mockReturnValue({
      load: () => Promise.reject(new Error('IndexedDB quota exceeded')),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    });

    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    expect(await screen.findByText('Unable to check the local receiver key.')).toBeTruthy();
    const warning = screen.getByTestId('share-safety-unavailable');
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(
      screen.getByText(
        'ZeroLink could not read the receiver key material stored on this device, so the Safety Code cannot be verified here.'
      )
    ).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();

    spy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('shows a storage-error warning and blocks decrypt when delivered state cannot read IndexedDB', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(storageModule, 'createIndexedDbReceiverKeyStorage').mockReturnValue({
      load: () => Promise.reject(new Error('IndexedDB quota exceeded')),
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    });

    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'delivered');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
    expect(screen.queryByTestId('share-decrypt-panel')).toBeNull();
    expect(await screen.findByText('Unable to load the local receiver key.')).toBeTruthy();
    expect(screen.getByTestId('share-decrypt-unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        'ZeroLink could not read the receiver key stored on this device, so local decrypt is unavailable here.'
      )
    ).toBeTruthy();

    spy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
