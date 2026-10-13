import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

/** Equivale al chequeo de layout.js: sin sesión → login */
export default function ProtectedRoute() {
  const { user, cargando, logoutReason } = useAuth();
  // B-01: mientras /auth/me responde no se pinta el layout (ni menús de un rol supuesto)
  if (cargando) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--gray)' }}>Cargando…</div>;
  }
  // Con el motivo del cierre: esta redireccion gana al navigate de logout y el login debe mostrarlo
  if (!user) return <Navigate to={logoutReason ? `/login?reason=${logoutReason}` : '/login'} replace />;
  return <Outlet />;
}
