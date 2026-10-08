import { useCallback, useEffect, useRef, useState } from 'react';

/** Íconos SVG copiados de showAlert (layout.js). */
const ICONS = {
  danger: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="16" height="16">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  ),
};

/**
 * <Alert type="danger|success|warning|info" message="..." />
 * Reemplaza el markup que generaba showAlert(). `message` puede ser string o JSX.
 */
export default function Alert({ type = 'info', message, style }) {
  if (!message) return null;
  return (
    <div className={`alert alert-${type}`} style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
      {ICONS[type] || null}
      <span>{message}</span>
    </div>
  );
}

/**
 * useAlert() → { alert, showAlert(type, message), clearAlert }
 * Reemplaza showAlert(containerId, type, msg): auto-dismiss a los 5 s.
 * Uso: const { alert, showAlert } = useAlert(); ... <Alert {...alert} />
 */
export function useAlert() {
  const [alert, setAlert] = useState(null);
  const timerRef = useRef(null);

  const clearAlert = useCallback(() => {
    clearTimeout(timerRef.current);
    setAlert(null);
  }, []);

  const showAlert = useCallback((type, message) => {
    clearTimeout(timerRef.current);
    setAlert({ type, message });
    timerRef.current = setTimeout(() => setAlert(null), 5000);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { alert: alert || {}, showAlert, clearAlert };
}
