import { describe, expect, it, vi } from 'vitest';
import { ArkeselSmsClient } from './arkesel';
import { SmsError } from './types';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(body: unknown, status = 200) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, opts?: RequestInit) => {
    calls.push({
      url: input.toString(),
      method: opts?.method ?? 'GET',
      headers: opts?.headers as Record<string, string>,
      body: opts?.body ? JSON.parse(opts.body as string) : undefined,
    });
    return jsonResponse(body, status);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const message = { to: '+233244123456', sender: 'INSTL', message: 'Hello' };

describe('ArkeselSmsClient', () => {
  it('throws when apiKey is missing', () => {
    expect(() => new ArkeselSmsClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('POSTs /api/v2/sms/send with the api-key header and recipients array', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: 'success',
      code: 'ok',
      data: [{ id: 'ark-1', recipient: '+233244123456' }],
    });
    const client = new ArkeselSmsClient({ apiKey: 'k1', fetchImpl });

    const result = await client.send(message);

    expect(result).toEqual({
      id: 'ark-1',
      status: 'queued',
      rawResponse: {
        status: 'success',
        code: 'ok',
        data: [{ id: 'ark-1', recipient: '+233244123456' }],
      },
    });
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://sms.arkesel.com/api/v2/sms/send');
    expect(call.headers['api-key']).toBe('k1');
    expect(call.body).toEqual({
      sender: 'INSTL',
      recipients: ['+233244123456'],
      message: 'Hello',
    });
  });

  it('throws SmsError when the JSON body reports a non-success status', async () => {
    const { fetchImpl } = makeFetch({ status: 'error', message: 'Invalid sender' });
    const client = new ArkeselSmsClient({ apiKey: 'k1', fetchImpl });
    await expect(client.send(message)).rejects.toBeInstanceOf(SmsError);
  });

  it('throws SmsError carrying status on non-2xx', async () => {
    const { fetchImpl } = makeFetch({ message: 'unauthorised' }, 401);
    const client = new ArkeselSmsClient({ apiKey: 'k1', fetchImpl });
    let err: unknown;
    try {
      await client.send(message);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).status).toBe(401);
  });

  it('wraps network errors in SmsError with cause', async () => {
    const boom = new Error('fetch boom');
    const fetchImpl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;
    const client = new ArkeselSmsClient({ apiKey: 'k1', fetchImpl });
    let err: unknown;
    try {
      await client.send(message);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).cause).toBe(boom);
  });
});
