import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, CardContent } from '@installment/ui';
import { formatGhs } from '@installment/api-types';
import { apiErrorMessage } from '@installment/web-kit';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { useCart, useRemoveCartItem, useSetCartQuantity } from '../lib/shop-api';
import { variantLabel } from '../lib/variant-cache';
import { EmptyState, ErrorState, LoadingState } from '../components/data-states';

export function CartPage() {
  const navigate = useNavigate();
  const cart = useCart();
  const setQty = useSetCartQuantity();
  const removeItem = useRemoveCartItem();

  if (cart.isPending) return <LoadingState />;
  if (cart.isError) return <ErrorState error={cart.error} onRetry={() => void cart.refetch()} />;

  const items = cart.data?.items ?? [];
  const busy = setQty.isPending || removeItem.isPending;
  const mutationError = setQty.error ?? removeItem.error;

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Your cart</h1>
        <EmptyState
          message="Your cart is empty."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate('/')}>
              Start shopping
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Your cart</h1>

      {mutationError ? (
        <p className="text-sm text-destructive">{apiErrorMessage(mutationError)}</p>
      ) : null}

      <ul className="space-y-3">
        {items.map((item) => {
          const label = variantLabel(item.variant_id);
          return (
            <li key={item.id}>
              <Card>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {label ? (
                        <Link
                          to={`/products/${label.productId}`}
                          className="truncate text-sm font-medium hover:underline"
                        >
                          {label.title}
                        </Link>
                      ) : (
                        <p className="truncate text-sm font-medium">Item</p>
                      )}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatGhs(item.unit_price_pesewas)} each
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-semibold">
                      {formatGhs(item.unit_price_pesewas * item.quantity)}
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8"
                        aria-label="Decrease quantity"
                        disabled={busy}
                        onClick={() =>
                          setQty.mutate({
                            variantId: item.variant_id,
                            quantity: item.quantity - 1,
                          })
                        }
                      >
                        <Minus />
                      </Button>
                      <span className="w-6 text-center text-sm font-medium">{item.quantity}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8"
                        aria-label="Increase quantity"
                        disabled={busy}
                        onClick={() =>
                          setQty.mutate({
                            variantId: item.variant_id,
                            quantity: item.quantity + 1,
                          })
                        }
                      >
                        <Plus />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => removeItem.mutate(item.variant_id)}
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>

      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <span className="text-sm text-muted-foreground">Subtotal</span>
          <span className="text-lg font-semibold">
            {formatGhs(cart.data?.subtotal_pesewas ?? 0)}
          </span>
        </CardContent>
      </Card>

      <Button className="w-full" size="lg" onClick={() => navigate('/checkout')}>
        Checkout
      </Button>
    </div>
  );
}
