import {
  type AttestationJSON,
  type Base64Url,
  CHALLENGE_BYTES,
  CHANNEL_STATE,
  CHANNEL_TTL_MS,
  type ChannelRecord,
  type CompoundChallenge,
  CreateBeginRequestSchema,
  CreateFinishRequestSchema,
  type ECDSAPublicKeyJWK,
  type HexString,
  type LockChallenge,
  type RSAPublicKeyJWK,
  type SoftkeyCredential,
  type StoredCredential,
  type UUID,
} from '@zerolink/shared';
import { type AttestationVerificationResult, verifyAttestation } from '../crypto/attestation.ts';
import { asUnixMs, decodeBase64Url, encodeBase64Url, getCryptoApi } from '../crypto/bytes.ts';
import { generateCreationOptions } from '../crypto/webauthn.ts';
import { beginCompoundChallengeInternal, commitCompoundInternal } from './SecretVaultCompound.ts';
import {
  handleCompoundBegin,
  handleCompoundCommit,
  handleGetDecryptPayload,
  handleGetFilePayload,
  handleGetPublicState,
  handleLockBegin,
  handleLockCommit,
} from './SecretVaultHandlers.ts';
import {
  assertUuidMatch,
  jsonError,
  jsonResponse,
  mapError,
  methodNotAllowed,
  notFound,
  readJsonBody,
} from './SecretVaultHttp.ts';
import { beginLockChallengeInternal, commitLockChallengeInternal } from './SecretVaultLock.ts';
import { SecretVaultStateMachine } from './SecretVaultStateMachine.ts';
import {
  finalizeTerminalRecord,
  finalizeTerminalState,
  loadActiveRecord,
  saveRecord,
  scheduleNextAlarm,
  shouldPurgeRecord,
  tryLoadActiveRecord,
} from './SecretVaultStorage.ts';
import {
  acceptWebSocket,
  handleWebSocketClose,
  handleWebSocketError,
  handleWebSocketMessage,
} from './SecretVaultWebSocket.ts';

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility (tests import from this module)
// ---------------------------------------------------------------------------

export { SecretVaultStateMachine } from './SecretVaultStateMachine.ts';
export type {
  CommitDeliveryParams,
  CommitLockChallengeParams,
  CommitLockParams,
  CompoundCommitParams,
  SecretVaultEnv,
  SoftkeyCompoundCommitParams,
  StoredCompoundChallenge,
  StoredLockChallenge,
  StoredTerminalTombstone,
  WebAuthnCompoundCommitParams,
} from './SecretVaultTypes.ts';
export {
  CHANNEL_RECORD_KEY,
  COMPOUND_CHALLENGE_KEY,
  CREATION_CHALLENGE_KEY,
  LOCK_CHALLENGE_KEY,
  NONCE_INDEX_KEY_PREFIX,
  NONCE_KEY_PREFIX,
  nonceIndexStorageKey,
  nonceStorageKey,
  RateLimitError,
  StateTransitionError,
  TERMINAL_TOMBSTONE_KEY,
} from './SecretVaultTypes.ts';

import {
  CHANNEL_RECORD_KEY,
  type CommitDeliveryParams,
  type CommitLockChallengeParams,
  type CommitLockParams,
  type CompoundCommitParams,
  CREATION_CHALLENGE_KEY,
  type RateLimitWindow,
  type SecretVaultEnv,
  StateTransitionError,
  type StoredTerminalTombstone,
  TERMINAL_TOMBSTONE_KEY,
  type VaultContext,
} from './SecretVaultTypes.ts';

interface BeginRequestContext {
  callerKey: Base64Url | undefined;
}

interface CommitRequestContext extends BeginRequestContext {
  commitToken: string | undefined;
}

export class SecretVault implements VaultContext {
  readonly ctx: DurableObjectState;
  readonly env: SecretVaultEnv;
  readonly rateLimitWindows = new Map<string, RateLimitWindow>();

  constructor(ctx: DurableObjectState, env: SecretVaultEnv) {
    this.ctx = ctx;
    this.env = env;

    // L-3: Validate RP_ID and RP_ORIGIN at construction time
    if (!env.RP_ID || typeof env.RP_ID !== 'string') {
      throw new Error('RP_ID environment variable is missing or empty');
    }
    if (!env.RP_ORIGIN || typeof env.RP_ORIGIN !== 'string' || !env.RP_ORIGIN.startsWith('http')) {
      throw new Error(
        'RP_ORIGIN environment variable is missing or malformed (must start with http)'
      );
    }
    if (!env.COMMIT_TOKEN_SECRET || typeof env.COMMIT_TOKEN_SECRET !== 'string') {
      throw new Error('COMMIT_TOKEN_SECRET environment variable is missing or empty');
    }
  }

  // ─── Hibernation API WebSocket handlers ───────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const record = await tryLoadActiveRecord(this);
    handleWebSocketMessage(ws, message, record);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    handleWebSocketClose(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    handleWebSocketError(ws);
  }

  async fetch(request: Request): Promise<Response> {
    let handler = 'fetch';

    try {
      const url = new URL(request.url);

      // Handle WebSocket upgrade before method check
      if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
        handler = 'ws_subscribe';
        const record = await tryLoadActiveRecord(this);
        if (!record) {
          return notFound();
        }
        return acceptWebSocket(this.ctx);
      }

      if (request.method !== 'POST') {
        handler = 'method_not_allowed';
        return methodNotAllowed();
      }

      if (url.pathname === '/create_begin') {
        handler = 'create_begin';
        return await this.handleCreateBegin(request);
      }

      if (url.pathname === '/create_finish') {
        handler = 'create_finish';
        return await this.handleCreateFinish(request);
      }

      if (url.pathname === '/lock_begin') {
        handler = 'lock_begin';
        return await handleLockBegin(this, request);
      }

      if (url.pathname === '/lock_commit') {
        handler = 'lock_commit';
        return await handleLockCommit(this, request);
      }

      if (url.pathname === '/compound_begin') {
        handler = 'compound_begin';
        return await handleCompoundBegin(this, request);
      }

      if (url.pathname === '/compound_commit') {
        handler = 'compound_commit';
        return await handleCompoundCommit(this, request);
      }

      if (url.pathname === '/get_public_state') {
        handler = 'get_public_state';
        return await handleGetPublicState(this);
      }

      if (url.pathname === '/get_decrypt_payload') {
        handler = 'get_decrypt_payload';
        return await handleGetDecryptPayload(this);
      }

      if (url.pathname === '/get_file_payload') {
        handler = 'get_file_payload';
        return await handleGetFilePayload(this);
      }

      handler = 'not_found';
      return notFound();
    } catch (error) {
      return mapError(error, { appEnv: this.env.APP_ENV, handler });
    }
  }

  async alarm(now: number = Date.now()): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await scheduleNextAlarm(this, now);
    });
  }

  async initialize(record: ChannelRecord): Promise<ChannelRecord> {
    await saveRecord(this, record);
    await scheduleNextAlarm(this, Number(record.createdAt));
    return record;
  }

  async getRecord(): Promise<ChannelRecord> {
    return loadActiveRecord(this);
  }

  async commitLock(params: CommitLockParams): Promise<ChannelRecord> {
    return this.applyTransition((machine) => machine.commitLock(params));
  }

  async commitDelivery(params: CommitDeliveryParams): Promise<ChannelRecord> {
    return this.applyTransition((machine) => machine.commitDelivery(params));
  }

  async commitDelete(): Promise<ChannelRecord> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await loadActiveRecord(this);
      const next = new SecretVaultStateMachine(current).commitDelete();
      await finalizeTerminalState(this, current.uuid, 'deleted', undefined, current.fileRef);
      return next;
    });
  }

  async expire(): Promise<ChannelRecord> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await loadActiveRecord(this);
      const next = new SecretVaultStateMachine(current).expire();
      await finalizeTerminalState(this, current.uuid, 'expired', undefined, current.fileRef);
      return next;
    });
  }

  async beginCreate(
    uuid: string,
    securityProfile: ChannelRecord['securityProfile'],
    now: number = Date.now(),
    ttl: ChannelRecord['ttl'] = CHANNEL_TTL_MS.ONE_HOUR
  ): Promise<Record<string, unknown>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const tombstone = await this.ctx.storage.get<StoredTerminalTombstone>(TERMINAL_TOMBSTONE_KEY);
      if (tombstone) {
        throw new StateTransitionError('INVALID_TRANSITION', 'channel already exists');
      }

      const existing = await this.ctx.storage.get<ChannelRecord>(CHANNEL_RECORD_KEY);
      if (existing) {
        if (shouldPurgeRecord(existing, now)) {
          await finalizeTerminalRecord(this, existing, now);
        }
        throw new StateTransitionError('INVALID_TRANSITION', 'channel already exists');
      }

      const cryptoApi = getCryptoApi();
      const challenge = cryptoApi.getRandomValues(new Uint8Array(CHALLENGE_BYTES));

      const expiresAt = asUnixMs(now + ttl);
      const record: ChannelRecord = {
        uuid: uuid as UUID,
        state: CHANNEL_STATE.WAITING,
        createdAt: asUnixMs(now),
        expiresAt,
        ttl,
        securityProfile,
        adminMode: 'webauthn',
        adminCredential: {
          credentialId: '' as Base64Url,
          publicKey: '' as Base64Url,
          signCount: 0,
          aaguid: '' as Base64Url,
        },
        lockKey: '' as Base64Url,
        version: 0,
      };

      await saveRecord(this, record);
      await this.ctx.storage.put(CREATION_CHALLENGE_KEY, encodeBase64Url(challenge));
      await scheduleNextAlarm(this, now);

      return generateCreationOptions({
        rpId: this.env.RP_ID,
        rpName: 'ZeroLink',
        uuid,
        challenge,
        securityProfile,
      });
    });
  }

  async commitCreate(params: {
    uuid: string;
    adminMode: 'webauthn' | 'password' | 'softkey';
    attestation?: AttestationJSON;
    softkeyPubJwk?: ECDSAPublicKeyJWK;
    lockKeyB64u: Base64Url;
  }): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const record = await loadActiveRecord(this);
      assertUuidMatch(record.uuid, params.uuid);
      if (record.lockKey !== '') {
        throw new StateTransitionError('INVALID_TRANSITION', 'channel already finalized');
      }

      // H-1: Enforce securityProfile → adminMode binding (prevent downgrade attack)
      const requiresWebAuthn = record.securityProfile === 'secure';
      if (requiresWebAuthn && params.adminMode !== 'webauthn') {
        throw new StateTransitionError(
          'LOCK_FORBIDDEN',
          `security profile '${record.securityProfile}' requires webauthn admin mode`
        );
      }

      let adminCredential: StoredCredential | SoftkeyCredential;

      if (params.adminMode === 'password' || params.adminMode === 'softkey') {
        if (!params.softkeyPubJwk) {
          throw new StateTransitionError(
            'LOCK_FORBIDDEN',
            'softkeyPubJwk required for password mode'
          );
        }
        adminCredential = {
          type: 'softkey',
          softkeyPubJwk: params.softkeyPubJwk,
        };
      } else {
        if (!params.attestation) {
          throw new StateTransitionError(
            'LOCK_FORBIDDEN',
            'attestation required for webauthn mode'
          );
        }

        const storedChallenge = await this.ctx.storage.get<Base64Url>(CREATION_CHALLENGE_KEY);
        if (!storedChallenge) {
          throw new StateTransitionError('CHALLENGE_INVALID', 'creation challenge not found');
        }
        await this.ctx.storage.delete(CREATION_CHALLENGE_KEY);

        const requireUV = record.securityProfile === 'secure';

        let verification: AttestationVerificationResult;
        try {
          verification = await verifyAttestation({
            attestationObjectB64u: params.attestation.response.attestationObject,
            clientDataJSONB64u: params.attestation.response.clientDataJSON,
            expectedRpId: this.env.RP_ID,
            expectedOrigin: this.env.RP_ORIGIN,
            expectedChallenge: decodeBase64Url(storedChallenge),
            requireUserVerification: requireUV,
          });
        } catch (err) {
          throw new StateTransitionError(
            'ATTESTATION_UNVERIFIABLE',
            err instanceof Error ? err.message : 'Attestation verification failed'
          );
        }

        if (!verification.verified && verification.fmt !== 'none') {
          throw new StateTransitionError(
            'ATTESTATION_UNVERIFIABLE',
            `security profile '${record.securityProfile}' requires verified attestation for fmt:'${verification.fmt}'`
          );
        }

        adminCredential = {
          credentialId: verification.credentialId,
          publicKey: verification.publicKey,
          signCount: verification.signCount,
          aaguid: verification.aaguid,
          ...(verification.transports ? { transports: verification.transports } : {}),
        };
      }

      // biome-ignore lint/suspicious/noExplicitAny: transports mismatch between DOM and shared types
      const updatedRecord: any = {
        ...record,
        adminMode: params.adminMode,
        adminCredential,
        lockKey: params.lockKeyB64u,
      };

      await saveRecord(this, updatedRecord as ChannelRecord);
      await scheduleNextAlarm(this);
    });
  }

  async beginCompoundChallenge(
    uuid: string,
    now: number = Date.now(),
    context: BeginRequestContext = { callerKey: undefined }
  ): Promise<{
    challenge: CompoundChallenge;
    allowCredentials?: Array<{
      id: Base64Url;
      type: 'public-key';
    }>;
    receiverPubFpr?: HexString;
    receiverPubJwk?: RSAPublicKeyJWK;
    currentVersion: number;
    securityProfile: ChannelRecord['securityProfile'];
    adminMode: ChannelRecord['adminMode'];
  }> {
    const { response } = await beginCompoundChallengeInternal(this, uuid, now, context);
    return response;
  }

  async commitCompound(
    params: CompoundCommitParams,
    now: number = Date.now(),
    context: CommitRequestContext = { callerKey: undefined, commitToken: undefined }
  ): Promise<void> {
    await commitCompoundInternal(this, params, now, context);
  }

  async beginLockChallenge(
    uuid: string,
    now: number = Date.now(),
    context: BeginRequestContext = { callerKey: undefined }
  ): Promise<LockChallenge> {
    const { lockChallenge } = await beginLockChallengeInternal(this, uuid, now, context);
    return lockChallenge;
  }

  async commitLockChallenge(
    {
      uuid,
      lockChallengeId,
      lockProof,
      receiverPubJwk,
      receiverPubFpr,
      lockedAt,
    }: CommitLockChallengeParams,
    now: number = Date.now(),
    context: CommitRequestContext = { callerKey: undefined, commitToken: undefined }
  ): Promise<void> {
    await commitLockChallengeInternal(
      this,
      {
        uuid,
        lockChallengeId,
        lockProof,
        receiverPubJwk,
        receiverPubFpr,
        lockedAt,
      },
      now,
      context
    );
  }

  private async applyTransition(
    transition: (machine: SecretVaultStateMachine) => ChannelRecord
  ): Promise<ChannelRecord> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await loadActiveRecord(this);
      const next = transition(new SecretVaultStateMachine(current));
      await saveRecord(this, next);
      await scheduleNextAlarm(this);
      return next;
    });
  }

  private async handleCreateBegin(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) {
      return jsonError('BAD_REQUEST', 400);
    }

    const parsed = CreateBeginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('BAD_REQUEST', 400);
    }

    try {
      const creationOptions = await this.beginCreate(
        parsed.data.uuid,
        parsed.data.securityProfile,
        Date.now(),
        parsed.data.ttl
      );
      return jsonResponse({ ok: true, creationOptions }, 200);
    } catch (error) {
      return mapError(error, { appEnv: this.env.APP_ENV, handler: 'create_begin' });
    }
  }

  private async handleCreateFinish(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) {
      return jsonError('BAD_REQUEST', 400);
    }

    const parsed = CreateFinishRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('BAD_REQUEST', 400);
    }

    try {
      const isPasswordMode =
        parsed.data.adminMode === 'password' || parsed.data.adminMode === 'softkey';
      // biome-ignore lint/suspicious/noExplicitAny: complex union schema mismatch
      const commitParams: any = {
        uuid: parsed.data.uuid,
        adminMode: parsed.data.adminMode,
        attestation: parsed.data.adminMode === 'webauthn' ? parsed.data.attestation : undefined,
        softkeyPubJwk: isPasswordMode
          ? // biome-ignore lint/suspicious/noExplicitAny: Discriminated union narrowing in ternary
            (parsed.data as any).softkeyPubJwk
          : undefined,
        lockKeyB64u: parsed.data.lockKeyB64u,
      };
      await this.commitCreate(commitParams);

      return jsonResponse(
        {
          ok: true,
          shareUrl: `${this.env.RP_ORIGIN}/s/${parsed.data.uuid}`,
          manageUrl: `${this.env.RP_ORIGIN}/m/${parsed.data.uuid}`,
        },
        200
      );
    } catch (error) {
      return mapError(error, { appEnv: this.env.APP_ENV, handler: 'create_finish' });
    }
  }
}
