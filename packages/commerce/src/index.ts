// @installment/commerce — the e-commerce layer (catalog, storefront) that sits
// on top of the installment engine (@installment/core). One-way dependency:
// commerce imports engine seams; the engine never imports commerce.

export * from './permissions';

// Stores
export * from './modules/stores/dto';
export * from './modules/stores/errors';
export * from './modules/stores/stores.service';

// Catalog: categories, products, variants, images, inventory, plan offers
export * from './modules/catalog/dto';
export * from './modules/catalog/products.dto';
export * from './modules/catalog/errors';
export * from './modules/catalog/categories.service';
export * from './modules/catalog/products.service';
export * from './modules/catalog/inventory.service';

// Orders: cart + addresses + checkout/orders (with the engine hand-off)
export * from './modules/orders/dto';
export * from './modules/orders/errors';
export * from './modules/orders/order-state';
export * from './modules/orders/addresses.service';
export * from './modules/orders/cart.service';
export * from './modules/orders/orders.service';
