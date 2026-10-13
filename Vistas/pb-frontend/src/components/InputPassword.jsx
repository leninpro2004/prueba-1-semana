import { useState } from 'react';

const OJO = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);
const OJO_TACHADO = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18">
    <path d="M17.94 17.94A10.07 10.07 0 0112 19c-7 0-11-7-11-7a18.45 18.45 0 015.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 7 11 7a18.5 18.5 0 01-2.16 3.19"/>
    <path d="M14.12 14.12a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

/**
 * B-12: campo de contraseña con un ojo para mostrarla u ocultarla.
 * Recibe las mismas props que un <input> (id, value, onChange, style, autoFocus, disabled…).
 * El botón no entra en el orden de Tab: se sigue pasando de un campo al siguiente como antes.
 */
export default function InputPassword({ className = 'form-control', style, ...props }) {
  const [visible, setVisible] = useState(false);
  const etiqueta = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
  return (
    <div style={{ position: 'relative' }}>
      <input {...props} className={className} type={visible ? 'text' : 'password'} style={{ paddingRight: 38, ...style }} />
      <button type="button" tabIndex={-1} onClick={() => setVisible(v => !v)} aria-label={etiqueta} title={etiqueta}
        disabled={props.disabled}
        style={{ position: 'absolute', top: '50%', right: 8, transform: 'translateY(-50%)', display: 'flex',
                 background: 'none', border: 'none', padding: 2, color: 'var(--gray)', cursor: 'pointer' }}>
        {visible ? OJO_TACHADO : OJO}
      </button>
    </div>
  );
}
