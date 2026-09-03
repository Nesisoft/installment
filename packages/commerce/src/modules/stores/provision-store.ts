import { randomBytes } from 'node:crypto';
import type { StoreActor, StoresService } from './stores.service';

/**
 * The shopfront a newly signed-up merchant starts with.
 *
 * It exists so that self-signup produces something a seller can immediately
 * work on: a `draft` store they can name, brand and fill with products, none of
 * which is visible or purchasable until an admin activates them.
 *
 * The slug is derived here rather than chosen by the person signing up. Two
 * reasons, and the second is the important one:
 *
 *   - It is immutable to the merchant afterwards (see `updateMyStoreSchema`),
 *     because it is the public URL and renaming it breaks every link and QR
 *     code already in circulation. Asking a stranger to pick a permanent URL in
 *     the middle of a signup form is a bad moment to make that decision.
 *   - Letting anyone claim an arbitrary slug at signup is how `melcom`, `mtn`
 *     and `ecobank` get squatted before anybody notices. Deriving it from the
 *     name they gave means a squatter has to at least trade under the name.
 *
 * An admin can still change a slug during review, which is the right place for
 * the judgement call that "kentekente" should really be "kente-kente".
 */

/** `Auntie Akos' Kente & Beads!` → `auntie-akos-kente-beads`. */
export function slugifyShopName(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Strip accents, so "Créperie" and "Creperie" do not become different shops.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // 80 is the slug column's ceiling; trim to 60 so a collision suffix fits.
    .slice(0, 60)
    .replace(/-+$/g, '');
  // A name with no latin characters at all — "布料店" — still needs an address.
  return slug || 'shop';
}

export interface ProvisionStoreInput {
  merchantId: string;
  shopName: string;
  /** What the shop mainly sells, if they said. A top-level category slug. */
  categorySlug?: string;
}

/**
 * Creates the store, retrying the slug on collision.
 *
 * Collisions are resolved by suffixing rather than by asking, because signup is
 * the wrong place to hand somebody a "that name is taken" dead end — two real
 * shops called "City Electronics" both deserve an account. The suffix is random
 * rather than a counter so it takes no extra query and leaks no count of how
 * many shops share a name.
 */
export async function provisionStore(
  stores: StoresService,
  input: ProvisionStoreInput,
  actor: StoreActor,
  attempts = 5,
): Promise<void> {
  const base = slugifyShopName(input.shopName);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    try {
      await stores.create(
        {
          merchant_id: input.merchantId,
          slug,
          display_name: input.shopName,
          ...(input.categorySlug ? { primary_category_slug: input.categorySlug } : {}),
        },
        actor,
      );
      return;
    } catch (err) {
      // StoreConflictError covers both a taken slug and "this merchant already
      // has a store". The second is not worth retrying — and it means signup is
      // being replayed, which is fine: they already have their shopfront.
      if (!isSlugTaken(err)) throw err;
    }
  }
  throw new Error(`could not find a free slug for "${input.shopName}" after ${attempts} attempts`);
}

function isSlugTaken(err: unknown): boolean {
  return err instanceof Error && /slug .* is already taken/i.test(err.message);
}
