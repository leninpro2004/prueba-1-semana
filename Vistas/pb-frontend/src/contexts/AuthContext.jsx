import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API, setUnauthorizedHandler } from '../services/api';
import { getToken, setToken, TEMP_PASS_KEY } from '../utils/session';
import { getApodo, setApodo } from '../utils/user';

export const AuthContext = createContext(null);

/**
 * AuthProvider — reemplaza la lectura de sessionStorage.pb_user que hacía layout.js
 * en cada página. Debe montarse DENTRO de <BrowserRouter> (usa useNavigate).
 *
 * B-01: el usuario vive en memoria y sale del backend (/auth/me al cargar la app, la
 * respuesta del login al entrar). El navegador solo guarda el token. `cargando` es true
 * mientras se consulta /auth/me: ProtectedRoute no pinta el layout hasta saber quién es.
 */
export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [cargando, setCargando] = useState(() => !!getToken());
  // Motivo del ultimo cierre: ProtectedRoute lo usa al redirigir, porque su Navigate gana al de logout
  const [logoutReason, setLogoutReason] = useState(null);

  /** Usuario de la sesión según el backend, con el apodo local (B-05). */
  const recargarUsuario = useCallback(async () => {
    try {
      const me = await API.auth.me(); // null si respondió 401 (apiFetch ya limpió la sesión)
      setUser(me ? { ...me, apodo: getApodo(me.id) } : null);
    } catch {
      // Red caída o backend reiniciando: se mantiene lo que había
    }
  }, []);

  // Al cargar la app (o con F5): si hay token, preguntar quién es
  useEffect(() => {
    if (!getToken()) return undefined;
    let vigente = true;
    API.auth.me()
      .then(me => { if (vigente) setUser(me ? { ...me, apodo: getApodo(me.id) } : null); })
      .catch(() => { /* red caída: ProtectedRoute manda al login */ })
      .finally(() => { if (vigente) setCargando(false); });
    return () => { vigente = false; };
  }, []);

  /** Login exitoso */
  const login = useCallback((data, passVal) => {
    setLogoutReason(null);
    setToken(data.token);
    // CU-84 CP3: Si la contraseña es temporal, guardarla para el cambio obligatorio en el dashboard
    if (data.requiere_cambio_password) {
      sessionStorage.setItem(TEMP_PASS_KEY, passVal);
    }
    setUser({
      ...data.user,
      apodo: getApodo(data.user.id),
      requiere_cambio_password: data.requiere_cambio_password || false,
    });
  }, []);

  const logout = useCallback((reason) => {
    setToken(null);
    setLogoutReason(reason || null);
    setUser(null);
    navigate(reason ? `/login?reason=${reason}` : '/login');
  }, [navigate]);

  /** Actualiza campos del usuario en memoria (flag de cambio de contraseña, apodo). */
  const updateUser = useCallback((patch) => {
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      Object.keys(next).forEach(k => { if (next[k] === undefined) delete next[k]; });
      // B-05: el apodo se guarda en el navegador, por usuario (D81)
      if ('apodo' in patch) setApodo(prev.id, patch.apodo);
      return next;
    });
  }, []);

  // 401 en apiFetch: limpiar sesión y navegar al login usando el router
  useEffect(() => {
    setUnauthorizedHandler((detalle) => {
      // OPUS-8: si el backend corto por cuenta desactivada, el login lo explica
      const reason = detalle?.codigo === 'CUENTA_DESACTIVADA' ? 'cuenta_desactivada' : null;
      setLogoutReason(reason);
      setUser(null);
      navigate(reason ? `/login?reason=${reason}` : '/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const value = useMemo(
    () => ({ user, cargando, logoutReason, login, logout, updateUser, recargarUsuario }),
    [user, cargando, logoutReason, login, logout, updateUser, recargarUsuario],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
