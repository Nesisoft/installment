import { useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
} from '@installment/ui';
import type { Category, UpdateCategoryInput } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { useCategories, useCreateCategory, useUpdateCategory } from '../../lib/catalogue-api';
import { PageHeader } from '../../components/page-header';
import { ErrorState, LoadingState } from '../../components/data-states';

/** "Phones & Tablets" → "phones-tablets": what the API's slug rule accepts. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const byPlace = (a: Category, b: Category) =>
  a.position - b.position || a.name.localeCompare(b.name);

interface Node {
  category: Category;
  depth: number;
}

/**
 * The taxonomy flattened into display order: each category followed by its
 * subcategories. Anything not reachable from a top-level category — a parent
 * that no longer exists — is listed after, at the top level, rather than lost.
 */
function flatten(all: Category[]): Node[] {
  const children = new Map<string | null, Category[]>();
  for (const c of all) {
    const list = children.get(c.parent_id) ?? [];
    list.push(c);
    children.set(c.parent_id, list);
  }
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const c of (children.get(parent) ?? []).sort(byPlace)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ category: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const c of [...all].sort(byPlace)) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push({ category: c, depth: 0 });
      walk(c.id, 1);
    }
  }
  return out;
}

/** The ids of a category and everything filed beneath it: not valid as its parent. */
function selfAndBelow(all: Category[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

export function CategoriesPage() {
  const categories = useCategories();
  const [editing, setEditing] = useState<string | null>(null);
  const nodes = useMemo(() => flatten(categories.data ?? []), [categories.data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Categories"
        description="What buyers browse by, and what a seller picks when they list something or sign up."
      />

      {categories.isPending ? (
        <LoadingState />
      ) : categories.isError ? (
        <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />
      ) : (
        <>
          <NewCategoryCard all={categories.data} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">All categories</CardTitle>
              <CardDescription>
                Turning one off hides it from the storefront&apos;s category rail and from seller
                signup. Listings already filed under it stay on sale. Categories are never deleted,
                so old listings keep their place.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {nodes.length === 0 ? (
                <p className="px-6 pb-6 text-sm text-muted-foreground">No categories yet.</p>
              ) : (
                <ul className="divide-y divide-border border-t border-border">
                  {nodes.map(({ category, depth }) =>
                    editing === category.id ? (
                      <li key={category.id} className="bg-muted/40 px-6 py-4">
                        <EditCategoryForm
                          category={category}
                          all={categories.data}
                          onDone={() => setEditing(null)}
                        />
                      </li>
                    ) : (
                      <CategoryRow
                        key={category.id}
                        category={category}
                        depth={depth}
                        onEdit={() => setEditing(category.id)}
                      />
                    ),
                  )}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function CategoryRow({
  category,
  depth,
  onEdit,
}: {
  category: Category;
  depth: number;
  onEdit: () => void;
}) {
  const update = useUpdateCategory();
  return (
    <li className="flex flex-wrap items-center gap-3 px-6 py-3">
      <div className="min-w-0 flex-1" style={{ paddingLeft: `${depth * 1.5}rem` }}>
        <div className={category.is_active ? 'font-medium' : 'font-medium text-muted-foreground'}>
          {depth > 0 ? <span className="mr-1 text-muted-foreground">↳</span> : null}
          {category.name}
        </div>
        <div className="text-xs text-muted-foreground">
          {category.slug} · position {category.position}
        </div>
      </div>
      {category.is_active ? null : <StatusBadge status="inactive" label="Off" />}
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={update.isPending}
        onClick={() =>
          update.mutate({ id: category.id, input: { is_active: !category.is_active } })
        }
      >
        {category.is_active ? 'Turn off' : 'Turn on'}
      </Button>
      {update.isError ? (
        <p className="w-full text-sm text-destructive">{apiErrorMessage(update.error)}</p>
      ) : null}
    </li>
  );
}

function ParentSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: Node[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">None — a top-level category</option>
      {options.map(({ category, depth }) => (
        <option key={category.id} value={category.id}>
          {'  '.repeat(depth)}
          {category.name}
          {category.is_active ? '' : ' (off)'}
        </option>
      ))}
    </select>
  );
}

function NewCategoryCard({ all }: { all: Category[] }) {
  const create = useCreateCategory();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [parentId, setParentId] = useState('');
  const [position, setPosition] = useState('0');
  const options = useMemo(() => flatten(all), [all]);
  const effectiveSlug = slugTouched ? slug : slugify(name);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        slug: effectiveSlug,
        position: Number(position) || 0,
        ...(parentId ? { parent_id: parentId } : {}),
      },
      {
        onSuccess: () => {
          setName('');
          setSlug('');
          setSlugTouched(false);
          setPosition('0');
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New category</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <div className="space-y-2 lg:col-span-1">
            <Label htmlFor="new-cat-name">Name</Label>
            <Input
              id="new-cat-name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-cat-slug">Address</Label>
            <Input
              id="new-cat-slug"
              required
              maxLength={80}
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-cat-parent">Filed under</Label>
            <ParentSelect
              id="new-cat-parent"
              value={parentId}
              options={options}
              onChange={setParentId}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-cat-position">Position</Label>
            <Input
              id="new-cat-position"
              type="number"
              min={0}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={create.isPending || !name.trim() || !effectiveSlug}>
            {create.isPending ? 'Adding…' : 'Add category'}
          </Button>
        </form>
        {create.isError ? (
          <p className="mt-3 text-sm text-destructive">{apiErrorMessage(create.error)}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EditCategoryForm({
  category,
  all,
  onDone,
}: {
  category: Category;
  all: Category[];
  onDone: () => void;
}) {
  const update = useUpdateCategory();
  const [name, setName] = useState(category.name);
  const [slug, setSlug] = useState(category.slug);
  const [parentId, setParentId] = useState(category.parent_id ?? '');
  const [position, setPosition] = useState(String(category.position));
  // A category cannot go beneath itself; the API refuses it, so do not offer it.
  const options = useMemo(() => {
    const blocked = selfAndBelow(all, category.id);
    return flatten(all).filter((n) => !blocked.has(n.category.id));
  }, [all, category.id]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input: UpdateCategoryInput = {};
    if (name.trim() !== category.name) input.name = name.trim();
    if (slug.trim() !== category.slug) input.slug = slug.trim();
    if ((parentId || null) !== category.parent_id) input.parent_id = parentId || null;
    if ((Number(position) || 0) !== category.position) input.position = Number(position) || 0;
    if (Object.keys(input).length === 0) return onDone();
    update.mutate({ id: category.id, input }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor={`cat-${category.id}-name`}>Name</Label>
          <Input
            id={`cat-${category.id}-name`}
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`cat-${category.id}-slug`}>Address</Label>
          <Input
            id={`cat-${category.id}-slug`}
            required
            maxLength={80}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`cat-${category.id}-parent`}>Filed under</Label>
          <ParentSelect
            id={`cat-${category.id}-parent`}
            value={parentId}
            options={options}
            onChange={setParentId}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`cat-${category.id}-position`}>Position</Label>
          <Input
            id={`cat-${category.id}-position`}
            type="number"
            min={0}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
        </div>
      </div>
      {slug.trim() !== category.slug ? (
        <p className="text-sm text-warning-foreground">
          Changing the address breaks any link or saved filter that uses “{category.slug}”.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {update.isError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(update.error)}</p>
      ) : null}
    </form>
  );
}
