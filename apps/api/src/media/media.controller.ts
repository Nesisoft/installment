import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Head,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { resolveLocalPath, verifyLocalToken } from '@installment/storage-client';
import { Public } from '../auth/decorators';
import { LocalMediaConfig } from './local-media.config';

/**
 * The local driver's other half: the endpoint its presigned URLs point at.
 *
 * Live only when `STORAGE_DRIVER=local`, and only useful in development — it
 * puts image bytes through the API process and writes them to a container
 * filesystem a redeploy throws away. It exists so the *client* flow is the same
 * one production uses: ask for a URL, PUT the bytes at it. A dev-only shortcut
 * would leave that path untested until the first deploy.
 *
 * Routes are `@Public()` because the signed token IS the authorisation — the
 * same reason an S3 presigned URL carries no bearer header.
 */

/** Extension → content type, for serving. Deliberately the set we accept. */
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

@ApiExcludeController()
@Controller('media')
export class MediaController {
  constructor(private readonly config: LocalMediaConfig) {}

  /** No local driver, no local routes — every one of these 404s. */
  private assertEnabled(): void {
    if (!this.config.enabled) throw new NotFoundException();
  }

  /**
   * Resolves a key that arrived on the URL rather than inside a signed token.
   *
   * `resolveLocalPath` throws `StorageConfigurationError` on an escape, which is
   * deliberately a 500 — it means our own signer emitted a bad key. Here the key
   * is whatever a stranger typed, so a 500 would be both wrong and an invitation
   * to flood Sentry with `%2e%2e%2f`. An unreachable key and a missing one look
   * the same from outside, which is also the answer that tells an attacker least.
   */
  private resolveReadable(key: string): string {
    try {
      return resolveLocalPath(this.config.directory, key);
    } catch {
      throw new NotFoundException();
    }
  }

  /**
   * Accepts the bytes a presigned upload URL was minted for.
   *
   * Streams rather than buffering, and aborts the moment the byte count passes
   * the ceiling — which is strictly better than the S3 path can manage, since a
   * presigned PUT has no way to bound a length the client never committed to.
   */
  @Public()
  @Put('upload')
  async upload(
    @Req() req: Request,
    @Query('key') key?: string,
    @Query('type') type?: string,
    @Query('expires') expires?: string,
    @Query('signature') signature?: string,
  ): Promise<{ key: string; bytes: number }> {
    this.assertEnabled();
    if (!key || !type || !expires || !signature) {
      throw new BadRequestException('Missing upload token');
    }

    const ok = verifyLocalToken(
      { method: 'PUT', key, contentType: type, expires: Number(expires) },
      signature,
      this.config.secret,
    );
    if (!ok) throw new ForbiddenException('Upload token is invalid or has expired');

    // The signature pins the content type, so sending a different one is the
    // same refusal S3 would give — not a courtesy check.
    const sent = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (sent !== type) {
      throw new BadRequestException(`This URL was signed for ${type}, not ${sent || 'nothing'}`);
    }

    const target = resolveLocalPath(this.config.directory, key);
    await mkdir(dirname(target), { recursive: true });

    let bytes = 0;
    const limit = this.config.maxUploadBytes;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) req.destroy(new PayloadTooLargeException(`Limit is ${limit} bytes`));
    });

    await pipeline(req, createWriteStream(target));
    return { key, bytes };
  }

  /**
   * Serves an object back.
   *
   * `public/` is open, exactly as a CDN-fronted public prefix would be.
   * `private/` demands the signed query the driver mints, so a KYC document is
   * no more readable here than it is in a real bucket — the local driver must
   * not be the place where the privacy split quietly stops applying.
   */
  @Public()
  @Get('*path')
  async serve(
    @Param('path') path: string | string[],
    @Res() res: Response,
    @Query('expires') expires?: string,
    @Query('signature') signature?: string,
  ): Promise<void> {
    this.assertEnabled();
    const key = Array.isArray(path) ? path.join('/') : path;

    if (key.startsWith('private/')) {
      const ok =
        Boolean(expires && signature) &&
        verifyLocalToken(
          { method: 'GET', key, contentType: '', expires: Number(expires) },
          signature!,
          this.config.secret,
        );
      if (!ok) throw new ForbiddenException('This object needs a signed link');
    } else if (!key.startsWith('public/')) {
      throw new NotFoundException();
    }

    const target = this.resolveReadable(key);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();

    const extension = key.split('.').pop()?.toLowerCase() ?? '';
    res.setHeader('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    // Private objects must not sit in a shared cache; public ones are immutable
    // (every upload mints a fresh UUID key), so they can be cached hard.
    res.setHeader(
      'Cache-Control',
      key.startsWith('private/') ? 'private, no-store' : 'public, max-age=31536000, immutable',
    );
    // The bytes came from an upload we did not inspect, so refuse to let a
    // browser sniff its way to executing one.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    await pipeline(createReadStream(target), res);
  }

  @Public()
  @Head('*path')
  async exists(@Param('path') path: string | string[], @Res() res: Response): Promise<void> {
    this.assertEnabled();
    const key = Array.isArray(path) ? path.join('/') : path;
    if (!key.startsWith('public/')) throw new NotFoundException();
    const info = await stat(this.resolveReadable(key)).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();
    res.setHeader('Content-Length', info.size);
    res.status(200).end();
  }
}
