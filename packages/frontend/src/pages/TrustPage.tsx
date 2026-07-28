import { type ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  PageCard,
  PageCardContent,
  PageCardDescription,
  PageCardFooter,
  PageCardHeader,
  PageCardTitle,
} from '../components/layout';
import { Button } from '../components/ui/button';
import { hasTrustRouteReturnTo } from '../trust-route-state';

export function TrustPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const canReturnToPreviousRoute = hasTrustRouteReturnTo(location.state);

  const trustSections = useMemo(
    () => [
      {
        title: t('trust.section1Title'),
        body: t('trust.section1Body'),
      },
      {
        title: t('trust.section2Title'),
        body: t('trust.section2Body'),
      },
      {
        title: t('trust.section3Title'),
        body: t('trust.section3Body'),
      },
      {
        title: t('trust.section4Title'),
        body: t('trust.section4Body'),
      },
      {
        title: t('trust.section5Title'),
        body: t('trust.section5Body'),
      },
      {
        title: t('trust.section6Title'),
        body: t('trust.section6Body'),
      },
    ],
    [t]
  );

  return (
    <PageCard data-testid="page-trust" tone="cyan">
      <PageCardHeader className="gap-2">
        <p className="text-xs uppercase tracking-[0.32em] text-muted-foreground">
          {t('trust.badge')}
        </p>
        <PageCardTitle asChild className="text-primary">
          <h2>{t('trust.title')}</h2>
        </PageCardTitle>
        <PageCardDescription className="max-w-2xl">{t('trust.description')}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent className="space-y-5">
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/45">
          {trustSections.map((section, index) => (
            <article
              className="flex flex-col gap-3 border-b border-border/60 px-5 py-5 last:border-b-0 sm:px-6"
              key={section.title}
            >
              <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </p>
              <div className="grid gap-2 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-6">
                <h3 className="text-lg font-semibold text-foreground">{section.title}</h3>
                <p className="max-w-3xl text-sm leading-7 text-muted-foreground">{section.body}</p>
              </div>
            </article>
          ))}
        </div>
      </PageCardContent>
      <PageCardFooter className="flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-between">
        <Button
          className="w-full sm:w-auto"
          data-testid="trust-back-button"
          onClick={() => {
            if (canReturnToPreviousRoute) {
              navigate(-1);
              return;
            }

            navigate('/');
          }}
          type="button"
          variant="secondary"
        >
          {t('trust.backButton')}
        </Button>
        <Button asChild className="w-full sm:w-auto" data-testid="trust-create-button">
          <Link to="/">{t('trust.createButton')}</Link>
        </Button>
      </PageCardFooter>
    </PageCard>
  );
}
