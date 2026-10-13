import { useEffect, useRef, useState } from 'react';
import { API, setFirmaHandler } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { AvisoCerrable } from './Alert';
import InputPassword from './InputPassword';

/**
 * F-11: modal "Autorización de gerencia". apiFetch lo abre cuando el backend responde 428
 * (acción sensible sin firma) y, con el token que devuelve, repite la misma petición.
 * Firma cualquier gerente: si la sesión es de gerencia, el usuario viene precargado.
 * Se monta una sola vez en App.
 */
export default function FirmaGerencia() {
  const { user } = useAuth();
  const [pendiente, setPendiente] = useState(null);   // { datos: { requiere_firma, descripcion }, resolver }
  const [username, setUsername] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState('');
  const [bloqueado, setBloqueado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const usuarioSesion = useRef('');
  useEffect(() => {
    usuarioSesion.current = user?.rol === 'gerencia' ? user.username || '' : '';
  }, [user]);

  useEffect(() => {
    setFirmaHandler((datos) => new Promise((resolver) => {
      setUsername(usuarioSesion.current);
      setClave('');
      setError('');
      setBloqueado(false);
      // Si ya había una firma pendiente (dos acciones a la vez), la anterior se cancela
      setPendiente(prev => { prev?.resolver(null); return { datos, resolver }; });
    }));
    return () => setFirmaHandler(null);
  }, []);

  if (!pendiente) return null;

  const cerrar = (firma) => {
    pendiente.resolver(firma);
    setPendiente(null);
  };

  const enviar = async (e) => {
    e.preventDefault();
    if (!username.trim() || !clave || enviando) return;
    setEnviando(true);
    setError('');
    try {
      const r = await API.auth.firmar(username.trim(), clave, pendiente.datos.requiere_firma);
      if (!r) return;   // 401: la sesión expiró y apiFetch ya lleva al login
      if (r.error) { setError(r.error); return; }
      cerrar(r.autorizacion);
    } catch (err) {
      // 403: contraseña incorrecta o no es gerente · 423: bloqueo de 15 minutos
      setClave('');
      if (err.status === 423) setBloqueado(true);
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="modal-backdrop show" style={{ zIndex: 2000 }}>
      <form className="modal" onSubmit={enviar}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Autorización de gerencia</div>
            <div className="modal-subtitle">Acción sensible</div>
          </div>
          <button type="button" className="modal-close" onClick={() => cerrar(null)}>&#x2715;</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>
            Para <strong>{pendiente.datos.descripcion}</strong> se necesita que un gerente ingrese su usuario y contraseña.
          </p>
          <div className="form-group">
            <label className="form-label" htmlFor="firma-usuario">Usuario del gerente</label>
            <input className="form-control" id="firma-usuario" autoComplete="off" autoFocus={!username}
              value={username} onChange={e => setUsername(e.target.value)} disabled={enviando} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="firma-clave">Contraseña</label>
            <InputPassword className="form-control" id="firma-clave" autoComplete="off" autoFocus={!!username}
              value={clave} onChange={e => setClave(e.target.value)} disabled={bloqueado || enviando} />
          </div>
          {error && (
            <AvisoCerrable className={`alert ${bloqueado ? 'alert-danger' : 'alert-warning'}`} style={{ marginTop: 12, marginBottom: 0 }}>{error}</AvisoCerrable>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={() => cerrar(null)}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={!username.trim() || !clave || bloqueado || enviando}>
            {enviando ? 'Validando…' : 'Autorizar'}
          </button>
        </div>
      </form>
    </div>
  );
}
