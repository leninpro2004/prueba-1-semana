import { useEffect, useState } from 'react';
import { API } from '../../services/api';

/**
 * CU-102 Exc 2: crear una receta nueva a partir de otra ("nueva versión conservando
 * la anterior"). Con "reemplaza", la original queda inactiva y apunta a la nueva.
 * D37: el código es obligatorio; se propone la siguiente versión libre (<código>-V<n>),
 * y tanto el código como el nombre se pueden modificar.
 */
export default function DuplicarReceta({ receta, onCerrar, onDuplicada }) {
  const [nombre, setNombre] = useState('');
  const [codigo, setCodigo] = useState('');
  const [reemplaza, setReemplaza] = useState(Boolean(receta.activo));
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [cargando, setCargando] = useState(true);

  // Sugerencia del backend: revisa los códigos de todas las recetas, activas e inactivas
  useEffect(() => {
    let cancelado = false;
    API.recetas.sugerenciaDuplicado(receta.id)
      .then(s => { if (!cancelado) { setNombre(s.nombre || ''); setCodigo(s.codigo || ''); } })
      .catch(() => { if (!cancelado) setNombre(`${receta.nombre} v2`); })
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [receta.id, receta.nombre]);

  const duplicar = async (e) => {
    e.preventDefault();
    if (!nombre.trim()) { setError('Indique el nombre de la nueva receta.'); return; }
    if (!codigo.trim()) { setError('Indique el código de la nueva receta.'); return; }
    setEnviando(true);
    setError('');
    try {
      const resp = await API.recetas.duplicar(receta.id, { nombre: nombre.trim(), codigo: codigo.trim(), reemplaza });
      if (resp?.error) { setError(resp.error); return; }   // 409: código repetido (apiFetch no lo lanza)
      onDuplicada(resp);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="modal-overlay" style={{ display: 'flex' }}>
      <form className="modal" style={{ maxWidth: 520 }} onSubmit={duplicar}>
        <div className="modal-header">
          <div className="modal-title">Duplicar receta</div>
          <button type="button" className="modal-close" onClick={onCerrar}>×</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, marginTop: 0 }}>
            Se crea una receta nueva con los mismos insumos (cantidades, merma y área) que <strong>{receta.nombre}</strong>.
            Después puede ajustarla libremente durante 24 horas.
          </p>
          <div className="form-group">
            <label className="form-label">Código de la nueva receta *</label>
            <input className="form-control" value={codigo} onChange={e => setCodigo(e.target.value.toUpperCase())}
              maxLength={80} disabled={cargando} placeholder={cargando ? 'Calculando…' : 'Ej: PB-ABC-V2'} />
            <div style={{ fontSize: 11, color: 'var(--gray)', marginTop: 2 }}>Se propone la siguiente versión libre; puede cambiarlo.</div>
          </div>
          <div className="form-group">
            <label className="form-label">Nombre de la nueva receta *</label>
            <input className="form-control" value={nombre} onChange={e => setNombre(e.target.value)} maxLength={200} disabled={cargando} />
          </div>
          {receta.activo && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={reemplaza} onChange={e => setReemplaza(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                <strong>La nueva reemplaza a la original</strong> (nueva versión).
                <span style={{ display: 'block', color: 'var(--gray)', fontSize: 12 }}>
                  La original queda inactiva, se conserva y dirá "Reemplazada por…". Desmárquelo si quiere dos variantes activas.
                </span>
              </span>
            </label>
          )}
          {error && <div className="alert alert-danger" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px' }}>
          <button type="button" className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={enviando || cargando}>{enviando ? 'Duplicando…' : 'Duplicar'}</button>
        </div>
      </form>
    </div>
  );
}
