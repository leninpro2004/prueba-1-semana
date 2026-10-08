import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import TabDesviaciones from './TabDesviaciones';
import TabConsumo from './TabConsumo';
import { ocultaMontos } from '../../utils/user';

// R1: Consumo reemplaza a Consumos, Estimados y Registrar consumo (docs/sprint/decisiones.md)
const TABS = [['consumo', 'Consumo'], ['movimientos', 'Movimientos'], ['desviaciones', 'Desviaciones']];   // CU-103
// Estados en que la OT ya no admite finalizarse (mismo criterio que el backend)
const ESTADOS_CERRADOS = ['cancelada', 'finalizada', 'completada', 'cerrada'];

/**
 * Detalle Orden de Trabajo — conversión 1:1 de ordenes/detalle.html (?id= → /ordenes/:id).
 * data-rol="gerencia": enlace "Costos" (oculto si rol === 'jop').
 */
export default function OrdenDetalle() {
  usePageTitle('Detalle Orden de Trabajo');
  const { id: otId } = useParams();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const confirm = useConfirm();

  const [tab, setTab] = useState('consumo');
  const [data, setData] = useState(null);       // respuesta de consumos()
  const [bodegas, setBodegas] = useState([]);


  // Comparativo (CU-92)
  const [comp, setComp] = useState(null); // null | { loading } | { error } | { detalle, resumen }

  // OPUS-11 (Req #3): pinturas usadas en esta OT (seguimiento por peso)
  const [pinturas, setPinturas] = useState(null);

  // OPUS-9 (Req #1): movimientos de inventario generados por esta OT
  const [movs, setMovs] = useState(null);      // null = aún no cargado
  const [movTipo, setMovTipo] = useState('');
  const [movDesde, setMovDesde] = useState('');
  const [movHasta, setMovHasta] = useState('');
  const [movError, setMovError] = useState(null);

  useEffect(() => {
    if (!otId) showAlert('danger', 'No se especificó un ID de orden de trabajo');
  }, [otId, showAlert]);

  const cargarConsumos = useCallback(async () => {
    try {
      const d = await API.ordenesTrabajo.consumos(otId);
      setData(d);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [otId, showAlert]);

  useEffect(() => {
    if (!otId) return;
    cargarConsumos();
    API.bodegas.listar().then(b => setBodegas(b || [])).catch(e => console.warn('Error cargando bodegas:', e.message));
    // OPUS-11: la sección de pinturas solo aparece si esta OT tiene usos registrados
    API.seguimientoPinturas.listar({ orden_trabajo_id: otId })
      .then(d => setPinturas(d))
      .catch(e => console.warn('Error cargando pinturas de la OT:', e.message));
  }, [otId, cargarConsumos]);



  // CU-103: finalizar la OT (gerencia y jop). El backend bloquea si hay reservas
  // activas o retiros de pintura sin devolver.
  const gestionaProduccion = ['gerencia', 'jop'].includes(user?.rol);
  const estadoOT = data?.orden?.estado;
  const finalizarOT = async () => {
    const ok = await confirm(
      `¿Finalizar la orden de trabajo #${otId}? Ya no se podrán registrar consumos ni estimados, y quedará lista para procesar sus diferenciales.`,
      'Finalizar orden de trabajo');
    if (!ok) return;
    try {
      const r = await API.ordenesTrabajo.finalizar(otId);
      showAlert('success', r.message);
      cargarConsumos();
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  const cambiarTab = (t) => setTab(t);

  // OPUS-9: los filtros se aplican solos al cambiarlos (mismo criterio que SONNET-1)
  useEffect(() => {
    if (tab !== 'movimientos' || !otId) return;
    let cancelado = false;
    setMovError(null);
    API.ordenesTrabajo.movimientos(otId, { tipo: movTipo || null, desde: movDesde || null, hasta: movHasta || null })
      .then(d => { if (!cancelado) setMovs(d); })
      .catch(err => { if (!cancelado) { setMovs(null); setMovError(err.message); } });
    return () => { cancelado = true; };
  }, [tab, otId, movTipo, movDesde, movHasta]);

  // Comparativo (CU-92)
  const verComparativo = async () => {
    setComp({ loading: true });
    try {
      const d = await API.ordenesTrabajo.comparativo(otId);
      if (d?.error) { setComp({ error: d.error }); return; }
      setComp({ detalle: d.detalle || [], resumen: d.resumen || {} });
    } catch (err) {
      setComp({ error: 'Error: ' + err.message });
    }
  };

  const tieneEstimadosComp = comp?.detalle?.some(d => d.estimado != null && parseFloat(d.estimado) > 0);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Orden de Trabajo <span id="ot-id">{data ? '#' + otId : ''}</span></div>
          <div className="page-subtitle" id="ot-estado">{data ? 'Estado: ' + (data.orden?.estado || '—') : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/ordenes" className="btn btn-ghost">← Órdenes de trabajo</Link>
          <button className="btn btn-ghost" id="btn-comparativo" onClick={verComparativo}>Ver comparativo</button>
          {!ocultaMontos(user) && <Link to={`/ordenes/${otId}/costos`} className="btn btn-ghost" id="link-costos">Costos</Link>}
          {gestionaProduccion && estadoOT && !ESTADOS_CERRADOS.includes(estadoOT) && (
            <button className="btn btn-primary" id="btn-finalizar-ot" onClick={finalizarOT}>Finalizar OT</button>
          )}
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)' }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={'btn btn-ghost tab-btn' + (tab === k ? ' active' : '')}
            style={{ borderRadius: 0, marginBottom: -2, borderBottom: tab === k ? '2px solid var(--primary)' : 'none' }}
            onClick={() => cambiarTab(k)}>{label}</button>
        ))}
      </div>

      {/* Tab: Desviaciones (CU-103) */}
      {tab === 'desviaciones' && (
        <TabDesviaciones otId={otId} estado={estadoOT} puedeProcesar={gestionaProduccion} />
      )}

      {/* Tab: Consumo (R1): receta + consumo real, se guarda todo junto */}
      {tab === 'consumo' && (
        <TabConsumo otId={otId} data={data} bodegas={bodegas} showAlert={showAlert} onGuardado={cargarConsumos}
          abierta={!!estadoOT && !ESTADOS_CERRADOS.includes(estadoOT)}
          puedeCorregir={user?.rol === 'gerencia' && !!estadoOT && ESTADOS_CERRADOS.includes(estadoOT)} />
      )}

      {/* OPUS-11 (Req #3): pinturas utilizadas en esta OT */}
      {tab === 'consumo' && pinturas?.seguimientos?.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-title">
            Pinturas utilizadas
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
              {' · '}{pinturas.resumen.consumido_gr} gr consumidos en {pinturas.resumen.cerrados} uso(s)
              {pinturas.resumen.abiertos > 0 && ` · ${pinturas.resumen.abiertos} envase(s) sin devolver`}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th><th>Pintura</th><th>Color</th><th>Área</th>
                  <th style={{ textAlign: 'right' }}>Retiro</th>
                  <th style={{ textAlign: 'right' }}>Devolución</th>
                  <th style={{ textAlign: 'right' }}>Consumido</th>
                  <th style={{ textAlign: 'right' }}>gr/m²</th>
                </tr>
              </thead>
              <tbody>
                {pinturas.seguimientos.map(s => (
                  <tr key={s.id}>
                    <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>
                      {s.fecha_uso ? new Date(s.fecha_uso).toLocaleString('sv-SE').slice(0, 16) : '—'}
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{s.material}</div>
                      <div style={{ fontSize: 11, color: '#aaa' }}>{s.sku}</div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.color_aplicado || s.color_catalogo || '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.area || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.peso_entrada_gr} gr</td>
                    <td style={{ textAlign: 'right' }}>
                      {s.abierto
                        ? <span className="badge badge-warning" style={{ fontSize: 10 }}>sin devolver</span>
                        : s.peso_salida_gr + ' gr'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {s.peso_consumido_gr != null ? s.peso_consumido_gr + ' gr' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12 }}>{s.rendimiento_gr_m2 ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '8px 4px 0', fontSize: 12 }}>
            <Link to="/pinturas/seguimiento">Ir al seguimiento de pinturas →</Link>
          </div>
        </div>
      )}

      {/* Tab: Movimientos vinculados a la OT (OPUS-9 / Req #1) */}
      {tab === 'movimientos' && (
        <div className="tab-content" id="tab-movimientos">
          <div className="card card-sm" style={{ marginBottom: 16 }}>
            <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Tipo</label>
                <select className="form-control" id="mov-filtro-tipo" style={{ width: 'auto' }}
                  value={movTipo} onChange={e => setMovTipo(e.target.value)}>
                  <option value="">Todos</option>
                  <option value="salida">Salida</option>
                  <option value="entrada">Entrada</option>
                </select>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Desde</label>
                <input className="form-control" type="date" id="mov-filtro-desde" style={{ width: 'auto' }}
                  value={movDesde} onChange={e => setMovDesde(e.target.value)} />
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Hasta</label>
                <input className="form-control" type="date" id="mov-filtro-hasta" style={{ width: 'auto' }}
                  value={movHasta} onChange={e => setMovHasta(e.target.value)} />
              </div>
              <div>
                <button className="btn btn-ghost btn-sm" id="btn-limpiar-mov"
                  onClick={() => { setMovTipo(''); setMovDesde(''); setMovHasta(''); }}>Limpiar filtros</button>
              </div>
            </div>
          </div>

          {movError && <div className="alert alert-danger" style={{ marginBottom: 16, fontSize: 13 }}>Error cargando movimientos: {movError}</div>}

          {movs?.resumen && (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12, fontSize: 13 }}>
              <span><strong>{movs.resumen.total}</strong> movimiento(s)</span>
              <span style={{ color: 'var(--danger)' }}><strong>{movs.resumen.salidas}</strong> salida(s)</span>
              <span style={{ color: 'var(--success)' }}><strong>{movs.resumen.entradas}</strong> devolución(es)</span>
              <span>Neto descontado: <strong>{movs.resumen.cantidad_neta}</strong></span>
              {movs.resumen.revertidos > 0 && <span style={{ color: 'var(--text-secondary)' }}>{movs.resumen.revertidos} revertido(s)</span>}
            </div>
          )}

          <div className="card">
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th><th>Fecha</th><th>Tipo</th><th>Material</th>
                    <th style={{ textAlign: 'right' }}>Cantidad</th>
                    <th>Bodega</th><th>Lote</th><th>Motivo</th><th>Trabajador</th><th>Estado</th>
                  </tr>
                </thead>
                <tbody id="movimientos-ot-body">
                  {!movs && !movError && <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
                  {movs && movs.movimientos.length === 0 && (
                    <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
                      No hay movimientos de inventario vinculados a esta OT
                      {(movTipo || movDesde || movHasta) ? ' con los filtros aplicados.' : '. Se generan automáticamente al registrar consumos reales.'}
                    </td></tr>
                  )}
                  {movs && movs.movimientos.map(m => {
                    const tl = (m.tipo || '').toLowerCase();
                    const cls = tl.includes('entrada') ? 'badge-success' : tl.includes('salida') ? 'badge-danger' : 'badge-gray';
                    const signo = tl.includes('entrada') ? '+' : tl.includes('salida') ? '−' : '';
                    const revertido = m.estado === 'revertido';
                    return (
                      <tr key={m.id} style={revertido ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>
                        <td><span className="td-mono" style={{ fontSize: 11 }}>{m.id}</span></td>
                        <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>
                          {m.fecha_hora ? new Date(m.fecha_hora).toLocaleString('sv-SE').slice(0, 16) : '—'}
                        </td>
                        <td><span className={'badge ' + cls}>{m.tipo || '—'}</span></td>
                        <td>
                          <div style={{ fontWeight: 500, fontSize: 13 }}>{m.material || '—'}</div>
                          <div style={{ fontSize: 11, color: '#aaa' }}>{m.sku}</div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {signo}{parseFloat(m.cantidad || 0)}
                          {m.unidad && <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-secondary)' }}> {m.unidad}</span>}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.bodega || '—'}</td>
                        <td style={{ fontSize: 11, color: 'var(--gray)' }}>{m.lote || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }} title={m.descripcion_motivo || ''}>{m.motivo || '—'}</td>
                        {/* El movimiento hereda el trabajador asignado a la OT, no quien lo registró */}
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario || '—'}</td>
                        <td>
                          <span className={'badge ' + (revertido ? 'badge-gray' : m.estado === 'pendiente_aprobacion' ? 'badge-warning' : 'badge-success')}>
                            {m.estado || '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Modal comparativo (CU-92) */}
      {comp && (
        <div className="modal-overlay" id="modal-comparativo" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 800 }}>
            <div className="modal-header">
              <div className="modal-title">Comparativo Estimado vs Real</div>
              <button className="modal-close" id="cerrar-comparativo" onClick={() => setComp(null)}>×</button>
            </div>
            <div className="modal-body" id="comparativo-body">
              {comp.loading && 'Cargando…'}
              {comp.error}
              {comp.detalle && !tieneEstimadosComp && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>No existe una base de comparación</div>
                  <div style={{ fontSize: 13 }}>Debe registrar estimados cargando la receta en la pestaña "Consumo" antes de poder generar un comparativo.</div>
                </div>
              )}
              {comp.detalle && tieneEstimadosComp && (
                <>
                  {/* Los costos solo llegan si el rol puede verlos (el backend los quita a jop) */}
                  {comp.resumen.costo_total_estimado != null && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 8, marginBottom: 16 }}>
                    <div style={{ textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo estimado</div><div style={{ fontWeight: 700 }}>{formatMoney(comp.resumen.costo_total_estimado)}</div></div>
                    <div style={{ textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo real</div><div style={{ fontWeight: 700 }}>{formatMoney(comp.resumen.costo_total_real)}</div></div>
                    <div style={{ textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Diferencia</div><div style={{ fontWeight: 700, color: comp.resumen.costo_total_real > comp.resumen.costo_total_estimado ? 'var(--danger)' : 'var(--success)' }}>{formatMoney(comp.resumen.costo_total_real - comp.resumen.costo_total_estimado)}</div></div>
                  </div>
                  )}
                  <table className="table">
                    <thead><tr><th>SKU</th><th>Material</th><th style={{ textAlign: 'right' }}>Estimado</th><th style={{ textAlign: 'right' }}>Real</th><th style={{ textAlign: 'right' }}>Var.</th><th style={{ textAlign: 'right' }}>Var. %</th></tr></thead>
                    <tbody>
                      {comp.detalle.map(d => (
                        <tr key={d.sku}>
                          <td><code>{d.sku}</code></td><td>{d.nombre}</td>
                          <td style={{ textAlign: 'right' }}>{d.estimado ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{d.real ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{d.varianza != null ? (d.varianza > 0 ? '+' : '') + d.varianza : '—'}</td>
                          <td style={{ textAlign: 'right' }}>{d.varianza_pct != null ? d.varianza_pct + '%' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
