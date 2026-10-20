import { describe, expect, it } from 'vitest';
import { skusFor } from './sku';

// 72 characters. The API refused this with sizes S and M:
// 409 SKU "HANDWOVEN-KENTE-STOLE-FOR-GRADUATION-AND-WEDDINGS-BONWIRE-WEAVER"
// already exists for this product.
const LONG = 'Handwoven Kente Stole for Graduation and Weddings, Bonwire Weavers Guild';

describe('skusFor', () => {
  it('gives each size of a long-titled listing its own code', () => {
    const skus = skusFor(LONG, ['S', 'M', 'L']);
    expect(new Set(skus).size).toBe(3);
    for (const sku of skus) expect(sku.length).toBeLessThanOrEqual(64);
    expect(skus[0]).toMatch(/-S$/);
    expect(skus[1]).toMatch(/-M$/);
  });

  it('reads the same as before for a title that fits', () => {
    expect(skusFor('Ankara Wrap Dress · Adinkra print', ['M', 'default'])).toEqual([
      'ANKARA-WRAP-DRESS-ADINKRA-PRINT-M',
      'ANKARA-WRAP-DRESS-ADINKRA-PRINT-DEFAULT',
    ]);
  });

  it('numbers values that slug to the same code', () => {
    // "Red/Blue" and "Red Blue" are different to the seller, equal as a slug;
    // a value with no Latin letters or digits slugs to nothing at all.
    expect(skusFor('Wrap', ['Red/Blue', 'Red Blue'])).toEqual(['WRAP-RED-BLUE', 'WRAP-RED-BLUE-2']);
    expect(skusFor('Wrap', ['ɔ', '大'])).toEqual(['WRAP-OPTION', 'WRAP-OPTION-2']);
  });

  it('steers clear of the codes a product already has', () => {
    expect(skusFor('Wrap', ['XL'], ['WRAP-XL'])).toEqual(['WRAP-XL-2']);
    expect(skusFor(LONG, ['XL'], skusFor(LONG, ['XL']))[0]).toMatch(/-XL-2$/);
  });

  it('never ends up empty, or with a dash where the title was cut', () => {
    expect(skusFor('', ['M'])).toEqual(['ITEM-M']);
    const cutAtSpace = 'A'.repeat(61) + ' B';
    const [sku] = skusFor(cutAtSpace, ['M']);
    expect(sku).not.toMatch(/--/);
    expect(sku!.length).toBeLessThanOrEqual(64);
  });
});
