import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StorageVisibility } from '@installment/storage-client';

/**
 * What may be uploaded, by whom, and under what key.
 *
 * This lives in the API rather than in `storage-client` on purpose: the storage
 * package moves bytes and knows nothing about merchants, customers or KYC. The
 * decision that a product photograph belongs to a merchant and a Ghana Card
 * belongs to exactly one customer is an authorisation decision, and it belongs
 * next to the guards that enforce it.
 *
 * The single rule everything else follows from: **the key is derived here, never
 * supplied by the client.** A client-chosen key is a client-chosen victim — it
 * would let a merchant overwrite a competitor's product photograph, or write
 * `../../` out of the bucket, or drop an object into the public prefix that was
 * meant to be private. The client says what it is uploading; the server says
 * where it goes.
 */

/** Content type → extension. Never the client's filename, which can say `.html`. */
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** A scan of a physical card is often a PDF from a scanner app. */
const DOCUMENT_TYPES: Record<string, string> = { ...IMAGE_TYPES, 'application/pdf': 'pdf' };

export type UploadPurpose =
  | 'product_image'
  | 'store_logo'
  | 'store_banner'
  | 'category_image'
  | 'kyc_document';

export interface UploadPurposeRule {
  visibility: StorageVisibility;
  /** Content types accepted, mapped to the extension the key will carry. */
  types: Record<string, string>;
  /**
   * Whose id namespaces the key. `merchant` and `customer` scope the object to
   * the caller; `none` is for catalogue art that belongs to the platform.
   */
  owner: 'merchant' | 'customer' | 'none';
  /** Key prefix, below the visibility marker the driver adds. */
  folder: string;
}

export const UPLOAD_PURPOSES: Record<UploadPurpose, UploadPurposeRule> = {
  product_image: {
    visibility: 'public',
    types: IMAGE_TYPES,
    owner: 'merchant',
    folder: 'products',
  },
  store_logo: { visibility: 'public', types: IMAGE_TYPES, owner: 'merchant', folder: 'stores' },
  store_banner: { visibility: 'public', types: IMAGE_TYPES, owner: 'merchant', folder: 'stores' },
  category_image: { visibility: 'public', types: IMAGE_TYPES, owner: 'none', folder: 'categories' },
  /**
   * Private, and it is the reason the visibility split exists at all. A Ghana
   * Card photograph is personal data under the Data Protection Act, 2012
   * (Act 843); in the public prefix it would be readable by anyone who learned
   * the key, and keys leak through logs, screenshots and referrer headers.
   */
  kyc_document: { visibility: 'private', types: DOCUMENT_TYPES, owner: 'customer', folder: 'kyc' },
};

export const requestUploadSchema = z.object({
  purpose: z.enum(Object.keys(UPLOAD_PURPOSES) as [UploadPurpose, ...UploadPurpose[]]),
  content_type: z.string().trim().min(1),
  /**
   * Advisory: the client's own view of the file size, checked against the
   * deployment's ceiling before a URL is issued. It is not a guarantee — a
   * presigned PUT cannot enforce a length the client did not commit to — which
   * is why the bucket needs its own object-size policy as the real backstop.
   * Checking it here still turns the common case (someone picking a 40 MB
   * photograph) into an immediate, explainable refusal rather than a transfer
   * that fails halfway over a Ghanaian mobile connection.
   */
  content_length: z.coerce.number().int().positive().optional(),
});

export type RequestUploadInput = z.infer<typeof requestUploadSchema>;

export class UploadNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadNotAllowedError';
  }
}

export interface DerivedUploadKey {
  key: string;
  visibility: StorageVisibility;
  contentType: string;
}

/**
 * Turns a validated request plus the caller's own id into the object key.
 *
 * `ownerId` must come from the authenticated request — `CurrentMerchantId`, or
 * the customer on the JWT — never from the body. That is what makes the
 * per-merchant folder a boundary rather than a naming convention.
 */
export function deriveUploadKey(
  input: RequestUploadInput,
  ownerId: string | undefined,
  maxBytes: number,
): DerivedUploadKey {
  const rule = UPLOAD_PURPOSES[input.purpose];

  // Parameters after a `;` (charset, boundary) are not part of the type and
  // would be signed as if they were, so a client sending the bare type would
  // then fail to verify.
  const contentType = input.content_type.split(';')[0]!.trim().toLowerCase();
  const extension = rule.types[contentType];
  if (!extension) {
    throw new UploadNotAllowedError(
      `${input.purpose} accepts ${Object.keys(rule.types).join(', ')}, not ${contentType}`,
    );
  }

  if (input.content_length !== undefined && input.content_length > maxBytes) {
    throw new UploadNotAllowedError(
      `File is ${input.content_length} bytes; the limit is ${maxBytes}`,
    );
  }

  if (rule.owner !== 'none' && !ownerId) {
    throw new UploadNotAllowedError(`${input.purpose} requires a ${rule.owner} to upload it`);
  }

  // A fresh UUID every time, so an upload never overwrites an existing object.
  // Replacing an image is a new key plus a database update: cheap, and it makes
  // a mistaken upload recoverable instead of destructive.
  const segments = [
    rule.folder,
    rule.owner === 'none' ? undefined : ownerId,
    `${randomUUID()}.${extension}`,
  ];

  return {
    key: segments.filter(Boolean).join('/'),
    visibility: rule.visibility,
    contentType,
  };
}

/**
 * The prefix every key for `purpose` and `ownerId` sits under, as stored.
 *
 * Note the visibility segment: {@link deriveUploadKey} returns the key without
 * it and the driver prepends it, so what a client hands back — and what ends up
 * in `product_images.storage_key` — is the prefixed form. Built from the same
 * `UPLOAD_PURPOSES` row so the folder cannot be changed in one place only.
 */
export function uploadKeyPrefix(purpose: UploadPurpose, ownerId: string | undefined): string {
  const rule = UPLOAD_PURPOSES[purpose];
  const segments = [rule.visibility, rule.folder, rule.owner === 'none' ? undefined : ownerId];
  return `${segments.filter(Boolean).join('/')}/`;
}

/**
 * Whether `key` is one this owner was actually issued.
 *
 * Keys are derived server-side and never chosen by a client — but the endpoints
 * that *attach* a key to a row take it back from the client, which reopens the
 * same door from the other side. Without this a seller could point their own
 * listing at a competitor's photograph: the object is public, so it would
 * render perfectly, and the listing would show someone else's product as if it
 * were theirs.
 *
 * Conservative by construction — an owned purpose with no owner matches
 * nothing, rather than matching the whole folder.
 */
export function keyBelongsTo(
  purpose: UploadPurpose,
  key: string,
  ownerId: string | undefined,
): boolean {
  if (UPLOAD_PURPOSES[purpose].owner !== 'none' && !ownerId) return false;
  return key.startsWith(uploadKeyPrefix(purpose, ownerId));
}
