/**
 * Helpers de sesión (sessionStorage) — mismas claves que el frontend HTML.
 */
export const USER_KEY      = 'pb_user';
export const TEMP_PASS_KEY = 'pb_temp_pass';
export const OPS_KEY       = 'pb_ops_pendientes';
export const COLLAPSE_KEY  = 'pb_sidebar_collapsed';

export function getStoredUser() {
  try {
    return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  if (user) sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  else sessionStorage.removeItem(USER_KEY);
}

export function getToken() {
  return getStoredUser()?.token || null;
}
