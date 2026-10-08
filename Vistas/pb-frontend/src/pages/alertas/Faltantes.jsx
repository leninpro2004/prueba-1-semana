import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { overlayStyle, cancelBtnStyle } from '../../components/ConfirmDialog';
import { useAuth } from '../../hooks/useAuth';
import TabInsumosEspeciales from './TabInsumosEspeciales';

function getViabilidad(a) {
  if (!a.tiempo_reposicion || !a.fecha_instalacion) return { label: 'Sin datos', cls: 'badge-gray' };
  const diasRestantes = Math.ceil((new Date(a.fecha_instalacion) - new Date()) / (1000 * 60 * 60 * 24));
  if (diasRestantes <= 0) return { label: 'Vencida', cls: 'badge-danger' };
  if (a.tiempo_reposicion <= diasRestantes * 0.7) return { label: 'Viable', cls: 'badge-success' };
  if (a.tiempo_reposicion <= diasRestantes) return { label: 'En riesgo', cls: 'badge-warning' };
  return { label: 'No viable', cls: 'badge-danger' };
}

const boxStyle = (w) => ({ background: 'var(--white,#fff)', borderRadius: 12, padding: 24, maxWidth: w, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,.2)' });
const aviso = { padding: 8, background: '#FFF3CD', borderRadius: 6, fontSize: 12, color: '#856404', marginTop: 8 };

/** Alertas de Productos Faltantes — conversión 1:1 de alertas/faltantes.html (sin data-rol en el HTML) */
export default function Faltantes() {
  usePageTitle('Alertas de Faltantes');
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { alert, showAlert } = useAlert();
  // CU-122: pestaña de insumos especiales vendidos. CU-124: jop también la ve (para vincular)
  const { user } = useAuth();
  const esGerencia = user?.rol === 'gerencia';
  const veEspeciales = esGerencia || user?.rol === 'jop';
  const [tab, setTab] = useState('ot');

  const [estado, setEstado] = useState('activa');
  const [periodo, setPeriodo] = useState('48');
  const [buscar, setBuscar] = useState('');
  const [alertas, setAlertas] = useState(null);
  const [detalle, setDetalle] = useState(null); // null | { loading } | { error } | data
  const [dlgProv, setDlgProv] = useState(null); // { data, resolve, value }
  const [dlgCierre, setDlgCierre] = useState(null); // { resolve }

  const cargar = useCallback(async () => {
    try {
      const data = await API.alertasFaltantes.listar({ estado, buscar: buscar.trim(), horas: periodo });
      if (data?.error) { showAlert('danger', data.error); return; }
      setAlertas(Array.isArray(data) ? data : []);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [estado, buscar, periodo, showAlert]);

  // Carga inicial y al cambiar los selects de estado/periodo; el buscador requiere Enter o el botón "Filtrar"
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [estado, periodo]);

  const pag = usePagination(alertas, 20);

  const verDetalle = async (id) => {
    setDetalle({ loading: true });
    try {
      const data = await API.alertasFaltantes.obtener(id);
      if (data?.error) { setDetalle({ error: data.error }); return; }
      setDetalle(data);
    } catch (err) {
      setDetalle({ error: 'Error: ' + err.message });
    }
  };

  const cerrarDetalle = () => { setDetalle(null); cargar(); };

  const linkProveedor = (txt, style) => <Link to="/proveedores" style={{ fontWeight: 600, textDecoration: 'underline', ...style }}>{txt}</Link>;

  const emitirSolicitud = async (id) => {
    try {
      // CU-115 CP3: Obtener detalle con lista de proveedores antes de emitir
      const data = await API.alertasFaltantes.obtener(id);
      if (data?.error) { showAlert('danger', data.error); return; }
      if (!data.proveedores || data.proveedores.length === 0) {
        showAlert('warning', <>No hay proveedores registrados para este material. {linkProveedor('Registrar proveedor')}</>);
        return;
      }
      const principal = data.proveedores.find(p => p.es_principal) || data.proveedores[0];
      const proveedor_id = await new Promise(resolve => setDlgProv({ data, resolve, value: String(principal.id) }));
      if (!proveedor_id) return;
      const resp = await API.alertasFaltantes.emitirSolicitud(id, { proveedor_id });
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      cargar();
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  const resolver = async (id) => {
    // CU-116 CP2: flujos separados resolver / descartar
    const accion = await new Promise(resolve => setDlgCierre({ resolve }));
    if (!accion) return;
    const placeholder = accion === 'resuelta' ? 'Ej: Stock repuesto, compra realizada...' : 'Ej: Alerta duplicada, requerimiento cancelado...';
    const titulo = accion === 'resuelta' ? 'Resolver alerta' : 'Descartar alerta';
    // CU-116 CP4: motivo mínimo 10 caracteres
    let motivo = null;
    while (true) {
      motivo = await prompt('Ingrese el motivo (mínimo 10 caracteres):', titulo, placeholder);
      if (motivo === null) return;
      if (motivo.trim().length >= 10) break;
      showAlert('warning', 'El motivo debe tener al menos 10 caracteres.');
    }
    const confirmMsg = accion === 'resuelta'
      ? '¿Confirma marcar esta alerta como resuelta?'
      : '¿Confirma descartar esta alerta? Esta acción indica que el faltante no requiere acción.';
    if (!(await confirm(confirmMsg, titulo))) return;
    try {
      const resp = await API.alertasFaltantes.resolver(id, { accion, motivo });
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      cargar();
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  const generar = async () => {
    const reintentar = <button className="btn btn-secondary btn-sm" style={{ marginLeft: 8 }} onClick={generar}>Reintentar</button>;
    try {
      const resp = await API.alertasFaltantes.generar();
      // CU-113 CP3: si la verificación falló, ofrecer reintentar
      if (resp?.reintentar) { showAlert('danger', <>{resp.error} {reintentar}</>); return; }
      if (resp?.error) { showAlert('danger', resp.error); return; }
      // OPUS-2: el backend devuelve el detalle de que se genero/actualizo y que ya tenia alerta
      const nuevas = (resp?.detalle || []).filter(d => d.resultado === 'generada' || d.resultado === 'actualizada');
      showAlert(resp?.generadas > 0 ? 'success' : 'info', (
        <>
          {resp?.message}
          {nuevas.length > 0 && (
            <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: 12 }}>
              {nuevas.map(d => (
                <li key={d.alerta_id}>
                  <code>{d.sku}</code> {d.nombre ? '— ' + d.nombre : ''}
                  {' · requiere '}{d.requerido}{', disponible '}{d.disponible}
                  {d.ordenes?.length ? ` · OT ${d.ordenes.join(', ')}` : ''}
                  {d.resultado === 'actualizada' ? ' (alerta existente actualizada)' : ''}
                </li>
              ))}
            </ul>
          )}
        </>
      ));
      cargar();
    } catch {
      showAlert('danger', <>La verificación de faltantes no pudo completarse. {reintentar}</>);
    }
  };

  const closeProv = (v) => { const r = dlgProv.resolve; setDlgProv(null); r(v); };
  const closeCierre = (v) => { const r = dlgCierre.resolve; setDlgCierre(null); r(v); };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Alertas de Productos Faltantes</div>
          <div className="page-subtitle">
            {tab === 'ot' ? 'Materiales con stock insuficiente para pedidos próximos' : 'Insumos especiales vendidos que hay que comprar'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/alertas" className="btn btn-ghost">← Alertas</Link>
          {tab === 'ot' && (
            <button className="btn btn-primary" id="btn-generar" onClick={generar}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
              Revisar faltantes
            </button>
          )}
        </div>
      </div>

      {veEspeciales && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button className={'btn ' + (tab === 'ot' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('ot')}>Faltantes de OT</button>
          <button className={'btn ' + (tab === 'especiales' ? 'btn-primary' : 'btn-ghost')} onClick={() => setTab('especiales')}>Insumos especiales</button>
        </div>
      )}

      {tab === 'especiales' && <TabInsumosEspeciales esGerencia={esGerencia} />}

      {tab === 'ot' && <>
      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label">Estado</label>
            <select className="form-control" id="filter-estado" value={estado} onChange={e => setEstado(e.target.value)}>
              <option value="">Todos</option>
              <option value="activa">Activas</option>
              <option value="en_gestion">En gestión</option>
              <option value="solicitud_emitida">Solicitud emitida</option>
              <option value="resuelta">Resueltas</option>
              <option value="descartada">Descartadas</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 160 }}>
            <label className="form-label">Periodo</label>
            <select className="form-control" id="filter-periodo" value={periodo} onChange={e => setPeriodo(e.target.value)}>
              <option value="">Todo</option>
              <option value="48">Últimas 48 horas</option>
              <option value="168">Última semana</option>
              <option value="720">Último mes</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 200 }}>
            <label className="form-label">Buscar</label>
            <input className="form-control" id="filter-buscar" placeholder="SKU o nombre…" value={buscar} onChange={e => setBuscar(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') cargar(); }} />
          </div>
          <button className="btn btn-secondary" id="btn-filtrar" onClick={cargar}>Filtrar</button>
        </div>
      </div>

      {/* Tabla */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th><th>SKU</th><th>Material</th>
                <th style={{ textAlign: 'right' }}>Disponible</th>
                <th style={{ textAlign: 'right' }}>Requerido</th>
                <th>Proyecto</th><th>OTs afectadas</th><th>Proveedor</th><th>Viabilidad</th><th>Estado</th><th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {alertas === null && <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando…</td></tr>}
              {alertas !== null && alertas.length === 0 && <EmptyRow colSpan={11} emptyMsg="No hay alertas de faltantes" />}
              {pag.items.map(a => {
                const badgeClass = a.estado === 'activa' ? 'badge-danger' : a.estado === 'en_gestion' ? 'badge-warning' : a.estado === 'solicitud_emitida' ? 'badge-info' : 'badge-success';
                const esAbierta = a.estado === 'activa' || a.estado === 'en_gestion';
                const v = getViabilidad(a);
                return (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td><code>{a.sku}</code></td>
                    <td>{a.material_nombre}{a.es_critico && <> <span className="badge badge-danger" style={{ fontSize: 10 }}>Crítico</span></>}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(a.cantidad_disponible)}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(a.cantidad_requerida)}</td>
                    <td>{a.proyecto_codigo || '—'}</td>
                    {/* OPUS-3: OTs abiertas que necesitan este material (vinculo por material+proyecto) */}
                    <td style={{ fontSize: 12 }}>
                      {(a.ordenes_afectadas || []).length === 0
                        ? <span style={{ color: 'var(--text-secondary)' }}>—</span>
                        : a.ordenes_afectadas.map((o, i) => (
                            <span key={o.id}>
                              {i > 0 && ', '}
                              <Link to={`/ordenes/${o.id}`} title={`${o.estado} · estimado ${o.estimado ?? '—'}`}>#{o.id}</Link>
                            </span>
                          ))}
                    </td>
                    <td>{a.proveedor_nombre || '—'}</td>
                    <td><span className={`badge ${v.cls}`}>{v.label}</span></td>
                    <td><span className={`badge ${badgeClass}`}>{a.estado}</span></td>
                    <td>
                      <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => verDetalle(a.id)}>Ver</button>
                      {esAbierta && (
                        <>
                          <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => emitirSolicitud(a.id)}>Solicitar compra</button>
                          <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => resolver(a.id)}>Resolver</button>
                        </>
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
      </>}

      {/* Modal detalle/resolver */}
      {detalle && (
        <div className="modal-overlay" id="modal-detalle" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <div className="modal-title">Detalle de faltante</div>
              <button className="modal-close" id="modal-cerrar" onClick={cerrarDetalle}>×</button>
            </div>
            <div className="modal-body" id="modal-body">
              {detalle.loading && 'Cargando…'}
              {detalle.error}
              {!detalle.loading && !detalle.error && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <strong>{detalle.sku}</strong> — {detalle.material_nombre}
                    {detalle.es_critico && <> <span className="badge badge-danger">Crítico</span></>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                    <div><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Disponible:</span> {detalle.stock_actual}</div>
                    <div><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Requerido:</span> {detalle.cantidad_requerida}</div>
                    <div><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Proyecto:</span> {detalle.proyecto_codigo || '—'} {detalle.proyecto_nombre || ''}</div>
                    <div><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Estado:</span> {detalle.estado}</div>
                  </div>
                  {/* OPUS-3: OTs que dependen de este faltante */}
                  {(detalle.ordenes_afectadas || []).length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                        Órdenes de trabajo afectadas ({detalle.ordenes_afectadas.length}):
                      </div>
                      <table className="table" style={{ fontSize: 12 }}>
                        <thead><tr><th>OT</th><th>Estado</th><th style={{ textAlign: 'right' }}>Estimado</th><th style={{ textAlign: 'right' }}>Real</th></tr></thead>
                        <tbody>
                          {detalle.ordenes_afectadas.map(o => (
                            <tr key={o.id}>
                              <td><Link to={`/ordenes/${o.id}`}>#{o.id}</Link></td>
                              <td>{o.estado}</td>
                              <td style={{ textAlign: 'right' }}>{o.estimado ?? '—'}</td>
                              <td style={{ textAlign: 'right' }}>{o.real ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {detalle.estado_resolucion && <div style={{ padding: 8, background: '#D1ECF1', borderRadius: 6, fontSize: 12, color: '#0C5460', marginBottom: 12 }}>ℹ El stock ha cambiado recientemente. La alerta fue actualizada a <strong>en proceso de resolución</strong>.</div>}
                  {detalle.estado_resolucion === 'en_resolucion' && <div style={{ padding: 8, background: '#D4EDDA', borderRadius: 6, fontSize: 12, color: '#155724', marginBottom: 12 }}>✓ El stock disponible ahora cubre el requerimiento. Considere resolver esta alerta.</div>}
                  {detalle.proveedores && detalle.proveedores.length > 0 ? (
                    <>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Proveedores disponibles:</div>
                      <table className="table" style={{ fontSize: 12 }}>
                        {/* El precio solo llega si el rol puede verlo (el backend lo quita a jop) */}
                        <thead><tr><th>Proveedor</th><th>Tiempo repos.</th>{detalle.proveedores.some(p => 'precio_referencial' in p) && <th>Precio ref.</th>}<th>Principal</th></tr></thead>
                        <tbody>
                          {detalle.proveedores.map((p, i) => (
                            <tr key={p.id ?? i}>
                              <td>{p.nombre}</td>
                              <td>{p.tiempo_reposicion ? p.tiempo_reposicion + ' días' : '—'}</td>
                              {'precio_referencial' in p && <td>{p.precio_referencial ? formatMoney(p.precio_referencial) : '—'}</td>}
                              <td>{p.es_principal ? 'Sí' : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : <div style={{ color: 'var(--warning)', fontSize: 13 }}>Sin proveedores registrados para este material.</div>}
                  {detalle.sin_proveedores && <div style={aviso}>No se puede generar solicitud de compra sin proveedor asociado. Se recomienda {linkProveedor('registrar un proveedor', { color: '#856404' })} para este material.</div>}
                  {!detalle.sin_proveedores && detalle.proveedor_sin_tiempo && <div style={aviso}>⚠ Ningún proveedor tiene tiempo de entrega registrado. No es posible evaluar la viabilidad temporal de reposición. Se recomienda actualizar los datos del proveedor.</div>}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Diálogo: selección de proveedor para solicitud de compra (CU-115) */}
      {dlgProv && (
        <div id="pb-dialog-overlay" style={overlayStyle}>
          <div style={boxStyle(480)}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Solicitud de compra de emergencia</div>
            <div style={{ fontSize: 13, color: '#555', marginBottom: 16 }}><strong>{dlgProv.data.sku}</strong> — {dlgProv.data.material_nombre}</div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>Seleccione proveedor:</label>
              <select id="pb-dlg-prov" className="form-control" value={dlgProv.value} onChange={e => setDlgProv({ ...dlgProv, value: e.target.value })}>
                {dlgProv.data.proveedores.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}{p.tiempo_reposicion ? ` (${p.tiempo_reposicion} días)` : ''}{p.precio_referencial ? ` — ${formatMoney(p.precio_referencial)}` : ''}{p.es_principal ? ' ★ Principal' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button id="pb-dlg-cancel" style={cancelBtnStyle} onClick={() => closeProv(null)}>Cancelar</button>
              <button id="pb-dlg-ok" style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: 'var(--orange,#fe8f01)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={() => closeProv(dlgProv.value)}>Emitir solicitud</button>
            </div>
          </div>
        </div>
      )}

      {/* Diálogo: tipo de cierre (CU-116) */}
      {dlgCierre && (
        <div id="pb-dialog-overlay" style={overlayStyle}>
          <div style={boxStyle(420)}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Cerrar alerta de faltante</div>
            <div style={{ fontSize: 14, color: '#555', lineHeight: 1.5, marginBottom: 20 }}>Seleccione el tipo de cierre para esta alerta:</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button id="pb-dlg-cancel" style={cancelBtnStyle} onClick={() => closeCierre(null)}>Cancelar</button>
              <button id="pb-dlg-descartar" style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #dc3545', background: '#fff', color: '#dc3545', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={() => closeCierre('descartada')}>Descartar</button>
              <button id="pb-dlg-resolver" style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#198754', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }} onClick={() => closeCierre('resuelta')}>Resolver</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
