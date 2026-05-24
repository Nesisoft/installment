import { describe, expect, it } from 'vitest';
import { MockGhanaCardVerifier } from './ghana-card-verifier';

const input = {
  ghana_card_number: 'GHA-123456789-0',
  ghana_card_image_key: 's3://bucket/k.jpg',
};

describe('MockGhanaCardVerifier', () => {
  it('verifies any input by default', async () => {
    const v = new MockGhanaCardVerifier();
    expect(await v.verify(input)).toMatchObject({ verified: true });
  });

  it('rejects when alwaysVerified=false', async () => {
    const v = new MockGhanaCardVerifier({ alwaysVerified: false, mockReason: 'denied' });
    expect(await v.verify(input)).toEqual({ verified: false, reason: 'denied' });
  });

  it('honours an explicit allow-set', async () => {
    const v = new MockGhanaCardVerifier({
      verifiedSet: new Set(['GHA-000000001-0']),
      mockReason: 'not in set',
    });
    expect((await v.verify(input)).verified).toBe(false);
    expect((await v.verify({ ...input, ghana_card_number: 'GHA-000000001-0' })).verified).toBe(
      true,
    );
  });
});
