import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { CHANGE_PASSWORD_PATH } from '../pages/change-password';

/**
 * Signed-in pages. Someone on a temporary password is held on the
 * change-password page: the API would refuse everything else anyway, and a
 * console full of "missing permission" errors explains nothing.
 */
export function ProtectedRoute() {
  const { isAuthenticated, session } = useAuth();
  const { pathname } = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (session?.mustChangePassword && pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }
  return <Outlet />;
}
