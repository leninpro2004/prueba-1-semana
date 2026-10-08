import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { EmptyRow } from '../../components/Pagination';
import DuplicarReceta from './DuplicarReceta';

/**
 * CU-102 (D37): módulo de recetas. Una receta es la plantilla de insumos de un tipo
 * de puerta; la OT la carga como consumo estimado y desde ahí se ajusta.
 * Versiones = duplicar. No se borran: se desactivan (ya no se vende) y se reactivan.
 */

const ddmmaaaa = (v) => (v ? new Date(v).toLocaleDateString('es-CL') : '—');

export default function RecetaLista() {
  usePageTitle('Recetas');
  const { user } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { alert, showAlert } = useAlert();
  const puedeEditar = ['gerencia', 'jop'].includes(user?.rol);

  const [recetas, setRecetas] = useState(null);
  const [verInactivas, setVerInactivas] = useState(false);
  const [duplicando, setDuplicando] = useState(null);   // receta que se está duplicando
  const [recarga, setRecarga] = useState(0);            // se incrementa para volver a consultar
  const cargar = () => setRecarga(n => n + 1);

  useEffect(() => {
    let cancelado = false;
    API.recetas.listar({ incluir_inactivos: verInactivas ? 'true' : null })
      .then(r => { if (!cancelado) setRecetas(Array.isArray(r) ? r : []); })
      .catch(err => {
        if (cancelado) return;
        showAlert('danger', 'Error cargando las recetas: ' + err.message);
        setRecetas([]);
      });
    return () => { cancelado = true; };
  }, [verInactivas, recarga, showAlert]);

  const cambiarEstado = async (r) => {
    const activar = !r.activo;
    const ok = await confirm(
      activar
        ? `¿Reactivar la receta "${r.nombre}"? Volverá a ofrecerse para cargar en las órdenes de trabajo.`
        : `¿Desactivar la receta "${r.nombre}"? Dejará de ofrecerse en las órdenes de trabajo. No se borra: puede reactivarla cuando quiera.`,
      activar ? 'Reactivar receta' : 'Desactivar receta'
    );
    if (!ok) return;
    try {
      const resp = await API.recetas.cambiarEstado(r.id, activar);
      showAlert('success', resp?.message);
      cargar();
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  const lista = recetas || [];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Recetas</div>
          <div className="page-subtitle">
            Plantillas de insumos por tipo de puerta. La orden de trabajo las carga como consumo estimado y desde ahí se ajustan.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/ordenes" className="btn btn-ghost">← Órdenes de trabajo</Link>
          {puedeEditar && <Link to="/recetas/nueva" className="btn btn-primary" id="btn-nueva-receta">+ Nueva receta</Link>}
        </div>
      </div>

      <Alert {...alert} />

      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={verInactivas} onChange={e => setVerInactivas(e.target.checked)} />
          Ver también las recetas inactivas (reemplazadas o que ya no se venden)
        </label>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Código</th><th>Receta</th><th>Tipo</th>
                <th style={{ textAlign: 'right' }}>Insumos</th><th>Creada</th><th>Estado</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {recetas === null && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
              {recetas !== null && lista.length === 0 && (
                <EmptyRow colSpan={7} emptyMsg={puedeEditar ? 'No hay recetas. Cree la primera con "Nueva receta".' : 'No hay recetas registradas.'} />
              )}
              {lista.map(r => (
                <tr key={r.id} style={r.activo ? undefined : { opacity: 0.7 }}>
                  <td><span className="td-mono">{r.codigo || '—'}</span></td>
                  <td><Link to={`/recetas/${r.id}`} style={{ fontWeight: 500 }}>{r.nombre}</Link></td>
                  <td style={{ fontSize: 12, color: 'var(--gray)' }}>{r.tipo || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.total_materiales}</td>
                  <td style={{ fontSize: 12 }}>{ddmmaaaa(r.fecha_creacion)}</td>
                  <td>
                    {r.activo
                      ? <span className="badge badge-success">Activa</span>
                      : r.reemplazada_por_id
                        ? <span className="badge badge-gray">Reemplazada por <Link to={`/recetas/${r.reemplazada_por_id}`}>{r.reemplazada_por_nombre}</Link></span>
                        : <span className="badge badge-gray">Inactiva</span>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/recetas/${r.id}`)}>
                      {puedeEditar && r.activo ? 'Ver / editar' : 'Ver'}
                    </button>
                    {puedeEditar && <button className="btn btn-ghost btn-sm" onClick={() => setDuplicando(r)}>Duplicar</button>}
                    {puedeEditar && (
                      <button className="btn btn-ghost btn-sm" onClick={() => cambiarEstado(r)}>
                        {r.activo ? 'Desactivar' : 'Reactivar'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {duplicando && (
        <DuplicarReceta receta={duplicando} onCerrar={() => setDuplicando(null)}
          onDuplicada={(resp) => { setDuplicando(null); navigate(`/recetas/${resp.id}`, { state: { mensaje: resp.message } }); }} />
      )}
    </>
  );
}
