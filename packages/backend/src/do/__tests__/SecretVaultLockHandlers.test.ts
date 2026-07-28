import { CHANNEL_STATE } from '@zerolink/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { MAX_JSON_BODY_BYTES } from '../../request-body.ts';
import { CHANNEL_RECORD_KEY, SecretVault, type SecretVaultEnv } from '../SecretVault.ts';
import {
  asUnixMs,
  createChannelRecord,
  createMockState,
  env,
  readTerminalTombstone,
  setupRealReceiverKey,
} from './helpers/vault-fixtures.ts';

vi.mock('../../crypto/softkey.ts', () => ({
  verifySoftkeySignature: vi.fn(),
}));

vi.mock('../../crypto/attestation.ts', () => ({
  verifyAttestation: vi.fn(),
}));

beforeAll(async () => {
  await setupRealReceiverKey();
});

describe('SecretVault lock challenge flow', () => {
  it('returns 405 for non-POST method in fetch', async () => {
    const { state } = createMockState();
    const vault = new SecretVault(state, env);

    const response = await vault.fetch(
      new Request('https://zerolink.test/lock_begin', { method: 'GET' })
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(405);
    expect(payload).toEqual({
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
    });
  });

  it('returns 404 for unknown fetch path', async () => {
    const { state } = createMockState();
    const vault = new SecretVault(state, env);

    const response = await vault.fetch(
      new Request('https://zerolink.test/unknown_path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(404);
    expect(payload).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('rejects websocket upgrade when channel record is missing', async () => {
    const { state, getAcceptedWebSocketCount } = createMockState();
    const vault = new SecretVault(state, env);

    const response = await vault.fetch(
      new Request('https://zerolink.test/ws', {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      })
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(404);
    expect(payload).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(getAcceptedWebSocketCount()).toBe(0);
  });

  it('rejects websocket upgrade when channel record is already expired', async () => {
    const now = 1_730_001_455_000;
    const expiredRecord = {
      ...createChannelRecord(CHANNEL_STATE.LOCKED),
      expiresAt: asUnixMs(now - 1),
    };
    const { state, getAcceptedWebSocketCount, snapshot } = createMockState(expiredRecord);
    const vault = new SecretVault(state, env);

    const response = await vault.fetch(
      new Request('https://zerolink.test/ws', {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      })
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(404);
    expect(payload).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(getAcceptedWebSocketCount()).toBe(0);
    expect(snapshot.get(CHANNEL_RECORD_KEY)).toBeUndefined();
    expect(readTerminalTombstone(snapshot)?.reason).toBe('expired');
  });

  it('redacts unexpected websocket upgrade errors through the top-level fetch guard', async () => {
    const { state, getAcceptedWebSocketCount } = createMockState();
    const storage = state.storage as unknown as {
      get: (key: string | string[]) => Promise<unknown>;
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storageGet = vi.spyOn(storage, 'get');
    const error = new Error('sensitive websocket failure');
    error.stack = [
      'Error: sensitive websocket failure',
      '    at https://prod.example.com/assets/index-123abc456.js:10:20',
      '    at websocketSubscribe (https://prod.example.com/assets/chunk-123abc456.js:30:40)',
    ].join('\n');
    storageGet.mockRejectedValue(error);

    try {
      const productionEnv: SecretVaultEnv = { ...env, APP_ENV: 'production' };
      const vault = new SecretVault(state, productionEnv);

      const response = await vault.fetch(
        new Request('https://zerolink.test/ws', {
          method: 'GET',
          headers: { Upgrade: 'websocket' },
        })
      );
      const payload = (await response.json()) as { ok: false; code: string };
      const logEntry = consoleError.mock.calls[0]?.[0] as Record<string, unknown>;

      expect(response.status).toBe(500);
      expect(payload).toEqual({ ok: false, code: 'INTERNAL_ERROR' });
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(logEntry).toMatchObject({
        event: 'secret_vault.unexpected_error',
        app_env: 'production',
        handler: 'ws_subscribe',
        error_name: 'Error',
        stack_fingerprint: expect.any(String),
      });
      expect(logEntry).not.toHaveProperty('error_message');
      expect(logEntry).not.toHaveProperty('error_stack');
      expect(getAcceptedWebSocketCount()).toBe(0);
    } finally {
      storageGet.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('returns 400 for invalid lock_begin payload', async () => {
    const { state } = createMockState();
    const vault = new SecretVault(state, env);

    const response = await vault.fetch(
      new Request('https://zerolink.test/lock_begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: 'invalid' }),
      })
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      ok: false,
      code: 'BAD_REQUEST',
    });
  });

  it('returns 413 for oversized lock_begin payloads', async () => {
    const { state } = createMockState();
    const vault = new SecretVault(state, env);
    const body = JSON.stringify({
      uuid: 'abcdefghijklmnopqrstu',
      padding: 'x'.repeat(MAX_JSON_BODY_BYTES + 1),
    });

    const response = await vault.fetch(
      new Request('https://zerolink.test/lock_begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );
    const payload = (await response.json()) as { ok: false; code: string };

    expect(response.status).toBe(413);
    expect(payload).toEqual({
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});
