import { type ChannelTtlMs, SECURITY_PROFILE, type SecurityProfile } from '@zerolink/shared';
import { Lock, Shield, Zap } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { StateNotice } from '../../components/layout';
import { PassphraseInput } from '../../components/lock/passphrase-input';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utils';
import { createTrustRouteState } from '../../trust-route-state';
import { CHANNEL_TTL_OPTIONS, getChannelTtlLabel } from './helpers';

type ModeCardProps = {
  title: string;
  description: string;
  icon: typeof Lock;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  'data-testid'?: string;
};

function ModeCard({
  title,
  description,
  icon: Icon,
  selected,
  disabled = false,
  onClick,
  'data-testid': testId,
}: ModeCardProps) {
  return (
    <button
      aria-disabled={disabled || undefined}
      aria-pressed={selected}
      className={cn(
        'flex w-full flex-col items-start gap-3 rounded-2xl border p-5 text-left transition-colors duration-200',
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-border/80',
        selected
          ? 'border-primary/55 bg-primary/8 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] ring-1 ring-primary/25'
          : 'border-border/60 bg-card/55'
      )}
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      type="button"
    >
      <div
        className={cn(
          'rounded-xl border p-2.5 transition-colors',
          selected
            ? 'border-primary/35 bg-primary/12 text-primary'
            : 'border-border/70 bg-background/30 text-muted-foreground'
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

export function ModeSelectorGrid({
  selected,
  webAuthnSupported,
  onSelect,
}: {
  selected: SecurityProfile;
  webAuthnSupported: boolean;
  onSelect: (profile: SecurityProfile) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold text-foreground">{t('create.chooseModeTitle')}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <ModeCard
          data-testid="mode-card-quick"
          description={t('create.quickShareDescription')}
          icon={Lock}
          onClick={() => onSelect(SECURITY_PROFILE.QUICK)}
          selected={selected === SECURITY_PROFILE.QUICK}
          title={t('create.quickShareTitle')}
        />
        <ModeCard
          data-testid="mode-card-secure"
          description={
            webAuthnSupported
              ? t('create.secureShareDescriptionAvailable')
              : t('create.secureShareDescriptionUnavailable')
          }
          disabled={!webAuthnSupported}
          icon={Shield}
          onClick={() => onSelect(SECURITY_PROFILE.SECURE)}
          selected={selected === SECURITY_PROFILE.SECURE}
          title={t('create.secureShareTitle')}
        />
      </div>
      {selected === SECURITY_PROFILE.SECURE ? (
        <div
          className="rounded-2xl border border-sky-300/20 bg-sky-400/8 p-4 text-sm leading-6 text-muted-foreground"
          data-testid="create-secure-share-hint"
        >
          {t('create.secureShareHint')}
        </div>
      ) : null}
      {!webAuthnSupported ? (
        <StateNotice
          data-testid="create-webauthn-blocked-warning"
          title={t('create.webauthnBlockedTitle')}
          tone="warning"
        >
          <p className="text-amber-100/90">{t('create.webauthnBlockedBody')}</p>
        </StateNotice>
      ) : null}
    </section>
  );
}

export function HowItWorks() {
  const { t } = useTranslation();

  const steps = useMemo(
    () => [
      {
        number: '01',
        numberClass: 'text-sky-200',
        title: t('create.step1Title'),
        description: t('create.step1Desc'),
      },
      {
        number: '02',
        numberClass: 'text-slate-200',
        title: t('create.step2Title'),
        description: t('create.step2Desc'),
      },
      {
        number: '03',
        numberClass: 'text-cyan-200',
        title: t('create.step3Title'),
        description: t('create.step3Desc'),
      },
      {
        number: '04',
        numberClass: 'text-amber-200',
        title: t('create.step4Title'),
        description: t('create.step4Desc'),
      },
      {
        number: '05',
        numberClass: 'text-emerald-200',
        title: t('create.step5Title'),
        description: t('create.step5Desc'),
      },
      {
        number: '06',
        numberClass: 'text-sky-100',
        title: t('create.step6Title'),
        description: t('create.step6Desc'),
      },
    ],
    [t]
  );

  return (
    <section
      className="rounded-2xl border border-border/60 bg-muted/18 p-5"
      data-testid="how-it-works"
    >
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        {t('create.howItWorksLabel')}
      </p>
      <div className="space-y-3">
        {steps.map((step) => (
          <div className="flex items-start gap-3" key={step.number}>
            <span
              className={cn(
                'mt-0.5 inline-flex min-h-8 min-w-8 items-center justify-center rounded-full border border-border/70 bg-background/30 text-xs font-semibold tracking-[0.18em]',
                step.numberClass
              )}
            >
              {step.number}
            </span>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">{step.title}</p>
              <p className="text-sm leading-6 text-muted-foreground">{step.description}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function TrustModelHint() {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <section className="rounded-2xl border border-border/60 bg-card/55 p-5">
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
          {t('trust.badge')}
        </p>
        <p className="text-sm leading-6 text-muted-foreground">{t('create.trustHintBody')}</p>
        <Link
          className="inline-flex text-sm font-semibold text-primary underline decoration-primary/35 underline-offset-4 transition-colors hover:text-foreground"
          data-testid="create-trust-link"
          state={createTrustRouteState(location)}
          to="/trust"
        >
          {t('create.trustHintLink')}
        </Link>
      </div>
    </section>
  );
}

export function QuickSharePasswordPanel({
  password,
  onPasswordChange,
}: {
  password: string;
  onPasswordChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="space-y-3 rounded-2xl border border-border/60 bg-card/55 p-5 text-sm"
      data-testid="quick-share-password-panel"
    >
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{t('create.passwordPanelTitle')}</p>
        <p className="leading-6 text-muted-foreground">{t('create.passwordPanelBody')}</p>
      </div>
      <PassphraseInput
        helperText={t('passphrase.policyHint')}
        inputId="create-quick-password"
        label={t('create.passwordLabel')}
        onChange={onPasswordChange}
        placeholder={t('create.passwordPlaceholder')}
        showStrength
        value={password}
      />
    </div>
  );
}

export function ExpirySelector({
  selected,
  onSelect,
}: {
  selected: ChannelTtlMs;
  onSelect: (ttl: ChannelTtlMs) => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground" id={titleId}>
          {t('create.expiryTitle')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('create.expiryDescription')}</p>
      </div>
      <div aria-labelledby={titleId} className="grid gap-3 sm:grid-cols-3" role="radiogroup">
        {CHANNEL_TTL_OPTIONS.map((option) => {
          const isSelected = selected === option.value;
          return (
            <label className="block cursor-pointer" key={option.value}>
              <input
                checked={isSelected}
                className="peer sr-only"
                data-testid={option.testId}
                name="channel-ttl"
                onChange={() => onSelect(option.value)}
                type="radio"
                value={String(option.value)}
              />
              <span
                className={cn(
                  'block rounded-2xl border px-4 py-3 text-left transition-[border-color,box-shadow,background-color] duration-200',
                  'peer-focus-visible:border-primary/70 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/35 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background',
                  'hover:border-border/80',
                  isSelected
                    ? 'border-primary/55 bg-primary/8 ring-1 ring-primary/25'
                    : 'border-border/60 bg-card/55'
                )}
              >
                <span className="font-semibold text-foreground">
                  {getChannelTtlLabel(t, option.value)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function ActionFooter({
  onCreate,
  disabled,
  canSubmit,
  isLoading,
  isQuickMode,
  quickPassword,
  selectedTtl,
}: {
  onCreate: () => void;
  disabled: boolean;
  canSubmit: boolean;
  isLoading: boolean;
  isQuickMode: boolean;
  quickPassword: string;
  selectedTtl: ChannelTtlMs;
}) {
  const { t } = useTranslation();
  const trimmedPassword = quickPassword.trim();
  const hint = isQuickMode
    ? trimmedPassword.length === 0
      ? t('create.footerHintPasswordRequired')
      : canSubmit
        ? t('create.footerHintReady', {
            mode: t('profile.quick'),
            ttl: getChannelTtlLabel(t, selectedTtl),
          })
        : t('create.footerHintPasswordInvalid')
    : t('create.footerHintReady', {
        mode: t('profile.secure'),
        ttl: getChannelTtlLabel(t, selectedTtl),
      });

  return (
    <section className="rounded-2xl border border-border/60 bg-muted/18 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          className="max-w-[28rem] text-sm leading-6 text-muted-foreground"
          data-testid="create-action-hint"
        >
          {hint}
        </p>
        <Button
          className="w-full sm:w-auto"
          data-testid="create-submit-button"
          disabled={disabled}
          onClick={onCreate}
          type="button"
        >
          {isLoading ? (
            <>
              <Spinner aria-hidden="true" className="size-4" />
              {t('create.submittingButton')}
            </>
          ) : (
            <>
              <Zap aria-hidden="true" className="size-4" />
              {t('create.submitButton')}
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
