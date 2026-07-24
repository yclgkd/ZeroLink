import { describe, expect, it } from 'vitest';
import { MAX_JSON_BODY_BYTES } from '../request-body.ts';
import {
  type ApiErrorResponse,
  computeCallerKey,
  createMockEnv,
  dispatch,
  getSetCookieHeaders,
  INTERNAL_CALLER_KEY_HEADER,
  INTERNAL_COMMIT_COOKIE_ACTION_HEADER,
  INTERNAL_COMMIT_COOKIE_EXP_HEADER,
  INTERNAL_COMMIT_COOKIE_KIND_HEADER,
  INTERNAL_COMMIT_COOKIE_TOKEN_HEADER,
  INTERNAL_COMMIT_TOKEN_HEADER,
  VALID_ATTESTATION,
  VALID_LOCK_COMMIT_BODY,
  VALID_UUID,
} from './helpers/worker-fixtures.ts';

describe('backend worker routing — lock begin/commit forwarding + cookie signals', () => {
  it('forwards lock_begin request to SecretVault DO and returns challenge response', async () => {
    const challengeResponse = {
      ok: true,
      lockChallenge: {
        id: 'challenge-id',
        challenge: 'challenge-token',
        expiresAt: 1_730_000_123_000,
      },
    };
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify(challengeResponse), { status: 200 });
    });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'POST', {
      uuid: VALID_UUID,
    });
    const payload = (await response.json()) as {
      ok: true;
      lockChallenge: { id: string; challenge: string; expiresAt: number };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(payload).toEqual(challengeResponse);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/lock_begin');
    expect(calls[0]?.method).toBe('POST');
  });

  it('forwards an HMAC caller key on protected begin routes', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          lockChallenge: {
            id: 'challenge-id',
            challenge: 'challenge-token',
            expiresAt: 1_730_000_123_000,
          },
        }),
        { status: 200 }
      );
    });

    const response = await dispatch(
      env,
      `/api/lock_begin/${VALID_UUID}`,
      'POST',
      { uuid: VALID_UUID },
      false,
      {
        'CF-Connecting-IP': '198.51.100.42',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
      }
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const { cookie } = calls[0]?.headers ?? {};
    expect(cookie).toBeUndefined();
    expect(calls[0]?.headers[INTERNAL_CALLER_KEY_HEADER.toLowerCase()]).toBe(
      await computeCallerKey(
        env.COMMIT_TOKEN_SECRET,
        '198.51.100.42',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36'
      )
    );
  });

  it('preserves Retry-After when SecretVault returns a forwarded 429', async () => {
    const { env } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'RATE_LIMITED' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': '17',
        },
      });
    });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'POST', {
      uuid: VALID_UUID,
    });

    await expect(response.json()).resolves.toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
  });

  it('forwards create_begin request to SecretVault DO', async () => {
    const creationOptions = { publicKey: { challenge: 'abc' } };
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: true, creationOptions }), {
        status: 200,
      });
    });

    const response = await dispatch(env, `/api/create_begin/${VALID_UUID}`, 'POST', {
      uuid: VALID_UUID,
      timestamp: 1_730_000_000_000,
      securityProfile: 'quick',
    });
    const payload = (await response.json()) as {
      ok: true;
      creationOptions: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(payload.creationOptions).toEqual(creationOptions);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/create_begin');
  });

  it('rate limits create_begin requests per caller across uuids', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: true, creationOptions: { publicKey: {} } }), {
        status: 200,
      });
    });

    const sharedHeaders = {
      'CF-Connecting-IP': '198.51.100.42',
      'User-Agent': 'curl/8.7.1',
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const uuid = `aaaaaaaaaaaaaaaaaaaa${String.fromCharCode(97 + attempt)}`;
      const response = await dispatch(
        env,
        `/api/create_begin/${uuid}`,
        'POST',
        {
          uuid,
          timestamp: 1_730_000_000_000,
          securityProfile: 'quick',
        },
        false,
        sharedHeaders
      );
      expect(response.status).toBe(200);
    }

    const limitedResponse = await dispatch(
      env,
      '/api/create_begin/bbbbbbbbbbbbbbbbbbbbb',
      'POST',
      {
        uuid: 'bbbbbbbbbbbbbbbbbbbbb',
        timestamp: 1_730_000_000_000,
        securityProfile: 'quick',
      },
      false,
      sharedHeaders
    );
    const limitedPayload = (await limitedResponse.json()) as ApiErrorResponse;

    expect(limitedResponse.status).toBe(429);
    expect(limitedPayload.code).toBe('RATE_LIMITED');
    expect(limitedResponse.headers.get('Retry-After')).toBeTruthy();
    expect(calls).toHaveLength(10);

    const otherCallerResponse = await dispatch(
      env,
      '/api/create_begin/ccccccccccccccccccccc',
      'POST',
      {
        uuid: 'ccccccccccccccccccccc',
        timestamp: 1_730_000_000_000,
        securityProfile: 'quick',
      },
      false,
      {
        'CF-Connecting-IP': '198.51.100.43',
        'User-Agent': 'curl/8.7.1',
      }
    );

    expect(otherCallerResponse.status).toBe(200);
    expect(calls).toHaveLength(11);
  });

  it('forwards create_finish request to SecretVault DO', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: true, shareUrl: '/s/abc', manageUrl: '/m/abc' }), {
        status: 200,
      });
    });

    const response = await dispatch(env, `/api/create_finish/${VALID_UUID}`, 'POST', {
      uuid: VALID_UUID,
      adminMode: 'webauthn',
      attestation: VALID_ATTESTATION,
      lockKeyB64u: 'lock-key',
      timestamp: 1_730_000_000_000,
    });
    const payload = (await response.json()) as { ok: true };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/create_finish');
  });

  it('forwards lock_commit request to SecretVault DO and returns ok response', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await dispatch(
      env,
      `/api/lock_commit/${VALID_UUID}`,
      'POST',
      VALID_LOCK_COMMIT_BODY
    );
    const payload = (await response.json()) as { ok: true };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pathname).toBe('/lock_commit');
    expect(calls[0]?.method).toBe('POST');
  });

  it('forwards only the target commit token cookie on protected commit routes', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const response = await dispatch(
      env,
      `/api/lock_commit/${VALID_UUID}`,
      'POST',
      VALID_LOCK_COMMIT_BODY,
      false,
      {
        'CF-Connecting-IP': '198.51.100.43',
        'User-Agent': 'curl/8.7.1',
        Cookie: 'session_id=abc; zl-lock-commit=lock-token-123; ignored=value',
      }
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const { cookie } = calls[0]?.headers ?? {};
    expect(cookie).toBeUndefined();
    expect(calls[0]?.headers[INTERNAL_COMMIT_TOKEN_HEADER.toLowerCase()]).toBe('lock-token-123');
    expect(calls[0]?.headers[INTERNAL_CALLER_KEY_HEADER.toLowerCase()]).toBeDefined();
  });

  it('translates internal lock cookie signals into external Set-Cookie headers', async () => {
    const { env } = createMockEnv(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          lockChallenge: {
            id: 'challenge-id',
            challenge: 'challenge-token',
            expiresAt: 1_730_000_123_000,
          },
        }),
        {
          status: 200,
          headers: {
            [INTERNAL_COMMIT_COOKIE_ACTION_HEADER]: 'set',
            [INTERNAL_COMMIT_COOKIE_KIND_HEADER]: 'lock',
            [INTERNAL_COMMIT_COOKIE_TOKEN_HEADER]: 'lock-token-abc',
            [INTERNAL_COMMIT_COOKIE_EXP_HEADER]: '1730000123000',
          },
        }
      );
    });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'POST', {
      uuid: VALID_UUID,
    });

    expect(response.status).toBe(200);
    const cookies = getSetCookieHeaders(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('zl-lock-commit=lock-token-abc');
    expect(cookies[0]).toContain(`Path=/api/lock_commit/${VALID_UUID}`);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Strict');
  });

  it('returns 400 for invalid lock_begin payload and does not call DO', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), {
        status: 500,
      });
    });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'POST', {
      uuid: 'invalid-uuid',
    });
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('returns 400 when path UUID and body UUID do not match', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), {
        status: 500,
      });
    });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'POST', {
      uuid: 'zzzzzzzzzzzzzzzzzzzzz',
    });
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('returns 400 when path UUID and body UUID do not match on lock_commit', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), {
        status: 500,
      });
    });

    const response = await dispatch(env, `/api/lock_commit/${VALID_UUID}`, 'POST', {
      ...VALID_LOCK_COMMIT_BODY,
      uuid: 'zzzzzzzzzzzzzzzzzzzzz',
    });
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('returns 400 for malformed JSON body on lock_commit', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), {
        status: 500,
      });
    });

    const response = await dispatch(
      env,
      `/api/lock_commit/${VALID_UUID}`,
      'POST',
      '{"uuid":',
      true
    );
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expect(payload.code).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('rejects oversized JSON bodies before forwarding lock_begin', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const body = JSON.stringify({ uuid: VALID_UUID, padding: 'x'.repeat(MAX_JSON_BODY_BYTES + 1) });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'POST', body, true);
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(413);
    expect(payload.code).toBe('PAYLOAD_TOO_LARGE');
    expect(calls).toHaveLength(0);
  });

  it('returns 405 for method mismatch on lock challenge routes', async () => {
    const { env, calls } = createMockEnv(async () => {
      return new Response(JSON.stringify({ ok: false, code: 'UNEXPECTED' }), {
        status: 500,
      });
    });

    const response = await dispatch(env, `/api/lock_begin/${VALID_UUID}`, 'GET');
    const payload = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(payload.code).toBe('METHOD_NOT_ALLOWED');
    expect(calls).toHaveLength(0);
  });

  it('propagates lock challenge error statuses from DO', async () => {
    const scenarios = [
      { status: 401, code: 'CHALLENGE_INVALID' },
      { status: 403, code: 'LOCK_FORBIDDEN' },
      { status: 409, code: 'CHALLENGE_CONSUMED' },
      { status: 404, code: 'NOT_FOUND' },
    ] as const;

    for (const scenario of scenarios) {
      const { env } = createMockEnv(async () => {
        return new Response(JSON.stringify({ ok: false, code: scenario.code }), {
          status: scenario.status,
        });
      });

      const response = await dispatch(
        env,
        `/api/lock_commit/${VALID_UUID}`,
        'POST',
        VALID_LOCK_COMMIT_BODY
      );
      const payload = (await response.json()) as ApiErrorResponse;

      expect(response.status).toBe(scenario.status);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(payload).toEqual({ ok: false, code: scenario.code });
    }
  });
});
