// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { routerProviderSpy } = vi.hoisted(() => ({
  routerProviderSpy: vi.fn(),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    RouterProvider: ({ router }: { router: unknown }) => {
      routerProviderSpy(router);
      return <div data-testid="router-provider-stub" />;
    },
  };
});

import { App } from '../App';
import { appRouter } from '../router';

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders RouterProvider with appRouter', () => {
    render(<App />);

    expect(screen.getByTestId('router-provider-stub')).toBeTruthy();
    expect(routerProviderSpy).toHaveBeenCalledTimes(1);
    expect(routerProviderSpy).toHaveBeenCalledWith(appRouter);
  });
});
