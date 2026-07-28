// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHANNEL_TTL_MS, SECURITY_PROFILE } from '@zerolink/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { detectWebAuthnSupportMock, createChannelMock } = vi.hoisted(() => ({
  detectWebAuthnSupportMock: vi.fn(),
  createChannelMock: vi.fn(),
}));
const originalClipboard = navigator.clipboard;
const writeTextMock = vi.fn();

vi.mock('../crypto/webauthn', async () => {
  const actual = await vi.importActual<typeof import('../crypto/webauthn')>('../crypto/webauthn');
  return {
    ...actual,
    detectWebAuthnSupport: detectWebAuthnSupportMock,
  };
});

vi.mock('../crypto/orchestrator', async () => {
  return {
    cryptoOrchestrator: {
      createChannel: createChannelMock,
    },
  };
});

import { CreatePage } from '../pages/CreatePage';
import { useCreateStore } from '../stores/create-store';

function mockWebAuthnSupport(supported: boolean): void {
  detectWebAuthnSupportMock.mockReturnValue({
    supported,
    secureContext: supported,
    hasPublicKeyCredential: supported,
    hasCredentialsCreate: supported,
    hasCredentialsGet: supported,
  });
}

function mockCreateSuccess(): void {
  createChannelMock.mockResolvedValue({
    ok: true,
    data: {
      shareUrl: '/s/aaaaaaaaaaaaaaaaaaaaa',
      manageUrl: '/m/aaaaaaaaaaaaaaaaaaaaa',
      shareUrlWithFragment: '/s/aaaaaaaaaaaaaaaaaaaaa#k=bW9ja19sb2NrX3NlY3JldA',
      lockSecretB64u: 'bW9ja19sb2NrX3NlY3JldA',
      lockKeyB64u: 'bW9ja19sb2NrX2tleQ',
    },
  });
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function renderCreatePage() {
  return render(
    <MemoryRouter>
      <CreatePage />
    </MemoryRouter>
  );
}

describe('CreatePage integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreateStore.getState().resetCreateStore();
    window.sessionStorage.clear();
    mockCreateSuccess();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('renders Quick and Secure mode cards', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    expect(screen.getByTestId('page-create')).toBeTruthy();
    expect(screen.getByTestId('mode-card-quick')).toBeTruthy();
    expect(screen.getByTestId('mode-card-secure')).toBeTruthy();
  });

  it('defaults to Quick mode when WebAuthn is available', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    expect(screen.getByTestId('mode-card-quick').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('mode-card-secure').getAttribute('aria-pressed')).toBe('false');
  });

  it('defaults to Quick mode when WebAuthn is unavailable', () => {
    mockWebAuthnSupport(false);
    renderCreatePage();

    expect(screen.getByTestId('mode-card-quick').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('mode-card-secure').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows WebAuthn blocked warning when WebAuthn is unavailable', () => {
    mockWebAuthnSupport(false);
    renderCreatePage();

    const warning = screen.getByTestId('create-webauthn-blocked-warning');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('status');
  });

  it('switches to Quick mode when Quick card is clicked', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));
    expect(screen.getByTestId('mode-card-quick').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('mode-card-secure').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows password panel when Quick mode is selected', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    expect(screen.getByTestId('quick-share-password-panel')).toBeTruthy();
  });

  it('defaults to 1 hour TTL and lets the user switch presets', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    const oneHourInput = screen.getByTestId('create-ttl-one-hour') as HTMLInputElement;
    const oneDayInput = screen.getByTestId('create-ttl-one-day') as HTMLInputElement;
    const sevenDaysInput = screen.getByTestId('create-ttl-seven-days') as HTMLInputElement;

    expect(screen.getByRole('radiogroup')).toBeTruthy();
    expect(oneHourInput.checked).toBe(true);
    expect(oneDayInput.checked).toBe(false);

    fireEvent.click(sevenDaysInput);

    expect(oneHourInput.checked).toBe(false);
    expect(sevenDaysInput.checked).toBe(true);
  });

  it('keeps the selected TTL radio in tab order and exposes visible focus classes on the option card', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    const user = userEvent.setup();
    const oneHourInput = screen.getByTestId('create-ttl-one-hour') as HTMLInputElement;
    const oneHourCard = oneHourInput.nextElementSibling as HTMLElement | null;

    for (let i = 0; i < 6 && document.activeElement !== oneHourInput; i += 1) {
      await user.tab();
    }

    expect(document.activeElement).toBe(oneHourInput);
    expect(oneHourCard?.className).toContain('peer-focus-visible:ring-2');
    expect(oneHourCard?.className).toContain('peer-focus-visible:ring-offset-2');
  });

  it('hides password panel when Secure mode is selected', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    expect(screen.queryByTestId('quick-share-password-panel')).toBeNull();
  });

  it('shows Secure Share passkey hint when Secure mode is selected', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    expect(screen.queryByTestId('create-secure-share-hint')).toBeNull();

    fireEvent.click(screen.getByTestId('mode-card-secure'));

    expect(screen.getByTestId('create-secure-share-hint').textContent).toContain(
      'This passkey is used only for this channel. If it appears in your passkey manager, it can be safely deleted after the channel expires.'
    );
  });

  it('disables submit button in Quick mode until password is entered', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));

    const submit = screen.getByTestId('create-submit-button') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('create-action-hint').textContent).toContain(
      'Enter a channel password with at least 12 characters.'
    );
    // Button should NOT show spinner/Creating when disabled due to empty form, not submission
    expect(submit.textContent).toContain('Create Channel');
    expect(submit.textContent).not.toContain('Creating');
  });

  it('keeps submit button disabled in Quick mode when password is shorter than 12 characters', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));

    const input = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'short' } });

    const submit = screen.getByTestId('create-submit-button') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('create-action-hint').textContent).toContain(
      'Use 4+ random words or at least 12 characters for the channel password.'
    );
  });

  it('enables submit button in Quick mode when password is at least 12 characters', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));

    const input = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Strong#Pass123' } });

    const submit = screen.getByTestId('create-submit-button') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.getByTestId('create-action-hint').textContent).toContain(
      'Ready to create a Quick Share channel that expires in 1 hour.'
    );
  });

  it('shows the passphrase policy hint in Quick mode', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    expect(screen.getByText('Use 4+ random words or 12+ characters')).toBeTruthy();
  });

  it('enables submit button for a multi-word passphrase with ordinary spaces', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));

    const input = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'correct horse battery staple' } });

    const submit = screen.getByTestId('create-submit-button') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('enables submit button in Secure mode when WebAuthn is available', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('create-ttl-one-day'));
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    const submit = screen.getByTestId('create-submit-button') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.getByTestId('create-action-hint').textContent).toContain(
      'Ready to create a Secure Share channel that expires in 24 hours.'
    );
  });

  it('disables submit button in Secure mode when WebAuthn is unavailable', () => {
    mockWebAuthnSupport(false);
    renderCreatePage();

    // Switch to Secure (should not be clickable when unavailable, but test the disabled state)
    const secureCard = screen.getByTestId('mode-card-secure');
    fireEvent.click(secureCard);

    // Secure mode can't be selected when WebAuthn is unavailable - Quick stays selected
    expect(screen.getByTestId('mode-card-quick').getAttribute('aria-pressed')).toBe('true');
  });

  it('calls createChannel with QUICK profile and password', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));
    const input = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Strong#Pass123' } });
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(createChannelMock).toHaveBeenCalledTimes(1);
    });

    const callArg = createChannelMock.mock.calls[0]?.[0];
    expect(callArg?.profile).toBe(SECURITY_PROFILE.QUICK);
    expect(callArg?.useCompatibilityMode).toBe(true);
    expect(callArg?.softkeyPassphrase).toBe('Strong#Pass123');
    expect(callArg?.uuid).toMatch(/^[A-Za-z0-9_-]{21}$/u);
  });

  it('calls createChannel with SECURE profile when WebAuthn is available', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(createChannelMock).toHaveBeenCalledTimes(1);
    });

    const callArg = createChannelMock.mock.calls[0]?.[0];
    expect(callArg?.profile).toBe(SECURITY_PROFILE.SECURE);
    expect(callArg?.uuid).toMatch(/^[A-Za-z0-9_-]{21}$/u);
  });

  it('shows share and manage links after successful creation (Secure mode)', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));
    await waitFor(() => {
      expect(screen.getByTestId('create-success-share-link')).toBeTruthy();
      expect(screen.getByTestId('create-success-manage-link')).toBeTruthy();
    });
  });

  it('warns that the share link is shown only once', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    const warning = await screen.findByTestId('create-success-share-link-warning');
    expect(warning.textContent).toContain('This share link is shown only once.');
    expect(warning.textContent).toContain(
      'the sender Manage page can re-copy it while the channel is still waiting.'
    );
    expect(warning.textContent).toContain(
      'Outside that window, if you lose it, create a new channel.'
    );
  });

  it('shows password mode badge in success summary for Quick Share', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));
    const input = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Strong#Pass123' } });
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-password-mode-badge')).toBeTruthy();
    });
  });

  it('shows a create another confirmation when no success links were copied', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('create-another-button'));

    const confirm = await screen.findByTestId('create-another-confirm');
    expect(confirm.textContent).toContain(
      'Have you saved both the share link and the private manage link?'
    );
    expect(screen.getByTestId('create-success-summary')).toBeTruthy();
  });

  it('shows a create another confirmation when only one success link was copied', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('create-success-share-link-copy'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        '/s/aaaaaaaaaaaaaaaaaaaaa#k=bW9ja19sb2NrX3NlY3JldA'
      );
    });

    fireEvent.click(screen.getByTestId('create-another-button'));

    expect(await screen.findByTestId('create-another-confirm')).toBeTruthy();
  });

  it('returns to the form immediately when both success links were copied', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('create-success-share-link-copy'));
    fireEvent.click(screen.getByTestId('create-success-manage-link-copy'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByTestId('create-another-button'));

    await waitFor(() => {
      expect(screen.getByTestId('how-it-works')).toBeTruthy();
    });

    expect(screen.queryByTestId('create-success-summary')).toBeNull();
    expect(screen.queryByTestId('create-another-confirm')).toBeNull();
  });

  it('hides the create another confirmation when cancel is clicked', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('create-another-button'));

    const cancelButton = await screen.findByTestId('create-another-confirm-cancel');
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByTestId('create-another-confirm')).toBeNull();
    });

    expect(screen.getByTestId('create-success-summary')).toBeTruthy();
  });

  it('returns to the form when the create another confirmation is accepted', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('create-another-button'));
    fireEvent.click(await screen.findByTestId('create-another-confirm-continue'));

    await waitFor(() => {
      expect(screen.getByTestId('how-it-works')).toBeTruthy();
    });

    expect(screen.queryByTestId('create-success-summary')).toBeNull();
  });

  it('does not count failed clipboard writes as copied links', async () => {
    mockWebAuthnSupport(true);
    writeTextMock.mockRejectedValueOnce(new Error('permission denied'));
    writeTextMock.mockResolvedValueOnce(undefined);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('create-success-share-link-copy'));
    fireEvent.click(screen.getByTestId('create-success-manage-link-copy'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByTestId('create-success-share-link-copy').textContent).toContain('Copy');
    expect(screen.getByTestId('create-success-manage-link-copy').textContent).toContain('Copied');

    fireEvent.click(screen.getByTestId('create-another-button'));

    expect(await screen.findByTestId('create-another-confirm')).toBeTruthy();
  });

  it('shows error notice when createChannel fails', async () => {
    mockWebAuthnSupport(true);
    createChannelMock.mockResolvedValueOnce({
      ok: false,
      error: { ok: false, code: 'NETWORK_ERROR', stage: 'create.begin' },
    });

    renderCreatePage();
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-submit-error')).toBeTruthy();
    });
  });

  it('clears error when mode is switched', async () => {
    mockWebAuthnSupport(true);
    createChannelMock.mockResolvedValueOnce({
      ok: false,
      error: { ok: false, code: 'NETWORK_ERROR', stage: 'create.begin' },
    });

    renderCreatePage();
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-submit-error')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('mode-card-quick'));
    expect(screen.queryByTestId('create-submit-error')).toBeNull();
  });

  it('clears password after successful Quick Share creation', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-quick'));
    const input = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Strong#Pass123' } });
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    // Form is hidden after success; click "Create another" to reveal form with cleared password
    fireEvent.click(screen.getByTestId('create-another-button'));
    fireEvent.click(await screen.findByTestId('create-another-confirm-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('quick-share-password-panel')).toBeTruthy();
    });
    const newInput = screen.getByTestId('passphrase-input-field') as HTMLInputElement;
    expect(newInput.value).toBe('');
  });

  it('disables submit button while create request is pending', async () => {
    mockWebAuthnSupport(true);
    const deferred = createDeferred<{
      ok: true;
      data: {
        shareUrl: string;
        manageUrl: string;
        shareUrlWithFragment: string;
        lockSecretB64u: string;
        lockKeyB64u: string;
      };
    }>();
    createChannelMock.mockReturnValueOnce(deferred.promise);
    renderCreatePage();

    const submit = screen.getByTestId('create-submit-button') as HTMLButtonElement;
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(submit);

    await waitFor(() => {
      expect((screen.getByTestId('create-submit-button') as HTMLButtonElement).disabled).toBe(true);
    });
    const busyContainer = submit.closest('[aria-busy]');
    expect(busyContainer?.getAttribute('aria-busy')).toBe('true');

    deferred.resolve({
      ok: true,
      data: {
        shareUrl: '/s/aaaaaaaaaaaaaaaaaaaaa',
        manageUrl: '/m/aaaaaaaaaaaaaaaaaaaaa',
        shareUrlWithFragment: '/s/aaaaaaaaaaaaaaaaaaaaa#k=bW9ja19sb2NrX3NlY3JldA',
        lockSecretB64u: 'bW9ja19sb2NrX3NlY3JldA',
        lockKeyB64u: 'bW9ja19sb2NrX2tleQ',
      },
    });

    // After success, form is replaced by success state (submit button is no longer visible)
    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });
    expect(screen.queryByTestId('create-submit-button')).toBeNull();
  });

  it('renders a trust model link that points to /trust', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    const trustLink = screen.getByTestId('create-trust-link');
    expect(trustLink.getAttribute('href')).toBe('/trust');
    expect(trustLink.textContent?.toLowerCase()).toContain('trust model');
  });

  it('renders HowItWorks with the full 6-step flow in order', () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    const howItWorks = screen.getByTestId('how-it-works');
    const text = howItWorks.textContent ?? '';
    expect(howItWorks).toBeTruthy();
    expect(text).toContain('Create');
    expect(text).toContain('Share');
    expect(text).toContain('Lock');
    expect(text).toContain('Verify');
    expect(text).toContain('Deliver');
    expect(text).toContain('Decrypt');
    expect(text).toContain('Receiver sets a passphrase on their device and locks the channel.');
    expect(text).toContain(
      'Compare the Safety Code over a separate channel to confirm the receiver identity.'
    );
    expect(text).toContain(
      'The receiver decrypts the secret locally on the device that created the lock.'
    );
    expect(text.indexOf('Create')).toBeLessThan(text.indexOf('Share'));
    expect(text.indexOf('Share')).toBeLessThan(text.indexOf('Lock'));
    expect(text.indexOf('Lock')).toBeLessThan(text.indexOf('Verify'));
    expect(text.indexOf('Verify')).toBeLessThan(text.indexOf('Deliver'));
    expect(text.indexOf('Deliver')).toBeLessThan(text.indexOf('Decrypt'));
  });

  it('renders HowItWorks when WebAuthn is unavailable', () => {
    mockWebAuthnSupport(false);
    renderCreatePage();

    expect(screen.getByTestId('how-it-works')).toBeTruthy();
  });

  it('hides HowItWorks after successful creation', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    expect(screen.getByTestId('how-it-works')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });
    expect(screen.queryByTestId('how-it-works')).toBeNull();
  });

  it('shows expiry hint in success summary', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('create-ttl-one-day'));
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    const expiryHint = await screen.findByTestId('create-success-expiry-hint');
    expect(expiryHint.textContent).toContain('Channel expires in 24 hours');
    expect(expiryHint.textContent).toContain('Coordinate with the receiver before it disappears.');
  });

  it('passes selected TTL to the create orchestrator', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('create-ttl-seven-days'));
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(createChannelMock).toHaveBeenCalledWith(
        expect.objectContaining({ ttl: CHANNEL_TTL_MS.SEVEN_DAYS })
      );
    });
  });

  it('persists the selected TTL in the share-link recovery cache', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('create-ttl-seven-days'));
    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });

    const raw = window.sessionStorage.getItem('zerolink:created-share-link:aaaaaaaaaaaaaaaaaaaaa');
    expect(raw).toBeTruthy();

    const parsed = JSON.parse(String(raw));
    expect(parsed.url).toBe('/s/aaaaaaaaaaaaaaaaaaaaa');
    expect(parsed.lockSecret).toBe('bW9ja19sb2NrX3NlY3JldA');
    expect(parsed.ttl).toBe(CHANNEL_TTL_MS.SEVEN_DAYS);
  });

  it('shows HowItWorks again after clicking Create another', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-summary')).toBeTruthy();
    });
    expect(screen.queryByTestId('how-it-works')).toBeNull();

    fireEvent.click(screen.getByTestId('create-success-share-link-copy'));
    fireEvent.click(screen.getByTestId('create-success-manage-link-copy'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByTestId('create-another-button'));

    await waitFor(() => {
      expect(screen.getByTestId('how-it-works')).toBeTruthy();
    });
  });

  it('share link is not a clickable anchor (prevents sender self-click)', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-share-link')).toBeTruthy();
    });

    const shareLink = screen.getByTestId('create-success-share-link');
    expect(shareLink.tagName.toLowerCase()).not.toBe('a');
  });

  it('keeps manage link in the same tab for session recovery', async () => {
    mockWebAuthnSupport(true);
    renderCreatePage();

    fireEvent.click(screen.getByTestId('mode-card-secure'));
    fireEvent.click(screen.getByTestId('create-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('create-success-manage-link')).toBeTruthy();
    });

    const manageLink = screen.getByTestId('create-success-manage-link');
    expect(manageLink.tagName.toLowerCase()).toBe('a');
    expect(manageLink.getAttribute('target')).toBeNull();
    expect(manageLink.getAttribute('rel')).toBeNull();
  });
});
