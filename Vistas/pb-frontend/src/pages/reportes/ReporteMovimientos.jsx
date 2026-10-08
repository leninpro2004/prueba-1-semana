import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { usePagination } from '../../hooks/usePagination';
import SelectorProducto from '../../components/SelectorProducto';
import { ocultaMontos } from '../../utils/user';

// Fechas LOCALES en formato AAAA-MM-DD. toISOString() da la fecha en UTC: entre las
// 21:00 y las 24:00 de Chile devolvia el dia siguiente.
const fechaLocal = (d) => d.toLocaleDateString('sv-SE');
const hoy = new Date();
const PRIMER_DIA = fechaLocal(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
const HOY = fechaLocal(hoy);

/**
 * CU-75: estado visible del movimiento, con las etiquetas del historial (CU-31, D28).
 * Solo los vigentes cuentan en los KPIs: los anulados (y sus inversos, D23), las
 * mermas pendientes y las rechazadas se listan pero no suman.
 */
function estadoMov(m) {
  if (m.revierte_a != null)              return { texto: `Reversión de #${m.revierte_a}`, badge: 'badge-gray', vigente: false };
  if (m.estado === 'revertido')          return { texto: 'Anulado por Reversión', badge: 'badge-gray', vigente: false };
  if (m.estado === 'pendiente_aprobacion') return { texto: 'Pendiente de aprobación', badge: 'badge-warning', vigente: false };
  if (m.estado === 'rechazado')          return { texto: 'Rechazado', badge: 'badge-danger', vigente: false };
  return { texto: 'Vigente', badge: 'badge-success', vigente: true };
}

const capitalizar = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Reporte de Movimientos — conversión 1:1 de reportes/movimientos.html.
 * data-rol="gerencia": enlace Valorización y botón Exportar (ocultos si rol === 'jop').
 * Columna "Precio unit." solo si rol === 'gerencia'.
 */
export default function ReporteMovimientos() {
  usePageTitle('Reporte Movimientos');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const esGerencia = user?.rol === 'gerencia';

  const [desde, setDesde] = useState(PRIMER_DIA);
  const [hasta, setHasta] = useState(HOY);
  const [tipo, setTipo] = useState('');
  const [tipos, setTipos] = useState([]);   // CU-75: desde el catálogo, no fijos
  const [sku, setSku] = useState('');
  const [materiales, setMateriales] = useState([]);
  // OPUS-9 (Req #1): filtrar el reporte por la OT que originó los movimientos
  const [otId, setOtId] = useState('');
  const [ordenes, setOrdenes] = useState([]);
  const [movs, setMovs] = useState(null); // null = estado vacío inicial
  const [rango, setRango] = useState({ desde: '', hasta: '' });
  const [generando, setGenerando] = useState(false);

  const generarReporte = useCallback(async () => {
    if (!desde || !hasta) { showAlert('danger', 'Selecciona un rango de fechas.'); return; }
    if (desde > hasta) {
      showAlert('danger', 'La fecha "Hasta" no puede ser anterior a la fecha "Desde".');
      setMovs(null);
      return;
    }
    // CU-77 CP3: Advertencia para rangos de fecha amplios
    const diffDias = Math.ceil((new Date(hasta) - new Date(desde)) / (1000 * 60 * 60 * 24));
    if (diffDias > 90) showAlert('warning', `El rango seleccionado abarca ${diffDias} días. Esto puede tardar más de lo habitual.`);

    setGenerando(true);
    try {
      const data = await API.reportes.movimientos({
        desde, hasta, tipo: tipo || null, buscar: sku || null, orden_trabajo_id: otId || null,
      });
      let lista = data?.movimientos || [];
      if (sku) lista = lista.filter(m => m.sku === sku);
      setMovs(lista);
      setRango({ desde, hasta });
    } catch (err) {
      showAlert('danger', 'Error generando reporte: ' + err.message);
    } finally {
      setGenerando(false);
    }
  }, [desde, hasta, tipo, sku, otId, showAlert]);

  // Al cargar (300 ms después, como el HTML): productos para el filtro y reporte con defaults
  // El ref se actualiza en un efecto y no durante el render: escribir un ref
  // mientras se renderiza rompe con el renderizado concurrente de React.
  const generarRef = useRef(generarReporte);
  useEffect(() => { generarRef.current = generarReporte; }, [generarReporte]);
  useEffect(() => {
    let cancelado = false;
    const t = setTimeout(async () => {
      try {
        const m = await API.materiales.listar();
        if (!cancelado) setMateriales(m || []);
      } catch (e) { console.warn('Error cargando productos para filtro:', e); }
      try {
        const o = await API.ordenesTrabajo.listar();
        if (!cancelado) setOrdenes(Array.isArray(o) ? o : (o?.ordenes || []));
      } catch (e) { console.warn('Error cargando OTs para filtro:', e); }
      try {
        const c = await API.movimientos.catalogos();
        if (!cancelado) setTipos(c?.tipos || []);
      } catch (e) { console.warn('Error cargando tipos de movimiento:', e); }
      if (!cancelado) generarRef.current();
    }, 300);
    return () => { cancelado = true; clearTimeout(t); };
  }, []);

  const pag = usePagination(movs, 20);
  const lista = movs || [];
  // CU-75: los KPIs cuentan solo vigentes; la tabla muestra todos con su estado
  const vigentes = lista.filter(m => estadoMov(m).vigente);
  const excluidos = lista.length - vigentes.length;
  const cnt = (t) => vigentes.filter(m => m.tipo?.toLowerCase().includes(t)).length;
  const traslados = vigentes.filter(m => m.tipo?.toLowerCase().includes('salida') &&
                                         m.clasificacion_salida?.toLowerCase().includes('traslado')).length;

  // SONNET-7: exportar CSV con los datos ya filtrados
  const exportar = () => {
    // CU-76: formato por columna (fecha-hora ISO 8601, cantidades con coma, CLP)
    const headers = ['ID', { titulo: 'Fecha y hora', formato: 'timestamp' }, 'Tipo', 'Estado', 'OT', 'SKU', 'Producto', 'Bodega',
                     { titulo: 'Cantidad', formato: 'numero' }, 'Clasificación'];
    if (esGerencia) headers.push({ titulo: 'Precio unitario', formato: 'clp' });
    headers.push('Usuario');
    const rows = lista.map(m => {
      const row = [
        m.id,
        m.fecha_hora || '',
        m.tipo || '',
        estadoMov(m).texto,
        // OPUS-9: OT que originó el movimiento (vacío si no viene de un consumo)
        m.orden_trabajo_id ? '#' + m.orden_trabajo_id : '',
        m.sku || '',
        m.material || '',
        m.bodega || '',
        parseFloat(m.cantidad || 0),
        m.clasificacion_salida || '',
      ];
      if (esGerencia) row.push(m.precio_unitario != null ? parseFloat(m.precio_unitario) : '');
      row.push(m.usuario || '');
      return row;
    });
    try { exportarCSV('movimientos', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Reporte de Movimientos</div>
          <div className="page-subtitle">Auditoría de entradas, salidas y traslados por período</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/mermas" className="btn btn-ghost">Mermas</Link>
          {!ocultaMontos(user) && <Link to="/reportes/valorizacion" className="btn btn-ghost">Valorización</Link>}
          <Link to="/reportes/consumo-area" className="btn btn-ghost">Consumo por área</Link>
          <Link to="/reportes/programacion" className="btn btn-ghost">Programación semanal</Link>
          {['gerencia', 'jop'].includes(user?.rol) && <Link to="/reportes/rotacion" className="btn btn-ghost">Rotación</Link>}
          {esGerencia && <Link to="/reportes/historico" className="btn btn-ghost">Histórico</Link>}
          {['gerencia', 'jop'].includes(user?.rol) && <Link to="/reportes/desviaciones" className="btn btn-ghost">Desviaciones</Link>}
          {user?.rol !== 'jop' && (
            <BotonExportar id="btn-exportar" onClick={exportar} filas={movs == null ? null : lista.length} />
          )}
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
          <div><label className="form-label" style={{ marginBottom: 4 }}>Desde</label><input className="form-control" type="date" id="filter-desde" style={{ width: 'auto' }} value={desde} onChange={e => setDesde(e.target.value)} /></div>
          <div><label className="form-label" style={{ marginBottom: 4 }}>Hasta</label><input className="form-control" type="date" id="filter-hasta" style={{ width: 'auto' }} value={hasta} onChange={e => setHasta(e.target.value)} /></div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Tipo</label>
            <select className="form-control" id="filter-tipo" style={{ width: 'auto' }} value={tipo} onChange={e => setTipo(e.target.value)}>
              <option value="">Todos</option>
              {tipos.map(t => <option key={t.id} value={t.nombre}>{capitalizar(t.nombre)}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Producto</label>
            <div style={{ minWidth: 260 }}><SelectorProducto id="filter-sku" vacio="Todos los productos" value={sku} onChange={setSku} opciones={materiales} /></div>
          </div>
          {/* OPUS-9 (Req #1): movimientos originados por una OT concreta */}
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Orden de trabajo</label>
            <select className="form-control" id="filter-ot" style={{ width: 'auto' }} value={otId} onChange={e => setOtId(e.target.value)}>
              <option value="">Todas las OT</option>
              {ordenes.map(o => (
                <option key={o.id} value={o.id}>#{o.id}{o.proyecto_codigo ? ' — ' + o.proyecto_codigo : ''}</option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: 'auto' }}>
            <button className="btn btn-primary btn-sm" id="btn-generar" onClick={generarReporte} disabled={generando}>{generando ? 'Generando...' : 'Generar reporte'}</button>
          </div>
        </div>
      </div>

      {movs !== null && (
        <>
          {/* KPIs resumen (CU-77 CP1: calculados desde los movimientos filtrados) */}
          <div className="kpi-grid" id="kpi-container" style={{ marginBottom: 24 }}>
            <div className="kpi-card"><div className="kpi-label">Movimientos vigentes</div><div className="kpi-value" id="kpi-total">{vigentes.length}</div><div className="kpi-sub">{excluidos > 0 ? `${excluidos} excluido(s): anulados, pendientes o rechazados` : 'En el período'}</div></div>
            <div className="kpi-card kpi-success"><div className="kpi-label">Entradas</div><div className="kpi-value" id="kpi-entradas" style={{ color: 'var(--success)' }}>{cnt('entrada')}</div><div className="kpi-sub">Ingresos de stock</div></div>
            <div className="kpi-card kpi-danger"><div className="kpi-label">Salidas</div><div className="kpi-value danger" id="kpi-salidas">{cnt('salida')}</div><div className="kpi-sub">Retiros de stock (incluye traslados)</div></div>
            <div className="kpi-card kpi-warning"><div className="kpi-label">Traslados</div><div className="kpi-value warning" id="kpi-traslados">{traslados}</div><div className="kpi-sub">Salidas con clasificación Traslado</div></div>
          </div>

          {/* Tabla resultado */}
          <div className="card" id="tabla-resultado">
            <div className="card-title" id="tabla-titulo">{lista.length} movimiento(s) entre {rango.desde} y {rango.hasta}</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ID</th><th>Fecha</th><th>Tipo</th><th>Estado</th><th>OT</th><th>Producto</th><th>Bodega</th><th>Cantidad</th><th>Clasificación</th>{esGerencia && <th id="th-precio">Precio unit.</th>}<th>Usuario</th></tr>
                </thead>
                <tbody id="tbody-reporte">
                  {lista.length === 0 && <EmptyRow colSpan={11} emptyMsg={<div className="empty-state"><p>Sin movimientos en este período.</p></div>} />}
                  {pag.items.map(m => {
                    const tl = (m.tipo || '').toLowerCase();
                    const cls = tl.includes('entrada') ? 'badge-success' : tl.includes('salida') ? 'badge-danger' : tl.includes('traslado') ? 'badge-orange' : 'badge-gray';
                    const signo = tl.includes('entrada') ? '+' : tl.includes('salida') ? '-' : '';
                    const est = estadoMov(m);
                    return (
                      <tr key={m.id} style={est.vigente ? undefined : { opacity: 0.65 }}>
                        <td><span className="td-mono" style={{ fontSize: 11 }}>{m.id}</span></td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.fecha_hora ? new Date(m.fecha_hora).toLocaleDateString('sv-SE') : '—'}</td>
                        <td><span className={`badge ${cls}`}>{m.tipo || ''}</span></td>
                        <td><span className={`badge ${est.badge}`}>{est.texto}</span></td>
                        {/* OPUS-9 (Req #1): OT que originó el movimiento */}
                        <td style={{ fontSize: 12 }}>
                          {m.orden_trabajo_id
                            ? <Link to={`/ordenes/${m.orden_trabajo_id}`}>#{m.orden_trabajo_id}</Link>
                            : <span style={{ color: 'var(--gray)' }}>—</span>}
                        </td>
                        <td><div style={{ fontWeight: 500, fontSize: 13 }}>{m.material || '—'}</div><div style={{ fontSize: 11, color: '#aaa' }}>{m.sku}</div></td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.bodega || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{signo}{parseFloat(m.cantidad || 0)}</td>
                        <td style={{ fontSize: 12 }}>{m.clasificacion_salida || '—'}</td>
                        {esGerencia && <td style={{ fontSize: 12 }}>{m.precio_unitario != null ? formatMoney(m.precio_unitario) : '—'}</td>}
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination {...pag} />
          </div>
        </>
      )}

      {/* Estado vacío inicial */}
      {movs === null && (
        <div className="card" id="empty-inicial">
          <div className="empty-state">
            <div className="empty-state-icon">📊</div>
            <p>Selecciona un rango de fechas y haz clic en <strong>Generar reporte</strong> para ver los resultados.</p>
          </div>
        </div>
      )}
    </>
  );
}
