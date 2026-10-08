import { useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useNotifications, obtenerDestinoNotif, formatearMensajeNotif } from '../hooks/useNotifications';
import { TitleContext } from '../contexts/TitleContext';
import { getInitials } from '../utils/user';

/**
 * Topbar — conversión de shared/topbar.html + campana de notificaciones (CU-45) de layout.js.
 */
export default function Topbar({ onHamburger }) {
  const { user } = useAuth();
  const { title } = useContext(TitleContext);
  const { noLeidas, lista, error, cargarLista, marcarTodas, navegar } = useNotifications();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const bellRef = useRef(null);

  // Cerrar dropdown al hacer clic fuera
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) && e.target !== bellRef.current) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next) cargarLista();
  };

  const onClickNotif = async (n) => {
    const destino = await navegar(n);
    if (destino) setOpen(false);
  };

  return (
    <header className="topbar">

      {/* Hamburger (mobile) */}
      <button className="topbar-hamburger" id="topbar-hamburger" aria-label="Abrir menú" onClick={onHamburger}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6"  x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>

      {/* Título dinámico */}
      <span className="topbar-title" id="topbar-title">{title}</span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Campana de notificaciones (CU-45) */}
        <div id="notif-bell" ref={bellRef} style={{ position: 'relative', cursor: 'pointer' }} title="Notificaciones" onClick={toggle}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="20" height="20" style={{ pointerEvents: 'none' }}>
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 01-3.46 0"/>
          </svg>
          <span id="notif-badge" style={{
            display: noLeidas > 0 ? 'block' : 'none', position: 'absolute', top: -4, right: -6,
            background: '#E53E3E', color: '#fff', fontSize: 10, fontWeight: 700, minWidth: 16, height: 16,
            borderRadius: 8, textAlign: 'center', lineHeight: '16px', padding: '0 4px', pointerEvents: 'none',
          }}>
            {noLeidas > 99 ? '99+' : noLeidas}
          </span>
        </div>

        {/* Avatar usuario */}
        <div className="topbar-avatar" id="topbar-avatar" title="Mi perfil">{getInitials(user)}</div>
      </div>

      {/* Dropdown notificaciones */}
      <div id="notif-dropdown" ref={dropdownRef} style={{
        display: open ? 'block' : 'none', position: 'fixed', top: 52, right: 16, width: 360, maxHeight: 420,
        background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,.12)', zIndex: 999, overflow: 'hidden',
      }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Notificaciones</span>
          <button id="notif-leer-todas" style={{ fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }} onClick={marcarTodas}>
            Marcar todas como leídas
          </button>
        </div>
        <div id="notif-list" style={{ overflowY: 'auto', maxHeight: 360, padding: 8 }}>
          {lista === null && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>Cargando…</div>
          )}
          {lista !== null && error && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-secondary)' }}>Error al cargar</div>
          )}
          {lista !== null && !error && lista.length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>Sin notificaciones</div>
          )}
          {lista !== null && !error && lista.map(n => {
            const esLeida = n.estado === 'leida';
            const fecha = new Date(n.fecha).toLocaleDateString('sv-SE');
            const destino = obtenerDestinoNotif(n);
            return (
              <div
                key={n.id}
                style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: esLeida ? 'transparent' : 'var(--bg-alt)' }}
                onClick={() => onClickNotif(n)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 13, fontWeight: esLeida ? 400 : 600, lineHeight: 1.4 }}>{formatearMensajeNotif(n)}</span>
                  {!esLeida && (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0, marginTop: 5, marginLeft: 8 }} />
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{n.tipo || 'sistema'} · {fecha}</div>
                {destino && <div style={{ fontSize: 10, color: 'var(--primary)', marginTop: 2 }}>Click para ir →</div>}
              </div>
            );
          })}
        </div>
      </div>

    </header>
  );
}
