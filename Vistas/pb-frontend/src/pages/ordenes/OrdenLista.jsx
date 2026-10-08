import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { ocultaMontos } from '../../utils/user';

const badgeEstado = (e) => e === 'cancelada' ? 'badge-ghost'
  : e === 'cerrada' || e === 'finalizada' || e === 'completada' ? 'badge-success'
  : e === 'en_curso' ? 'badge-warning' : 'badge-gray';

/** Órdenes de Trabajo — conversión 1:1 de ordenes/lista.html. data-rol="gerencia": enlace Costos. */
export default function OrdenLista() {
  usePageTitle('Órdenes de Trabajo');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const verCostos = !ocultaMontos(user);

  const [estado, setEstado] = useState('');
  const [buscar, setBuscar] = useState('');
  const [ots, setOts] = useState(null);

  const cargar = useCallback(async () => {
    try {
      const data = await API.ordenesTrabajo.listar({ estado, buscar: buscar.trim() });
      if (data?.error) { showAlert('danger', data.error); return; }
      const lista = Array.isArray(data) ? data : [];
      setOts(lista);
      // CU-130 CP3: Si hay OTs canceladas, sugerir regenerar el reporte semanal
      const canceladas = lista.filter(o => o.estado === 'cancelada');
      if (canceladas.length > 0) {
        showAlert('warning', <>⚠ Hay {canceladas.length} orden(es) de trabajo cancelada(s). Los datos del cronograma semanal pueden estar desactualizados. <Link to="/reportes/programacion" style={{ fontWeight: 600, textDecoration: 'underline' }}>Regenerar reporte semanal</Link></>);
      }
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [estado, buscar, showAlert]);

  // Carga inicial y al cambiar el select de estado; el buscador requiere Enter o el botón "Filtrar"
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [estado]);

  const pag = usePagination(ots, 20);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Órdenes de Trabajo</div>
          <div className="page-subtitle">Consumos, estimados y costos por orden</div>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label">Estado</label>
            <select className="form-control" id="filter-estado" value={estado} onChange={e => setEstado(e.target.value)}>
              <option value="">Todos</option>
              <option value="pendiente">Pendiente</option>
              <option value="en_curso">En curso</option>
              <option value="finalizada">Finalizada</option>
              <option value="cancelada">Cancelada</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 200 }}>
            <label className="form-label">Buscar (código o nombre proyecto)</label>
            <input className="form-control" id="filter-buscar" placeholder="Buscar…" value={buscar} onChange={e => setBuscar(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') cargar(); }} />
          </div>
          <button className="btn btn-primary" id="btn-filtrar" onClick={cargar}>Filtrar</button>
        </div>
      </div>

      {/* Tabla */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>OT</th><th>Fecha</th><th>Proyecto</th><th>Área</th><th>Responsable</th><th>Estado</th>
                <th style={{ textAlign: 'center' }}>Materiales</th>
                <th style={{ textAlign: 'center' }}>Con estimado</th>
                <th style={{ textAlign: 'center' }}>Con real</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {ots === null && <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando…</td></tr>}
              {ots !== null && ots.length === 0 && <EmptyRow colSpan={10} emptyMsg="No se encontraron órdenes de trabajo" />}
              {pag.items.map(o => (
                <tr key={o.id}>
                  <td><Link to={`/ordenes/${o.id}`}>#{o.id}</Link></td>
                  <td>{new Date(o.fecha).toLocaleDateString('sv-SE')}</td>
                  <td>{o.proyecto_codigo || ''} {o.proyecto_nombre || '—'}</td>
                  <td>{o.area || '—'}</td>
                  <td>{o.responsable || '—'}</td>
                  <td><span className={`badge ${badgeEstado(o.estado)}`}>{o.estado}</span></td>
                  <td style={{ textAlign: 'center' }}>{o.total_materiales}</td>
                  <td style={{ textAlign: 'center' }}>{o.con_estimado}</td>
                  <td style={{ textAlign: 'center' }}>{o.con_real}</td>
                  <td>
                    <Link to={`/ordenes/${o.id}`} className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }}>Detalle</Link>
                    {verCostos && <Link to={`/ordenes/${o.id}/costos`} className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }}>Costos</Link>}
                    {o.estado === 'cancelada' && <> <span style={{ fontSize: 11, color: 'var(--warning)' }} title="Reporte semanal puede estar desactualizado">⚠ Regenerar reporte</span></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>
    </>
  );
}
