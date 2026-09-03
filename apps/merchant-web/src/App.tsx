import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { ProtectedRoute } from './components/protected-route';
import { AppShell } from './components/app-shell';
import { LoginPage } from './pages/login';
import { SignupPage } from './pages/signup';
import { DashboardPage } from './pages/dashboard';
import { OrdersListPage } from './pages/orders/list';
import { OrderDetailPage } from './pages/orders/detail';
import { PlansListPage } from './pages/plans/list';
import { PlanDetailPage } from './pages/plans/detail';
import { ProductsListPage } from './pages/products/list';
import { NewProductPage } from './pages/products/new';
import { ProductDetailPage } from './pages/products/detail';
import { MorePage } from './pages/more';
import { StorePage } from './pages/store';
import { SettlementsPage } from './pages/settlements';
import { PayoutAccountPage } from './pages/payout-account';
import { StatementsPage } from './pages/statements';
import { PlanTemplatesPage } from './pages/plan-templates';

export function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/signup"
        element={isAuthenticated ? <Navigate to="/" replace /> : <SignupPage />}
      />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/orders" element={<OrdersListPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          <Route path="/plans" element={<PlansListPage />} />
          <Route path="/plans/:id" element={<PlanDetailPage />} />
          <Route path="/products" element={<ProductsListPage />} />
          {/* Before /products/:id, or "new" is read as a product id. */}
          <Route path="/products/new" element={<NewProductPage />} />
          <Route path="/products/:id" element={<ProductDetailPage />} />
          <Route path="/store" element={<StorePage />} />
          <Route path="/more" element={<MorePage />} />
          <Route path="/settlements" element={<SettlementsPage />} />
          <Route path="/payout-account" element={<PayoutAccountPage />} />
          <Route path="/statements" element={<StatementsPage />} />
          <Route path="/templates" element={<PlanTemplatesPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
