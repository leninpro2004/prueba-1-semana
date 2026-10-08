import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import VariacionPrecio from '../../components/VariacionPrecio';
import { ocultaMontos } from '../../utils/user';

const lbl = { fontSize: 11, color: 'var(--gray)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 3 };

// Fecha de BD (DATE) a dd/mm/aaaa sin pasar por UTC
const fmtFecha = (f) => (f ? new Date(f).toLocaleDateString('es-CL') : '—');
const FILTRO_VACIO = { desde: '', hasta: '', sku: '' };
// CU-62: 'YYYY-MM-DD' → dd/mm/aaaa sin new Date() (un DATE parseado como UTC retrocede un día en Chile)
const fmtDia = (f) => (f ? f.split('-').reverse().join('/') : '—');
const dias = (v) => (v == null ? '—' : `${Number(v).toLocaleString('es-CL', { maximumFractionDigits: 1 })} d`);

/**
 * CU-62: plazo real de entrega del proveedor (días hábiles entre pedido y recepción
 * de cada lote) contra el plazo prometido. Visible para todos los roles: no hay montos.
 * Exc 1: sin entregas registradas → "Dato no disponible". Exc 2: pendientes aparte.
 */
function CumplimientoEntregas({ provId }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelado = false;
    API.proveedores.cumplimiento(provId)
      .then(d => { if (!cancelado) setDatos(d); })
      .catch(err => { if (!cancelado) setError('Error cargando el cumplimiento: ' + err.message); });
    return () => { cancelado = true; };
  }, [provId]);

  const r = datos?.resumen;
  const kpi = (etiqueta, valor, sub, color) => (
    <div style={{ flex: '1 1 150px', minWidth: 140 }}>
      <div style={lbl}>{etiqueta}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'inherit' }}>{valor}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--gray)' }}>{sub}</div>}
    </div>
  );
  const colorCumpl = (pct) => (pct == null ? 'inherit' : pct >= 90 ? 'var(--success)' : pct >= 70 ? 'var(--warning)' : 'var(--danger)');

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="section-label">Cumplimiento de entregas</div>
      {error && <div className="alert alert-danger">{error}</div>}
      {!datos && !error && <p style={{ fontSize: 13, color: 'var(--gray)' }}>Cargando…</p>}

      {r && !r.disponible && (
        <div className="empty-state">
          <div className="empty-state-icon">📦</div>
          <p style={{ fontSize: 15, fontWeight: 600 }}>Dato no disponible</p>
          <p style={{ marginTop: 6 }}>
            Este proveedor no registra entregas con fecha de pedido y de recepción. Para medir su plazo real, ingrese la
            <strong> fecha del pedido</strong> al registrar la entrada de mercadería.
          </p>
          {r.pendientes > 0 && <p style={{ marginTop: 6 }}>{r.pendientes} pedido(s) pendiente(s) de recepción.</p>}
        </div>
      )}

      {r?.disponible && (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            {kpi('Plazo real promedio', dias(r.promedio_dias),
              r.plazo_prometido_promedio != null ? `Prometido: ${dias(r.plazo_prometido_promedio)}` : 'Sin plazo prometido registrado',
              r.plazo_prometido_promedio != null && r.promedio_dias > r.plazo_prometido_promedio ? 'var(--danger)' : null)}
            {kpi('Mediana', dias(r.mediana_dias))}
            {kpi('Mínimo / máximo', `${dias(r.minimo_dias)} / ${dias(r.maximo_dias)}`)}
            {kpi('Cumplimiento', r.cumplimiento_pct != null ? `${r.cumplimiento_pct.toLocaleString('es-CL')} %` : 'Sin datos',
              r.con_plazo ? `${r.a_tiempo} de ${r.con_plazo} a tiempo` : 'Ningún producto tiene plazo prometido', colorCumpl(r.cumplimiento_pct))}
            {kpi('Pendientes de recepción', r.pendientes, 'No entran al cálculo')}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Lote</th><th>Producto</th><th>Pedido</th><th>Recepción</th><th>Días hábiles</th><th>Prometido</th><th>Resultado</th></tr>
              </thead>
              <tbody id="tbody-entregas">
                {datos.entregas.map(e => (
                  <tr key={e.lote_id}>
                    <td><span className="td-mono" style={{ fontSize: 11 }}>{e.lote || `#${e.lote_id}`}</span></td>
                    <td style={{ fontSize: 13 }}>
                      {e.sku ? <Link to={`/productos/${e.sku}`} style={{ color: 'inherit' }}>{e.producto || e.sku}</Link> : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>{fmtDia(e.fecha_pedido)}</td>
                    <td style={{ fontSize: 12 }}>{e.fecha_recepcion ? fmtDia(e.fecha_recepcion) : <span style={{ color: 'var(--warning)' }}>Pendiente</span>}</td>
                    <td style={{ fontWeight: 600 }}>{e.dias_habiles ?? '—'}</td>
                    <td>{e.plazo_prometido ?? <span style={{ color: 'var(--gray)' }}>—</span>}</td>
                    <td>
                      {e.fecha_recepcion == null ? <span className="badge badge-gray">En tránsito</span>
                        : e.a_tiempo == null ? <span className="badge badge-gray">Sin plazo</span>
                        : e.a_tiempo ? <span className="badge badge-success">A tiempo</span>
                        : <span className="badge badge-danger">Con retraso</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 12, marginBottom: 0 }}>
        Días hábiles: lunes a viernes, sin feriados. Plazo real = desde la fecha del pedido hasta la recepción del lote.
        Plazo prometido = tiempo de reposición vigente del producto con este proveedor.
      </p>
    </div>
  );
}

/**
 * CU-61: historial de precios del proveedor, en orden cronologico. Solo gerencia.
 * Exc 1: el proveedor no tiene precios. Exc 2: el filtro no trae datos → se avisa
 * y se mantiene el filtro anterior (campos y tabla).
 */
function HistorialPrecios({ provId }) {
  const [filtro, setFiltro] = useState(FILTRO_VACIO);     // lo que esta en los campos
  const [aplicado, setAplicado] = useState(FILTRO_VACIO); // el ultimo filtro con resultados
  const [datos, setDatos] = useState(null);                // { precios, productos, total_proveedor }
  const [aviso, setAviso] = useState(null);                // { type, msg }

  const consultar = useCallback(async (f) => {
    try {
      const r = await API.proveedores.precios(provId, { desde: f.desde || null, hasta: f.hasta || null, sku: f.sku || null });
      return r;
    } catch (err) {
      setAviso({ type: 'danger', msg: 'Error cargando el historial de precios: ' + err.message });
      return null;
    }
  }, [provId]);

  // Carga inicial sin filtros
  useEffect(() => {
    let cancelado = false;
    (async () => {
      const r = await consultar(FILTRO_VACIO);
      if (!cancelado && r) setDatos(r);
    })();
    return () => { cancelado = true; };
  }, [consultar]);

  const rangoInvalido = Boolean(filtro.desde && filtro.hasta && filtro.desde > filtro.hasta);

  const filtrar = async () => {
    if (rangoInvalido) return;
    const r = await consultar(filtro);
    if (!r) return;
    if (r.precios.length === 0 && r.total_proveedor > 0) {
      // Exc 2: se mantiene el filtro anterior
      setAviso({ type: 'warning', msg: 'No hay precios registrados para el período consultado. Se mantiene el filtro anterior.' });
      setFiltro(aplicado);
      return;
    }
    setAviso(null);
    setAplicado(filtro);
    setDatos(r);
  };

  const limpiar = async () => {
    setFiltro(FILTRO_VACIO);
    const r = await consultar(FILTRO_VACIO);
    if (r) { setAviso(null); setAplicado(FILTRO_VACIO); setDatos(r); }
  };

  const cambiar = (campo) => (e) => setFiltro(f => ({ ...f, [campo]: e.target.value }));
  const sinHistorial = datos && datos.total_proveedor === 0;

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="section-label">Historial de precios</div>
      {aviso && <div className={`alert alert-${aviso.type}`} style={{ fontSize: 12 }}>{aviso.msg}</div>}

      {sinHistorial ? (
        <div className="empty-state"><div className="empty-state-icon">💲</div><p>Este proveedor no registra historial de costos para analizar.</p></div>
      ) : (
        <>
          <div className="filter-row" style={{ marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div><label className="form-label" style={{ marginBottom: 4 }}>Desde</label>
              <input className="form-control" type="date" style={{ width: 'auto', ...(rangoInvalido && { borderColor: 'var(--danger)' }) }} value={filtro.desde} onChange={cambiar('desde')} /></div>
            <div><label className="form-label" style={{ marginBottom: 4 }}>Hasta</label>
              <input className="form-control" type="date" style={{ width: 'auto', ...(rangoInvalido && { borderColor: 'var(--danger)' }) }} value={filtro.hasta} onChange={cambiar('hasta')} /></div>
            <div><label className="form-label" style={{ marginBottom: 4 }}>Producto</label>
              <select className="form-control" style={{ width: 'auto' }} value={filtro.sku} onChange={cambiar('sku')}>
                <option value="">Todos los productos</option>
                {(datos?.productos || []).map(p => <option key={p.sku} value={p.sku}>{p.sku} — {p.nombre}</option>)}
              </select></div>
            <button className="btn btn-primary btn-sm" onClick={filtrar} disabled={rangoInvalido}>Filtrar</button>
            <button className="btn btn-ghost btn-sm" onClick={limpiar}>Limpiar</button>
          </div>
          {rangoInvalido && (
            <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>La fecha de inicio es posterior a la fecha de fin. Corrija el rango.</div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Fecha</th><th>Producto</th><th>Precio anterior</th><th>Precio unitario</th><th>Variación</th><th>Fuente</th><th>Usuario</th></tr>
              </thead>
              <tbody>
                {!datos && <tr><td colSpan={7} style={{ color: 'var(--gray)' }}>Cargando…</td></tr>}
                {(datos?.precios || []).map(h => (
                  <tr key={h.id}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {fmtFecha(h.fecha)}
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>{h.fecha_hasta ? `hasta ${fmtFecha(h.fecha_hasta)}` : 'Vigente'}</div>
                    </td>
                    <td>
                      <Link to={`/productos/${h.sku}`} style={{ color: 'inherit', textDecoration: 'none', fontWeight: 500, fontSize: 13 }}>{h.material}</Link>
                      <div style={{ fontSize: 11, color: '#aaa' }}>{h.sku}</div>
                    </td>
                    {/* CU-64: precio anterior del mismo producto con este proveedor */}
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{h.precio_anterior != null ? formatMoney(h.precio_anterior) : '—'}</td>
                    <td style={{ fontWeight: 600 }}>{formatMoney(h.precio_unitario)}{h.moneda && h.moneda !== 'CLP' ? ` ${h.moneda}` : ''}</td>
                    <td><VariacionPrecio abs={h.variacion_abs} pct={h.variacion_pct} anterior={h.precio_anterior} registros={h.registros_producto} /></td>
                    <td style={{ fontSize: 12 }}>{h.fuente}{h.factura ? ` · Factura N° ${h.factura}` : ''}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{h.usuario || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Detalle Proveedor — conversión 1:1 de proveedores/detalle.html (?id= → /proveedores/:id).
 * data-rol="gerencia": columna "Precio referencial" (oculta si rol === 'jop').
 */
export default function ProveedorDetalle() {
  usePageTitle('Detalle Proveedor');
  const { id: provId } = useParams();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const verPrecio = !ocultaMontos(user);
  const esGerencia = user?.rol === 'gerencia'; // CU-61: el historial de precios es solo de gerencia

  const [p, setP] = useState(null);
  const [titulo, setTitulo] = useState('Cargando...');

  useEffect(() => {
    if (!provId) { showAlert('danger', 'ID de proveedor no especificado.'); return; }
    let cancelado = false;
    (async () => {
      try {
        const data = await API.proveedores.obtener(provId);
        if (cancelado) return;
        setP(data);
        setTitulo(data?.nombre || '—');
      } catch (err) {
        if (cancelado) return;
        showAlert('danger', 'Error cargando proveedor: ' + err.message);
        setTitulo('Error cargando proveedor');
      }
    })();
    return () => { cancelado = true; };
  }, [provId, showAlert]);

  const materiales = p?.materiales || [];
  const contactoNombre = p ? [p.contacto_nombre, p.contacto_apellido].filter(Boolean).join(' ') : '';

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title" id="prov-nombre">{titulo}</div>
          <div className="page-subtitle" id="prov-meta">{p ? `ID: ${p.id}` + (p.rut ? ` · RUT: ${p.rut}` : '') : ''}</div>
        </div>
        <Link to="/proveedores" className="btn btn-ghost">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
          Volver a proveedores
        </Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        <div className="card">
          <div className="section-label">Datos del proveedor</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><div style={lbl}>RUT</div><div className="td-mono" id="prov-rut">{p?.rut || '—'}</div></div>
            <div><div style={lbl}>Tipo</div><div id="prov-tipo">{p?.tipo || '—'}</div></div>
            <div><div style={lbl}>Rubro</div><div id="prov-rubro">{p?.rubro || '—'}</div></div>
            <div><div style={lbl}>País</div><div id="prov-pais">{p?.pais || '—'}</div></div>
            <div>
              <div style={lbl}>Estado</div>
              <span className={'badge' + (p ? (['activo', 'activa'].includes(p.estado) ? ' badge-success' : ' badge-gray') : '')} id="prov-estado-badge">{p?.estado || '—'}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="section-label">Contacto</div>
          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Persona de contacto</div>
            <div id="prov-contacto" style={{ fontWeight: 500 }}>{contactoNombre || '—'}</div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ ...lbl, marginBottom: 6 }}>Correos</div>
            <div id="prov-correos">
              {!p && '—'}
              {p && (p.correos?.length
                ? p.correos.map(c => <a key={c} href={`mailto:${c}`} style={{ color: 'var(--orange)', fontSize: 13, display: 'block' }}>{c}</a>)
                : <span style={{ color: 'var(--gray)', fontSize: 13 }}>Sin correos registrados</span>)}
            </div>
          </div>
          <div>
            <div style={{ ...lbl, marginBottom: 6 }}>Teléfonos</div>
            <div id="prov-telefonos">
              {!p && '—'}
              {p && (p.telefonos?.length
                ? p.telefonos.map(t => <span key={t} style={{ fontSize: 13, display: 'block' }}>{t}</span>)
                : <span style={{ color: 'var(--gray)', fontSize: 13 }}>Sin teléfonos registrados</span>)}
            </div>
          </div>
        </div>
      </div>

      {/* Materiales que provee */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="section-label" style={{ marginBottom: 0 }}>Materiales suministrados (FR-41)</div>
          <div style={{ fontSize: 12, color: 'var(--gray)' }} id="materiales-count">{p ? `${materiales.length} material(es) asociado(s)` : ''}</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th><th>Material</th><th>Tiempo reposición</th>
                {verPrecio && <th>Precio referencial</th>}
                <th>Proveedor principal</th>
              </tr>
            </thead>
            <tbody id="tbody-materiales">
              {p && materiales.length === 0 && (
                <tr><td colSpan={5}><div className="empty-state"><div className="empty-state-icon">📦</div><p>Este proveedor no tiene materiales asociados.</p></div></td></tr>
              )}
              {materiales.map(m => (
                <tr key={m.sku}>
                  <td><span className="td-mono">{m.sku}</span></td>
                  <td style={{ fontWeight: 500, fontSize: 13 }}>
                    <Link to={`/productos/${m.sku}`} style={{ color: 'inherit', textDecoration: 'none' }}>{m.nombre}</Link>
                  </td>
                  <td>
                    {m.tiempo_reposicion != null
                      ? <><span style={{ fontWeight: 600 }}>{Math.round(m.tiempo_reposicion)}</span> <span style={{ fontSize: 11, color: 'var(--gray)' }}>días</span></>
                      : <span style={{ color: 'var(--gray)' }}>—</span>}
                  </td>
                  {verPrecio && (
                    <td>
                      {m.precio_referencial != null
                        ? <span style={{ fontWeight: 500 }}>{formatMoney(m.precio_referencial)}</span>
                        : <span style={{ color: 'var(--gray)' }}>—</span>}
                    </td>
                  )}
                  <td>{m.es_principal ? <span className="badge badge-orange">Principal</span> : <span className="badge badge-gray">Secundario</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* CU-62: todos los roles (sin montos) */}
      {provId && <CumplimientoEntregas provId={provId} />}

      {esGerencia && provId && <HistorialPrecios provId={provId} />}
    </>
  );
}
