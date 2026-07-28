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
import { createIndexedDbReceiverKeyStorage, type ReceiverKeyStorage } from '../crypto/storage';
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
const LOCK_SECRET_SESSION_STORAGE_KEY = `zerolink:share-lock-secret:${VALID_UUID}`;
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

function mockLegacyTerminalPublicState(
  fetchSpy: ReturnType<typeof vi.fn>,
  state: 'deleted' | 'expired'
) {
  fetchSpy.mockResolvedValueOnce(
    jsonResponse({
      ok: true,
      state,
      adminMode: 'webauthn',
      securityProfile: SECURITY_PROFILE.SECURE,
    })
  );
}

function mockPublicNotFound(fetchSpy: ReturnType<typeof vi.fn>) {
  fetchSpy.mockResolvedValueOnce(
    jsonResponse(
      {
        ok: false,
        code: 'NOT_FOUND',
      },
      404
    )
  );
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

function createMockReceiverKeyStorage(
  overrides: Partial<ReceiverKeyStorage> = {}
): ReceiverKeyStorage {
  return {
    load: overrides.load ?? (() => Promise.resolve(null)),
    save: overrides.save ?? (() => Promise.resolve()),
    remove: overrides.remove ?? (() => Promise.resolve()),
  };
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

describe('SharePage – unavailable state + cleanup + role badge', () => {
  it('renders unavailable state when /api/public/:uuid returns 404', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicNotFound(fetchSpy);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
    expect(screen.getByText('Channel Unavailable')).toBeTruthy();
    expect(
      screen.getByText('This channel was destroyed, expired, or does not exist.')
    ).toBeTruthy();
  });

  it('clears the stored lock secret when /api/public/:uuid returns 404', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicNotFound(fetchSpy);
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it('cleans up the local receiver key when /api/public/:uuid returns 404', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicNotFound(fetchSpy);
    const remove = vi.fn(() => Promise.resolve());
    const storageSpy = vi
      .spyOn(storageModule, 'createIndexedDbReceiverKeyStorage')
      .mockReturnValue(createMockReceiverKeyStorage({ remove }));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    try {
      expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
      await waitFor(() => {
        expect(remove).toHaveBeenCalledWith(VALID_UUID);
      });
    } finally {
      storageSpy.mockRestore();
    }
  });

  it.each([
    'deleted',
    'expired',
  ] as const)('renders unavailable state when /api/public/:uuid returns legacy %s', async (state) => {
    const fetchSpy = getFetchSpy();
    mockLegacyTerminalPublicState(fetchSpy, state);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('share-step-onboarding')).toBeNull();
    expect(screen.queryByTestId('share-step-delivered')).toBeNull();
    expect(decryptDeliveredMock).not.toHaveBeenCalled();
    expect(lockChannelMock).not.toHaveBeenCalled();
  });

  it.each([
    'deleted',
    'expired',
  ] as const)('clears the stored lock secret when /api/public/:uuid returns legacy %s', async (state) => {
    const fetchSpy = getFetchSpy();
    mockLegacyTerminalPublicState(fetchSpy, state);
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it.each([
    'deleted',
    'expired',
  ] as const)('cleans up the local receiver key when /api/public/:uuid returns legacy %s', async (state) => {
    const fetchSpy = getFetchSpy();
    mockLegacyTerminalPublicState(fetchSpy, state);
    const remove = vi.fn(() => Promise.resolve());
    const storageSpy = vi
      .spyOn(storageModule, 'createIndexedDbReceiverKeyStorage')
      .mockReturnValue(createMockReceiverKeyStorage({ remove }));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    try {
      expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
      await waitFor(() => {
        expect(remove).toHaveBeenCalledWith(VALID_UUID);
      });
    } finally {
      storageSpy.mockRestore();
    }
  });

  it.each([
    'locked',
    'delivered',
  ] as const)('clears the stored lock secret when public state resolves to %s', async (state) => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, state);
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    if (state === 'locked') {
      expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    } else {
      expect(await screen.findByTestId('share-step-delivered')).toBeTruthy();
    }

    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it('cleans up the local receiver key when realtime state changes to a terminal state', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    const remove = vi.fn(() => Promise.resolve());
    const storageSpy = vi
      .spyOn(storageModule, 'createIndexedDbReceiverKeyStorage')
      .mockReturnValue(createMockReceiverKeyStorage({ remove }));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    try {
      expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

      act(() => {
        getLatestChannelSyncOptions().onStateChange({
          state: 'expired',
          version: 1,
          adminMode: 'webauthn',
          securityProfile: SECURITY_PROFILE.SECURE,
        });
      });

      expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
      await waitFor(() => {
        expect(remove).toHaveBeenCalledWith(VALID_UUID);
      });
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('clears the stored lock secret when realtime state changes to a terminal state', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'expired',
        version: 1,
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
      });
    });

    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it('cleans up the local receiver key when realtime close is received', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    const remove = vi.fn(() => Promise.resolve());
    const storageSpy = vi
      .spyOn(storageModule, 'createIndexedDbReceiverKeyStorage')
      .mockReturnValue(createMockReceiverKeyStorage({ remove }));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    try {
      expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

      act(() => {
        getLatestChannelSyncOptions().onChannelClosed('expired');
      });

      expect(await screen.findByTestId('share-step-unavailable')).toBeTruthy();
      await waitFor(() => {
        expect(remove).toHaveBeenCalledWith(VALID_UUID);
      });
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('clears the stored lock secret when realtime close is received', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();

    act(() => {
      getLatestChannelSyncOptions().onChannelClosed('expired');
    });

    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it.each([
    429, 500, 503,
  ] as const)('shows public-status error notice when /api/public/:uuid returns HTTP %i', async (status) => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: false, code: 'ERROR' }, status));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-public-status-error')).toBeTruthy();
    expect(
      screen.getByText('Unable to load channel state right now. Showing safe default state.')
    ).toBeTruthy();
    expect(screen.queryByTestId('share-step-unavailable')).toBeNull();
  });

  it.each([
    429, 500, 503,
  ] as const)('does not clean up the local receiver key when /api/public/:uuid returns HTTP %i', async (status) => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: false, code: 'ERROR' }, status));
    const remove = vi.fn(() => Promise.resolve());
    const storageSpy = vi
      .spyOn(storageModule, 'createIndexedDbReceiverKeyStorage')
      .mockReturnValue(createMockReceiverKeyStorage({ remove }));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    try {
      expect(await screen.findByTestId('share-public-status-error')).toBeTruthy();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('shows uuid and receiver role badge', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    await screen.findByTestId('share-step-onboarding');
    expect(screen.getByTestId('share-uuid').textContent).toContain(VALID_UUID);
    expect(screen.getByText('Receiver')).toBeTruthy();
  });

  it('falls back to (missing) label and skips network/decrypt calls when uuid param is absent', () => {
    const fetchSpy = getFetchSpy();
    renderSharePage('/s', '/s');

    expect(screen.getByTestId('share-uuid').textContent).toContain('(missing)');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lockChannelMock).not.toHaveBeenCalled();
    expect(decryptDeliveredMock).not.toHaveBeenCalled();
  });
});
