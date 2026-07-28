import { CHANNEL_STATE } from '@zerolink/shared';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { ChannelUnavailableState } from '../components/channel/channel-unavailable-state';
import { PageCard, PageCardContent, StateNotice } from '../components/layout';
import { PassphraseInput } from '../components/lock/passphrase-input';
import { clearCreatedShareLink, readCreatedShareLink } from './create/share-link-session-cache';
import {
  ActionPanel,
  DeliveryModeSelector,
  FileInput,
  ManagePageHeader,
  SecretInput,
  StatusContent,
  UuidDisplay,
} from './manage/manage-components';
import {
  canComposeDelivery,
  getChannelPasswordHelperI18n,
  isTerminalManageState,
} from './manage/manage-utils';

function getSoftkeyHelperText(passphrase: string, t: ReturnType<typeof useTranslation>['t']) {
  const helper = getChannelPasswordHelperI18n(passphrase, t('manage.softkeyLabel'));
  return helper ? t(helper.key, helper.params) : undefined;
}

import { useManagePageState } from './manage/use-manage-page-state';

/**
 * Sender-side manage page integrated with orchestrator deliver/delete flows.
 */
export function ManagePage(): ReactElement {
  const { t } = useTranslation();
  const { uuid } = useParams<{ uuid: string }>();
  const state = useManagePageState(uuid);
  const usesPasswordManagedChannel =
    state.adminMode === 'password' || state.adminMode === 'softkey';
  const showUnavailableState = state.isUnavailable && state.status !== CHANNEL_STATE.DELETED;
  const isTerminalState = isTerminalManageState(state.status, showUnavailableState);
  const showDeliveryComposer = !isTerminalState && canComposeDelivery(state.status);
  const showPasswordSection =
    !isTerminalState &&
    usesPasswordManagedChannel &&
    (showDeliveryComposer || state.destroyStage !== 'idle');
  const softkeyHelperText = getSoftkeyHelperText(state.softkeyPassphrase, t);
  const [cachedShareLink, setCachedShareLink] = useState<string | null>(() =>
    readCreatedShareLink(uuid)
  );

  useEffect(() => {
    setCachedShareLink(readCreatedShareLink(uuid));
  }, [uuid]);

  useEffect(() => {
    if (!uuid) {
      return;
    }

    if (showUnavailableState || state.status !== CHANNEL_STATE.WAITING) {
      clearCreatedShareLink(uuid);
      setCachedShareLink(null);
    }
  }, [uuid, showUnavailableState, state.status]);

  const actionErrorNotice = state.actionError ? (
    <StateNotice
      autoFocusOnMount
      data-testid="manage-action-error"
      id="manage-action-error"
      tone="error"
    >
      {state.actionError}
    </StateNotice>
  ) : null;

  const actionPanel = (
    <ActionPanel
      canDestroy={state.canRequestDestroy}
      canManageActions={state.canManageActions}
      canDeliver={state.canDeliver}
      onCancelDestroy={state.handleCancelDestroy}
      onConfirmDestroy={state.handleApplyDestroy}
      onDeliver={state.handleDeliver}
      onOpenDestroyConfirm={state.handleDestroyConfirm}
      pending={state.isActionPending}
      pendingAction={state.pendingAction}
      showDeliverAction={showDeliveryComposer}
      showDestroyConfirm={state.showDestroyConfirm}
      status={state.status}
      unavailable={showUnavailableState}
    />
  );

  return (
    <PageCard data-testid="page-manage" tone="orange">
      <ManagePageHeader status={state.status} unavailable={showUnavailableState} />
      <PageCardContent aria-busy={state.isActionPending} className="space-y-5 sm:space-y-6">
        <UuidDisplay uuid={uuid} />

        {state.publicStatusError ? (
          <StateNotice
            data-testid="manage-public-status-error"
            id="manage-public-status-error"
            tone="warning"
          >
            {state.publicStatusError}
          </StateNotice>
        ) : null}

        {showUnavailableState ? (
          <ChannelUnavailableState
            body={t('manage.unavailableBody')}
            testId="manage-state-unavailable"
          />
        ) : (
          <StatusContent
            safetyCode={state.safetyCode}
            shareLinkRecoveryUrl={state.statusConfirmed ? cachedShareLink : null}
            status={state.status}
          />
        )}

        {showDeliveryComposer || showPasswordSection ? (
          <section className="max-w-[52rem] space-y-4 rounded-2xl border border-border/60 bg-muted/18 p-4 sm:p-5">
            {showDeliveryComposer ? (
              <DeliveryModeSelector
                disabled={state.isActionPending}
                mode={state.deliveryMode}
                onModeChange={state.handleModeChange}
              />
            ) : null}

            {showDeliveryComposer && state.deliveryMode === 'text' ? (
              <SecretInput
                ariaDescribedBy={
                  state.actionError && state.isSecretInputInvalid
                    ? 'manage-action-error'
                    : undefined
                }
                ariaInvalid={state.isSecretInputInvalid ? true : undefined}
                disabled={state.isActionPending}
                onChange={state.handleSecretChange}
                value={state.secretInput}
              />
            ) : null}

            {showDeliveryComposer && state.deliveryMode === 'file' ? (
              <FileInput
                disabled={state.isActionPending}
                maxFileBytes={state.filePolicyMaxBytes}
                onSelect={state.handleFileSelect}
                selectedFile={state.selectedFile}
              />
            ) : null}

            {showPasswordSection ? (
              <section className="space-y-2" data-testid="manage-softkey-passphrase-section">
                <p className="text-sm leading-6 text-muted-foreground">
                  {t('manage.softkeyPassphraseHint')}
                </p>
                <PassphraseInput
                  helperText={softkeyHelperText}
                  inputId="manage-softkey-passphrase"
                  label={t('manage.softkeyLabel')}
                  onChange={state.handleSoftkeyPassphraseChange}
                  placeholder={t('manage.softkeyPlaceholder')}
                  showStrength={false}
                  value={state.softkeyPassphrase}
                />
              </section>
            ) : null}

            {actionErrorNotice}
            {actionPanel}
          </section>
        ) : null}
        {!showDeliveryComposer && !showPasswordSection ? (
          <>
            {actionErrorNotice}
            {actionPanel}
          </>
        ) : null}
      </PageCardContent>
    </PageCard>
  );
}
