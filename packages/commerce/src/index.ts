// @installment/commerce — the e-commerce layer (catalog, storefront) that sits
// on top of the installment engine (@installment/core). One-way dependency:
// commerce imports engine seams; the engine never imports commerce.

export * from './permissions';

// Stores
export * from './modules/stores/dto';
export * from './modules/stores/provision-store';
export * from './modules/stores/errors';
export * from './modules/stores/stores.service';

// Catalog: categories, products, variants, images, inventory, plan offers
export * from './modules/catalog/dto';
export * from './modules/catalog/products.dto';
export * from './modules/catalog/errors';
export * from './modules/catalog/categories.service';
export * from './modules/catalog/products.service';
export * from './modules/catalog/inventory.service';
export * from './modules/catalog/media';
export * from './modules/catalog/storefront.dto';
export * from './modules/catalog/storefront.service';
export * from './modules/fulfilment/dto';
export * from './modules/fulfilment/fulfilment.service';
export * from './modules/orders/checkout-decision.service';
export * from './modules/orders/seller-fees';
export * from './modules/shopper/errors';
export * from './modules/shopper/wishlist.service';
export * from './modules/shopper/reviews.service';
// Push devices moved to @installment/core: they are a notifications concern and
// the push sender lives there, and a merchant handset has nothing to do with
// the shopper module it used to sit in. Re-exported so importers that only
// wanted the shopper surface keep compiling.
export {
  DevicesService,
  registerDeviceSchema,
  type PushDevice,
  type RegisterDeviceInput,
  type DeviceOwner,
} from '@installment/core';

// Returns: sending an order back, and the decision on it
export {
  ReturnsService,
  type OrderReturn,
  type ReturnActor,
  type ReturnDecisionNotifier,
  type ReturnRefundRecorder,
  type ReturnScope,
} from './modules/returns/returns.service';
export * from './modules/returns/dto';
export * from './modules/returns/errors';
export {
  MerchantReturnsService,
  MERCHANT_RETURN_BUCKETS,
  type MerchantReturnBucket,
  type MerchantReturnCounts,
  type MerchantReturnDetail,
  type MerchantReturnRow,
} from './modules/returns/merchant-returns.service';
export {
  CustomerReturnsService,
  CUSTOMER_RETURN_BUCKETS,
  type CustomerReturnBucket,
  type CustomerReturnCounts,
  type CustomerReturnRow,
} from './modules/returns/customer-returns.service';

// Analytics: the merchant's own trading figures
export {
  MerchantStatsService,
  MERCHANT_STATS_WINDOWS,
  merchantStatsQuerySchema,
  type MerchantStats,
  type MerchantStatsByPaymentType,
  type MerchantStatsChange,
  type MerchantStatsDay,
  type MerchantStatsPaymentMix,
  type MerchantStatsPeriod,
  type MerchantStatsQuery,
  type MerchantStatsWindow,
} from './modules/analytics/merchant-stats.service';

// Orders: cart + addresses + checkout/orders (with the engine hand-off)
export * from './modules/orders/dto';
export * from './modules/orders/errors';
export * from './modules/orders/order-state';
export * from './modules/orders/addresses.service';
export * from './modules/orders/order-payment.service';
export * from './modules/orders/cart.service';
export * from './modules/orders/orders.service';
export * from './modules/orders/merchant-orders.service';
export * from './modules/orders/admin-orders.service';
export * from './modules/orders/merchant-plans.service';
