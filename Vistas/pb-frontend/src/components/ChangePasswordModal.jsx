import { useEffect, useState } from 'react';
import { API } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { useConfirm } from '../hooks/useDialog';
import { TEMP_PASS_KEY } from '../utils/session';

/**
 * Modal "Cambiar contraseña" (sidebar.html) + lógica de layout.js + pre-llenado de dashboard.html.
 *
 * CU-84 CP3: si user.requiere_cambio_password === true el modal se fuerza abierto:
 *  - sin X ni Cancelar, el backdrop no cierra (equivale al MutationObserver: `open` se deriva del flag)
 *  - aviso "Su contraseña es temporal..."
 *  - si existe pb_temp_pass, se pre-llena "contraseña actual" y se oculta ese campo
 *  - Enter en nueva/confirmar dispara Actualizar
 *  - al cambiar con éxito: borrar pb_temp_pass y quitar requiere_cambio_password de pb_user
 */
export default function ChangePasswordModal({ open, onClose }) {
  const { user, updateUser } = useAuth();
  const confirm = useConfirm();

  const forced = !!user?.requiere_cambio_password;
  const visible = forced || open;
  const tempPass = forced ? sessionStorage.getItem(TEMP_PASS_KEY) : null;

  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [confirmar, setConfirmar] = useState('');
  const [saving, setSaving] = useState(false);

  // Al abrir: limpiar campos (layout.js) y pre-llenar contraseña temporal (dashboard.html)
  useEffect(() => {
    if (!visible) return;
    setActual(tempPass || '');
    setNueva('');
    setConfirmar('');
  }, [visible, tempPass]);

  if (!visible) return null;

  const close = () => { if (!forced) onClose(); };

  const submit = async () => {
    if (saving) return;
    if (!actual)            { await confirm('Debe ingresar su contraseña actual.', 'Error'); return; }
    if (nueva.length < 8)   { await confirm('La contraseña debe tener al menos 8 caracteres.', 'Error'); return; }
    if (nueva !== confirmar) { await confirm('Las contraseñas no coinciden.', 'Error'); return; }
    setSaving(true);
    try {
      const resp = await API.auth.cambiarPassword(actual, nueva);
      if (resp?.error) {
        await confirm(resp.error, 'Error al cambiar contraseña');
        return;
      }
      // CU-84 CP3: limpiar flag y contraseña temporal tras cambio exitoso
      if (forced) {
        sessionStorage.removeItem(TEMP_PASS_KEY);
        updateUser({ requiere_cambio_password: undefined });
      }
      onClose();
      await confirm('Contraseña actualizada correctamente. Use su nueva contraseña en el próximo inicio de sesión.', 'Contraseña actualizada');
    } catch (err) {
      await confirm('Error: ' + err.message, 'Error al cambiar contraseña');
    } finally {
      setSaving(false);
    }
  };

  const onEnter = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  return (
    <div
      className="modal-backdrop"
      id="modal-cambiar-pass"
      style={{ display: 'flex' }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal" style={{ maxWidth: 380 }}>
        <div className="modal-header">
          <div className="modal-title">Cambiar contraseña</div>
          {!forced && (
            <button className="modal-close" id="close-modal-pass" onClick={close}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
        <div className="modal-body">
          {forced && (
            <div className="alert alert-warning alert-cambio-obligatorio" style={{ fontSize: 12, marginBottom: 12 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" style={{ verticalAlign: -2, marginRight: 4 }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Su contraseña es temporal. Debe cambiarla antes de continuar usando el sistema.
            </div>
          )}
          <div className="form-group" style={tempPass ? { display: 'none' } : undefined}>
            <label className="form-label">Contraseña actual</label>
            <input className="form-control" type="password" id="pass-actual" placeholder="••••••••"
              value={actual} onChange={e => setActual(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Nueva contraseña</label>
            <input className="form-control" type="password" id="pass-nueva" placeholder="Mínimo 8 caracteres"
              value={nueva} onChange={e => setNueva(e.target.value)} onKeyDown={forced ? onEnter : undefined} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Confirmar nueva contraseña</label>
            <input className="form-control" type="password" id="pass-confirmar" placeholder="Repite la contraseña"
              value={confirmar} onChange={e => setConfirmar(e.target.value)} onKeyDown={forced ? onEnter : undefined} />
          </div>
        </div>
        <div className="modal-footer">
          {!forced && (
            <button className="btn btn-ghost" id="cancel-modal-pass" onClick={close}>Cancelar</button>
          )}
          <button className="btn btn-primary" id="confirm-modal-pass" onClick={submit} disabled={saving}>Actualizar</button>
        </div>
      </div>
    </div>
  );
}
