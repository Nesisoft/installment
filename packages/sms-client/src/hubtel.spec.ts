import { describe, expect, it, vi } from 'vitest';
import { HubtelSmsClient } from './hubtel';
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

describe('HubtelSmsClient', () => {
  it('throws when credentials are missing', () => {
    expect(() => new HubtelSmsClient({ clientId: '', clientSecret: '' })).toThrow(
      /clientId and clientSecret/,
    );
  });

  it('POSTs the messaging endpoint with Basic auth and { From, To, Content }', async () => {
    const { fetchImpl, calls } = makeFetch({
      messageId: 'hub-123',
      status: 0,
      rate: 1,
    });
    const client = new HubtelSmsClient({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl,
    });

    const result = await client.send(message);

    expect(result).toEqual({
      id: 'hub-123',
      status: 'queued',
      rawResponse: { messageId: 'hub-123', status: 0, rate: 1 },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://sms.hubtel.com/v1/messages/send');
    expect(call.headers.Authorization).toBe(`Basic ${Buffer.from('cid:csec').toString('base64')}`);
    expect(call.body).toEqual({ From: 'INSTL', To: '+233244123456', Content: 'Hello' });
  });

  it('respects a custom baseUrl', async () => {
    const { fetchImpl, calls } = makeFetch({ messageId: 'x', status: 0 });
    const client = new HubtelSmsClient({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl,
      baseUrl: 'https://stub.local',
    });
    await client.send(message);
    expect(calls[0]!.url).toBe('https://stub.local/v1/messages/send');
  });

  // Hubtel returns 201 with a non-zero `status` for business-level rejections.
  // These used to be reported as 'sent', so a message the customer never
  // received was recorded as delivered.
  it.each([
    [1, 'Invalid Destination address'],
    [2, 'Invalid Source address'],
    [3, 'Message body was too long'],
    [6, 'The message content was rejected'],
    [100, 'General invalid request'],
  ])('throws SmsError when Hubtel returns 2xx with status %i', async (status, description) => {
    const { fetchImpl } = makeFetch({ status, statusDescription: description }, 201);
    const client = new HubtelSmsClient({ clientId: 'cid', clientSecret: 'csec', fetchImpl });

    let err: unknown;
    try {
      await client.send(message);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).message).toBe(description);
  });

  it('falls back to a readable message when Hubtel omits statusDescription', async () => {
    const { fetchImpl } = makeFetch({ status: 12 }, 201);
    const client = new HubtelSmsClient({ clientId: 'cid', clientSecret: 'csec', fetchImpl });

    await expect(client.send(message)).rejects.toThrow(/status 12/);
  });

  it('accepts status 0 as queued, not sent — delivery is only known from the receipt', async () => {
    const { fetchImpl } = makeFetch(
      { messageId: 'hub-9', status: 0, statusDescription: 'request submitted successfully' },
      201,
    );
    const client = new HubtelSmsClient({ clientId: 'cid', clientSecret: 'csec', fetchImpl });

    const result = await client.send(message);
    expect(result.status).toBe('queued');
    expect(result.id).toBe('hub-9');
  });

  it('throws SmsError carrying status and parsed message on non-2xx', async () => {
    const { fetchImpl } = makeFetch({ message: 'Invalid sender' }, 400);
    const client = new HubtelSmsClient({ clientId: 'cid', clientSecret: 'csec', fetchImpl });

    let err: unknown;
    try {
      await client.send(message);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SmsError);
    expect((err as SmsError).status).toBe(400);
    expect((err as SmsError).message).toMatch(/Invalid sender/);
  });

  it('wraps network errors in SmsError with cause', async () => {
    const boom = new Error('fetch boom');
    const fetchImpl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;
    const client = new HubtelSmsClient({ clientId: 'cid', clientSecret: 'csec', fetchImpl });

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
