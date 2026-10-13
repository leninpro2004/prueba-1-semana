/**
 * Helpers de sesión (sessionStorage).
 *
 * B-01: el navegador guarda SOLO el token. El usuario (nombre, rol) se pide a
 * /auth/me y vive en memoria (AuthContext), así que editarlo en DevTools no cambia
 * nada. pb_user era la clave antigua: se limpia si quedó de una sesión anterior.
 */
export const TOKEN_KEY     = 'pb_token';
export const USER_KEY      = 'pb_user';   // antigua (antes de B-01), solo para limpiarla
export const TEMP_PASS_KEY = 'pb_temp_pass';
export const OPS_KEY       = 'pb_ops_pendientes';
export const COLLAPSE_KEY  = 'pb_sidebar_collapsed';

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || null;
}

export function setToken(token) {
  sessionStorage.removeItem(USER_KEY);
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}
