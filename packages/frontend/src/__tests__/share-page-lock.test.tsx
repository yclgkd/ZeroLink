// @vitest-environment jsdom

import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { createIndexedDbReceiverKeyStorage } from '../crypto/storage';
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

describe('SharePage – lock flow', () => {
  it('loads waiting state from /api/public/:uuid and renders onboarding by default', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(`/api/public/${VALID_UUID}`);
    });

    expect(screen.getByTestId('page-share')).toBeTruthy();
    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
    expect(
      screen.getByText(
        'The sender already created this channel. Set your own passphrase here to generate your receiver key and lock the channel on this device.'
      )
    ).toBeTruthy();
    expect(
      screen.getByText('This page is only for the receiver using the shared link.')
    ).toBeTruthy();
    expect(screen.getByText('Your passphrase stays on this device')).toBeTruthy();
    expect(screen.getByTestId('share-continue-button').textContent).toContain(
      'Continue as receiver'
    );
    const content = screen.getByTestId('page-share').querySelector('[aria-busy]');
    expect(content?.getAttribute('aria-busy')).toBe('false');
  });

  it('moves from onboarding to lock form when continuing in waiting state', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));

    expect(screen.getByTestId('share-step-lock')).toBeTruthy();
    expect(screen.getByText('Choose your passphrase')).toBeTruthy();
    expect(screen.getByLabelText('Your passphrase')).toBeTruthy();
    expect(screen.getByTestId('share-generate-button').textContent).toContain(
      'Generate My Key & Lock'
    );
  });

  it('keeps generate button disabled when passphrase is empty', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    const generateButton = screen.getByTestId('share-generate-button') as HTMLButtonElement;

    expect(generateButton.disabled).toBe(true);
  });

  it('blocks lock when lock secret is missing and does not call lockChannel', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });

    const warning = screen.getByTestId('share-lock-secret-warning');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(
      (screen.getByTestId('passphrase-input-field') as HTMLInputElement).getAttribute(
        'aria-describedby'
      )
    ).toBe('share-lock-passphrase-helper');
    const generateButton = screen.getByTestId('share-generate-button') as HTMLButtonElement;
    expect(generateButton.disabled).toBe(true);

    fireEvent.click(generateButton);
    await waitFor(() => {
      expect(lockChannelMock).not.toHaveBeenCalled();
    });
  });

  it('calls lockChannel with uuid, lockSecretB64u and passphrase when inputs are valid', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    await waitFor(() => {
      expect(lockChannelMock).toHaveBeenCalledTimes(1);
    });

    const callArg = lockChannelMock.mock.calls[0]?.[0];
    expect(callArg?.uuid).toBe(VALID_UUID);
    expect(callArg?.lockSecretB64u).toBe(VALID_LOCK_SECRET);
    expect(callArg?.passphrase).toBe('Strong#Pass1234XYZ');
  });

  it('persists a valid hash lock secret into sessionStorage and strips it from the URL', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBe(
        VALID_LOCK_SECRET
      );
    });
    expect(replaceStateSpy).toHaveBeenCalledWith(window.history.state, '', `/s/${VALID_UUID}`);
  });

  it('uses the sessionStorage lock secret when the share page reloads without a fragment', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });

    expect(screen.queryByTestId('share-lock-secret-warning')).toBeNull();
    const generateButton = screen.getByTestId('share-generate-button') as HTMLButtonElement;
    expect(generateButton.disabled).toBe(false);

    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(lockChannelMock).toHaveBeenCalledTimes(1);
    });
    expect(lockChannelMock.mock.calls[0]?.[0]?.lockSecretB64u).toBe(VALID_LOCK_SECRET);
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('keeps the fragment in place when sessionStorage persistence fails but still locks successfully', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('sessionStorage disabled');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

      expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
      fireEvent.click(screen.getByTestId('share-continue-button'));
      fireEvent.change(screen.getByTestId('passphrase-input-field'), {
        target: { value: 'Strong#Pass1234XYZ' },
      });
      fireEvent.click(screen.getByTestId('share-generate-button'));

      await waitFor(() => {
        expect(lockChannelMock).toHaveBeenCalledTimes(1);
      });
      expect(lockChannelMock.mock.calls[0]?.[0]?.lockSecretB64u).toBe(VALID_LOCK_SECRET);
      expect(replaceStateSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('clears the sessionStorage lock secret immediately after a successful lock', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    window.sessionStorage.setItem(LOCK_SECRET_SESSION_STORAGE_KEY, VALID_LOCK_SECRET);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    expect(await screen.findByTestId('share-step-onboarding')).toBeTruthy();
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    await waitFor(() => {
      expect(window.sessionStorage.getItem(LOCK_SECRET_SESSION_STORAGE_KEY)).toBeNull();
    });
  });

  it('disables back/generate while lock request is pending then restores controls', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    const deferred = createDeferred<
      | {
          ok: true;
          data: {
            receiverPubJwk: {
              kty: 'RSA';
              alg: 'RSA-OAEP-256';
              n: string;
              e: string;
              ext: true;
              key_ops: ['encrypt'];
            };
            receiverPubFpr: string;
          };
        }
      | {
          ok: false;
          error: {
            ok: false;
            code: string;
            stage: string;
          };
        }
    >();
    lockChannelMock.mockReturnValueOnce(deferred.promise);

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });

    fireEvent.click(screen.getByTestId('share-generate-button'));

    await waitFor(() => {
      expect((screen.getByTestId('share-generate-button') as HTMLButtonElement).disabled).toBe(
        true
      );
      expect((screen.getByTestId('share-back-button') as HTMLButtonElement).disabled).toBe(true);
    });
    const busyContainer = screen.getByTestId('page-share').querySelector('[aria-busy]');
    expect(busyContainer?.getAttribute('aria-busy')).toBe('true');

    deferred.resolve({
      ok: false,
      error: {
        ok: false,
        code: 'NETWORK_ERROR',
        stage: 'lock.commit',
      },
    });

    await waitFor(() => {
      expect((screen.getByTestId('share-generate-button') as HTMLButtonElement).disabled).toBe(
        false
      );
      expect((screen.getByTestId('share-back-button') as HTMLButtonElement).disabled).toBe(false);
    });
    expect(busyContainer?.getAttribute('aria-busy')).toBe('false');
  });

  it('renders locked state with real safety code after successful lock', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    expect(await screen.findByTestId('share-step-locked')).toBeTruthy();
    expect(screen.getByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('share-safety-unavailable')).toBeNull();
  });

  it('shows lock error and remains in lock form when lockChannel fails', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    lockChannelMock.mockResolvedValueOnce({
      ok: false,
      error: {
        ok: false,
        code: 'MISSING_LOCK_CHALLENGE',
        stage: 'lock.begin',
      },
    });

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    expect(await screen.findByTestId('share-step-lock')).toBeTruthy();
    const error = await screen.findByTestId('share-lock-error');
    expect(error).toBeTruthy();
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.getAttribute('aria-live')).toBe('assertive');
    expect(
      (screen.getByTestId('passphrase-input-field') as HTMLInputElement).getAttribute(
        'aria-invalid'
      )
    ).toBeNull();
    expect(
      (screen.getByTestId('passphrase-input-field') as HTMLInputElement).getAttribute(
        'aria-describedby'
      )
    ).toBe('share-lock-passphrase-helper');
    expect(screen.queryByTestId('share-step-locked')).toBeNull();
  });

  it('marks lock passphrase invalid when lockChannel reports PASSPHRASE_REQUIRED', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    lockChannelMock.mockResolvedValueOnce({
      ok: false,
      error: {
        ok: false,
        code: 'PASSPHRASE_REQUIRED',
        stage: 'lock.validate',
      },
    });

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    const error = await screen.findByTestId('share-lock-error');
    expect(error).toBeTruthy();
    expect(
      (screen.getByTestId('passphrase-input-field') as HTMLInputElement).getAttribute(
        'aria-invalid'
      )
    ).toBe('true');
    expect(
      (screen.getByTestId('passphrase-input-field') as HTMLInputElement).getAttribute(
        'aria-describedby'
      )
    ).toBe('share-lock-error share-lock-passphrase-helper');
  });

  it('does not update state after unmount during pending lock request', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    const deferred = createDeferred<{
      ok: true;
      data: {
        receiverPubJwk: {
          kty: 'RSA';
          alg: 'RSA-OAEP-256';
          n: string;
          e: string;
          ext: true;
          key_ops: ['encrypt'];
        };
        receiverPubFpr: string;
      };
    }>();
    lockChannelMock.mockReturnValueOnce(deferred.promise);

    const { unmount } = renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    await waitFor(() => {
      expect(lockChannelMock).toHaveBeenCalledTimes(1);
    });

    unmount();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    deferred.resolve({
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
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('shows user-friendly error when lockChannel throws an exception', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    lockChannelMock.mockRejectedValueOnce(new Error('unexpected crash'));

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    expect(await screen.findByTestId('share-lock-error')).toBeTruthy();
    const errorText = screen.getByTestId('share-lock-error').textContent;
    expect(errorText).toBe('An unexpected error occurred. Please try again.');
    expect(errorText).not.toContain('INTERNAL_ERROR');
  });

  it('shows generic fallback error when lockChannel returns an unknown error code', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    lockChannelMock.mockResolvedValueOnce({
      ok: false,
      error: {
        ok: false,
        code: 'TOTALLY_UNKNOWN_CODE_XYZ',
        stage: 'lock.begin',
      },
    });

    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Strong#Pass1234XYZ' },
    });
    fireEvent.click(screen.getByTestId('share-generate-button'));

    expect(await screen.findByTestId('share-lock-error')).toBeTruthy();
    const errorText = screen.getByTestId('share-lock-error').textContent;
    expect(errorText).toBe('Lock failed. Please try again.');
    expect(errorText).not.toContain('TOTALLY_UNKNOWN_CODE_XYZ');
  });

  it('shows private mode notice with copy-link button in lock step when lock secret is present', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));

    await screen.findByTestId('share-step-lock');
    expect(screen.getByTestId('share-private-mode-notice')).toBeTruthy();
    expect(screen.getByTestId('share-private-mode-copy').textContent).toContain('Copy link');
  });

  it('does not show private mode notice in lock step when lock secret is missing', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');
    // No #k= fragment and no sessionStorage entry
    renderSharePage('/s/:uuid', `/s/${VALID_UUID}`);

    await screen.findByTestId('share-step-onboarding');
    fireEvent.click(screen.getByTestId('share-continue-button'));

    await screen.findByTestId('share-step-lock');
    expect(screen.queryByTestId('share-private-mode-notice')).toBeNull();
  });

  it('copy-link button writes reconstructed URL with fragment to clipboard and shows copied feedback', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    try {
      renderSharePage('/s/:uuid', `/s/${VALID_UUID}#k=${VALID_LOCK_SECRET}`);

      await screen.findByTestId('share-step-onboarding');
      fireEvent.click(screen.getByTestId('share-continue-button'));
      await screen.findByTestId('share-step-lock');

      const copyButton = screen.getByTestId('share-private-mode-copy');
      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledTimes(1);
      });
      const writtenUrl: string = writeTextMock.mock.calls[0]?.[0] as string;
      expect(writtenUrl).toContain(`#k=${VALID_LOCK_SECRET}`);

      await waitFor(() => {
        expect(screen.getByTestId('share-private-mode-copy').textContent).toContain('Copied!');
      });
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
