// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CHANNEL_TTL_MS, SECURITY_PROFILE } from '@zerolink/shared';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { deliverSecretMock, deleteChannelMock, syncHarness } = vi.hoisted(() => ({
  deliverSecretMock: vi.fn(),
  deleteChannelMock: vi.fn(),
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
      deliverSecret: deliverSecretMock,
      deleteChannel: deleteChannelMock,
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

import { ManagePage } from '../pages/ManagePage';
import { useCreateStore } from '../stores/create-store';
import { useDeliverStore } from '../stores/deliver-store';

const originalFetch = globalThis.fetch;
const originalClipboard = navigator.clipboard;

const VALID_UUID = 'aaaaaaaaaaaaaaaaaaaaa';
const VALID_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function renderManagePage(routePath = '/m/:uuid', initialPath = `/m/${VALID_UUID}`) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<ManagePage />} path={routePath} />
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

function getFetchSpy(): ReturnType<typeof vi.fn> {
  if (!vi.isMockFunction(globalThis.fetch)) {
    throw new Error('global fetch is not mocked');
  }

  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

function mockPublicState(
  fetchSpy: ReturnType<typeof vi.fn>,
  state: string,
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

function mockDeliverSuccessWithStoreSideEffects(): void {
  deliverSecretMock.mockImplementation(async () => {
    useDeliverStore.getState().markDelivered();
    return { ok: true, data: {} };
  });
}

function mockDeleteSuccessWithStoreSideEffects(): void {
  deleteChannelMock.mockImplementation(async () => {
    useDeliverStore.getState().markDeleted();
    return { ok: true, data: {} };
  });
}

function getLatestChannelSyncOptions() {
  if (!syncHarness.latestOptions) {
    throw new Error('useChannelSync options were not captured');
  }

  return syncHarness.latestOptions;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });

  useCreateStore.getState().resetCreateStore();
  useDeliverStore.getState().resetDeliverStore();
  syncHarness.latestOptions = null;
  window.sessionStorage.clear();

  vi.clearAllMocks();
  deliverSecretMock.mockReset();
  deleteChannelMock.mockReset();
  mockDeliverSuccessWithStoreSideEffects();
  mockDeleteSuccessWithStoreSideEffects();
});

afterEach(() => {
  cleanup();

  if (originalFetch) {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  } else {
    Reflect.deleteProperty(globalThis, 'fetch');
  }

  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('ManagePage – public status and waiting state', () => {
  it('calls /api/public/:uuid on mount and renders waiting state from API', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderManagePage();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(`/api/public/${VALID_UUID}`);
    });

    expect(screen.getByTestId('page-manage')).toBeTruthy();
    expect(await screen.findByTestId('manage-state-waiting')).toBeTruthy();
    expect(screen.getByText('Delete Channel')).toBeTruthy();
    expect(screen.queryByText('Destroy')).toBeNull();
  });

  it('shows sender role badge and uuid value', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderManagePage();

    expect(await screen.findByText('Sender')).toBeTruthy();
    expect(screen.getByTestId('manage-uuid').textContent).toContain(VALID_UUID);
  });

  it('surfaces same-session share link recovery while waiting', async () => {
    const fetchSpy = getFetchSpy();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockPublicState(fetchSpy, 'waiting');
    window.sessionStorage.setItem(
      `zerolink:created-share-link:${VALID_UUID}`,
      JSON.stringify({
        url: `/s/${VALID_UUID}#k=bW9ja19sb2NrX3NlY3JldA`,
        ts: Date.now(),
        ttl: CHANNEL_TTL_MS.ONE_DAY,
      })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderManagePage();

    expect(await screen.findByTestId('manage-share-link-recovery')).toBeTruthy();
    fireEvent.click(screen.getByTestId('manage-share-link-recovery-copy'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        new URL(`/s/${VALID_UUID}#k=bW9ja19sb2NrX3NlY3JldA`, window.location.origin).href
      );
    });
  });

  it('hides share link recovery when public status fetch fails', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockRejectedValueOnce(new Error('network error'));
    window.sessionStorage.setItem(
      `zerolink:created-share-link:${VALID_UUID}`,
      JSON.stringify({
        url: `/s/${VALID_UUID}#k=bW9ja19sb2NrX3NlY3JldA`,
        ts: Date.now(),
        ttl: CHANNEL_TTL_MS.ONE_DAY,
      })
    );

    renderManagePage();

    await waitFor(() => {
      expect(screen.getByTestId('manage-public-status-error')).toBeTruthy();
    });
    expect(screen.queryByTestId('manage-share-link-recovery')).toBeNull();
  });

  it('hides share link recovery when channel is not in waiting state', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');
    window.sessionStorage.setItem(
      `zerolink:created-share-link:${VALID_UUID}`,
      JSON.stringify({
        url: `/s/${VALID_UUID}#k=bW9ja19sb2NrX3NlY3JldA`,
        ts: Date.now(),
        ttl: CHANNEL_TTL_MS.ONE_DAY,
      })
    );

    renderManagePage();

    await waitFor(() => {
      expect(screen.getByTestId('manage-state-locked')).toBeTruthy();
    });
    expect(screen.queryByTestId('manage-share-link-recovery')).toBeNull();
  });

  it('falls back to (missing) label and blocks deliver/delete when uuid is absent', async () => {
    const fetchSpy = getFetchSpy();

    renderManagePage('/m', '/m');

    expect(screen.getByTestId('manage-uuid').textContent).toContain('(missing)');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('manage-secret-input')).toBeNull();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-destroy-button'));

    await waitFor(() => {
      expect(deliverSecretMock).not.toHaveBeenCalled();
      expect(deleteChannelMock).not.toHaveBeenCalled();
    });
  });

  it('renders locked state fallback when public status is missing receiver fingerprint', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked', { receiverPubFpr: null });

    renderManagePage();

    expect(await screen.findByTestId('manage-state-locked')).toBeTruthy();
    const warning = screen.getByTestId('manage-safety-unavailable');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Safety Code unavailable right now.')).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('renders real safety code in locked state when public status includes receiver fingerprint', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();

    expect(await screen.findByTestId('manage-state-locked')).toBeTruthy();
    expect(await screen.findByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('manage-safety-unavailable')).toBeNull();
  });

  it('falls back to safety unavailable and logs when receiverPubFpr is malformed', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');
    const MALFORMED_HEX = 'zzzz_not_valid_hex';
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderManagePage();

    await screen.findByTestId('manage-state-locked');
    expect(screen.getByTestId('safety-code-root')).toBeTruthy();

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'locked',
        version: 2,
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
        receiverPubFpr: MALFORMED_HEX,
      });
    });

    expect(screen.getByTestId('manage-safety-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[useManagePageState] deriveSafetyCodeDisplay failed',
      expect.objectContaining({ receiverPubFpr: MALFORMED_HEX })
    );

    consoleErrorSpy.mockRestore();
  });

  it('hides delivery composer while waiting for receiver lock', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    expect(screen.queryByTestId('manage-secret-input')).toBeNull();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect(screen.getByTestId('manage-destroy-button')).toBeTruthy();
  });

  it('keeps deliver disabled while secret input is empty after receiver lock', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();

    await screen.findByTestId('manage-state-locked');
    const deliverButton = screen.getByTestId('manage-deliver-button') as HTMLButtonElement;
    expect(deliverButton.disabled).toBe(true);
  });

  it('hides the channel password input while password-managed channels are still waiting', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        state: 'waiting',
        adminMode: 'password',
        securityProfile: SECURITY_PROFILE.QUICK,
      })
    );

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    expect(screen.queryByTestId('manage-softkey-passphrase-section')).toBeNull();
    expect(screen.queryByLabelText('Channel password')).toBeNull();
  });

  it('does not show the channel password input for webauthn-managed channels', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        state: 'waiting',
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
      })
    );

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    expect(screen.queryByTestId('manage-softkey-passphrase-section')).toBeNull();
    expect(screen.queryByLabelText('Channel password')).toBeNull();
  });

  it('keeps the safety code visible while compound begin loads and after retryable begin errors', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();

    await screen.findByTestId('manage-state-locked');
    expect(screen.getByTestId('safety-code-root')).toBeTruthy();

    act(() => {
      useDeliverStore.getState().startCompoundBegin();
    });

    expect(screen.getByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('manage-safety-unavailable')).toBeNull();

    act(() => {
      useDeliverStore.getState().failCompoundBegin('NETWORK_ERROR');
    });

    expect(screen.getByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('manage-safety-unavailable')).toBeNull();
  });

  it.each([
    'NOT_FOUND',
    'LOCK_FORBIDDEN',
  ] as const)('falls back to the safety warning after terminal compound begin error %s', async (errorCode) => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();

    await screen.findByTestId('manage-state-locked');
    expect(screen.getByTestId('safety-code-root')).toBeTruthy();

    act(() => {
      useDeliverStore.getState().failCompoundBegin(errorCode);
    });

    expect(screen.queryByTestId('safety-code-root')).toBeNull();
    expect(screen.getByTestId('manage-safety-unavailable')).toBeTruthy();
  });

  it('shows public status error when /api/public fails and keeps actions disabled', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    renderManagePage();

    const warning = await screen.findByTestId('manage-public-status-error');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('manage-state-waiting')).toBeTruthy();
    expect(screen.queryByTestId('manage-secret-input')).toBeNull();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('clears public status error when realtime state arrives after load failure', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    renderManagePage();

    await screen.findByTestId('manage-public-status-error');

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'locked',
        version: 1,
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
        receiverPubFpr: VALID_HEX,
      });
    });

    expect(screen.queryByTestId('manage-public-status-error')).toBeNull();
    expect(await screen.findByTestId('manage-state-locked')).toBeTruthy();
    expect(screen.getByTestId('safety-code-root')).toBeTruthy();
  });

  it('renders real safety code in delivered state when public status includes receiver fingerprint', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'delivered');

    renderManagePage();

    expect(await screen.findByTestId('manage-state-delivered')).toBeTruthy();
    expect(await screen.findByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('manage-safety-unavailable')).toBeNull();
  });

  it('renders safety code unavailable warning in delivered state when receiver fingerprint is missing', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'delivered', { receiverPubFpr: null });

    renderManagePage();

    expect(await screen.findByTestId('manage-state-delivered')).toBeTruthy();
    const warning = screen.getByTestId('manage-safety-unavailable');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
    expect(warning.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Safety Code unavailable right now.')).toBeTruthy();
    expect(screen.queryByTestId('safety-code-root')).toBeNull();
  });

  it('shows safety code when realtime onStateChange pushes delivered state with receiver fingerprint', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();

    await screen.findByTestId('manage-state-locked');

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'delivered',
        version: 1,
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
        receiverPubFpr: VALID_HEX,
      });
    });

    expect(await screen.findByTestId('manage-state-delivered')).toBeTruthy();
    expect(screen.getByTestId('safety-code-root')).toBeTruthy();
    expect(screen.queryByTestId('manage-safety-unavailable')).toBeNull();
  });

  it('keeps manage actions disabled until public status resolves', async () => {
    const fetchSpy = getFetchSpy();
    const publicStatus = {
      resolve: null as unknown as (v: Response) => void,
      promise: null as unknown as Promise<Response>,
    };
    publicStatus.promise = new Promise<Response>((res) => {
      publicStatus.resolve = res;
    });
    fetchSpy.mockReturnValueOnce(publicStatus.promise);

    renderManagePage();

    expect(screen.queryByTestId('manage-secret-input')).toBeNull();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(true);

    publicStatus.resolve(
      jsonResponse({
        ok: true,
        state: 'locked',
        adminMode: 'webauthn',
        securityProfile: SECURITY_PROFILE.SECURE,
      })
    );

    await screen.findByTestId('manage-state-locked');
    fireEvent.change(screen.getByTestId('manage-secret-input'), {
      target: { value: 'payload' },
    });
    await waitFor(() => {
      expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(
        false
      );
      expect((screen.getByTestId('manage-deliver-button') as HTMLButtonElement).disabled).toBe(
        false
      );
    });
  });
});
