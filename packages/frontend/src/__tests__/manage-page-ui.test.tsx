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

describe('ManagePage – UI state, input visibility, and navigation', () => {
  it('renders unavailable state from API 404 and shows create new button instead of action buttons', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicNotFound(fetchSpy);

    renderManagePage();

    expect(await screen.findByTestId('manage-state-unavailable')).toBeTruthy();

    expect(screen.queryByTestId('manage-share-link-card')).toBeNull();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect(screen.queryByTestId('manage-destroy-button')).toBeNull();
    expect(screen.getByTestId('manage-create-new-button')).toBeTruthy();
  });

  it('shows unavailable state when realtime close arrives from a non-terminal state', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'locked');

    renderManagePage();

    await screen.findByTestId('manage-state-locked');

    act(() => {
      getLatestChannelSyncOptions().onChannelClosed('expired');
    });

    expect(await screen.findByTestId('manage-state-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect(screen.queryByTestId('manage-destroy-button')).toBeNull();
  });

  it.each([
    'deleted',
    'expired',
  ] as const)('renders unavailable state from legacy public status %s', async (state) => {
    const fetchSpy = getFetchSpy();
    mockLegacyTerminalPublicState(fetchSpy, state);

    renderManagePage();

    expect(await screen.findByTestId('manage-state-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('manage-share-link-card')).toBeNull();
    expect(screen.queryByTestId('manage-state-deleted')).toBeNull();
    expect(screen.queryByTestId('manage-deliver-button')).toBeNull();
    expect(screen.queryByTestId('manage-destroy-button')).toBeNull();
    expect(screen.getByTestId('manage-create-new-button')).toBeTruthy();
  });

  it('hides SECRET PAYLOAD input when channel is unavailable', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicNotFound(fetchSpy);

    renderManagePage();

    await screen.findByTestId('manage-state-unavailable');
    expect(screen.queryByTestId('manage-secret-input')).toBeNull();
  });

  it('does not render share link copy controls while managing a channel', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    renderManagePage();
    await screen.findByTestId('manage-state-waiting');
    expect(screen.queryByTestId('manage-share-link-card')).toBeNull();
    expect(screen.queryByTestId('manage-share-link-value')).toBeNull();
    expect(screen.queryByTestId('manage-copy-button')).toBeNull();
  });

  it('navigates to home when create new button is clicked after destroy', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicState(fetchSpy, 'waiting');

    const router = createMemoryRouter(
      [
        { path: '/', element: <div data-testid="home-page">Home</div> },
        { path: '/m/:uuid', element: <ManagePage /> },
      ],
      { initialEntries: [`/m/${VALID_UUID}`] }
    );
    render(<RouterProvider router={router} />);

    await screen.findByTestId('manage-state-waiting');
    fireEvent.click(screen.getByTestId('manage-destroy-button'));
    fireEvent.click(screen.getByTestId('manage-destroy-confirm-apply'));

    await screen.findByTestId('manage-state-deleted');
    fireEvent.click(screen.getByTestId('manage-create-new-button'));

    await waitFor(() => {
      expect(screen.getByTestId('home-page')).toBeTruthy();
    });
  });

  it('shows create new button in terminal actions for unavailable state', async () => {
    const fetchSpy = getFetchSpy();
    mockPublicNotFound(fetchSpy);

    renderManagePage();

    await screen.findByTestId('manage-state-unavailable');
    expect(screen.getByTestId('manage-terminal-actions')).toBeTruthy();
    expect(screen.getByTestId('manage-create-new-button')).toBeTruthy();
  });
});
