import { describe, expect, it } from 'vitest';
import { presignS3Url, toAmzDate, uriEncode } from './sigv4';

/**
 * A signature is either byte-exact or worthless, and nothing in our own test
 * suite can tell the difference — a wrong implementation signs happily and only
 * fails against a real bucket. So the anchor here is AWS's own published
 * worked example ("Signature Calculation for a Presigned URL", S3 developer
 * guide): fixed credentials, a fixed clock, one known-correct signature. If a
 * refactor changes so much as the ordering of a query parameter, this fails.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  host: 'examplebucket.s3.amazonaws.com',
  path: '/test.txt',
  region: 'us-east-1',
  now: new Date('2013-05-24T00:00:00Z'),
  expiresInSeconds: 86_400,
};

describe('toAmzDate', () => {
  it('renders the basic ISO-8601 form AWS requires', () => {
    expect(toAmzDate(new Date('2026-08-28T17:00:00.000Z'))).toBe('20260828T170000Z');
  });

  it('drops milliseconds rather than rounding them into the seconds field', () => {
    expect(toAmzDate(new Date('2026-08-28T17:00:00.999Z'))).toBe('20260828T170000Z');
  });

  it('keeps a midnight boundary on the right day', () => {
    expect(toAmzDate(new Date('2026-01-01T00:00:00.000Z'))).toBe('20260101T000000Z');
  });
});

describe('uriEncode', () => {
  it('encodes the characters encodeURIComponent leaves alone', () => {
    // AWS percent-encodes all of these; encodeURIComponent does not. A key
    // containing one would sign one way and be requested another.
    expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('encodes a slash, because segments are encoded individually', () => {
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });

  it('leaves the unreserved set untouched', () => {
    expect(uriEncode('aZ0-_.~')).toBe('aZ0-_.~');
  });
});

describe('presignS3Url', () => {
  it("matches AWS's published presigned-GET signature exactly", () => {
    const url = presignS3Url({ method: 'GET', ...AWS_EXAMPLE });

    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('emits the query parameters in the canonical order, with the signature last', () => {
    const url = presignS3Url({ method: 'GET', ...AWS_EXAMPLE });
    const names = [...new URL(url).searchParams.keys()];

    // Everything but the signature must be sorted: it is the order they were
    // hashed in, and a bucket recomputes from what it receives.
    expect(names).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'X-Amz-Signature',
    ]);
  });

  it('changes the signature when the method changes', () => {
    const get = presignS3Url({ method: 'GET', ...AWS_EXAMPLE });
    const put = presignS3Url({ method: 'PUT', ...AWS_EXAMPLE });

    expect(signatureOf(put)).not.toBe(signatureOf(get));
  });

  it('folds a pinned header into both the signature and X-Amz-SignedHeaders', () => {
    const plain = presignS3Url({ method: 'PUT', ...AWS_EXAMPLE });
    const pinned = presignS3Url({
      method: 'PUT',
      ...AWS_EXAMPLE,
      headers: { 'content-type': 'image/jpeg' },
    });

    expect(new URL(plain).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(new URL(pinned).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(signatureOf(pinned)).not.toBe(signatureOf(plain));
  });

  it('sorts signed header names rather than trusting insertion order', () => {
    const url = presignS3Url({
      method: 'PUT',
      ...AWS_EXAMPLE,
      headers: { 'x-amz-meta-owner': 'm1', 'content-type': 'image/png' },
    });

    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-type;host;x-amz-meta-owner',
    );
  });

  it('includes the session token when temporary credentials are used', () => {
    const url = presignS3Url({ method: 'PUT', ...AWS_EXAMPLE, sessionToken: 'tok-123' });

    expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBe('tok-123');
  });

  it('encodes path segments individually, leaving the separators literal', () => {
    const url = presignS3Url({
      method: 'PUT',
      ...AWS_EXAMPLE,
      path: '/public/products/a b/photo (1).jpg',
    });

    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/public/products/')).toBe(true);
    expect(url).toContain('/a%20b/photo%20%281%29.jpg?');
  });

  it('is deterministic for a fixed clock', () => {
    const a = presignS3Url({ method: 'PUT', ...AWS_EXAMPLE });
    const b = presignS3Url({ method: 'PUT', ...AWS_EXAMPLE });

    expect(a).toBe(b);
  });

  it('produces a different signature a second later', () => {
    const a = presignS3Url({ method: 'PUT', ...AWS_EXAMPLE });
    const b = presignS3Url({
      method: 'PUT',
      ...AWS_EXAMPLE,
      now: new Date(AWS_EXAMPLE.now.getTime() + 1_000),
    });

    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });
});

function signatureOf(url: string): string {
  return new URL(url).searchParams.get('X-Amz-Signature') ?? '';
}
