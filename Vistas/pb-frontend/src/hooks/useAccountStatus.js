import { useEffect, useRef } from 'react';
import { API } from '../services/api';
import { useAuth } from './useAuth';

const POLL_MS = 60 * 1000; // 60s

/**
 * OPUS-8: cierre de sesión en vivo.
 *
 * Consulta /api/auth/session-status cada 60 segundos. Si la cuenta dejó de estar
 * activa —porque un administrador la desactivó o porque venció su desactivación
 * programada— se cierra la sesión sin esperar a que el usuario haga clic en algo.
 *
 * El backend también corta por su cuenta: el authMiddleware responde 401 con
 * codigo CUENTA_DESACTIVADA en el siguiente request. Este polling es lo que hace
 * que el cierre ocurra aunque el usuario tenga la pantalla quieta.
 */
export function useAccountStatus() {
  const { user, logout } = useAuth();
  const cerrando = useRef(false);

  useEffect(() => {
    if (!user) return undefined;

    const revisar = async () => {
      if (cerrando.current) return;
      try {
        const estado = await API.auth.sessionStatus();
        // apiFetch devuelve null cuando el backend respondió 401 (ya limpió la sesión)
        if (estado && estado.activo === false) {
          cerrando.current = true;
          logout('cuenta_desactivada');
        }
      } catch (err) {
        // Un 401 por cuenta desactivada llega aquí como error con su código
        if (err?.payload?.codigo === 'CUENTA_DESACTIVADA') {
          cerrando.current = true;
          logout('cuenta_desactivada');
        }
        // Cualquier otro error (red caída, backend reiniciando) se ignora:
        // no tiene sentido desloguear a alguien porque falló un ping.
      }
    };

    const id = setInterval(revisar, POLL_MS);
    revisar(); // primera comprobación al montar
    return () => clearInterval(id);
  }, [user, logout]);
}
