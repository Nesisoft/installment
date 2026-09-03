import { describe, expect, it, vi } from 'vitest';
import { ExpoPushClient } from './expo';
import { PushError } from './types';

const TOKEN = 'ExponentPushToken[abc123def456]';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(body: unknown, init: { status?: number; throws?: unknown } = {}) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, opts?: RequestInit) => {
    calls.push({
      url: input.toString(),
      method: opts?.method ?? 'GET',
      headers: opts?.headers as Record<string, string>,
      body: opts?.body ? JSON.parse(opts.body as string) : undefined,
    });
    if (init.throws) throw init.throws;
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const client = (fetchImpl: typeof fetch, accessToken?: string) =>
  new ExpoPushClient({ fetchImpl, accessToken });

const message = { to: TOKEN, title: 'New order', body: 'Ama ordered a wrap dress' };

describe('ExpoPushClient', () => {
  it('posts one message as an array, which is the shape Expo takes', async () => {
    const { fetchImpl, calls } = makeFetch({ data: [{ status: 'ok', id: 'ticket-1' }] });

    const result = await client(fetchImpl).send({ ...message, data: { orderId: 'o-1' } });

    expect(result).toMatchObject({ status: 'sent', id: 'ticket-1' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(calls[0]?.body).toEqual([
      {
        to: TOKEN,
        title: 'New order',
        body: 'Ama ordered a wrap dress',
        data: { orderId: 'o-1' },
        sound: 'default',
        priority: 'high',
      },
    ]);
  });

  it('sends unauthenticated by default, and bearers the token when given one', async () => {
    const bare = makeFetch({ data: [{ status: 'ok' }] });
    await client(bare.fetchImpl).send(message);
    expect(bare.calls[0]?.headers.Authorization).toBeUndefined();

    const authed = makeFetch({ data: [{ status: 'ok' }] });
    await client(authed.fetchImpl, 'expo-secret').send(message);
    expect(authed.calls[0]?.headers.Authorization).toBe('Bearer expo-secret');
  });

  it('refuses a malformed token without a network call', async () => {
    // A certain rejection, so spending a round trip to be told so only delays
    // the same answer.
    const { fetchImpl } = makeFetch({ data: [{ status: 'ok' }] });

    const result = await client(fetchImpl).send({ ...message, to: 'not-a-token' });

    expect(result).toMatchObject({ status: 'failed', error: 'InvalidPushToken' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces DeviceNotRegistered as a per-message failure, not a throw', async () => {
    // The one error that means something to the database: the handset has
    // uninstalled the app, and the caller should deactivate rather than retry.
    const { fetchImpl } = makeFetch({
      data: [
        {
          status: 'error',
          message: '"ExponentPushToken[…]" is not a registered push notification recipient',
          details: { error: 'DeviceNotRegistered' },
        },
      ],
    });

    const result = await client(fetchImpl).send(message);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('DeviceNotRegistered');
  });

  it('prefers the machine-readable error over the prose one', async () => {
    const { fetchImpl } = makeFetch({
      data: [{ status: 'error', message: 'Message too big', details: { error: 'MessageTooBig' } }],
    });

    expect((await client(fetchImpl).send(message)).error).toBe('MessageTooBig');
  });

  it('falls back to the prose message when Expo sends no error code', async () => {
    const { fetchImpl } = makeFetch({
      data: [{ status: 'error', message: 'Something went wrong' }],
    });

    expect((await client(fetchImpl).send(message)).error).toBe('Something went wrong');
  });

  it('throws on a non-2xx, because that is about the request and can be retried', async () => {
    // A rate limit or a bad access token is not the recipient's fault, and the
    // caller must be able to tell it apart from DeviceNotRegistered.
    const { fetchImpl } = makeFetch(
      { errors: [{ message: 'Too many requests' }] },
      { status: 429 },
    );

    await expect(client(fetchImpl).send(message)).rejects.toBeInstanceOf(PushError);
    await expect(client(fetchImpl).send(message)).rejects.toThrow(/Too many requests/);
  });

  it('throws on a transport failure rather than reporting a refusal', async () => {
    const { fetchImpl } = makeFetch({}, { throws: new Error('ECONNRESET') });

    await expect(client(fetchImpl).send(message)).rejects.toThrow(/Network error calling Expo/);
  });

  it('treats an unparseable 200 as a failure rather than a success', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>maintenance</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    expect((await client(fetchImpl).send(message)).status).toBe('failed');
  });

  it('accepts both Expo token spellings', async () => {
    for (const to of ['ExponentPushToken[x]', 'ExpoPushToken[x]']) {
      const { fetchImpl } = makeFetch({ data: [{ status: 'ok' }] });
      expect((await client(fetchImpl).send({ ...message, to })).status).toBe('sent');
    }
  });
});
