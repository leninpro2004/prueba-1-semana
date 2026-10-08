import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { usePrompt } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import { fechaLocal } from '../../utils/format';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';

const INSUMO_INFO = {
  disponible:       { label: 'Disponible',       cls: 'badge-success', icon: '✓',  bg: '#d1e7dd', color: '#198754' },
  faltante:         { label: 'Sin stock',        cls: 'badge-danger',  icon: '✗',  bg: '#f8d7da', color: '#dc3545' },
  reservado:        { label: 'Reservado',        cls: 'badge-info',    icon: '🔒', bg: '#cff4fc', color: '#055160' },
  solicitud_compra: { label: 'Pendiente compra', cls: 'badge-warning', icon: '⏳', bg: '#fff3cd', color: '#856404' },
  indeterminado:    { label: 'Sin datos',        cls: 'badge-gray',    icon: '?',  bg: '#e9ecef', color: '#6c757d' },
};

const IconAlerta = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
);

// CU-118: Estados extendidos (misma lógica que el HTML)
function estadoReal(ins) {
  const disp = parseFloat(ins.stock_disponible || 0);
  const req = parseFloat(ins.cantidad_requerida || 0);
  if (ins.estado_stock === 'reservado') return 'reservado';
  if (ins.estado_stock === 'solicitud_compra' || ins.solicitud_compra) return 'solicitud_compra';
  if (ins.stock_disponible == null && ins.cantidad_requerida == null) return 'indeterminado';
  if (Math.round(disp * 10000) >= Math.round(req * 10000)) return 'disponible';
  return 'faltante';
}

const POR_PAGINA = 20;

/** Validación de Pedidos — conversión 1:1 de pedidos/checklist.html. ?id=X abre el checklist de esa orden. */
export default function PedidoChecklist() {
  usePageTitle('Pedidos');
  const prompt = usePrompt();
  const { alert, showAlert } = useAlert();
  const [params] = useSearchParams();

  const [buscar, setBuscar] = useState('');
  const [estado, setEstado] = useState('');
  const [pedidos, setPedidos] = useState(null);
  const [pagina, setPagina] = useState(1);
  const [totalRegistros, setTotalRegistros] = useState(0);
  const [pedidoActual, setPedidoActual] = useState(null); // data de checklist
  const [otId, setOtId] = useState(null);
  const abiertoDesdeQuery = useRef(false);

  // OPUS-6: paginacion en el servidor (antes se traian TODAS las OTs y se
  // paginaban en el navegador). El backend devuelve total_registros en cada fila.
  const cargarPedidos = useCallback(async () => {
    try {
      const data = await API.pedidos.listar({
        buscar: buscar || null,
        estado: estado || null,
        page: pagina,
        limit: POR_PAGINA,
      });
      const filas = Array.isArray(data) ? data : [];
      setPedidos(filas);
      setTotalRegistros(filas.length > 0 ? parseInt(filas[0].total_registros || filas.length) : 0);
    } catch (err) {
      showAlert('danger', 'Error cargando pedidos: ' + err.message);
    }
  }, [buscar, estado, pagina, showAlert]);

  useEffect(() => { cargarPedidos(); }, [cargarPedidos]);

  // Al cambiar los filtros se vuelve a la primera pagina
  useEffect(() => { setPagina(1); }, [buscar, estado]);

  const totalPaginas = Math.max(1, Math.ceil(totalRegistros / POR_PAGINA));
  const pag = {
    pagina,
    totalPaginas,
    total: totalRegistros,
    items: pedidos || [],
    prev: () => setPagina(p => (p > 1 ? p - 1 : p)),
    next: () => setPagina(p => (p < totalPaginas ? p + 1 : p)),
  };

  const verChecklist = useCallback(async (id) => {
    try {
      const data = await API.pedidos.checklist(id);
      setOtId(id);
      setPedidoActual(data);
    } catch (err) {
      showAlert('danger', 'Error cargando checklist: ' + err.message);
    }
  }, [showAlert]);

  // ?id=X → abrir checklist directamente
  useEffect(() => {
    const id = params.get('id');
    if (id && !abiertoDesdeQuery.current) { abiertoDesdeQuery.current = true; verChecklist(parseInt(id)); }
  }, [params, verChecklist]);

  const volverLista = () => { setPedidoActual(null); setOtId(null); };

  const reservarStock = async (id) => {
    const materialesAReservar = (pedidoActual?.materiales || [])
      .filter(m => m.estado_stock === 'disponible')
      .map(m => ({ sku: m.sku, cantidad: parseFloat(m.cantidad_requerida || 0) }));
    if (materialesAReservar.length === 0) { showAlert('warning', 'No hay materiales disponibles para reservar.'); return; }
    try {
      await API.pedidos.reservar(id, { materiales: materialesAReservar });
      showAlert('success', 'Stock reservado correctamente.');
      verChecklist(id);
    } catch (err) {
      showAlert('danger', 'Error al reservar: ' + err.message);
    }
  };

  // CU-122: Reportar discrepancia en checklist
  const reportarDiscrepancia = async (id, sku, nombre) => {
    const descripcion = await prompt(`Describa la diferencia encontrada para ${nombre} (${sku}):`, 'Reportar diferencia', 'Ej: Cantidad física no coincide con el sistema...');
    if (!descripcion || !descripcion.trim()) return;
    try {
      const resp = await API.pedidos.reportarDiscrepancia(id, { sku, tipo: 'discrepancia_fisica', descripcion: descripcion.trim() });
      if (resp?.error) { showAlert('danger', resp.error); return; }
      // CU-119: sugerencia de traslado si hay stock en otras bodegas
      let msg = resp?.message;
      if (resp?.stock_otras_bodegas && resp.stock_otras_bodegas.length > 0) {
        const bodegas = resp.stock_otras_bodegas.map(b => `${b.bodega}: ${b.cantidad} ${b.unidad || 'uds.'}`).join(', ');
        msg += ` — Se encontró stock en otras bodegas: ${bodegas}. Considere solicitar un traslado.`;
        showAlert('warning', msg);
      } else {
        showAlert('success', msg);
      }
      verChecklist(id);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  /* ── Derivados del checklist ── */
  const data = pedidoActual;
  const o = data?.orden;
  const materiales = data?.materiales || [];
  const criticosFaltantes = materiales.filter(ins => {
    const disp = parseFloat(ins.stock_disponible || 0);
    const req = parseFloat(ins.cantidad_requerida || 0);
    const er = ins.estado_stock === 'reservado' ? 'reservado' : (Math.round(disp * 10000) >= Math.round(req * 10000)) ? 'disponible' : 'faltante';
    return er === 'faltante' && ins.es_critico;
  });
  const hayFaltantes = data ? data.resumen.faltante > 0 : false;
  const hayCriticosFaltantes = criticosFaltantes.length > 0;
  let badge = null;
  if (data) {
    if (hayCriticosFaltantes) badge = <span className="badge badge-danger" style={{ background: '#721c24', color: '#fff' }}>No viable</span>;
    else if (hayFaltantes) badge = <span className="badge badge-danger">En riesgo</span>;
    else if (data.resumen.reservado > 0) badge = <span className="badge badge-info">Reservado</span>;
    else badge = <span className="badge badge-success">Viable</span>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Validación de Pedidos</div>
          <div className="page-subtitle">Lista de chequeo de insumos por orden de trabajo — FR-74</div>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Vista lista */}
      {!data && (
        <div id="vista-lista">
          <div className="card">
            <div className="filter-row" style={{ marginBottom: 16 }}>
              <div className="search-bar" style={{ flex: 1 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ color: 'var(--gray)' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input id="search-pedidos" placeholder="Buscar por proyecto o código..." value={buscar} onChange={e => setBuscar(e.target.value)} />
              </div>
              <select className="form-control" id="filter-estado-ot" style={{ width: 180 }} value={estado} onChange={e => setEstado(e.target.value)}>
                <option value="">Todos los estados</option>
                <option value="pendiente">Pendiente</option>
                <option value="en_proceso">En proceso</option>
                <option value="completado">Completado</option>
              </select>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ID Orden</th><th>Proyecto</th><th>Fecha</th><th>Viabilidad</th><th>Materiales</th><th>Acciones</th></tr>
                </thead>
                <tbody id="tbody-pedidos">
                  {pedidos !== null && pedidos.length === 0 && (
                    <EmptyRow colSpan={6} emptyMsg={<div className="empty-state"><div className="empty-state-icon">📋</div><p>No hay órdenes de trabajo registradas.</p></div>} />
                  )}
                  {pag.items.map(p => {
                    const faltantes = parseInt(p.materiales_faltantes || 0);
                    const criticos = parseInt(p.criticos_faltantes || 0);
                    const total = parseInt(p.total_materiales || 0);
                    const estadoBadge = criticos > 0 ? <span className="badge badge-danger" style={{ background: '#721c24', color: '#fff' }}>No viable</span>
                      : faltantes > 0 ? <span className="badge badge-danger">En riesgo</span>
                      : total > 0 ? <span className="badge badge-success">Viable</span>
                      : <span className="badge badge-gray">Sin materiales</span>;
                    return (
                      <tr key={p.id}>
                        <td><span className="td-mono">#{p.id}</span></td>
                        <td style={{ fontWeight: 500, fontSize: 13 }}>
                          {p.proyecto_nombre || '—'}
                          {p.proyecto_codigo && <div style={{ fontSize: 11, color: 'var(--gray)' }}>{p.proyecto_codigo}</div>}
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--gray)' }}>{fechaLocal(p.fecha)}</td>
                        <td>{estadoBadge}</td>
                        <td style={{ fontSize: 12 }}>
                          {total} material(es){faltantes > 0 && <> · <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{faltantes} faltante(s)</span></>}
                          {criticos > 0 && <div style={{ fontSize: 11, color: '#721c24', fontWeight: 600 }}>⚡ {criticos} crítico(s) sin stock</div>}
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => verChecklist(p.id)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Ver checklist
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination {...pag} />
          </div>
        </div>
      )}

      {/* Vista detalle / checklist */}
      {data && (
        <div id="vista-detalle">
          <button className="btn btn-ghost" style={{ marginBottom: 16 }} onClick={volverLista}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
            Volver a pedidos
          </button>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }} id="det-cliente">{o.proyecto_nombre || `Orden #${o.id}`}</div>
                <div style={{ fontSize: 12, color: 'var(--gray)' }} id="det-meta">
                  {[o.proyecto_codigo, `Área: ${o.area || '—'}`, `Responsable: ${o.responsable || '—'}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              {badge}
            </div>

            {/* KPIs resumen */}
            <div id="det-resumen" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 12, marginBottom: 20 }}>
              <div className="kpi-card" style={{ padding: 12 }}><div className="kpi-label">Total materiales</div><div className="kpi-value" style={{ fontSize: 20 }}>{data.resumen.total}</div></div>
              <div className="kpi-card" style={{ padding: 12 }}><div className="kpi-label" style={{ color: 'var(--success)' }}>Disponibles</div><div className="kpi-value" style={{ fontSize: 20, color: 'var(--success)' }}>{data.resumen.disponible}</div></div>
              <div className="kpi-card" style={{ padding: 12 }}><div className="kpi-label" style={{ color: 'var(--info)' }}>Reservados</div><div className="kpi-value" style={{ fontSize: 20, color: 'var(--info)' }}>{data.resumen.reservado}</div></div>
              <div className="kpi-card" style={{ padding: 12 }}><div className="kpi-label" style={{ color: 'var(--danger)' }}>Faltantes</div><div className="kpi-value" style={{ fontSize: 20, color: 'var(--danger)' }}>{data.resumen.faltante}</div></div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Materiales requeridos</div>
            <div id="checklist-items">
              {materiales.length === 0 && <div className="empty-state"><p>Esta orden no tiene materiales asignados.</p></div>}
              {materiales.length > 0 && criticosFaltantes.length > 0 && (
                <div className="alert alert-danger" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <span><strong>⚡ Instalación no viable — {criticosFaltantes.length} material(es) crítico(s) sin stock:</strong> {criticosFaltantes.map(c => c.nombre + ' (' + c.sku + ')').join(', ')}</span>
                </div>
              )}
              {materiales.map(ins => {
                const disp = parseFloat(ins.stock_disponible || 0);
                const req = parseFloat(ins.cantidad_requerida || 0);
                const ii = INSUMO_INFO[estadoReal(ins)] || INSUMO_INFO.faltante;
                const ubic = ins.ubicaciones && ins.ubicaciones.length > 0;
                return (
                  <div key={ins.sku} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 28, height: 28, borderRadius: 6, background: ii.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: ii.color, flexShrink: 0, fontWeight: 700 }}>{ii.icon}</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{ins.nombre}{ins.es_critico && <> <span style={{ color: 'var(--danger)', fontSize: 11 }}>⚡ Crítico</span></>}</div>
                        <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                          <span className="td-mono">{ins.sku}</span>
                          {' '}· Requerido: <strong>{req} {ins.unidad || ''}</strong>
                          {' '}· Disponible: <strong style={{ color: disp >= req ? 'var(--success)' : 'var(--danger)' }}>{disp}</strong>
                          {parseFloat(ins.ya_reservado || 0) > 0 && <> · Reservado: <strong style={{ color: '#0d6efd' }}>{parseFloat(ins.ya_reservado)}</strong></>}
                          {' '}· <span style={{ color: ubic ? 'var(--primary)' : 'var(--gray)' }}>📍 {ubic ? ins.ubicaciones.map(u => u.bodega + (u.anaquel ? '/' + u.anaquel : '')).join(', ') : 'Ubicación desconocida'}</span>
                          {ins.stock_otras_bodegas && ins.stock_otras_bodegas.length > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 2 }}>🔄 Stock disponible en: {ins.stock_otras_bodegas.map(b => b.bodega + ' (' + b.disponible + ')').join(', ')} — Considere solicitar traslado</div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`badge ${ii.cls}`}>{ii.label}</span>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--danger)' }} onClick={() => reportarDiscrepancia(otId, ins.sku, (ins.nombre || '').replace(/'/g, ''))}>Diferencia</button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Acciones */}
            <div id="acciones-reserva" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--gray-mid)' }}>
              {hayCriticosFaltantes ? (
                <>
                  <div className="alert alert-danger" style={{ width: '100%', margin: 0, background: '#f5c6cb', borderColor: '#721c24' }}>
                    <IconAlerta /> <span><strong>Instalación no viable.</strong> Faltan {criticosFaltantes.length} material(es) crítico(s). No se puede agendar la instalación hasta resolver el abastecimiento.</span>
                  </div>
                  <Link to="/movimientos/entrada" className="btn btn-secondary">Registrar compra de emergencia</Link>
                </>
              ) : hayFaltantes ? (
                <>
                  <div className="alert alert-danger" style={{ width: '100%', margin: 0 }}>
                    <IconAlerta /> <span>{data.resumen.faltante} material(es) sin stock suficiente. Registra una compra antes de confirmar.</span>
                  </div>
                  <Link to="/movimientos/entrada" className="btn btn-secondary">Registrar compra</Link>
                </>
              ) : (data.resumen.reservado === data.resumen.total && data.resumen.total > 0) ? (
                <div className="alert alert-success" style={{ margin: 0 }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
                  Todos los materiales están reservados para esta orden.
                </div>
              ) : (
                <>
                  <Link to="/movimientos/entrada" className="btn btn-secondary">Registrar compra</Link>
                  <button className="btn btn-primary" onClick={() => reservarStock(otId)}>Reservar insumos disponibles</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
