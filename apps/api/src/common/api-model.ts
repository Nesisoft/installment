import { applyDecorators } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';

/**
 * Documents an endpoint's success response as one of the domain component
 * schemas registered in openapi.ts (e.g. 'Merchant', 'ProductDetails'). The
 * `$ref` resolves against those components in the emitted spec.
 *
 * - `array: true`  → the response is a list of the model.
 * - `created: true` → use the 201 response (for @HttpCode(201) creates).
 */
export function ApiModel(
  ref: string,
  opts: { array?: boolean; created?: boolean } = {},
): MethodDecorator & ClassDecorator {
  const item = { $ref: `#/components/schemas/${ref}` };
  const schema = opts.array ? { type: 'array' as const, items: item } : item;
  const response = opts.created ? ApiCreatedResponse : ApiOkResponse;
  return applyDecorators(response({ schema }));
}
