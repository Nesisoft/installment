import { describe, expect, it } from 'vitest';
import { ManualReviewGhanaCardVerifier, MockGhanaCardVerifier } from './ghana-card-verifier';

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

describe('ManualReviewGhanaCardVerifier', () => {
  it('verifies, because the reviewer who called it already made the decision', async () => {
    expect(await new ManualReviewGhanaCardVerifier().verify(input)).toMatchObject({
      verified: true,
    });
  });

  it('labels the audit payload as a human review rather than a provider check', async () => {
    // The whole reason this class exists. `{ mock: true }` on a production audit
    // row reads, a year later, as though something verified the card.
    const { raw } = await new ManualReviewGhanaCardVerifier().verify(input);
    expect(raw).toEqual({ manual_review: true });
  });
});
