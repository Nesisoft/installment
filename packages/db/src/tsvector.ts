import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `tsvector` (full-text search vector). drizzle-kit's introspector
 * cannot parse the `tsvector` type, so generated columns are rewritten to use
 * this custom type by scripts/fix-introspect.ts. It is only ever a STORED
 * generated column, read through raw SQL (`@@ to_tsquery(...)`); JS code never
 * reads or writes the value directly.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});
