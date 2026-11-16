import { NavLink, Outlet } from 'react-router-dom';
import { CHANGE_PASSWORD_PATH } from '../pages/change-password';
import { useAuth } from '@installment/web-kit';
import { Button, cn } from '@installment/ui';
import {
  Activity,
  Banknote,
  BookCheck,
  Briefcase,
  Building2,
  ClipboardList,
  IdCard,
  FolderTree,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Package,
  PhoneCall,
  Receipt,
  ShieldAlert,
  ShoppingBag,
  Undo2,
  Store,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/applications', label: 'Applications', icon: ClipboardList },
  { to: '/plans', label: 'Plan operations', icon: Banknote },
  { to: '/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/refunds', label: 'Refunds', icon: Undo2 },
  { to: '/collections', label: 'Collections', icon: PhoneCall },
  { to: '/merchants', label: 'Merchants', icon: Store },
  { to: '/catalogue/stores', label: 'Shops', icon: Building2 },
  { to: '/catalogue/products', label: 'Listings', icon: Package },
  { to: '/catalogue/categories', label: 'Categories', icon: FolderTree },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/employers', label: 'Employers', icon: Briefcase },
  { to: '/employment-checks', label: 'Employment checks', icon: IdCard },
  { to: '/templates', label: 'Plan templates', icon: Receipt },
  { to: '/scoring', label: 'Scoring', icon: ShieldAlert },
  { to: '/telco-health', label: 'Telco health', icon: Activity },
  { to: '/ledger', label: 'Ledger', icon: BookCheck },
  { to: '/staff', label: 'Staff and roles', icon: UserCog },
];

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
    isActive
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );

export function AppShell() {
  const { logout, session } = useAuth();
  // On a temporary password nothing else would load, so nothing else is offered.
  const nav = session?.mustChangePassword ? [] : NAV;

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5 font-semibold text-primary">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <ShieldAlert className="size-4" />
          </span>
          Admin Console
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/'} className={navLinkClass}>
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t border-border p-3">
          <NavLink to={CHANGE_PASSWORD_PATH} className={navLinkClass}>
            <KeyRound className="size-4" />
            Change password
          </NavLink>
          <Button variant="ghost" className="w-full justify-start" onClick={logout}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
          <span className="font-semibold text-primary">Admin Console</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <NavLink to={CHANGE_PASSWORD_PATH} aria-label="Change password">
                <KeyRound className="size-4" />
              </NavLink>
            </Button>
            <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
