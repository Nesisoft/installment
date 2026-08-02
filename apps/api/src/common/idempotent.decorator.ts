import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiConflictResponse, ApiHeader } from '@nestjs/swagger';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a route as requiring an `Idempotency-Key` header.
 *
 * Put this on every endpoint that moves money or creates a financial
 * commitment. On Ghanaian mobile networks a request timeout followed by a
 * client retry is routine, and a customer double-tapping "Pay" is routine —
 * without this the second request is simply a second charge.
 *
 * `required: false` accepts the header when present but does not demand it,
 * for routes where breaking existing callers would be worse than the risk.
 */
export const Idempotent = (opts: { required?: boolean } = {}) => {
  const required = opts.required ?? true;
  return applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, { required }),
    // Publish the contract, so an integrator reading the spec knows the header
    // exists and is required — an undocumented safety requirement is one
    // nobody sends.
    ApiHeader({
      name: 'Idempotency-Key',
      required,
      description:
        'Unique key for this logical request. Reuse the same value when retrying so the ' +
        'operation is applied at most once; a retry returns the original response. ' +
        'Reusing a key with a different request body returns 409.',
      schema: { type: 'string', maxLength: 255 },
    }),
    ApiConflictResponse({
      description:
        'The Idempotency-Key was reused with a different request body, or an earlier ' +
        'request with this key is still in progress.',
    }),
  );
};

export interface IdempotentOptions {
  required: boolean;
}
