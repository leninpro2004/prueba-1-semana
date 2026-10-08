import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { ESTADO_DESPACHO, estadoDespacho, fechaCorta, ventaCancelada } from './formatoInstalacion';

/**
 * CU-120: pedidos de instalación. Una fila por venta de Finanzas aprobada o en proceso
 * (más las que ya tienen insumos vinculados, cualquiera sea su estado ahora).
 * Sesión 15 (punto 26): pestañas Activos / Historial, búsqueda, filtro por estado y paginación.
 *  - Historial = ya despachados ("En tránsito"), cancelados, o ventas que quedaron con vinculación pero ya
 *    no están aprobadas ni en proceso. D51: el pedido de una venta CANCELADA que todavía no se cancela sigue en
 *    Activos: gerencia tiene que liberar sus reservas.
 */

const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// <button> para usarse con teclado, sin el borde ni el fondo del navegador (la clase .tab da el resto)
const estiloTab = (activa) => ({ border: 'none', font: 'inherit', background: activa ? undefined : 'transparent' });
/** D51: venta cancelada con el pedido todavía abierto (sus reservas siguen activas). */
const porCancelar = (v) => ventaCancelada(v.estado_pedido) && ['vinculado', 'preparado', 'en_carga'].includes(v.estado_despacho);
const esHistorial = (v) => ['en_transito', 'cancelado'].includes(v.estado_despacho)
  || (!v.vinculable && v.estado_despacho !== 'sin_vincular' && !porCancelar(v));

export default function PedidosInstalacion() {
  usePageTitle('Pedidos de instalación');
  const { alert, showAlert } = useAlert();
  const [ventas, setVentas] = useState(null);
  const [pestana, setPestana] = useState('activos');
  const [buscar, setBuscar] = useState('');
  const [estado, setEstado] = useState('');

  useEffect(() => {
    let cancelado = false;
    API.pedidosVenta.listar()
      .then(v => { if (!cancelado) setVentas(Array.isArray(v) ? v : []); })
      .catch(err => { if (!cancelado) { setVentas([]); showAlert('danger', 'Error cargando los pedidos: ' + err.message); } });
    return () => { cancelado = true; };
  }, [showAlert]);

  const activos = useMemo(() => (ventas || []).filter(v => !esHistorial(v)), [ventas]);
  const historial = useMemo(() => (ventas || []).filter(esHistorial), [ventas]);

  const filtradas = useMemo(() => {
    const q = normalizar(buscar).trim();
    return (pestana === 'activos' ? activos : historial).filter(v =>
      (!estado || v.estado_despacho === estado) &&
      (!q || normalizar(v.numero).includes(q) || normalizar(v.cliente).includes(q)));
  }, [pestana, activos, historial, buscar, estado]);
  const pag = usePagination(filtradas, 20);

  // Los estados que tienen sentido en cada pestaña
  const estadosPestana = pestana === 'activos'
    ? ['sin_vincular', 'vinculado', 'preparado', 'en_carga']
    : ['en_transito', 'cancelado', 'vinculado', 'preparado', 'en_carga'];
  const cambiarPestana = (p) => { setPestana(p); setEstado(''); };
  const hayFiltros = !!(buscar.trim() || estado);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Pedidos de instalación</div>
          <div className="page-subtitle">Insumos que viajan a terreno con cada venta: vinculación y despacho (CU-120)</div>
        </div>
        <Link to="/instalacion/trazabilidad" className="btn btn-secondary">Trazabilidad</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div className="tabs" style={{ marginBottom: 12 }}>
        <button type="button" id="tab-activos" className={'tab' + (pestana === 'activos' ? ' active' : '')} style={estiloTab(pestana === 'activos')} onClick={() => cambiarPestana('activos')}>
          Activos{ventas !== null && ` (${activos.length})`}
        </button>
        <button type="button" id="tab-historial" className={'tab' + (pestana === 'historial' ? ' active' : '')} style={estiloTab(pestana === 'historial')} onClick={() => cambiarPestana('historial')}>
          Historial{ventas !== null && ` (${historial.length})`}
        </button>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <input className="form-control" id="buscar-pedido" style={{ maxWidth: 320 }} placeholder="Buscar por número de venta o cliente…"
            value={buscar} onChange={e => setBuscar(e.target.value)} />
          <select className="form-control" id="filtro-estado" style={{ width: 'auto' }} value={estado} onChange={e => setEstado(e.target.value)}>
            <option value="">Todos los estados</option>
            {estadosPestana.map(k => <option key={k} value={k}>{ESTADO_DESPACHO[k].texto}</option>)}
          </select>
          {hayFiltros && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setBuscar(''); setEstado(''); }}>Limpiar filtros</button>}
        </div>
        <div className="table-wrap">
          <table id="tabla-pedidos-instalacion">
            <thead>
              <tr>
                <th>Venta</th><th>Cliente</th><th>Estado de la venta</th><th>Entrega</th>
                <th style={{ textAlign: 'right' }}>Puertas con instalación</th><th>Despacho</th><th>Insumos</th><th />
              </tr>
            </thead>
            <tbody>
              {ventas === null ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--gray)' }}>Cargando…</td></tr>
              ) : pag.items.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--gray)' }}>
                  {hayFiltros ? 'Ningún pedido coincide con los filtros.'
                    : pestana === 'activos' ? 'No hay ventas aprobadas ni en proceso por despachar.' : 'Todavía no hay pedidos despachados.'}
                </td></tr>
              ) : pag.items.map(v => {
                const e = estadoDespacho(v.estado_despacho);
                return (
                  <tr key={v.id}>
                    <td className="td-mono">{v.numero}</td>
                    <td>{v.cliente || '—'}</td>
                    <td>
                      {v.estado_pedido}
                      {porCancelar(v)
                        ? <span className="badge badge-danger" style={{ marginLeft: 6 }}>liberar reservas</span>
                        : !v.vinculable && v.estado_despacho !== 'cancelado' && <span className="badge badge-warning" style={{ marginLeft: 6 }}>no se modifica</span>}
                    </td>
                    <td>{fechaCorta(v.fecha_max_entrega)}</td>
                    <td style={{ textAlign: 'right' }}>{v.puertas_instalacion || '—'}</td>
                    <td><span className={'badge ' + e.badge}>{e.texto}</span></td>
                    <td>
                      {v.items ? `${v.items} insumo(s)` : '—'}
                      {v.faltantes > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{v.faltantes} con faltante</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link to={`/instalacion/${v.id}`}>{v.estado_despacho === 'sin_vincular' && v.vinculable ? 'Vincular' : 'Ver'}</Link>
                      {pestana === 'historial' && (
                        <> · <Link to={`/instalacion/trazabilidad?q=${encodeURIComponent(v.numero)}`}>Trazabilidad</Link></>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>
    </>
  );
}
