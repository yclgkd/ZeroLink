// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SECURITY_PROFILE } from '@zerolink/shared';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router';
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
const NEXT_UUID = 'bbbbbbbbbbbbbbbbbbbbb';
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

function renderManagePageWithRouter(initialPath = `/m/${VALID_UUID}`) {
  const router = createMemoryRouter(
    [
      {
        path: '/m/:uuid',
        element: <ManagePage />,
      },
    ],
    {
      initialEntries: [initialPath],
    }
  );

  return { router, ...render(<RouterProvider router={router} />) };
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

function getLatestChannelSyncOptions() {
  if (!syncHarness.latestOptions) {
    throw new Error('useChannelSync options were not captured');
  }

  return syncHarness.latestOptions;
}

async function waitForManageActionsEnabled(): Promise<void> {
  await waitFor(() => {
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(false);
  });
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

describe('ManagePage – delete / destroy confirm', () => {
  it('uses inline destroy confirm and transitions to deleted after confirm', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');

    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect(screen.getByTestId('manage-destroy-confirm')).toBeTruthy();
    expect(screen.getByText('Permanently delete this channel?')).toBeTruthy();
    expect(screen.getByText('Confirm Delete')).toBeTruthy();

    fireEvent.click(screen.getByTestId('manage-destroy-cancel'));
    expect(screen.queryByTestId('manage-destroy-confirm')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await waitFor(() => {
      expect(deleteChannelMock).toHaveBeenCalledTimes(1);
    });

    expect(deleteChannelMock.mock.calls[0]?.[0]?.uuid).toBe(VALID_UUID);
    expect(deleteChannelMock.mock.calls[0]?.[0]?.profile).toBe(SECURITY_PROFILE.SECURE);
    expect(await screen.findByTestId('manage-state-deleted')).toBeTruthy();
    expect(
      screen.getByText('You deleted this channel. It can no longer deliver or decrypt content.')
    ).toBeTruthy();
    expect(screen.getByTestId('manage-create-new-button')).toBeTruthy();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect(screen.queryByTestId('manage-destroy-button')).toBeNull();
  });

  it('keeps deleted state when realtime close follows a local delete', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));
    await screen.findByTestId('manage-state-deleted');

    act(() => {
      getLatestChannelSyncOptions().onChannelClosed('deleted');
    });

    expect(screen.getByTestId('manage-state-deleted')).toBeTruthy();
    expect(screen.queryByTestId('manage-state-unavailable')).toBeNull();
  });

  it('uses quick profile for password-managed delete even when create state conflicts', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        state: 'waiting',
        adminMode: 'password',
        securityProfile: SECURITY_PROFILE.QUICK,
      })
    );

    useCreateStore.getState().setSelectedProfile(SECURITY_PROFILE.SECURE);
    useCreateStore.getState().setCreatedProfile(SECURITY_PROFILE.SECURE);

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect(screen.getByTestId('manage-softkey-passphrase-section')).toBeTruthy();
    expect(screen.queryByTestId('manage-destroy-confirm')).toBeNull();
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Quick#Manage123' },
    });
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect(screen.getByTestId('manage-destroy-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await waitFor(() => {
      expect(deleteChannelMock).toHaveBeenCalledTimes(1);
    });

    expect(deleteChannelMock.mock.calls[0]?.[0]?.profile).toBe(SECURITY_PROFILE.QUICK);
    expect(deleteChannelMock.mock.calls[0]?.[0]?.softkeyPassphrase).toBe('Quick#Manage123');
  });

  it('keeps password-managed delete disabled until the waiting-state password is valid', async () => {
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
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'short' },
    });
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('manage-destroy-confirm')).toBeNull();
    expect(deleteChannelMock).not.toHaveBeenCalled();
  });

  it('requires a valid password before locked-state delete can open confirm', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        state: 'locked',
        adminMode: 'password',
        securityProfile: SECURITY_PROFILE.QUICK,
      })
    );

    renderManagePage();

    await screen.findByTestId('manage-state-locked');
    expect(screen.getByTestId('manage-softkey-passphrase-section')).toBeTruthy();
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('manage-destroy-confirm')).toBeNull();

    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Quick#Manage123' },
    });

    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect(screen.getByTestId('manage-destroy-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await waitFor(() => {
      expect(deleteChannelMock).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps waiting-state delete auth visible after same-state realtime updates', async () => {
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
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect(screen.getByTestId('manage-softkey-passphrase-section')).toBeTruthy();

    act(() => {
      getLatestChannelSyncOptions().onStateChange({
        state: 'waiting',
        version: 2,
        adminMode: 'password',
        securityProfile: SECURITY_PROFILE.QUICK,
      });
    });

    expect(screen.getByTestId('manage-state-waiting')).toBeTruthy();
    expect(screen.getByTestId('manage-softkey-passphrase-section')).toBeTruthy();
    expect(screen.queryByTestId('manage-destroy-confirm')).toBeNull();
  });

  it('returns waiting-state delete flow to idle after confirm cancel', async () => {
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
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.change(screen.getByTestId('passphrase-input-field'), {
      target: { value: 'Quick#Manage123' },
    });
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    expect(screen.getByTestId('manage-destroy-confirm')).toBeTruthy();

    fireEvent.click(screen.getByTestId('manage-destroy-cancel'));

    expect(screen.queryByTestId('manage-destroy-confirm')).toBeNull();
    expect(screen.queryByTestId('manage-softkey-passphrase-section')).toBeNull();
    expect((screen.getByTestId('manage-destroy-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows unavailable state after remounting a locally deleted channel', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    const firstRender = renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));
    await screen.findByTestId('manage-state-deleted');

    firstRender.unmount();
    mockPublicNotFound(fetchSpy);

    renderManagePage();

    expect(await screen.findByTestId('manage-state-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('manage-state-deleted')).toBeNull();
  });

  it('disables confirm panel actions while delete request is pending', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    const deferred = createDeferred<{
      ok: true;
      data: Record<string, never>;
    }>();
    deleteChannelMock.mockReturnValueOnce(deferred.promise);

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await waitFor(() => {
      expect((screen.getByTestId('manage-destroy-cancel') as HTMLButtonElement).disabled).toBe(
        true
      );
      expect(
        (screen.getByTestId('manage-destroy-confirm-apply') as HTMLButtonElement).disabled
      ).toBe(true);
    });
    expect(screen.getByText('Deleting…')).toBeTruthy();

    deferred.resolve({ ok: true, data: {} });
  });

  it('keeps the deliver button label unchanged while a locked-state delete request is pending', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    const deferred = createDeferred<{
      ok: true;
      data: Record<string, never>;
    }>();
    deleteChannelMock.mockReturnValueOnce(deferred.promise);

    renderManagePage();

    await screen.findByTestId('manage-state-locked');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await waitFor(() => {
      expect((screen.getByTestId('manage-deliver-button') as HTMLButtonElement).disabled).toBe(
        true
      );
    });

    expect(screen.getByTestId('manage-deliver-button').textContent).toContain('Deliver');
    expect(screen.getByTestId('manage-deliver-button').textContent).not.toContain('Delivering');
    expect(screen.getByTestId('manage-destroy-confirm-apply').textContent).toContain('Deleting');

    deferred.resolve({ ok: true, data: {} });
  });

  it('shows action error on delete failure', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    deleteChannelMock.mockResolvedValueOnce({
      ok: false,
      error: { ok: false, code: 'PROFILE_BLOCKED', stage: 'delete.assert' },
    });

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    expect(await screen.findByTestId('manage-action-error')).toBeTruthy();
    expect(screen.getByTestId('manage-state-waiting')).toBeTruthy();
  });

  it('shows INTERNAL_ERROR and logs to console when deleteChannel throws', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    deleteChannelMock.mockRejectedValueOnce(new TypeError('unexpected crypto failure'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderManagePage();

    await screen.findByTestId('manage-state-waiting');
    await waitForManageActionsEnabled();
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    const error = await screen.findByTestId('manage-action-error');
    expect(error.textContent).toContain('Unexpected internal error');
    expect(screen.getByTestId('manage-state-waiting')).toBeTruthy();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[useManageDestructionLogic] deleteChannel threw unexpectedly',
      expect.objectContaining({ uuid: VALID_UUID })
    );

    consoleErrorSpy.mockRestore();
  });

  it('ignores stale delete failure after navigating to a new uuid', async () => {
    const fetchSpy = getFetchSpy();
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/public/${VALID_UUID}` || url === `/api/public/${NEXT_UUID}`) {
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

    const deferred = createDeferred<{
      ok: false;
      error: { ok: false; code: 'PROFILE_BLOCKED'; stage: 'delete.assert' };
    }>();
    deleteChannelMock.mockReturnValueOnce(deferred.promise);

    const { router } = renderManagePageWithRouter();

    await screen.findByTestId('manage-state-waiting');
    await waitForManageActionsEnabled();
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await router.navigate(`/m/${NEXT_UUID}`);
    expect(await screen.findByTestId('manage-state-waiting')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('manage-uuid').textContent).toContain(NEXT_UUID);
    });
    expect(screen.queryByTestId('manage-action-error')).toBeNull();
    expect(screen.queryByTestId('manage-state-deleted')).toBeNull();

    deferred.resolve({
      ok: false,
      error: { ok: false, code: 'PROFILE_BLOCKED', stage: 'delete.assert' },
    });

    await waitFor(() => {
      expect(screen.queryByTestId('manage-action-error')).toBeNull();
      expect(screen.getByTestId('manage-state-waiting')).toBeTruthy();
      expect(screen.queryByTestId('manage-state-deleted')).toBeNull();
    });
  });

  it('hides SECRET PAYLOAD input after successful destroy', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();
    await screen.findByTestId('manage-state-locked');
    await waitForManageActionsEnabled();

    fireEvent.change(screen.getByTestId('manage-secret-input'), {
      target: { value: 'my secret text' },
    });
    expect((screen.getByTestId('manage-secret-input') as HTMLTextAreaElement).value).toBe(
      'my secret text'
    );

    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await screen.findByTestId('manage-state-deleted');
    expect(screen.queryByTestId('manage-share-link-card')).toBeNull();
    expect(screen.queryByTestId('manage-secret-input')).toBeNull();
  });

  it('retains SECRET PAYLOAD content after destroy failure', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    deleteChannelMock.mockResolvedValueOnce({
      ok: false,
      error: { ok: false, code: 'PROFILE_BLOCKED', stage: 'delete.assert' },
    });

    renderManagePage();
    await screen.findByTestId('manage-state-locked');

    fireEvent.change(screen.getByTestId('manage-secret-input'), {
      target: { value: 'my secret text' },
    });

    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await screen.findByTestId('manage-action-error');
    expect((screen.getByTestId('manage-secret-input') as HTMLTextAreaElement).value).toBe(
      'my secret text'
    );
  });
});
