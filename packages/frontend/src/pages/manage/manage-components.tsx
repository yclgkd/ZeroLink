import { CHANNEL_STATE, type ChannelState } from '@zerolink/shared';
import { ClipboardCheck, Copy, PlusCircle, Send, Trash2 } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  PageCardDescription,
  PageCardHeader,
  PageCardTitle,
  RoleBadge,
  StateNotice,
  StatusBadge,
} from '../../components/layout';
import { SafetyCode } from '../../components/safety/safety-code';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import type { deriveSafetyCodeDisplay } from '../../crypto/safety-code-derive';
import { cn } from '../../lib/utils';
import { isTerminalManageState } from './manage-utils';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function ManagePageHeader({
  status,
  unavailable,
}: {
  status: ChannelState;
  unavailable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <PageCardHeader>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <PageCardTitle asChild className="text-primary">
            <h2>{t('manage.headerTitle')}</h2>
          </PageCardTitle>
          {unavailable ? null : <StatusBadge status={status} />}
        </div>
        <RoleBadge party="sender" />
      </div>
      <PageCardDescription className="max-w-2xl">
        {t('manage.headerDescription')}
      </PageCardDescription>
    </PageCardHeader>
  );
}

export function UuidDisplay({ uuid }: { uuid?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      {t('manage.channelIdLabel')}{' '}
      <code
        className="rounded-lg border border-border/60 bg-background/35 px-2 py-1 font-mono text-sm text-foreground"
        data-testid="manage-uuid"
      >
        {uuid ?? t('manage.channelIdMissing')}
      </code>
    </p>
  );
}

function ShareLinkRecoveryPanel({ shareUrl }: { shareUrl: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  async function handleCopy(): Promise<void> {
    if (!navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(new URL(shareUrl, window.location.origin).href);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <StateNotice
      data-testid="manage-share-link-recovery"
      title={t('manage.shareLinkRecoveryTitle')}
      tone="info"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-foreground/85">{t('manage.shareLinkRecoveryBody')}</p>
        <button
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-border/70 bg-background/35 px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          data-testid="manage-share-link-recovery-copy"
          onClick={() => void handleCopy()}
          type="button"
        >
          {copied ? (
            <>
              <ClipboardCheck aria-hidden="true" className="size-4 text-emerald-200" />
              {t('manage.shareLinkRecoveryCopied')}
            </>
          ) : (
            <>
              <Copy aria-hidden="true" className="size-4" />
              {t('manage.shareLinkRecoveryButton')}
            </>
          )}
        </button>
      </div>
    </StateNotice>
  );
}

export function StatusContent({
  status,
  safetyCode,
  shareLinkRecoveryUrl,
}: {
  status: ChannelState;
  safetyCode: ReturnType<typeof deriveSafetyCodeDisplay> | null;
  shareLinkRecoveryUrl?: string | null;
}) {
  const { t } = useTranslation();

  if (status === CHANNEL_STATE.WAITING) {
    return (
      <section className="max-w-[48rem] space-y-4" data-testid="manage-state-waiting">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">{t('manage.waitingTitle')}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{t('manage.waitingBody')}</p>
        </div>
        {shareLinkRecoveryUrl ? <ShareLinkRecoveryPanel shareUrl={shareLinkRecoveryUrl} /> : null}
      </section>
    );
  }

  if (status === CHANNEL_STATE.LOCKED) {
    return (
      <section className="max-w-[52rem] space-y-3" data-testid="manage-state-locked">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">{t('manage.lockedTitle')}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{t('manage.lockedBody')}</p>
        </div>

        {safetyCode ? (
          <SafetyCode density="compact" display={safetyCode} />
        ) : (
          <StateNotice
            data-testid="manage-safety-unavailable"
            title={t('manage.safetyUnavailableTitle')}
            tone="warning"
          >
            <p className="mt-1 text-sm text-foreground/85">{t('manage.safetyUnavailableBody')}</p>
          </StateNotice>
        )}
      </section>
    );
  }

  if (status === CHANNEL_STATE.DELIVERED) {
    return (
      <section className="max-w-[52rem] space-y-3" data-testid="manage-state-delivered">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-foreground">{t('manage.deliveredTitle')}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{t('manage.deliveredBody')}</p>
        </div>

        {safetyCode ? (
          <SafetyCode density="compact" display={safetyCode} />
        ) : (
          <StateNotice
            data-testid="manage-safety-unavailable"
            title={t('manage.safetyUnavailableTitle')}
            tone="warning"
          >
            <p className="mt-1 text-sm text-foreground/85">{t('manage.safetyUnavailableBody')}</p>
          </StateNotice>
        )}
      </section>
    );
  }

  if (status === CHANNEL_STATE.DELETED) {
    return (
      <section className="max-w-[46rem] space-y-2" data-testid="manage-state-deleted">
        <h3 className="text-base font-semibold text-foreground">{t('manage.deletedTitle')}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{t('manage.deletedBody')}</p>
      </section>
    );
  }

  return (
    <section className="max-w-[46rem] space-y-2" data-testid="manage-state-expired">
      <h3 className="text-base font-semibold text-foreground">{t('manage.expiredTitle')}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{t('manage.expiredBody')}</p>
    </section>
  );
}

export function DeliveryModeSelector({
  mode,
  onModeChange,
  disabled,
}: {
  mode: 'text' | 'file';
  onModeChange: (mode: 'text' | 'file') => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label="Delivery mode"
      className="flex gap-1 rounded-xl border border-border/60 bg-background/20 p-1"
      data-testid="manage-delivery-mode-selector"
      role="tablist"
    >
      {(['text', 'file'] as const).map((m) => (
        <button
          aria-selected={mode === m}
          className={cn(
            'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
            mode === m
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
          data-testid={`manage-mode-${m}`}
          disabled={disabled}
          key={m}
          onClick={() => onModeChange(m)}
          role="tab"
          type="button"
        >
          {t(m === 'text' ? 'manage.deliveryModeText' : 'manage.deliveryModeFile')}
        </button>
      ))}
    </div>
  );
}

export function SecretInput({
  value,
  onChange,
  disabled,
  ariaInvalid,
  ariaDescribedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  ariaInvalid?: boolean | undefined;
  ariaDescribedBy?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-3">
      <label className="text-sm font-medium text-foreground" htmlFor="manage-secret-input">
        {t('manage.secretLabel')}
      </label>
      <textarea
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className="min-h-28 w-full rounded-2xl border border-border/70 bg-card/60 px-4 py-3 text-sm text-foreground outline-none ring-offset-background transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="manage-secret-input"
        disabled={disabled}
        id="manage-secret-input"
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('manage.secretPlaceholder')}
        value={value}
      />
    </section>
  );
}

export function FileInput({
  selectedFile,
  disabled,
  onSelect,
  maxFileBytes,
}: {
  selectedFile: File | null;
  disabled: boolean;
  onSelect: (file: File | null) => boolean;
  maxFileBytes: number | null;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectedFile && inputRef.current?.value) {
      inputRef.current.value = '';
    }
  }, [selectedFile]);

  function clearSelection(): void {
    if (inputRef.current) {
      inputRef.current.value = '';
    }
    onSelect(null);
  }

  const sizeHint =
    maxFileBytes === null
      ? t('manage.fileSizeLimitLoading')
      : t('manage.fileSizeLimit', { size: formatFileSize(maxFileBytes) });

  return (
    <section className="flex flex-col gap-3">
      <label className="text-sm font-medium text-foreground" htmlFor="manage-file-input">
        {t('manage.fileLabel')}
      </label>
      <input
        className="block w-full rounded-2xl border border-border/70 bg-card/60 px-4 py-3 text-sm text-foreground file:mr-3 file:rounded-xl file:border-0 file:bg-primary/12 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="manage-file-input"
        disabled={disabled}
        id="manage-file-input"
        onChange={(event) => {
          const accepted = onSelect(event.target.files?.[0] ?? null);
          if (!accepted) {
            event.target.value = '';
          }
        }}
        ref={inputRef}
        type="file"
      />
      <p className="text-xs text-muted-foreground" data-testid="manage-file-size-hint">
        {sizeHint}
      </p>
      {selectedFile ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/60 bg-background/35 px-4 py-3 text-sm text-muted-foreground"
          data-testid="manage-file-selected"
        >
          <span className="break-all text-foreground">
            {selectedFile.name} ({selectedFile.size} bytes)
          </span>
          <Button
            data-testid="manage-file-clear"
            disabled={disabled}
            onClick={clearSelection}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t('manage.fileClearButton')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function DestroyConfirmPanel({
  pending,
  isDeleting,
  onCancelDestroy,
  onConfirmDestroy,
}: {
  pending: boolean;
  isDeleting: boolean;
  onCancelDestroy: () => void;
  onConfirmDestroy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="space-y-3 rounded-2xl border border-destructive/40 bg-destructive/8 p-4 text-sm ring-1 ring-destructive/15"
      data-testid="manage-destroy-confirm"
    >
      <div className="space-y-1">
        <p className="font-semibold text-destructive">{t('manage.destroyConfirmTitle')}</p>
        <p className="text-sm leading-6 text-muted-foreground">{t('manage.destroyConfirmBody')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="manage-destroy-cancel"
          disabled={pending}
          onClick={onCancelDestroy}
          size="sm"
          type="button"
          variant="secondary"
        >
          {t('manage.destroyCancelButton')}
        </Button>
        <Button
          data-testid="manage-destroy-confirm-apply"
          disabled={pending}
          onClick={onConfirmDestroy}
          size="sm"
          type="button"
          variant="danger"
        >
          {isDeleting ? (
            <>
              <Spinner aria-hidden="true" className="size-3.5" />
              {t('manage.destroyDeletingButton')}
            </>
          ) : (
            <>
              <Trash2 aria-hidden="true" className="size-3.5" />
              {t('manage.destroyConfirmButton')}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export function TerminalActions(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <section data-testid="manage-terminal-actions">
      <Button
        className="w-full sm:w-auto"
        data-testid="manage-create-new-button"
        onClick={() => void navigate('/')}
        type="button"
        variant="secondary"
      >
        <PlusCircle aria-hidden="true" className="size-4" />
        {t('manage.createNewButton')}
      </Button>
    </section>
  );
}

export function ActionPanel({
  status,
  unavailable,
  showDestroyConfirm,
  pending,
  pendingAction,
  showDeliverAction,
  canDestroy,
  canManageActions,
  canDeliver,
  onDeliver,
  onOpenDestroyConfirm,
  onCancelDestroy,
  onConfirmDestroy,
}: {
  status: ChannelState;
  unavailable: boolean;
  showDestroyConfirm: boolean;
  pending: boolean;
  pendingAction: 'deliver' | 'delete' | null;
  showDeliverAction: boolean;
  canDestroy: boolean;
  canManageActions: boolean;
  canDeliver: boolean;
  onDeliver: () => void;
  onOpenDestroyConfirm: () => void;
  onCancelDestroy: () => void;
  onConfirmDestroy: () => void;
}) {
  const { t } = useTranslation();
  const isDeliverPending = pendingAction === 'deliver';
  const isDeletePending = pendingAction === 'delete';

  if (isTerminalManageState(status, unavailable)) {
    return <TerminalActions />;
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {showDeliverAction ? (
          <Button
            className="w-full sm:w-auto"
            data-testid="manage-deliver-button"
            disabled={pending || !canDeliver}
            onClick={onDeliver}
            type="button"
          >
            {isDeliverPending ? (
              <>
                <Spinner aria-hidden="true" className="size-4" />
                {t('manage.deliveringButton')}
              </>
            ) : (
              <>
                <Send aria-hidden="true" className="size-4" />
                {t('manage.deliverButton')}
              </>
            )}
          </Button>
        ) : null}
        <Button
          className="w-full sm:w-auto"
          data-testid="manage-destroy-button"
          disabled={pending || !canManageActions || !canDestroy}
          onClick={onOpenDestroyConfirm}
          type="button"
          variant="danger"
        >
          <Trash2 aria-hidden="true" className="size-4" />
          {t('manage.deleteChannelButton')}
        </Button>
      </div>

      {showDestroyConfirm ? (
        <DestroyConfirmPanel
          isDeleting={isDeletePending}
          onCancelDestroy={onCancelDestroy}
          onConfirmDestroy={onConfirmDestroy}
          pending={pending}
        />
      ) : null}
    </section>
  );
}
