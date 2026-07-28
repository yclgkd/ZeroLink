import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  PageCard,
  PageCardContent,
  PageCardDescription,
  PageCardFooter,
  PageCardHeader,
  PageCardTitle,
  StateNotice,
} from '../components/layout';
import { Button } from '../components/ui/button';

export function NotFoundPage(): ReactElement {
  const { t } = useTranslation();

  return (
    <PageCard data-testid="page-not-found" tone="orange">
      <PageCardHeader className="gap-2">
        <PageCardTitle asChild className="text-destructive">
          <h2>{t('notFound.title')}</h2>
        </PageCardTitle>
        <PageCardDescription>{t('notFound.description')}</PageCardDescription>
      </PageCardHeader>
      <PageCardContent>
        <StateNotice data-testid="not-found-info" tone="info">
          {t('notFound.hint')}
        </StateNotice>
      </PageCardContent>
      <PageCardFooter>
        <Button asChild size="sm" variant="secondary">
          <Link to="/">{t('notFound.backButton')}</Link>
        </Button>
      </PageCardFooter>
    </PageCard>
  );
}
