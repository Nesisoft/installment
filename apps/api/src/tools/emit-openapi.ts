import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { buildOpenApiDocument } from '../openapi';

/**
 * Boots the Nest application without listening, serialises its OpenAPI document
 * to docs/api/openapi.json, and exits. That file is the input to
 * @installment/api-types' type generation and the versioned contract for
 * partner integrators. Run against a reachable Postgres + Redis (providers
 * connect on construction); it never opens an HTTP port.
 *
 * `pnpm --filter @installment/api openapi:emit` (after build).
 */
const OUT = resolve(__dirname, '../../../../docs/api/openapi.json');

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = buildOpenApiDocument(app);
  await app.close();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
  const paths = Object.keys(document.paths ?? {}).length;
  console.log(`[openapi] wrote ${OUT} (${paths} paths)`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
