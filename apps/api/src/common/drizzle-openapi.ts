import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Derives an OpenAPI schema for a domain read model straight from its Drizzle
 * table definition, so the published spec documents response shapes without a
 * hand-maintained (drift-prone) copy. Column types map to their JSON forms;
 * non-`NOT NULL` columns become `nullable`. Pass `omit` to drop internal or
 * sensitive columns (e.g. `search_tsv`, `password_hash`).
 */
interface DrizzleColumnLike {
  columnType: string;
  notNull: boolean;
  baseColumn?: DrizzleColumnLike;
}

function columnToSchema(col: DrizzleColumnLike): SchemaObject {
  let schema: SchemaObject;
  switch (col.columnType) {
    case 'PgUUID':
      schema = { type: 'string', format: 'uuid' };
      break;
    case 'PgTimestamp':
    case 'PgTimestampString':
      schema = { type: 'string', format: 'date-time' };
      break;
    case 'PgDate':
    case 'PgDateString':
      schema = { type: 'string', format: 'date' };
      break;
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgBigInt53':
      schema = { type: 'integer' };
      break;
    case 'PgBoolean':
      schema = { type: 'boolean' };
      break;
    case 'PgJson':
    case 'PgJsonb':
      schema = { type: 'object', additionalProperties: true };
      break;
    case 'PgArray':
      schema = { type: 'array', items: col.baseColumn ? columnToSchema(col.baseColumn) : {} };
      break;
    // PgText / PgVarchar / PgChar and custom columns (citext, …) → string.
    default:
      schema = { type: 'string' };
      break;
  }
  if (!col.notNull) schema.nullable = true;
  return schema;
}

export function drizzleSchema(table: PgTable, opts: { omit?: string[] } = {}): SchemaObject {
  const omit = new Set(opts.omit ?? []);
  const cols = getTableColumns(table) as Record<string, DrizzleColumnLike>;
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  for (const [name, col] of Object.entries(cols)) {
    if (omit.has(name)) continue;
    properties[name] = columnToSchema(col);
    if (col.notNull) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
