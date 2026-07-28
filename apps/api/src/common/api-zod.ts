import { applyDecorators } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Attaches an OpenAPI request-body schema derived from a Zod schema.
 *
 * Request bodies are validated by Zod *inside* the domain services, so the
 * controllers type them as `unknown`. This decorator makes the live Swagger UI
 * (`/docs`) and the published `docs/api/openapi.json` document the exact shape a
 * client must send, without changing how validation works. Schemas are inlined
 * (no `$ref`) against the OpenAPI-3 target so each operation renders standalone.
 */
// zod-to-json-schema's generic return type can blow tsc's instantiation depth
// (TS2589) when called with a plain ZodTypeAny. We only need a plain schema
// object here, so call through a simply-typed alias.
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  options?: { target?: 'openApi3'; $refStrategy?: 'none' },
) => SchemaObject;

export function ApiZodBody(schema: ZodTypeAny, description?: string) {
  const jsonSchema = toJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
  return applyDecorators(ApiBody({ schema: jsonSchema, description }));
}
