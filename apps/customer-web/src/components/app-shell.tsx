import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { Button, cn } from '@installment/ui';
import { CalendarClock, LogOut, Receipt, ShoppingBag, ShoppingCart, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCart } from '../lib/shop-api';

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
}

const TABS: Tab[] = [
  { to: '/', label: 'Shop', icon: ShoppingBag },
  { to: '/cart', label: 'Cart', icon: ShoppingCart },
  { to: '/orders', label: 'Orders', icon: Receipt },
  { to: '/plans', label: 'Plans', icon: CalendarClock },
];

/** Phone-shaped shell: sticky header, bottom tab bar, centred on larger screens. */
export function AppShell() {
  const { logout, isAuthenticated } = useAuth();
  const cart = useCart(isAuthenticated);
  const itemCount = (cart.data?.items ?? []).reduce((n, i) => n + i.quantity, 0);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-md items-center justify-between px-4">
          <div className="flex items-center gap-2 font-semibold text-primary">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Wallet className="size-4" />
            </span>
            Installment
          </div>
          {isAuthenticated ? (
            <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <a href="/login">Sign in</a>
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 pb-28 pt-5">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card">
        <div className="mx-auto grid max-w-md grid-cols-4">
          {TABS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center gap-1 py-2 text-[11px] font-medium transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                )
              }
            >
              <span className="relative">
                <Icon className="size-5" />
                {to === '/cart' && itemCount > 0 ? (
                  <span className="absolute -right-2 -top-1.5 grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {itemCount > 9 ? '9+' : itemCount}
                  </span>
                ) : null}
              </span>
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
