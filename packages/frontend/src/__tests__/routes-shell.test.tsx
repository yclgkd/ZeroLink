// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_ROUTES } from '../routes';

function renderFrom(pathname: string) {
  const router = createMemoryRouter(APP_ROUTES, {
    initialEntries: [pathname],
  });

  return { router, ...render(<RouterProvider router={router} />) };
}

describe('App shell routes rendering', () => {
  afterEach(() => {
    cleanup();
  });

  describe('in-app browser warning banner', () => {
    const IN_APP_UA =
      'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Instagram/123.0 Mobile Safari/537.36';
    const NORMAL_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const DISMISSED_KEY = 'zl-inapp-dismissed';

    beforeEach(() => {
      sessionStorage.clear();
    });

    it('shows the banner when UA matches an in-app browser pattern', async () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: IN_APP_UA });
      renderFrom('/');

      expect(await screen.findByTestId('inapp-browser-warning')).toBeTruthy();
      vi.unstubAllGlobals();
    });

    it('hides the banner and writes sessionStorage when dismiss is clicked', async () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: IN_APP_UA });
      renderFrom('/');

      const banner = await screen.findByTestId('inapp-browser-warning');
      expect(banner).toBeTruthy();

      fireEvent.click(screen.getByTestId('inapp-browser-warning-dismiss'));
      expect(screen.queryByTestId('inapp-browser-warning')).toBeNull();
      expect(sessionStorage.getItem(DISMISSED_KEY)).toBe('1');
      vi.unstubAllGlobals();
    });

    it('keeps the banner dismissible when sessionStorage writes throw', async () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      const storageMock = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(() => {
          throw new Error('sessionStorage disabled');
        }),
      } as unknown as Storage;

      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get: () => storageMock,
      });

      try {
        vi.stubGlobal('navigator', { ...navigator, userAgent: IN_APP_UA });
        renderFrom('/');

        expect(await screen.findByTestId('inapp-browser-warning')).toBeTruthy();
        fireEvent.click(screen.getByTestId('inapp-browser-warning-dismiss'));

        expect(screen.queryByTestId('inapp-browser-warning')).toBeNull();
        expect(storageMock.setItem).toHaveBeenCalledWith(DISMISSED_KEY, '1');
      } finally {
        vi.unstubAllGlobals();
        if (originalDescriptor) {
          Object.defineProperty(window, 'sessionStorage', originalDescriptor);
        }
      }
    });

    it('does not show the banner when sessionStorage already has the dismissed key', async () => {
      sessionStorage.setItem(DISMISSED_KEY, '1');
      vi.stubGlobal('navigator', { ...navigator, userAgent: IN_APP_UA });
      renderFrom('/');

      await screen.findByTestId('app-shell');
      expect(screen.queryByTestId('inapp-browser-warning')).toBeNull();
      vi.unstubAllGlobals();
    });

    it('does not show the banner for a normal desktop browser UA', async () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: NORMAL_UA });
      renderFrom('/');

      await screen.findByTestId('app-shell');
      expect(screen.queryByTestId('inapp-browser-warning')).toBeNull();
      vi.unstubAllGlobals();
    });
  });

  it('renders app shell and default create child route', async () => {
    renderFrom('/');

    expect(await screen.findByTestId('app-shell')).toBeTruthy();
    expect(screen.getByText('Zero')).toBeTruthy();
    expect(screen.queryByTestId('manifest-info-card')).toBeNull();
    expect(screen.getByTestId('page-create')).toBeTruthy();
  });

  it('renders a footer repository link in the app shell', async () => {
    renderFrom('/');

    await screen.findByTestId('app-shell');

    const repositoryLink = screen.getByTestId('app-shell-repo-link');
    expect(repositoryLink.getAttribute('href')).toBe('https://github.com/yclgkd/ZeroLink');
    expect(repositoryLink.getAttribute('target')).toBe('_blank');
    expect(repositoryLink.getAttribute('rel')).toContain('noreferrer');
    expect(repositoryLink.textContent).toContain('GitHub');
  });

  it('does not render demo nav links for share/manage', async () => {
    renderFrom('/');

    await screen.findByTestId('app-shell');
    expect(screen.queryByRole('link', { name: 'Share' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull();
  });

  it('renders trust page inside the app shell and swaps the shell CTA to back-to-create', async () => {
    renderFrom('/trust');

    expect(await screen.findByTestId('app-shell')).toBeTruthy();
    expect(screen.getByTestId('page-trust')).toBeTruthy();
    expect(screen.getByTestId('app-shell-back-link').getAttribute('href')).toBe('/');
    expect(screen.getByTestId('trust-create-button').textContent).toContain(
      'Create Secure Channel'
    );
  });

  it('create-page trust link navigates to the trust page via SPA routing', async () => {
    renderFrom('/');

    expect(await screen.findByTestId('page-create')).toBeTruthy();

    const trustLink = screen.getByTestId('create-trust-link');
    expect(trustLink.getAttribute('href')).toBe('/trust');

    fireEvent.click(trustLink);
    expect(await screen.findByTestId('page-trust')).toBeTruthy();
  });

  it('returns to the prior shell route when trust page is opened from the shell trust link', async () => {
    renderFrom('/non-existing-path');

    expect(await screen.findByTestId('page-not-found')).toBeTruthy();

    fireEvent.click(screen.getByTestId('app-shell-trust-link'));
    expect(await screen.findByTestId('page-trust')).toBeTruthy();

    fireEvent.click(screen.getByTestId('trust-back-button'));

    expect(await screen.findByTestId('page-not-found')).toBeTruthy();
  });

  it('falls back to create page when trust page is opened directly', async () => {
    renderFrom('/trust');

    expect(await screen.findByTestId('page-trust')).toBeTruthy();

    fireEvent.click(screen.getByTestId('trust-back-button'));

    expect(await screen.findByTestId('page-create')).toBeTruthy();
  });

  it('falls back to not-found child route for unknown path', async () => {
    renderFrom('/non-existing-path');

    expect(await screen.findByTestId('page-not-found')).toBeTruthy();
    expect(screen.getByText('Page Not Found')).toBeTruthy();
  });
});
