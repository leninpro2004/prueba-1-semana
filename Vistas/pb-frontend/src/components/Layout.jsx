import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import ChangePasswordModal from './ChangePasswordModal';
import { TitleProvider } from '../contexts/TitleContext';
import { useAuth } from '../hooks/useAuth';
import { useSessionTimer } from '../hooks/useSessionTimer';
import { useAccountStatus } from '../hooks/useAccountStatus';

/**
 * Layout — estructura común de cada página HTML (div.layout > sidebar + main-content > topbar + page-body).
 * Reemplaza a layout.js: modales de apodo/contraseña, hamburger móvil, timer de sesión.
 */
export default function Layout() {
  const { user, updateUser } = useAuth();
  const { warning, extend } = useSessionTimer();
  useAccountStatus(); // OPUS-8: cierra la sesión si desactivan la cuenta

  const [mobileOpen, setMobileOpen] = useState(false);
  const [apodoOpen, setApodoOpen] = useState(false);
  const [apodo, setApodo] = useState('');
  const [passOpen, setPassOpen] = useState(false);

  const openApodo = () => {
    setApodo(user?.username || user?.nombre || '');
    setApodoOpen(true);
  };

  const confirmApodo = () => {
    const val = apodo.trim();
    if (!val) return;
    updateUser({ username: val });
    setApodoOpen(false);
  };

  return (
    <TitleProvider>
      {/* CU-87/88: banner de inactividad */}
      {warning && (
        <div id="inactivity-warning" style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, padding: '12px 20px',
          background: '#FEF3CD', color: '#856404', textAlign: 'center', fontSize: 14, fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0,0,0,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        }}>
          <span>Su sesión se cerrará por inactividad en 5 minutos.</span>
          <button id="btn-extend-session" onClick={extend} style={{
            padding: '4px 14px', border: '1px solid #856404', borderRadius: 6,
            background: '#fff', color: '#856404', cursor: 'pointer', fontWeight: 600,
          }}>Continuar sesión</button>
        </div>
      )}

      <div className="layout">
        <Sidebar mobileOpen={mobileOpen} onOpenApodo={openApodo} onOpenPass={() => setPassOpen(true)} />
        <div
          className={'sidebar-overlay' + (mobileOpen ? ' show' : '')}
          id="sidebar-overlay"
          onClick={() => setMobileOpen(false)}
        />

        <div className="main-content">
          <Topbar onHamburger={() => setMobileOpen(o => !o)} />
          <main className="page-body">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Modal cambiar apodo */}
      {apodoOpen && (
        <div className="modal-backdrop" id="modal-apodo" style={{ display: 'flex' }}
          onClick={e => { if (e.target === e.currentTarget) setApodoOpen(false); }}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <div className="modal-title">Cambiar apodo</div>
              <button className="modal-close" id="close-modal-apodo" onClick={() => setApodoOpen(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Nuevo apodo</label>
                <input className="form-control" id="input-apodo" placeholder="ej: jgarcia" maxLength={50}
                  value={apodo} onChange={e => setApodo(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" id="cancel-modal-apodo" onClick={() => setApodoOpen(false)}>Cancelar</button>
              <button className="btn btn-primary" id="confirm-modal-apodo" onClick={confirmApodo}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal cambiar contraseña (+ forzado CU-84 CP3) */}
      <ChangePasswordModal open={passOpen} onClose={() => setPassOpen(false)} />
    </TitleProvider>
  );
}
