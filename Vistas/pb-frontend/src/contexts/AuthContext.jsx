import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setUnauthorizedHandler } from '../services/api';
import { getStoredUser, setStoredUser, TEMP_PASS_KEY } from '../utils/session';

export const AuthContext = createContext(null);

/**
 * AuthProvider — reemplaza la lectura de sessionStorage.pb_user que hacía layout.js
 * en cada página. Debe montarse DENTRO de <BrowserRouter> (usa useNavigate).
 */
export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(() => getStoredUser());

  /** Login exitoso: misma estructura que guardaba login.html */
  const login = useCallback((data, passVal) => {
    const u = {
      ...data.user,
      token: data.token,
      requiere_cambio_password: data.requiere_cambio_password || false,
    };
    setStoredUser(u);
    // CU-84 CP3: Si la contraseña es temporal, guardarla para el cambio obligatorio en el dashboard
    if (data.requiere_cambio_password) {
      sessionStorage.setItem(TEMP_PASS_KEY, passVal);
    }
    setUser(u);
  }, []);

  const logout = useCallback((reason) => {
    sessionStorage.removeItem('pb_token');
    setStoredUser(null);
    setUser(null);
    navigate(reason ? `/login?reason=${reason}` : '/login');
  }, [navigate]);

  /** Actualiza campos del usuario y persiste (apodo, flag de cambio de contraseña). */
  const updateUser = useCallback((patch) => {
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      Object.keys(next).forEach(k => { if (next[k] === undefined) delete next[k]; });
      setStoredUser(next);
      return next;
    });
  }, []);

  // 401 en apiFetch: limpiar sesión y navegar al login usando el router
  useEffect(() => {
    setUnauthorizedHandler((detalle) => {
      setUser(null);
      // OPUS-8: si el backend corto por cuenta desactivada, el login lo explica
      navigate(detalle?.codigo === 'CUENTA_DESACTIVADA' ? '/login?reason=cuenta_desactivada' : '/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const value = useMemo(() => ({ user, login, logout, updateUser }), [user, login, logout, updateUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
