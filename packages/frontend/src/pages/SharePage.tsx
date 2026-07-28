import { CHANNEL_STATE } from '@zerolink/shared';
import { type ReactElement, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams } from 'react-router';

import { PageCard, PageCardContent, StateNotice } from '../components/layout';
import { SharePageHeader } from '../components/share/share-page-header';
import {
  DeliveredStep,
  LoadingStep,
  LockedStep,
  LockStep,
  OnboardingStep,
  StepIndicator,
  UnavailableStep,
} from '../components/share/share-steps';
import { createIndexedDbReceiverKeyStorage } from '../crypto/storage';
import {
  usePublicShareState,
  useReceiverSafetyCodeState,
  useSharePageDecryptLogic,
  useSharePageLockLogic,
} from '../features/share/share-logic';

function UuidDisplay({ uuid }: { uuid?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      {t('share.channelIdLabel')}{' '}
      <code
        className="rounded-lg border border-border/60 bg-background/35 px-2 py-1 font-mono text-sm text-foreground"
        data-testid="share-uuid"
      >
        {uuid ?? t('share.channelIdMissing')}
      </code>
    </p>
  );
}

const LOCK_STEP_INDEX: Record<'onboarding' | 'lock' | 'locked', number> = {
  onboarding: 1,
  lock: 2,
  locked: 3,
};

/**
 * Receiver page integrating lock flow and delivered decryption flow with orchestrator.
 */
export function SharePage(): ReactElement {
  const { t } = useTranslation();
  const LOCK_FLOW_STEPS = useMemo(
    () => [t('share.stepIntro'), t('share.stepPassphrase'), t('share.stepReady')] as const,
    [t]
  );
  const { uuid } = useParams<{ uuid: string }>();
  const location = useLocation();
  const receiverKeyStorage = useMemo(() => createIndexedDbReceiverKeyStorage(), []);
  const publicState = usePublicShareState(uuid, receiverKeyStorage);
  const isUnavailable = !publicState.isPublicStatusLoading && publicState.isUnavailable;
  const lockLogic = useSharePageLockLogic(uuid, location.pathname, location.search, location.hash);
  const { clearLockSecretCache } = lockLogic;
  const isDeliveredState =
    !publicState.isPublicStatusLoading && publicState.channelState === CHANNEL_STATE.DELIVERED;
  const decryptLogic = useSharePageDecryptLogic(uuid, isDeliveredState);
  const receiverSafetyCode = useReceiverSafetyCodeState({
    uuid,
    channelState: publicState.channelState,
    publicReceiverPubFpr: publicState.receiverPubFpr,
    localSafetyCode: lockLogic.store.safetyCode,
    receiverKeyStorage,
  });
  const isPageBusy =
    publicState.isPublicStatusLoading || lockLogic.lockPending || decryptLogic.decryptPending;

  useEffect(() => {
    if (!uuid || publicState.isPublicStatusLoading) return;
    if (publicState.isUnavailable) {
      clearLockSecretCache('public-state:unavailable');
      return;
    }
    if (publicState.channelState !== CHANNEL_STATE.WAITING) {
      clearLockSecretCache(`public-state:${publicState.channelState}`);
    }
  }, [
    uuid,
    publicState.isPublicStatusLoading,
    publicState.isUnavailable,
    publicState.channelState,
    clearLockSecretCache,
  ]);

  return (
    <PageCard data-testid="page-share" tone="cyan">
      <SharePageHeader
        channelState={publicState.channelState}
        isPublicStatusLoading={publicState.isPublicStatusLoading}
        isUnavailable={isUnavailable}
      />
      <PageCardContent aria-busy={isPageBusy} className="space-y-5 sm:space-y-6">
        <UuidDisplay uuid={uuid} />

        {publicState.publicStatusError ? (
          <StateNotice
            data-testid="share-public-status-error"
            id="share-public-status-error"
            tone="warning"
          >
            {publicState.publicStatusError}
          </StateNotice>
        ) : null}

        {publicState.isPublicStatusLoading ? <LoadingStep /> : null}

        {isUnavailable ? <UnavailableStep /> : null}

        {!publicState.isPublicStatusLoading &&
        !publicState.isUnavailable &&
        publicState.channelState === CHANNEL_STATE.WAITING ? (
          <>
            {lockLogic.store.step !== 'locked' ? (
              <StepIndicator
                current={LOCK_STEP_INDEX[lockLogic.store.step]}
                labels={LOCK_FLOW_STEPS}
                total={3}
              />
            ) : null}
            {lockLogic.store.step === 'onboarding' ? (
              <OnboardingStep onContinue={() => lockLogic.store.setStep('lock')} />
            ) : null}
            {lockLogic.store.step === 'lock' ? (
              <LockStep
                canGenerate={lockLogic.canGenerate}
                isLockPassphraseInvalid={lockLogic.isLockPassphraseInvalid}
                lockError={lockLogic.lockError}
                lockPending={lockLogic.lockPending}
                lockSecretWarning={lockLogic.lockSecretWarning}
                originalShareUrl={lockLogic.originalShareUrl}
                onBack={() => {
                  if (lockLogic.lockPending) return;
                  lockLogic.clearLockError();
                  lockLogic.store.setStep('onboarding');
                }}
                onGenerate={() => void lockLogic.handleGenerate()}
                onPassphraseChange={lockLogic.handlePassphraseChange}
                passphrase={lockLogic.store.passphrase}
              />
            ) : null}
            {lockLogic.store.step === 'locked' ? (
              <LockedStep
                safetyCodeAvailable={lockLogic.store.safetyCode}
                safetyCodeStatus="verified-local-key"
              />
            ) : null}
          </>
        ) : null}

        {!publicState.isPublicStatusLoading &&
        !publicState.isUnavailable &&
        publicState.channelState === CHANNEL_STATE.LOCKED ? (
          <LockedStep
            safetyCodeAvailable={receiverSafetyCode.display}
            safetyCodeStatus={receiverSafetyCode.status}
          />
        ) : null}

        {!publicState.isUnavailable && isDeliveredState ? (
          <DeliveredStep
            canBurn={decryptLogic.canBurn}
            canDecrypt={decryptLogic.canDecrypt}
            canDecryptLocally={receiverSafetyCode.canDecryptLocally}
            cipherVersion={decryptLogic.cipherVersion}
            decryptError={decryptLogic.decryptError}
            decryptHelperText={decryptLogic.decryptHelperText}
            decryptPending={decryptLogic.decryptPending}
            deliveredAt={decryptLogic.deliveredAt}
            file={decryptLogic.store.file}
            isDecryptPassphraseInvalid={decryptLogic.isDecryptPassphraseInvalid}
            localPlaintextBurned={decryptLogic.store.localPlaintextBurned}
            onBurn={decryptLogic.handleBurn}
            onDecrypt={() => void decryptLogic.handleDecrypt()}
            onDownloadFile={decryptLogic.handleDownloadFile}
            onPassphraseChange={decryptLogic.handlePassphraseChange}
            passphrase={decryptLogic.passphrase}
            plaintext={decryptLogic.store.plaintext}
            safetyCodeAvailable={receiverSafetyCode.display}
            safetyCodeStatus={receiverSafetyCode.status}
          />
        ) : null}
      </PageCardContent>
    </PageCard>
  );
}
