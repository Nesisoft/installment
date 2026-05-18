import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Post-processes the drizzle-kit introspect output.
 *
 * drizzle-kit cannot parse PostgreSQL `citext` columns: it emits
 * `unknown("col")` (an undefined identifier) preceded by a
 * `// TODO: failed to parse database type 'citext'` comment. We rewrite those
 * to our local `citext` custom type so the generated schema compiles.
 */
const schemaPath = resolve(__dirname, '../drizzle/_introspect/schema.ts');

let src = readFileSync(schemaPath, 'utf8');

if (src.includes('unknown(')) {
  src = src.replace(/^[ \t]*\/\/ TODO: failed to parse database type 'citext'\r?\n/gm, '');
  src = src.replace(/\bunknown\(/g, 'citext(');

  const importLine = 'import { citext } from "../../src/citext";';
  if (!src.includes(importLine)) {
    const lines = src.split('\n');
    const lastImportIdx = lines.reduce(
      (acc, line, idx) => (line.startsWith('import ') ? idx : acc),
      -1,
    );
    lines.splice(lastImportIdx + 1, 0, importLine);
    src = lines.join('\n');
  }

  writeFileSync(schemaPath, src, 'utf8');
  console.log('[fix-introspect] rewrote citext columns and added import');
} else {
  console.log('[fix-introspect] no unknown() columns — nothing to fix');
}
