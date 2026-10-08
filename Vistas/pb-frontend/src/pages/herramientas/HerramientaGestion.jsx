import { useCallback, useEffect, useState } from 'react';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import BotonExportar from '../../components/BotonExportar';
import { EmptyRow } from '../../components/Pagination';
import { overlayStyle, boxStyle, titleStyle, cancelBtnStyle, okBtnStyle } from '../../components/ConfirmDialog';
import SelectorProducto from '../../components/SelectorProducto';

/**
 * Pestañas de gestión de herramientas — OPUS-13 (Req #5, completo).
 * Viven aparte de HerramientaLista para no dejar esa página inmanejable.
 * Cada una recibe `herramientas` (el listado ya cargado) y un `avisar(tipo, msg)`.
 */

// D47: el RUT nunca se muestra. Sin nombre se dice así; con homónimos se agrega el cargo.
const SIN_NOMBRE = 'Empleado sin nombre';
function etiquetasEmpleados(empleados) {
  const cuenta = {};
  for (const e of empleados) { const n = e.nombre || SIN_NOMBRE; cuenta[n] = (cuenta[n] || 0) + 1; }
  return (e) => { const n = e.nombre || SIN_NOMBRE; return cuenta[n] > 1 ? `${n} — ${e.cargo || 'sin cargo'}` : n; };
}

const fmtFecha = (f) => (f ? new Date(f).toLocaleString('sv-SE').slice(0, 16) : '—');

const ESTADO_CIERRE = [
  ['devuelta', 'Devuelta'],
  ['perdida', 'Perdida'],
  ['dada_de_baja', 'Dada de baja'],
];

/* ── Asignaciones: quién tiene cada herramienta ── */
export function TabAsignaciones({ herramientas, catalogo, avisar, onCambio }) {
  const [datos, setDatos] = useState(null);
  const [fSku, setFSku] = useState('');
  const [fEstado, setFEstado] = useState('asignada');

  // Formulario de asignación
  const [sku, setSku] = useState('');
  const [empleado, setEmpleado] = useState('');
  const [area, setArea] = useState('');
  const [cantidad, setCantidad] = useState('1');
  const [observacion, setObservacion] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setDatos(await API.herramientas.asignaciones({ sku: fSku || null, estado: fEstado || 'todos' }));
    } catch (err) {
      avisar('danger', 'Error cargando asignaciones: ' + err.message);
      setDatos({ resumen: {}, asignaciones: [] });
    }
  }, [fSku, fEstado, avisar]);

  useEffect(() => { cargar(); }, [cargar]);

  const asignar = async () => {
    if (!sku) { avisar('warning', 'Seleccione la herramienta a asignar.'); return; }
    if (!empleado && !area) { avisar('warning', 'Indique a qué empleado o a qué área se asigna.'); return; }
    const cant = parseInt(cantidad);
    if (isNaN(cant) || cant <= 0) { avisar('warning', 'La cantidad debe ser mayor a 0.'); return; }
    setGuardando(true);
    try {
      const resp = await API.herramientas.asignar(sku, {
        empleado_rut: empleado || null, area_trabajo_id: area || null,
        cantidad: cant, observacion: observacion || null,
      });
      avisar('success', resp?.message || 'Herramienta asignada');
      setSku(''); setEmpleado(''); setArea(''); setCantidad('1'); setObservacion('');
      cargar();
      onCambio?.();
    } catch (err) {
      avisar('danger', 'Error al asignar: ' + err.message);
    } finally {
      setGuardando(false);
    }
  };

  // D52: perdida y dada de baja descuentan el stock: piden evidencia (y bodega si hay varias)
  const [dlgCierre, setDlgCierre] = useState(null);   // { id, estado, evidencia, bodegas, bodega, error, guardando }

  const cerrar = async (id, estado, extra = {}) => {
    try {
      const resp = await API.herramientas.devolverAsignacion(id, { estado, ...extra });
      avisar('success', resp?.message || 'Asignación cerrada');
      setDlgCierre(null);
      cargar();
      onCambio?.();
    } catch (err) {
      // Con stock en varias bodegas el backend pide elegir: se muestra en el diálogo
      if (err.payload?.bodegas?.length && dlgCierre) {
        setDlgCierre(d => ({ ...d, bodegas: err.payload.bodegas, error: 'La herramienta está en varias bodegas: elija de cuál se descuenta.', guardando: false }));
        return;
      }
      if (dlgCierre) { setDlgCierre(d => ({ ...d, error: err.message, guardando: false })); return; }
      avisar('danger', 'Error: ' + err.message);
    }
  };
  const pedirCierre = (id, estado) => {
    if (estado === 'devuelta') { cerrar(id, estado); return; }
    setDlgCierre({ id, estado, evidencia: '', bodegas: null, bodega: '', error: '', guardando: false });
  };
  const confirmarCierre = () => {
    const d = dlgCierre;
    if (!/^https?:\/\//i.test(d.evidencia.trim())) { setDlgCierre({ ...d, error: 'Ingrese un enlace válido a la evidencia (http:// o https://).' }); return; }
    if (d.bodegas && !d.bodega) { setDlgCierre({ ...d, error: 'Elija la bodega de la que se descuenta.' }); return; }
    setDlgCierre({ ...d, guardando: true, error: '' });
    cerrar(d.id, d.estado, { evidencia_url: d.evidencia.trim(), ...(d.bodega && { bodega_id: Number(d.bodega) }) });
  };

  const lista = datos?.asignaciones || [];
  const resumen = datos?.resumen || {};
  const etiquetaEmpleado = etiquetasEmpleados(catalogo.empleados || []);

  // CU-76: la tabla de asignaciones con los filtros aplicados
  const exportar = () => {
    const headers = ['ID', 'SKU', 'Herramienta', 'Asignada a', 'Área', { titulo: 'Cantidad', formato: 'numero' },
                     { titulo: 'Desde', formato: 'timestamp' }, { titulo: 'Cierre', formato: 'timestamp' }, 'Estado', 'Observación'];
    const rows = lista.map(a => [
      a.id, a.sku, a.herramienta, a.empleado || (a.empleado_rut ? SIN_NOMBRE : ''), a.area || '', a.cantidad,
      a.fecha_asignacion, a.fecha_devolucion, a.estado, a.observacion || '',
    ]);
    try { exportarCSV('asignaciones-herramientas', headers, rows); } catch (e) { avisar('danger', e.message); }
  };

  return (
    <div className="tab-content" id="tab-asignaciones">
      {dlgCierre && (
        <div style={overlayStyle} role="dialog" aria-modal="true">
          <div style={boxStyle}>
            <div style={titleStyle}>{dlgCierre.estado === 'perdida' ? 'Herramienta perdida' : 'Dar de baja la herramienta'}</div>
            <div style={{ fontSize: 13, color: '#555', marginBottom: 12 }}>
              Las unidades asignadas salen del inventario como una merma. Adjunte la evidencia (foto, acta o denuncia).
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="cierre-evidencia">Enlace a la evidencia *</label>
              <input className="form-control" id="cierre-evidencia" type="url" placeholder="https://drive.google.com/…"
                value={dlgCierre.evidencia} onChange={e => setDlgCierre(d => ({ ...d, evidencia: e.target.value, error: '' }))} />
            </div>
            {dlgCierre.bodegas && (
              <div className="form-group">
                <label className="form-label" htmlFor="cierre-bodega">Bodega de la que se descuenta *</label>
                <select className="form-control" id="cierre-bodega" value={dlgCierre.bodega}
                  onChange={e => setDlgCierre(d => ({ ...d, bodega: e.target.value, error: '' }))}>
                  <option value="">Seleccione…</option>
                  {dlgCierre.bodegas.map(b => <option key={b.bodega_id} value={b.bodega_id}>{b.nombre || 'Bodega ' + b.bodega_id} — {b.disponible} disp.</option>)}
                </select>
              </div>
            )}
            {dlgCierre.error && <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>{dlgCierre.error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" style={cancelBtnStyle} onClick={() => setDlgCierre(null)} disabled={dlgCierre.guardando}>Cancelar</button>
              <button type="button" style={okBtnStyle} onClick={confirmarCierre} disabled={dlgCierre.guardando}>
                {dlgCierre.guardando ? 'Registrando…' : 'Registrar y descontar'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Asignar herramienta</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Solo se pueden entregar unidades libres: el sistema descuenta las que ya están asignadas.
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 190 }}>
            <label className="form-label">Herramienta</label>
            <SelectorProducto id="asig-sku" value={sku} onChange={setSku}
              opciones={herramientas.map(x => ({ sku: x.sku, nombre: x.nombre, detalle: `stock ${x.stock_total}` }))} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Empleado</label>
            <select className="form-control" id="asig-empleado" value={empleado} onChange={e => setEmpleado(e.target.value)}>
              <option value="">Sin empleado</option>
              {(catalogo.empleados || []).map(e => <option key={e.rut} value={e.rut}>{etiquetaEmpleado(e)}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label">Área</label>
            <select className="form-control" id="asig-area" value={area} onChange={e => setArea(e.target.value)}>
              <option value="">Sin área</option>
              {(catalogo.areas || []).map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 90 }}>
            <label className="form-label">Cantidad</label>
            <input className="form-control" type="number" id="asig-cantidad" min={1} step="1"
              value={cantidad} onChange={e => setCantidad(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 150 }}>
            <label className="form-label">Observación</label>
            <input className="form-control" id="asig-observacion" value={observacion}
              onChange={e => setObservacion(e.target.value)} placeholder="Opcional" />
          </div>
          <button className="btn btn-primary" id="btn-asignar" onClick={asignar} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Asignar'}
          </button>
        </div>
      </div>

      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Herramienta</label>
            <div style={{ minWidth: 240 }}><SelectorProducto id="fasig-sku" vacio="Todas" value={fSku} onChange={setFSku} opciones={herramientas} /></div>
          </div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Estado</label>
            <select className="form-control" id="fasig-estado" style={{ width: 'auto' }} value={fEstado} onChange={e => setFEstado(e.target.value)}>
              <option value="asignada">Vigentes</option>
              <option value="devuelta">Devueltas</option>
              <option value="perdida">Perdidas</option>
              <option value="dada_de_baja">Dadas de baja</option>
              <option value="todos">Todas</option>
            </select>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
            {resumen.unidades_asignadas != null && <>Unidades entregadas ahora: <strong>{resumen.unidades_asignadas}</strong></>}
          </div>
          <BotonExportar id="btn-exportar-asig" className="btn btn-secondary btn-sm" onClick={exportar}
                         filas={datos ? lista.length : null} etiqueta="Exportar asignaciones" />
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th><th>Herramienta</th><th>Asignada a</th><th>Área</th>
                <th style={{ textAlign: 'right' }}>Cant.</th>
                <th>Desde</th><th>Cierre</th><th>Estado</th>
                <th style={{ textAlign: 'center' }}>Acción</th>
              </tr>
            </thead>
            <tbody id="asignaciones-body">
              {!datos && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
              {datos && lista.length === 0 && (
                <EmptyRow colSpan={9} emptyMsg="No hay asignaciones con estos filtros." />
              )}
              {datos && lista.map(a => (
                <tr key={a.id}>
                  <td><span className="td-mono" style={{ fontSize: 11 }}>{a.id}</span></td>
                  <td>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{a.herramienta}</div>
                    <div style={{ fontSize: 11, color: '#aaa' }}>{a.sku}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>{a.empleado || (a.empleado_rut ? SIN_NOMBRE : '—')}</td>
                  <td style={{ fontSize: 12, color: 'var(--gray)' }}>{a.area || '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{a.cantidad}</td>
                  <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>{fmtFecha(a.fecha_asignacion)}</td>
                  <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>{fmtFecha(a.fecha_devolucion)}</td>
                  <td>
                    <span className={'badge ' + (a.estado === 'asignada' ? 'badge-warning'
                      : a.estado === 'devuelta' ? 'badge-success' : 'badge-danger')}>{a.estado}</span>
                  </td>
                  <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                    {a.estado === 'asignada' ? ESTADO_CIERRE.map(([k, label]) => (
                      <button key={k} className="btn btn-ghost" style={{ padding: '2px 6px', fontSize: 11 }}
                        onClick={() => pedirCierre(a.id, k)}>{label}</button>
                    )) : <span style={{ fontSize: 11, color: 'var(--gray)' }}>cerrada</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Depreciación: valor contable actual ── */
export function TabDepreciacion({ avisar, puedeEditar }) {
  const [reporte, setReporte] = useState(null);
  const [editSku, setEditSku] = useState(null);
  const [metodo, setMetodo] = useState('lineal');
  const [vida, setVida] = useState('');
  const [residual, setResidual] = useState('');

  const cargar = useCallback(async () => {
    try {
      setReporte(await API.herramientas.reporte());
    } catch (err) {
      avisar('danger', 'Error cargando la valorización: ' + err.message);
      setReporte({ resumen: {}, herramientas: [], areas: [] });
    }
  }, [avisar]);

  useEffect(() => { cargar(); }, [cargar]);

  const abrir = (h) => {
    setEditSku(h.sku);
    setMetodo(h.metodo || 'lineal');
    setVida('');
    setResidual('');
  };

  const guardar = async (sku) => {
    const v = parseInt(vida);
    if (isNaN(v) || v <= 0) {
      avisar('warning', metodo === 'lineal' ? 'Indique la vida útil en meses.' : 'Indique la vida útil en usos.');
      return;
    }
    try {
      const resp = await API.herramientas.configurarDepreciacion(sku, {
        metodo,
        vida_util_meses: metodo === 'lineal' ? v : null,
        vida_util_usos: metodo === 'uso' ? v : null,
        valor_residual: residual === '' ? 0 : parseFloat(residual),
      });
      setEditSku(null);
      avisar('success', resp?.message || 'Depreciación configurada');
      cargar();
    } catch (err) {
      avisar('danger', 'Error: ' + err.message);
    }
  };

  const lista = reporte?.herramientas || [];
  const resumen = reporte?.resumen || {};

  const exportar = () => {
    const clp = (titulo) => ({ titulo, formato: 'clp' });
    const headers = ['SKU', 'Herramienta', { titulo: 'Stock', formato: 'numero' }, clp('Valor unitario'), 'Método',
      clp('Depreciación unitaria'), clp('Valor actual unitario'), clp('Valor adquisición total'),
      clp('Depreciación total'), clp('Valor contable total')];
    const rows = lista.map(h => [
      h.sku, h.nombre, h.stock, h.valor_unitario ?? '', h.metodo || '',
      h.depreciacion_unitaria ?? '', h.valor_actual_unitario ?? '',
      h.valor_adquisicion_total, h.depreciacion_total, h.valor_actual_total,
    ]);
    try { exportarCSV('valorizacion-herramientas', headers, rows); } catch (e) { avisar('danger', e.message); }
  };

  return (
    <div className="tab-content" id="tab-depreciacion">
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-label">Valor de adquisición</div>
          <div className="kpi-value">{formatMoney(resumen.valor_adquisicion_total || 0)}</div>
          <div className="kpi-sub">{resumen.unidades ?? 0} unidad(es)</div>
        </div>
        <div className="kpi-card kpi-danger">
          <div className="kpi-label">Depreciación acumulada</div>
          <div className="kpi-value danger">{formatMoney(resumen.depreciacion_acumulada_total || 0)}</div>
          <div className="kpi-sub">Según método y vida útil</div>
        </div>
        <div className="kpi-card kpi-success">
          <div className="kpi-label">Valor contable actual</div>
          <div className="kpi-value" style={{ color: 'var(--success)' }}>{formatMoney(resumen.valor_contable_total || 0)}</div>
          <div className="kpi-sub">Adquisición − depreciación</div>
        </div>
        <div className="kpi-card kpi-warning">
          <div className="kpi-label">Sin configurar</div>
          <div className="kpi-value warning">{resumen.sin_depreciacion ?? 0}</div>
          <div className="kpi-sub">de {resumen.herramientas ?? 0} herramienta(s)</div>
        </div>
      </div>

      {(resumen.sin_depreciacion > 0 || resumen.sin_valor > 0) && (
        <div className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
          ⚠ Valorización contable parcial:
          {resumen.sin_valor > 0 && ` ${resumen.sin_valor} herramienta(s) sin valor de adquisición`}
          {resumen.sin_valor > 0 && resumen.sin_depreciacion > 0 && ' y'}
          {resumen.sin_depreciacion > 0 && ` ${resumen.sin_depreciacion} sin depreciación configurada`}
          . Esas no suman a los totales.
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0 10px' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Valor contable por herramienta</div>
          <BotonExportar id="btn-exportar-dep" className="btn btn-secondary btn-sm" onClick={exportar}
                         filas={reporte ? lista.length : null} etiqueta="Exportar depreciación" />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th><th>Herramienta</th>
                <th style={{ textAlign: 'right' }}>Stock</th>
                <th style={{ textAlign: 'right' }}>Valor unit.</th>
                <th>Método</th>
                <th style={{ textAlign: 'right' }}>Depreciación</th>
                <th style={{ textAlign: 'right' }}>Valor actual</th>
                <th style={{ textAlign: 'right' }}>Contable total</th>
                {puedeEditar && <th style={{ textAlign: 'center' }}>Acción</th>}
              </tr>
            </thead>
            <tbody id="depreciacion-body">
              {!reporte && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
              {reporte && lista.length === 0 && <EmptyRow colSpan={9} emptyMsg="No hay herramientas activas." />}
              {reporte && lista.map(h => {
                const editando = editSku === h.sku;
                return (
                  <tr key={h.sku} style={!h.depreciacion_configurada ? { background: 'rgba(255,193,7,0.08)' } : undefined}>
                    <td><code>{h.sku}</code></td>
                    <td style={{ fontSize: 13 }}>{h.nombre}</td>
                    <td style={{ textAlign: 'right' }}>{h.stock}</td>
                    <td style={{ textAlign: 'right' }}>
                      {h.valor_unitario != null ? formatMoney(h.valor_unitario)
                        : <span style={{ color: 'var(--gray)', fontSize: 12 }}>sin valor</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {editando ? (
                        <select className="form-control" style={{ width: 100, fontSize: 12 }}
                          value={metodo} onChange={e => setMetodo(e.target.value)}>
                          <option value="lineal">Lineal</option>
                          <option value="uso">Por uso</option>
                        </select>
                      ) : (h.metodo || <span style={{ color: 'var(--gray)' }}>sin configurar</span>)}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12 }}>
                      {editando ? (
                        <input className="form-control" type="number" min={1} step="1" style={{ width: 110, fontSize: 12 }}
                          placeholder={metodo === 'lineal' ? 'meses' : 'usos'}
                          value={vida} onChange={e => setVida(e.target.value)} autoFocus
                          onKeyDown={e => { if (e.key === 'Enter') guardar(h.sku); if (e.key === 'Escape') setEditSku(null); }} />
                      ) : (h.depreciacion_unitaria != null ? formatMoney(h.depreciacion_unitaria) : '—')}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12 }}>
                      {editando ? (
                        <input className="form-control" type="number" min={0} step="0.01" style={{ width: 110, fontSize: 12 }}
                          placeholder="residual" value={residual} onChange={e => setResidual(e.target.value)} />
                      ) : (h.valor_actual_unitario != null ? formatMoney(h.valor_actual_unitario) : '—')}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {h.valor_actual_total ? formatMoney(h.valor_actual_total) : '—'}
                    </td>
                    {puedeEditar && (
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {editando ? (
                          <>
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => guardar(h.sku)}>Guardar</button>
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => setEditSku(null)}>Cancelar</button>
                          </>
                        ) : (
                          <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                            disabled={h.valor_unitario == null}
                            title={h.valor_unitario == null ? 'Cargue primero el valor de adquisición' : 'Configurar depreciación'}
                            onClick={() => abrir(h)}>Configurar</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div style={{ fontWeight: 600, fontSize: 13, padding: '4px 0 10px' }}>Valor contable por área</div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Área</th>
                <th style={{ textAlign: 'right' }}>Unidades</th>
                <th style={{ textAlign: 'right' }}>Adquisición</th>
                <th style={{ textAlign: 'right' }}>Depreciación</th>
                <th style={{ textAlign: 'right' }}>Valor contable</th>
              </tr>
            </thead>
            <tbody id="areas-body">
              {(reporte?.areas || []).length === 0 && <EmptyRow colSpan={5} emptyMsg="Sin datos." />}
              {(reporte?.areas || []).map(a => (
                <tr key={a.area}>
                  <td style={{ fontWeight: 500 }}>{a.area}</td>
                  <td style={{ textAlign: 'right' }}>{a.unidades}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(a.valor_adquisicion)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--danger)' }}>{formatMoney(a.depreciacion)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(a.valor_actual)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Mantenimiento ── */
export function TabMantenimiento({ herramientas, avisar }) {
  const [datos, setDatos] = useState(null);
  const [fSku, setFSku] = useState('');
  const [fTipo, setFTipo] = useState('');
  const [soloVencidos, setSoloVencidos] = useState(false);

  const [sku, setSku] = useState('');
  const [tipo, setTipo] = useState('preventivo');
  const [descripcion, setDescripcion] = useState('');
  const [costo, setCosto] = useState('');
  const [proximo, setProximo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setDatos(await API.herramientas.mantenimientos({
        sku: fSku || null, tipo: fTipo || null, vencidos: soloVencidos ? 'true' : null,
      }));
    } catch (err) {
      avisar('danger', 'Error cargando mantenimientos: ' + err.message);
      setDatos({ resumen: {}, mantenimientos: [] });
    }
  }, [fSku, fTipo, soloVencidos, avisar]);

  useEffect(() => { cargar(); }, [cargar]);

  const registrar = async () => {
    if (!sku) { avisar('warning', 'Seleccione la herramienta.'); return; }
    setGuardando(true);
    try {
      const resp = await API.herramientas.registrarMantenimiento(sku, {
        tipo, descripcion: descripcion || null,
        costo_mantenimiento: costo === '' ? null : parseFloat(costo),
        proximo_mantenimiento: proximo || null,
      });
      avisar('success', resp?.message || 'Mantenimiento registrado');
      setSku(''); setDescripcion(''); setCosto(''); setProximo('');
      cargar();
    } catch (err) {
      avisar('danger', 'Error: ' + err.message);
    } finally {
      setGuardando(false);
    }
  };

  const lista = datos?.mantenimientos || [];
  const resumen = datos?.resumen || {};

  // CU-76: la tabla de mantenimientos con los filtros aplicados
  const exportar = () => {
    const headers = [{ titulo: 'Fecha', formato: 'timestamp' }, 'SKU', 'Herramienta', 'Tipo', 'Descripción',
                     { titulo: 'Costo', formato: 'clp' }, { titulo: 'Próximo', formato: 'fecha' }, 'Vencido', 'Usuario'];
    const rows = lista.map(m => [
      m.fecha_mantenimiento, m.sku, m.herramienta, m.tipo, m.descripcion || '', m.costo,
      m.proximo_mantenimiento, m.vencido ? 'Sí' : 'No', m.usuario || '',
    ]);
    try { exportarCSV('mantenimientos-herramientas', headers, rows); } catch (e) { avisar('danger', e.message); }
  };

  return (
    <div className="tab-content" id="tab-mantenimiento">
      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Registrar mantenimiento</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 190 }}>
            <label className="form-label">Herramienta</label>
            <SelectorProducto id="mant-sku" value={sku} onChange={setSku} opciones={herramientas} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 140 }}>
            <label className="form-label">Tipo</label>
            <select className="form-control" id="mant-tipo" value={tipo} onChange={e => setTipo(e.target.value)}>
              <option value="preventivo">Preventivo</option>
              <option value="correctivo">Correctivo</option>
              <option value="calibracion">Calibración</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 170 }}>
            <label className="form-label">Descripción</label>
            <input className="form-control" id="mant-descripcion" value={descripcion}
              onChange={e => setDescripcion(e.target.value)} placeholder="Opcional" />
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 120 }}>
            <label className="form-label">Costo</label>
            <input className="form-control" type="number" id="mant-costo" min={0} step="0.01"
              value={costo} onChange={e => setCosto(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 160 }}>
            <label className="form-label">Próximo</label>
            <input className="form-control" type="date" id="mant-proximo" value={proximo}
              onChange={e => setProximo(e.target.value)} />
          </div>
          <button className="btn btn-primary" id="btn-mantenimiento" onClick={registrar} disabled={guardando}>
            {guardando ? 'Guardando…' : 'Registrar'}
          </button>
        </div>
      </div>

      {resumen.vencidos > 0 && !soloVencidos && (
        <div className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
          ⚠ {resumen.vencidos} herramienta(s) tienen el próximo mantenimiento vencido.{' '}
          <button className="btn btn-ghost btn-sm" style={{ padding: '0 6px' }} onClick={() => setSoloVencidos(true)}>Ver solo esos</button>
        </div>
      )}

      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Herramienta</label>
            <div style={{ minWidth: 240 }}><SelectorProducto id="fmant-sku" vacio="Todas" value={fSku} onChange={setFSku} opciones={herramientas} /></div>
          </div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Tipo</label>
            <select className="form-control" id="fmant-tipo" style={{ width: 'auto' }} value={fTipo} onChange={e => setFTipo(e.target.value)}>
              <option value="">Todos</option>
              <option value="preventivo">Preventivo</option>
              <option value="correctivo">Correctivo</option>
              <option value="calibracion">Calibración</option>
            </select>
          </div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>&nbsp;</label>
            <button className="btn btn-ghost btn-sm" id="btn-toggle-vencidos" onClick={() => setSoloVencidos(v => !v)}>
              {soloVencidos ? 'Ver todos' : 'Solo vencidos'}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
            Costo acumulado: <strong>{formatMoney(resumen.costo_total || 0)}</strong>
          </div>
          <BotonExportar id="btn-exportar-mant" className="btn btn-secondary btn-sm" onClick={exportar}
                         filas={datos ? lista.length : null} etiqueta="Exportar mantenimientos" />
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th><th>Herramienta</th><th>Tipo</th><th>Descripción</th>
                <th style={{ textAlign: 'right' }}>Costo</th>
                <th>Próximo</th><th>Usuario</th>
              </tr>
            </thead>
            <tbody id="mantenimientos-body">
              {!datos && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
              {datos && lista.length === 0 && (
                <EmptyRow colSpan={7} emptyMsg="No hay mantenimientos registrados con estos filtros." />
              )}
              {datos && lista.map(m => (
                <tr key={m.id} style={m.vencido ? { background: 'rgba(255,193,7,0.12)' } : undefined}>
                  <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>{fmtFecha(m.fecha_mantenimiento)}</td>
                  <td>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{m.herramienta}</div>
                    <div style={{ fontSize: 11, color: '#aaa' }}>{m.sku}</div>
                  </td>
                  <td><span className="badge badge-gray" style={{ fontSize: 10 }}>{m.tipo}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.descripcion || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{m.costo != null ? formatMoney(m.costo) : '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {m.proximo_mantenimiento || '—'}
                    {m.vencido && <span className="badge badge-warning" style={{ fontSize: 10, marginLeft: 6 }}>vencido</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
