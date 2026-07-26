import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { ProtectedRoute } from './components/protected-route';
import { AppShell } from './components/app-shell';
import { LoginPage } from './pages/login';
import { DashboardPage } from './pages/dashboard';
import { PlaceholderPage } from './pages/placeholder';

export function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/orders" element={<PlaceholderPage title="Orders" />} />
          <Route path="/settlements" element={<PlaceholderPage title="Settlements" />} />
          <Route path="/statements" element={<PlaceholderPage title="Statements" />} />
          <Route path="/templates" element={<PlaceholderPage title="Plan templates" />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
