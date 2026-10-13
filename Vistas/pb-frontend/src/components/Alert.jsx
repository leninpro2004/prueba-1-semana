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
 * <Alert type="danger|success|warning|info" message="..." onClose={fn} />
 * Reemplaza el markup que generaba showAlert(). `message` puede ser string o JSX.
 * B-07: con `onClose` muestra una × para cerrarlo (sin ella, un error quedaba fijo en la pantalla).
 */
export default function Alert({ type = 'info', message, style, onClose }) {
  if (!message) return null;
  return (
    <div className={`alert alert-${type}`} style={{ display: 'flex', alignItems: 'center', gap: 8, ...style }}>
      {ICONS[type] || null}
      <span style={{ flex: 1 }}>{message}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Cerrar aviso" title="Cerrar aviso"
          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px', opacity: 0.7, alignSelf: 'flex-start' }}>
          ×
        </button>
      )}
    </div>
  );
}

/**
 * B-07: aviso fijo de una pantalla (informativo, validación o error de un modal) que se puede cerrar.
 * Reemplaza a <div className="alert …"> conservando su clase, estilo y contenido. Vuelve a aparecer al
 * volver a la pantalla, cuando la condición que lo muestra desaparece y se repite, o cuando cambia su texto
 * (otro error, otra cantidad): recuerda el texto que se cerró, no solo que se cerró.
 */
function textoDe(children) {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textoDe).join('');
  return '';
}

export function AvisoCerrable({ className = 'alert alert-info', style, children, ...resto }) {
  const [cerradoCon, setCerradoCon] = useState(null);   // texto del aviso cuando se cerró
  const texto = textoDe(children);
  if (cerradoCon === texto) return null;
  return (
    <div className={className} style={{ position: 'relative', paddingRight: 32, ...style }} {...resto}>
      {children}
      <button type="button" onClick={() => setCerradoCon(texto)} aria-label="Cerrar aviso" title="Cerrar aviso"
        style={{ position: 'absolute', top: 6, right: 8, background: 'none', border: 'none', color: 'inherit',
                 cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px', opacity: 0.7 }}>
        ×
      </button>
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

  // B-07: el aviso trae su onClose, así todo <Alert {...alert} /> se puede cerrar con la ×
  return { alert: alert ? { ...alert, onClose: clearAlert } : {}, showAlert, clearAlert };
}
