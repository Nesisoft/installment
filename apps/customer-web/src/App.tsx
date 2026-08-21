import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { ProtectedRoute } from './components/protected-route';
import { AppShell } from './components/app-shell';
import { LoginPage } from './pages/login';
import { ShopPage } from './pages/shop';
import { ProductPage } from './pages/product';
import { CartPage } from './pages/cart';
import { CheckoutPage } from './pages/checkout';
import { OrderDetailPage, OrdersPage } from './pages/orders';
import { PlanDetailPage, PlansPage } from './pages/plans';

export function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />

      <Route element={<AppShell />}>
        {/* Public storefront — browsing must not require an account. */}
        <Route path="/" element={<ShopPage />} />
        <Route path="/products/:id" element={<ProductPage />} />

        {/* Everything tied to a customer identity. */}
        <Route element={<ProtectedRoute />}>
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/plans/:id" element={<PlanDetailPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
