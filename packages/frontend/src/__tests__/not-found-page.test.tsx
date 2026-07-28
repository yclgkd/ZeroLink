// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { NotFoundPage } from '../pages/NotFoundPage';

describe('NotFoundPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders info notice with status semantics and keeps back navigation', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );

    expect(screen.getByTestId('page-not-found')).toBeTruthy();
    const info = screen.getByTestId('not-found-info');
    expect(info.getAttribute('role')).toBe('status');
    expect(info.getAttribute('aria-live')).toBe('polite');

    const backLink = screen.getByRole('link', { name: 'Back to Create' });
    expect(backLink.getAttribute('href')).toBe('/');
  });
});
