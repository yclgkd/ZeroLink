import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { APP_ROUTE_ID, APP_ROUTES } from '../routes';

function resolveLeafRouteId(pathname: string): string | undefined {
  const matches = matchRoutes(APP_ROUTES as Parameters<typeof matchRoutes>[0], pathname);
  if (!matches || matches.length === 0) {
    return undefined;
  }

  const lastMatch = matches[matches.length - 1];
  return typeof lastMatch?.route.id === 'string' ? lastMatch.route.id : undefined;
}

describe('frontend app shell routes', () => {
  it('matches root to create route', () => {
    expect(resolveLeafRouteId('/')).toBe(APP_ROUTE_ID.CREATE);
  });

  it('matches /s/:uuid to share route', () => {
    expect(resolveLeafRouteId('/s/test-channel')).toBe(APP_ROUTE_ID.SHARE);
  });

  it('matches /m/:uuid to manage route', () => {
    expect(resolveLeafRouteId('/m/test-channel')).toBe(APP_ROUTE_ID.MANAGE);
  });

  it('matches /trust to trust route', () => {
    expect(resolveLeafRouteId('/trust')).toBe(APP_ROUTE_ID.TRUST);
  });

  it('matches unknown paths to not-found route', () => {
    expect(resolveLeafRouteId('/not-a-real-route')).toBe(APP_ROUTE_ID.NOT_FOUND);
  });
});
