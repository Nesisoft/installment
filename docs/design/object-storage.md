# Object storage

Every product in the app rendered a placeholder tile. `product_images.storage_key`,
`stores.logo_key`, `categories.image_key` and `customers.ghana_card_image_key` all
existed and were all writable — but nothing in the system could put bytes anywhere,
so the only keys in the database were the ones the seed script invented. This is
the missing half.

## The shape

Direct-to-bucket, presigned. The client asks the API where to put a file, gets a
one-shot URL back, and PUTs the bytes straight at the storage provider:

```
  client                      API                       bucket
    │  POST /merchant/uploads  │                           │
    │─────────────────────────>│  derive key, sign          │
    │  { key, url, headers }   │                           │
    │<─────────────────────────│                           │
    │                                                      │
    │  PUT url  (the file)                                 │
    │─────────────────────────────────────────────────────>│
    │                                                      │
    │  POST /admin/products/:id/images  { storage_key }     │
    │─────────────────────────>│                           │
```

Image bytes never pass through the API. That matters more here than in most
places: a 4 MB photograph over a Ghanaian mobile connection is a slow request,
and a Node process holding hundreds of them is a process doing nothing else.

## Why the signer is hand-rolled

`packages/storage-client` implements AWS Signature V4 itself, in about 120 lines
against `node:crypto`, rather than depending on `@aws-sdk/client-s3`.

The house precedent is `paystack-client`: this workspace talks to external
services over plain `fetch` and keeps the dependency surface small. The AWS SDK
is a large tree to carry for one signature. It also buys provider-independence
for free — S3, Cloudflare R2, DigitalOcean Spaces and MinIO all verify the same
signature, so choosing a provider (or moving between them, which matters when
R2 charges no egress and Ghana-facing bandwidth is not cheap) stays a config
change.

The risk in hand-rolling is that a wrong signature signs perfectly happily and
only fails against a real bucket. So the spec is anchored on AWS's own published
worked example — fixed credentials, fixed clock, one known-correct signature —
and it matches byte for byte.

## Visibility lives in the key

One bucket, private by default, with two prefixes:

| Prefix | Holds | Read by |
| --- | --- | --- |
| `public/` | product images, store logo/banner, category artwork | anyone, straight off the CDN |
| `private/` | KYC documents | a short-lived signed URL, issued to staff with `customers:read` |

The split is not decorative. A Ghana Card photograph is personal data under the
Data Protection Act, 2012 (Act 843); in a public prefix it would be readable by
anyone who learned the key, and keys leak — through logs, screenshots, referrer
headers, and support tickets.

Putting the marker in the key rather than in a side table means you can tell from
a database row alone whether an object is world-readable. And the **driver**
applies the prefix, not the caller: a policy layer that forgets to mark a KYC
upload private still gets a `private/` key, because the driver strips whatever
prefix it was handed and re-derives it from the declared visibility.

Two things enforce it beyond the bucket policy:

- `MediaService.url()` returns `null` for a `private/` key. A URL that looks
  right and 403s is worse than no URL — it invites a caller to put it in an
  `<img>` and blame storage. The only way to read a private object is
  `UploadsService.readPrivate`, which sits behind a permission check.
- `UploadsService.readPrivate` refuses a *public* key, for the mirror-image
  reason: signing one implies protection that is not there.

## The key is derived server-side. Always.

A client-chosen key is a client-chosen victim. It would let a merchant overwrite
a competitor's product photograph, write outside the bucket, or drop an object
into the public prefix that was meant to be private.

So the client says *what* it is uploading; the server says *where* it goes:

| Purpose | Visibility | Key | Surface |
| --- | --- | --- | --- |
| `product_image` | public | `products/{merchantId}/{uuid}.{ext}` | `POST /merchant/uploads` |
| `store_logo` | public | `stores/{merchantId}/{uuid}.{ext}` | `POST /merchant/uploads` |
| `store_banner` | public | `stores/{merchantId}/{uuid}.{ext}` | `POST /merchant/uploads` |
| `category_image` | public | `categories/{uuid}.{ext}` | `POST /admin/uploads` |
| `kyc_document` | private | `kyc/{customerId}/{uuid}.{ext}` | `POST /me/uploads` |

The owner id always comes from the authenticated request — `CurrentMerchantId`,
or the customer resolved from the JWT — never from the body. That is what makes
the per-merchant folder a boundary rather than a naming convention.

Three surfaces rather than one `/uploads` with a role branch, because then the
guard and the permitted purposes sit in the same place: a merchant token reaching
a route that only mints category keys is refused by the router, not by a branch
someone has to remember to write.

## What a presigned URL can and cannot enforce

**Can:**

- **The content type**, pinned into the signature. A URL issued for a JPEG cannot
  be used to upload an HTML page that the bucket would then serve from an origin
  of ours. The extension in the key comes from the declared type, never from a
  client filename.
- **Expiry** — five minutes by default. The URL is a bearer token for a write.
- **The exact key**, and nothing else.

**Cannot:**

- **Size.** A presigned PUT has no way to bound a length the client never
  committed to. The API checks a declared `content_length` before minting a URL,
  which turns the honest case (someone picking a 40 MB photograph) into an
  immediate refusal instead of a transfer that dies halfway — but it is not a
  guarantee. **Set an object-size limit on the bucket**; that is the real
  backstop, and `.env.example` says so.

SVG is deliberately not an accepted image type anywhere. It is an image to a file
picker and a script host to a browser, and these objects are served from an
origin of ours.

## The local driver, and why it is not a shortcut

`STORAGE_DRIVER=local` writes to disk through the API and hands out URLs signed
with an HMAC over the same facts SigV4 pins — method, key, content type, expiry.

The obvious cheaper thing would have been "in dev, just multipart-POST the file
to the API". That would leave the real path — presigning, pinned types, expiry,
direct-to-bucket transfer — unexercised until the first deploy, which is exactly
when you want it to have been exercised already. Here the **client flow is
byte-identical**: ask for a URL, PUT the bytes at it.

It keeps the privacy split too — `private/` needs a signed query even locally —
because the dev driver must not be the place where a security property quietly
stops applying.

It is refused under `NODE_ENV=production`: it stores uploads on a container
filesystem that a redeploy discards.

## Configuration

`STORAGE_PUBLIC_URL` becomes `MEDIA_BASE_URL` when that is unset, so configuring
storage is one variable rather than two that have to agree. `MEDIA_BASE_URL` still
wins when set, because a CDN in front of a bucket is a different hostname from the
bucket and only the operator knows it.

Both empty means every image URL resolves to `null` and the apps draw their
placeholder tile — the quiet degradation `MediaService` was written for, now
reachable in one more way.

Boot refuses: `s3` without bucket or credentials; `local` in production; the
published dev upload secret in production.

## Not done

- **Nothing deletes.** Replacing a store logo orphans the old object. Harmless
  and cheap for now, and a lifecycle rule on the bucket is the usual answer, but
  a real `delete` belongs in the driver eventually.
- **No image processing.** No resizing, no thumbnails, no format conversion, no
  stripping of EXIF (which carries GPS coordinates from a phone camera). The
  phone uploads what it picked. A transform step — on upload, or a CDN that
  resizes on the fly — is worth having before this is carrying real traffic.
- **No virus scanning** on KYC documents.
- **No UI drives any of it.** The merchant portal is Phase 15; today the routes
  are driven by the admin console and by hand.
