import { ROUTE_PATTERN } from '@zerolink/shared';
import { AlertTriangle, X } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouteObject } from 'react-router';
import { Link, Outlet, useLocation } from 'react-router';
import { Toaster } from 'sonner';

import { AppShellFooter } from './components/layout';
import { LanguageSwitcher } from './components/layout/language-switcher';
import { ManifestInfo } from './components/manifest-info';
import { Button } from './components/ui/button';
import { Card, CardHeader, CardTitle } from './components/ui/card';
import { CreatePage } from './pages/CreatePage';
import { ManagePage } from './pages/ManagePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SharePage } from './pages/SharePage';
import { TrustPage } from './pages/TrustPage';
import { createTrustRouteState } from './trust-route-state';

export const APP_ROUTE_ID = {
  SHELL: 'shell',
  CREATE: 'create',
  SHARE: 'share',
  MANAGE: 'manage',
  TRUST: 'trust',
  NOT_FOUND: 'not-found',
} as const;

const TRUST_PAGE_PATH = 'trust' as const;

function toChildPath(routePattern: string): string {
  return routePattern.startsWith('/') ? routePattern.slice(1) : routePattern;
}

const IN_APP_BROWSER_DISMISSED_KEY = 'zl-inapp-dismissed';

const IN_APP_BROWSER_UA_PATTERN =
  /Instagram|FBAN|FBAV|Twitter|Snapchat|TikTok|musical_ly|LinkedInApp|Line\/|Telegram|MicroMessenger/i;

function isInAppBrowser(): boolean {
  const ua = navigator.userAgent;
  if (IN_APP_BROWSER_UA_PATTERN.test(ua)) return true;
  // Android WebView: contains "wv" flag
  if (/Android.*wv\b/i.test(ua)) return true;
  // iOS UIWebView / WKWebView: AppleWebKit present but no "Safari" version token
  if (/(iPhone|iPod|iPad).*AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) return true;
  return false;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readSessionStorage(key: string): string | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage failures and keep the UI responsive in restricted WebViews/private modes.
  }
}

function AppShellLayout(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const isTrustRoute = location.pathname === `/${TRUST_PAGE_PATH}`;
  const trustRouteState = createTrustRouteState(location);
  const [showInAppWarning, setShowInAppWarning] = useState(
    () => isInAppBrowser() && readSessionStorage(IN_APP_BROWSER_DISMISSED_KEY) !== '1'
  );

  const handleDismissInAppWarning = () => {
    writeSessionStorage(IN_APP_BROWSER_DISMISSED_KEY, '1');
    setShowInAppWarning(false);
  };

  return (
    <main
      className="relative isolate mx-auto min-h-screen w-full max-w-6xl overflow-x-hidden px-4 py-7 md:px-8 md:py-10"
      data-testid="app-shell"
    >
      <Toaster position="bottom-center" richColors />
      {showInAppWarning ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-300/28 bg-amber-400/8 px-4 py-3 text-sm text-amber-200"
          data-testid="inapp-browser-warning"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{t('shell.inAppBrowserWarning')}</span>
          <button
            aria-label="Dismiss"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-amber-100/75 transition-colors hover:bg-amber-300/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/35"
            data-testid="inapp-browser-warning-dismiss"
            onClick={handleDismissInAppWarning}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}
      <Card className="sticky top-3 z-50 border-white/8 bg-slate-950/74 shadow-[0_18px_40px_rgb(2_8_23_/_0.22)] backdrop-blur-lg md:top-4">
        <CardHeader className="gap-3 py-4 md:flex-row md:items-center md:justify-between md:gap-5">
          <div className="flex items-center gap-3">
            <img alt="" aria-hidden="true" className="size-10 shrink-0" src="/zerolink-icon.svg" />
            <div>
              <CardTitle asChild className="text-[1.95rem] tracking-tight md:text-[2.35rem]">
                <h1>
                  Zero<span className="text-primary">Link</span>
                </h1>
              </CardTitle>
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                {t('shell.tagline')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start md:self-center">
            <LanguageSwitcher />
            <Button asChild size="sm" variant="outline">
              {isTrustRoute ? (
                <Link data-testid="app-shell-back-link" to="/">
                  {t('shell.backToCreate')}
                </Link>
              ) : (
                <Link
                  data-testid="app-shell-trust-link"
                  state={trustRouteState}
                  to={`/${TRUST_PAGE_PATH}`}
                >
                  {t('shell.trustModelLink')}
                </Link>
              )}
            </Button>
          </div>
        </CardHeader>
      </Card>
      <section className="mt-6 space-y-4 md:mt-8">
        <ManifestInfo />
        <Outlet />
      </section>
      <AppShellFooter />
    </main>
  );
}

export const APP_ROUTES: RouteObject[] = [
  {
    id: APP_ROUTE_ID.SHELL,
    path: '/',
    element: <AppShellLayout />,
    children: [
      {
        id: APP_ROUTE_ID.CREATE,
        index: true,
        element: <CreatePage />,
      },
      {
        id: APP_ROUTE_ID.SHARE,
        path: toChildPath(ROUTE_PATTERN.SHARE),
        element: <SharePage />,
      },
      {
        id: APP_ROUTE_ID.MANAGE,
        path: toChildPath(ROUTE_PATTERN.MANAGE),
        element: <ManagePage />,
      },
      {
        id: APP_ROUTE_ID.TRUST,
        path: TRUST_PAGE_PATH,
        element: <TrustPage />,
      },
      {
        id: APP_ROUTE_ID.NOT_FOUND,
        path: '*',
        element: <NotFoundPage />,
      },
    ],
  },
];
