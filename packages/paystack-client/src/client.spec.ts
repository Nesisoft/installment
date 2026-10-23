import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { chargeableEmail, PaystackClient, PaystackError } from './client';

const SECRET = 'sk_test_phase2_dummy';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(body: unknown, init: { status?: number } = {}) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, opts?: RequestInit) => {
    calls.push({
      url: input.toString(),
      method: opts?.method ?? 'GET',
      headers: opts?.headers as Record<string, string>,
      body: opts?.body ? JSON.parse(opts.body as string) : undefined,
    });
    return jsonResponse(body, init);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe('PaystackClient construction', () => {
  it('throws when secretKey is missing', () => {
    expect(() => new PaystackClient({ secretKey: '' })).toThrow(/secretKey is required/);
  });
});

describe('PaystackClient.verifySignature', () => {
  const payload = JSON.stringify({ event: 'charge.success', data: { reference: 'r-1' } });
  const expected = createHmac('sha512', SECRET).update(payload).digest('hex');
  const client = new PaystackClient({ secretKey: SECRET });

  it('accepts a correctly computed HMAC-SHA512 hex signature', () => {
    expect(client.verifySignature(payload, expected)).toBe(true);
    expect(client.verifySignature(Buffer.from(payload), expected)).toBe(true);
  });

  it('rejects a tampered body or wrong signature', () => {
    const tamperedBody = payload.replace('r-1', 'r-2');
    expect(client.verifySignature(tamperedBody, expected)).toBe(false);
    expect(client.verifySignature(payload, 'a'.repeat(expected.length))).toBe(false);
    expect(client.verifySignature(payload, '')).toBe(false);
  });

  it('rejects a signature signed with the wrong secret', () => {
    const wrong = createHmac('sha512', 'sk_test_other').update(payload).digest('hex');
    expect(client.verifySignature(payload, wrong)).toBe(false);
  });
});

describe('PaystackClient HTTP methods', () => {
  it('chargeMobileMoney POSTs /charge with the mobile_money body and bearer auth', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      message: 'ok',
      data: { reference: 'ref-1', status: 'pay_offline' },
    });
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    const res = await client.chargeMobileMoney({
      email: 'ama@example.com',
      amount: 12_345,
      currency: 'GHS',
      phone: '0244123456',
      provider: 'mtn',
      reference: 'ref-1',
      metadata: { schedule_id: 's1' },
    });

    expect(res.data.status).toBe('pay_offline');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.paystack.co/charge');
    expect(call.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(call.body).toEqual({
      email: 'ama@example.com',
      amount: 12_345,
      currency: 'GHS',
      reference: 'ref-1',
      mobile_money: { phone: '0244123456', provider: 'mtn' },
      metadata: { schedule_id: 's1' },
    });
  });

  it('chargeCard POSTs /charge with the authorization_code', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      message: 'ok',
      data: { reference: 'r', status: 'success' },
    });
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    await client.chargeCard({
      email: 'ama@example.com',
      amount: 100,
      currency: 'GHS',
      authorization_code: 'AUTH_xyz',
      reference: 'r',
    });
    expect(calls[0]!.body).toMatchObject({ authorization_code: 'AUTH_xyz' });
  });

  it('verifyTransaction GETs the verify endpoint with the encoded reference', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      message: 'ok',
      data: { reference: 'r/with/slashes', status: 'success' },
    });
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    await client.verifyTransaction('r/with/slashes');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.paystack.co/transaction/verify/r%2Fwith%2Fslashes');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('createPaymentLink POSTs /transaction/initialize and returns authorization_url', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      message: 'ok',
      data: {
        reference: 'r-1',
        access_code: 'ac',
        authorization_url: 'https://paystack.shop/pay/r-1',
      },
    });
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    const res = await client.createPaymentLink({
      email: 'ama@example.com',
      amount: 50_000,
      currency: 'GHS',
      reference: 'r-1',
      callback_url: 'https://app.example/return',
    });
    expect(res.data.authorization_url).toBe('https://paystack.shop/pay/r-1');
    expect(calls[0]!.url).toBe('https://api.paystack.co/transaction/initialize');
    expect(calls[0]!.body).toMatchObject({ callback_url: 'https://app.example/return' });
  });

  it('initiateTransfer POSTs /transfer and verifyTransfer GETs /transfer/verify/:ref', async () => {
    const transferBody = {
      status: true,
      message: 'ok',
      data: { transfer_code: 'TRF_x', reference: 'r-1', status: 'pending' },
    };
    const { fetchImpl, calls } = makeFetch(transferBody);
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    await client.initiateTransfer({
      source: 'balance',
      amount: 91_000,
      recipient: 'RCP_x',
      reason: 'Settlement',
      reference: 'r-1',
    });
    expect(calls[0]!.url).toBe('https://api.paystack.co/transfer');
    expect(calls[0]!.method).toBe('POST');

    await client.verifyTransfer('r-1');
    expect(calls[1]!.url).toBe('https://api.paystack.co/transfer/verify/r-1');
    expect(calls[1]!.method).toBe('GET');
  });

  it('refund POSTs /refund against the original transaction, verifyRefund GETs /refund/:id', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      message: 'ok',
      data: { id: 4567, status: 'pending' },
    });
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    await client.refund({
      transaction: 'INSTL-abc-1',
      amount: 25_000,
      currency: 'GHS',
      merchant_note: 'returned goods',
    });
    expect(calls[0]!.url).toBe('https://api.paystack.co/refund');
    expect(calls[0]!.method).toBe('POST');
    // Keyed on the transaction — a refund carries no reference of its own, which
    // is why callers must key idempotency on their own record.
    expect(calls[0]!.body).toMatchObject({
      transaction: 'INSTL-abc-1',
      amount: 25_000,
      currency: 'GHS',
    });

    // Verification is by Paystack's refund id, not by any reference of ours.
    await client.verifyRefund('4567');
    expect(calls[1]!.url).toBe('https://api.paystack.co/refund/4567');
    expect(calls[1]!.method).toBe('GET');
  });

  it('rejects a refund whose transaction reference Paystack could not accept', () => {
    const client = new PaystackClient({ secretKey: SECRET });
    // The colon-bearing references S1 removed would fail at the API and park the
    // refund in `unknown` — indistinguishable from a network fault, on the one
    // operation where a customer is waiting for their money.
    expect(() => client.refund({ transaction: 'INSTL:abc:1' })).toThrow(PaystackError);
    expect(() => client.verifyRefund('')).toThrow(PaystackError);
  });

  it("lists a charge's refunds by its numeric transaction id", async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      message: 'Refunds retrieved',
      data: [{ id: 18758414, amount: 200, status: 'pending', transaction: 6675930705 }],
    });
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    const res = await client.listRefundsForTransaction(6675930705);

    expect(calls[0]!.url).toBe('https://api.paystack.co/refund?transaction=6675930705');
    expect(calls[0]!.method).toBe('GET');
    expect(res.data[0]!.id).toBe(18758414);
  });

  it('refuses to list refunds by a reference, which Paystack answers with nothing', () => {
    // Captured from test mode: `?transaction=<reference>` returns `status: true`
    // and an empty list — read as "no refund exists", it invites a second one.
    const client = new PaystackClient({ secretKey: SECRET });
    expect(() => client.listRefundsForTransaction('INSTL-abc-1')).toThrow(PaystackError);
    expect(() => client.listRefundsForTransaction('')).toThrow(PaystackError);
  });

  it('respects a custom baseUrl', async () => {
    const { fetchImpl, calls } = makeFetch({ status: true, message: 'ok', data: {} });
    const client = new PaystackClient({
      secretKey: SECRET,
      fetchImpl,
      baseUrl: 'https://stub.local',
    });
    await client.verifyTransaction('r-1');
    expect(calls[0]!.url).toBe('https://stub.local/transaction/verify/r-1');
  });
});

describe('PaystackClient error handling', () => {
  it('throws PaystackError with status and parsed message on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: false, message: 'Invalid key' }, { status: 401 }),
    ) as unknown as typeof fetch;
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    let err: unknown;
    try {
      await client.verifyTransaction('r-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PaystackError);
    expect((err as PaystackError).status).toBe(401);
    expect((err as PaystackError).message).toMatch(/Invalid key/);
  });

  it('wraps network errors in PaystackError with cause', async () => {
    const boom = new Error('fetch boom');
    const fetchImpl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;
    const client = new PaystackClient({ secretKey: SECRET, fetchImpl });

    let err: unknown;
    try {
      await client.verifyTransaction('r-1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PaystackError);
    expect((err as PaystackError).cause).toBe(boom);
  });

  it('rejects empty reference inputs', () => {
    const client = new PaystackClient({ secretKey: SECRET });
    expect(() => client.verifyTransaction('')).toThrow(PaystackError);
    expect(() => client.verifyTransfer('')).toThrow(PaystackError);
  });
});

describe('PaystackClient reference charset', () => {
  const client = new PaystackClient({ secretKey: SECRET });
  const momo = {
    email: 'a@b.gh',
    amount: 1000,
    currency: 'GHS' as const,
    phone: '+233244000111',
    provider: 'mtn' as const,
  };

  it('rejects a reference containing a colon', () => {
    // The exact format this engine used to send. Paystack's charset excludes
    // ':', so every charge would have failed at the API and been recorded as
    // `unknown` — indistinguishable from a network fault.
    const legacy = `INSTL-${'a'.repeat(36)}-${'a'.repeat(36)}:1`;
    expect(() => client.chargeMobileMoney({ ...momo, reference: legacy })).toThrow(PaystackError);
  });

  it('rejects references with spaces, slashes or over-length', () => {
    for (const bad of ['has space', 'has/slash', 'a'.repeat(101)]) {
      expect(() => client.chargeMobileMoney({ ...momo, reference: bad })).toThrow(PaystackError);
    }
  });

  it('accepts the reference format the engine now sends', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: true, data: { reference: 'r', status: 'success' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const ok = new PaystackClient({ secretKey: SECRET, fetchImpl: fetchImpl as typeof fetch });
    await expect(
      ok.chargeMobileMoney({ ...momo, reference: `INSTL-${crypto.randomUUID()}-1` }),
    ).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('PaystackClient payout destinations', () => {
  const client = (fetchImpl: typeof fetch) => new PaystackClient({ secretKey: SECRET, fetchImpl });

  it('asks for the Ghanaian list, a page at a time large enough to hold it', async () => {
    const { fetchImpl, calls } = makeFetch({ status: true, data: [] });
    await client(fetchImpl).listBanks();

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/bank?currency=GHS');
    expect(calls[0]?.url).toContain('perPage=100');
  });

  it('resolves an account number against a bank code', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      data: { account_number: '0244771122', account_name: 'AKUA BOATENG' },
    });
    const res = await client(fetchImpl).resolveAccount('0244771122', 'MTN');

    expect(res.data.account_name).toBe('AKUA BOATENG');
    expect(calls[0]?.url).toContain('account_number=0244771122');
    expect(calls[0]?.url).toContain('bank_code=MTN');
  });

  it('refuses to resolve without both halves — a partial query resolves nothing', () => {
    const { fetchImpl } = makeFetch({ status: true, data: {} });
    expect(() => client(fetchImpl).resolveAccount('', 'MTN')).toThrow(PaystackError);
    expect(() => client(fetchImpl).resolveAccount('0244771122', '')).toThrow(PaystackError);
  });

  it('creates a transfer recipient with the currency and type Ghana needs', async () => {
    const { fetchImpl, calls } = makeFetch({
      status: true,
      data: { recipient_code: 'RCP_abc123', type: 'ghipss' },
    });
    const res = await client(fetchImpl).createTransferRecipient({
      type: 'ghipss',
      name: 'AKUA BOATENG',
      account_number: '1234567890123',
      bank_code: '030100',
      currency: 'GHS',
    });

    expect(res.data.recipient_code).toBe('RCP_abc123');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/transferrecipient');
    expect(calls[0]?.body).toEqual({
      type: 'ghipss',
      name: 'AKUA BOATENG',
      account_number: '1234567890123',
      bank_code: '030100',
      currency: 'GHS',
    });
  });

  it('surfaces a rejected account as a PaystackError, not a silent empty result', async () => {
    const { fetchImpl } = makeFetch(
      { status: false, message: 'Could not resolve account name. Check parameters or try again.' },
      { status: 422 },
    );
    await expect(client(fetchImpl).resolveAccount('9999999999', 'MTN')).rejects.toThrow(
      /Could not resolve account name/,
    );
  });
});

describe('chargeableEmail', () => {
  const STAND_IN = 'customers.ejua.gh';

  it('moves the address phone signup stores, which Paystack refuses, to the stand-in domain', () => {
    expect(chargeableEmail('+233247392504@customer.installment.local', STAND_IN)).toBe(
      '+233247392504@customers.ejua.gh',
    );
  });

  it('moves every reserved top-level domain, whatever its case', () => {
    for (const domain of ['x.localhost', 'x.test', 'x.invalid', 'x.example', 'X.LOCAL']) {
      expect(chargeableEmail(`a@${domain}`, STAND_IN)).toBe('a@customers.ejua.gh');
    }
  });

  it('leaves a real address alone, including one at example.com', () => {
    expect(chargeableEmail('ama@gmail.com', STAND_IN)).toBe('ama@gmail.com');
    expect(chargeableEmail('ama.customer@example.com', STAND_IN)).toBe('ama.customer@example.com');
  });

  it('changes nothing without a stand-in domain', () => {
    expect(chargeableEmail('+233247392504@customer.installment.local', undefined)).toBe(
      '+233247392504@customer.installment.local',
    );
  });

  it('is applied to every request that carries an email', async () => {
    const { fetchImpl, calls } = makeFetch({ status: true, message: 'ok', data: {} });
    const client = new PaystackClient({
      secretKey: SECRET,
      fetchImpl,
      standInEmailDomain: STAND_IN,
    });
    const email = '+233247392504@customer.installment.local';
    await client.chargeMobileMoney({
      email,
      amount: 100,
      currency: 'GHS',
      phone: '0551234987',
      provider: 'mtn',
      reference: 'ref-1',
    });
    await client.chargeCard({
      email,
      amount: 100,
      currency: 'GHS',
      authorization_code: 'AUTH_x',
      reference: 'ref-2',
    });
    await client.createPaymentLink({
      email,
      amount: 100,
      currency: 'GHS',
      reference: 'ref-3',
      callback_url: 'https://ejua.gh/paid',
    });
    expect(calls.map((c) => (c.body as { email: string }).email)).toEqual([
      '+233247392504@customers.ejua.gh',
      '+233247392504@customers.ejua.gh',
      '+233247392504@customers.ejua.gh',
    ]);
  });
});
