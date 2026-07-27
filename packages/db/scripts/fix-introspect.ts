import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Post-processes the drizzle-kit introspect output.
 *
 * drizzle-kit cannot parse some PostgreSQL types (e.g. `citext`, `tsvector`):
 * for each it emits `unknown("col")` (an undefined identifier) preceded by a
 * `// TODO: failed to parse database type '<type>'` comment. We rewrite each
 * such column to the matching local custom type (packages/db/src/<type>.ts) so
 * the generated schema compiles, drop the TODO comment, and add the import.
 *
 * The rewrite is type-aware — it reads the type name out of each TODO comment
 * rather than assuming every `unknown(` is the same type.
 */
const schemaPath = resolve(__dirname, '../drizzle/_introspect/schema.ts');

// DB type named in the TODO comment → local custom-type factory (which is also
// its module basename under ../../src/). Extend as new unparsed types appear.
const TYPE_MAP: Record<string, string> = {
  citext: 'citext',
  tsvector: 'tsvector',
};

const todoRe = /^\s*\/\/ TODO: failed to parse database type '([a-z_]+)'\s*$/;

const original = readFileSync(schemaPath, 'utf8');
const out: string[] = [];
const used = new Set<string>();
let pending: string | undefined;

for (const line of original.split('\n')) {
  const todo = line.match(todoRe);
  if (todo && TYPE_MAP[todo[1]]) {
    pending = TYPE_MAP[todo[1]]; // drop this comment line; rewrite the next column
    continue;
  }
  if (pending && line.includes('unknown(')) {
    out.push(line.replace(/\bunknown\(/g, `${pending}(`));
    used.add(pending);
    pending = undefined;
    continue;
  }
  pending = undefined;
  out.push(line);
}

if (used.size === 0) {
  console.log('[fix-introspect] no unknown() columns — nothing to fix');
} else {
  const imports = [...used]
    .sort()
    .map((t) => `import { ${t} } from "../../src/${t}";`)
    .filter((line) => !original.includes(line));
  const lastImportIdx = out.reduce(
    (acc, line, idx) => (line.startsWith('import ') ? idx : acc),
    -1,
  );
  out.splice(lastImportIdx + 1, 0, ...imports);
  writeFileSync(schemaPath, out.join('\n'), 'utf8');
  console.log(
    `[fix-introspect] rewrote ${[...used].sort().join(', ')} column(s) and added imports`,
  );
}
