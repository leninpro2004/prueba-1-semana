import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import { fechaLocal } from '../../utils/format';
import Alert, { useAlert } from '../../components/Alert';
import Pagination from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import BotonExportar from '../../components/BotonExportar';
import { exportarCSV, ErrorExportacion, LIMITE_FILAS } from '../../utils/csvExport';

const getPrioridadCls = (p) => p === 'urgente' ? 'badge-danger' : p === 'alta' ? 'badge-warning' : 'badge-gray';
const BORDER = { urgente: 'var(--danger)', alta: 'var(--warning)', media: 'var(--gray-mid)' };
const fecha = (a) => fechaLocal(a.fecha_generacion);
// CU-57: "−2 (−6,67 %)"; sin stock teórico no hay porcentaje
const num = (v) => Number(v).toLocaleString('es-CL', { maximumFractionDigits: 4 });
const difConteo = (a) => {
  const d = parseFloat(a.diferencia);
  const signo = (v) => (v > 0 ? '+' : '');
  const pct = a.diferencia_pct == null ? 'sin stock teórico' : `${signo(parseFloat(a.diferencia_pct))}${num(a.diferencia_pct)} %`;
  return `${signo(d)}${num(d)} (${pct})`;
};

/** CU-47: productos que la evaluación no pudo calcular (no son alertas: solo viven en la respuesta). */
function ListaProductos({ titulo, ayuda, items, conMotivo = false }) {
  if (!items?.length) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title">{titulo} ({items.length})</div>
      <p style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 8 }}>{ayuda}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Producto</th><th>Stock disponible</th>{conMotivo && <th>Motivo</th>}</tr></thead>
          <tbody>
            {items.map(p => (
              <tr key={p.sku}>
                <td><Link to={`/productos/${encodeURIComponent(p.sku)}`} style={{ fontWeight: 500 }}>{p.nombre}</Link><div style={{ fontSize: 11, color: '#aaa' }}>{p.sku}</div></td>
                <td>{num(p.stock_disponible)}</td>
                {conMotivo && <td style={{ fontSize: 12 }}>{p.motivo}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** CU-47: productos en riesgo que dejó la evaluación (críticos primero), con su alerta nueva o actualizada. */
function TablaEnRiesgo({ criticas, preventivas }) {
  const filas = [
    ...criticas.map(p => ({ ...p, critico: true })),
    ...[...preventivas].sort((a, b) => a.dias_restantes - b.dias_restantes),
  ];
  if (filas.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title">En riesgo ({filas.length})</div>
      <p style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 8 }}>
        Productos que se agotan antes de que llegue la reposición, o que ya no tienen stock disponible.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Producto</th><th>Tipo</th><th>Stock disponible</th><th>Días restantes</th><th>Plazo</th>
              <th>Proveedor sugerido</th><th>Cantidad sugerida</th><th>Observaciones</th><th>Alerta</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(p => (
              <tr key={p.sku}>
                <td><Link to={`/productos/${encodeURIComponent(p.sku)}`} style={{ fontWeight: 500 }}>{p.nombre}</Link><div style={{ fontSize: 11, color: '#aaa' }}>{p.sku}</div></td>
                <td>{p.critico
                  ? <span className="badge badge-danger">Crítico</span>
                  : <span className="badge badge-warning">Preventivo</span>}</td>
                <td>{num(p.stock_disponible)}</td>
                <td>{p.critico ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Sin stock</span> : num(p.dias_restantes)}</td>
                <td style={{ fontSize: 12 }}>
                  {p.plazo_dias_habiles != null
                    ? <>{p.plazo_dias_habiles} días hábiles<div style={{ color: 'var(--gray)' }}>({p.plazo_dias_corridos} corridos)</div></>
                    : <span style={{ color: 'var(--warning)' }}>Sin plazo</span>}
                </td>
                <td style={{ fontSize: 12 }}>{p.proveedor || <span style={{ color: 'var(--warning)' }}>Sin proveedor con plazo</span>}</td>
                <td style={{ fontWeight: 600 }}>{p.cantidad_sugerida != null ? num(p.cantidad_sugerida) : '—'}</td>
                <td style={{ fontSize: 12, maxWidth: 280 }}>{p.notas?.length ? p.notas.join(' ') : '—'}</td>
                <td>{p.alerta === 'nueva'
                  ? <span className="badge badge-orange">Nueva</span>
                  : <span className="badge badge-gray">Actualizada</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SIN_CATEGORIA = '__sin__';

/** CU-48: días restantes según lo que dejó la evaluación (CU-47). */
function diasRestantes(a) {
  if (a.urgencia === 'critica' && a.stock_disponible <= 0) return <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Sin stock</span>;
  if (a.fecha_agotamiento == null) return <span style={{ color: 'var(--gray)' }}>Sin evaluar</span>;
  if (a.dias_restantes <= 0) return <span style={{ color: 'var(--danger)', fontWeight: 600 }} title={`Agotamiento estimado: ${a.fecha_agotamiento}`}>Hoy o antes</span>;
  return <span title={`Agotamiento estimado: ${a.fecha_agotamiento}`}>{a.dias_restantes} día(s)</span>;
}

/**
 * CU-48: panel de alertas de reposición activas, ordenadas por urgencia, con
 * filtros por urgencia y categoría que se aplican solos.
 */
function TablaAlertasReposicion({ alertas }) {
  const [fu, setFu] = useState('');   // urgencia
  const [fc, setFc] = useState('');   // categoría

  // Exc 1: sin alertas activas no se despliega la tabla
  if (alertas.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16 }}><div className="empty-state">
        <div className="empty-state-icon">✅</div>
        <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--success)' }}>Inventario bajo control</p>
        <p style={{ marginTop: 8 }}>No hay alertas de reposición activas.</p>
      </div></div>
    );
  }

  const categorias = [...new Set(alertas.map(a => a.categoria).filter(Boolean))].sort();
  const haySinCategoria = alertas.some(a => !a.categoria);
  const filtradas = alertas.filter(a =>
    (!fu || a.urgencia === fu) &&
    (!fc || (fc === SIN_CATEGORIA ? !a.categoria : a.categoria === fc)));
  const hayFiltros = Boolean(fu || fc);
  const limpiar = () => { setFu(''); setFc(''); };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title">Alertas de reposición activas ({alertas.length})</div>
      <div className="filter-row" style={{ marginBottom: 12 }}>
        <select className="form-control" id="filter-urgencia-repo" style={{ width: 'auto' }} value={fu} onChange={e => setFu(e.target.value)}>
          <option value="">Todas las urgencias</option>
          <option value="critica">Crítica (sin stock)</option>
          <option value="preventiva">Preventiva</option>
        </select>
        <select className="form-control" id="filter-categoria-repo" style={{ width: 'auto' }} value={fc} onChange={e => setFc(e.target.value)}>
          <option value="">Todas las categorías</option>
          {categorias.map(c => <option key={c} value={c}>{c}</option>)}
          {haySinCategoria && <option value={SIN_CATEGORIA}>Sin categoría</option>}
        </select>
        {hayFiltros && <button className="btn btn-ghost btn-sm" onClick={limpiar}>Limpiar filtros</button>}
      </div>

      {/* Exc 2: los filtros no devuelven nada (distinto de la Exc 1) */}
      {filtradas.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <p style={{ fontSize: 16, fontWeight: 600 }}>Sin coincidencias</p>
          <p style={{ marginTop: 8 }}>No hay alertas que coincidan con los criterios seleccionados.</p>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={limpiar}>Limpiar filtros</button>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Producto</th><th>Urgencia</th><th>Stock disponible</th><th>Días restantes</th>
                <th>Proveedor sugerido</th><th>Plazo</th><th>Cantidad sugerida</th><th>Observaciones</th>
              </tr>
            </thead>
            <tbody id="tbody-reposicion">
              {filtradas.map(a => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/productos/${encodeURIComponent(a.sku)}`} style={{ fontWeight: 500 }}>{a.producto}</Link>
                    <div style={{ fontSize: 11, color: '#aaa' }}>{a.sku}{a.categoria ? ` · ${a.categoria}` : ''}</div>
                  </td>
                  <td>{a.urgencia === 'critica'
                    ? <span className="badge badge-danger">Crítica</span>
                    : <span className="badge badge-warning">Preventiva</span>}</td>
                  <td>{num(a.stock_disponible)}</td>
                  <td>{diasRestantes(a)}</td>
                  <td style={{ fontSize: 12 }}>
                    {a.proveedor || (a.fecha_agotamiento == null
                      ? <span style={{ color: 'var(--gray)' }}>Sin evaluar</span>
                      : <span style={{ color: 'var(--warning)' }}>Sin proveedor con plazo</span>)}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {a.plazo_dias_habiles != null
                      ? <>{a.plazo_dias_habiles} días hábiles<div style={{ color: 'var(--gray)' }}>({a.plazo_dias_corridos} corridos)</div></>
                      : '—'}
                  </td>
                  <td style={{ fontWeight: 600 }}>{a.cantidad_sugerida != null ? num(a.cantidad_sugerida) : '—'}</td>
                  <td style={{ fontSize: 12, maxWidth: 320, color: 'var(--gray)' }}>
                    {a.fecha_agotamiento == null ? 'Pulse "Evaluar cobertura" para calcular días, proveedor y cantidad.' : a.observaciones}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** CU-47: evaluación de cobertura de stock contra el plazo del proveedor (gerencia y jop). */
function PanelReposicion({ onEvaluado }) {
  const { user } = useAuth();
  const puedeEvaluar = ['gerencia', 'jop'].includes(user?.rol);
  const [evaluando, setEvaluando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState('');
  // CU-48: alertas de reposición activas (null = cargando)
  const [alertasRepo, setAlertasRepo] = useState(null);
  const [recarga, setRecarga] = useState(0);   // se incrementa tras cada evaluación

  useEffect(() => {
    if (!puedeEvaluar) return undefined;
    let cancelado = false;
    API.alertas.reposicion()
      .then(data => { if (!cancelado) setAlertasRepo(Array.isArray(data) ? data : []); })
      .catch(err => { if (!cancelado) setError('No se pudieron cargar las alertas de reposición: ' + err.message); });
    return () => { cancelado = true; };
  }, [puedeEvaluar, recarga]);

  const evaluar = async () => {
    setEvaluando(true);
    setError('');
    try {
      const r = await API.alertas.evaluarReposicion();
      setResultado(r);
      onEvaluado?.();
      setRecarga(n => n + 1);
    } catch (err) {
      setError('No se pudo evaluar la cobertura: ' + err.message);
    } finally {
      setEvaluando(false);
    }
  };

  return (
    <>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: 'var(--gray)', lineHeight: 1.6 }}>
          Compara los días de stock que quedan (consumo promedio de los últimos 90 días) con el plazo de entrega
          del proveedor. Los productos que se agotarían antes de que llegue el pedido generan una alerta preventiva;
          los que ya no tienen stock, una alerta crítica.
        </div>
        {puedeEvaluar
          ? <button className="btn btn-primary" id="btn-evaluar-reposicion" onClick={evaluar} disabled={evaluando}>
              {evaluando ? 'Evaluando…' : 'Evaluar cobertura'}
            </button>
          : <span style={{ fontSize: 12, color: 'var(--gray)' }}>Solo Gerencia y Jefatura de Operaciones pueden evaluar.</span>}
      </div>

      {error && <div className="alert alert-danger" style={{ marginTop: 16 }}>{error}</div>}

      {resultado && (
        <>
          <div className={`alert ${resultado.en_riesgo > 0 ? 'alert-warning' : 'alert-success'}`} style={{ marginTop: 16 }}>
            <div><strong>{resultado.message}</strong></div>
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Alertas: <strong>{resultado.nuevas}</strong> nueva(s) · <strong>{resultado.actualizadas}</strong> actualizada(s) ·{' '}
              <strong>{resultado.resueltas}</strong> resuelta(s) por ya no estar en riesgo
            </div>
            <div style={{ fontSize: 12, marginTop: 4, color: 'var(--gray)' }}>
              {resultado.evaluados} producto(s) evaluado(s).
              {resultado.en_riesgo > 0 && ' Las alertas también quedan en la pestaña Alertas.'}
            </div>
          </div>
          <div className="kpi-grid" style={{ marginTop: 16 }}>
            <div className="kpi-card kpi-danger"><div className="kpi-label">Críticos</div><div className="kpi-value danger">{resultado.criticas.length}</div><div className="kpi-sub">Sin stock disponible</div></div>
            <div className="kpi-card kpi-warning"><div className="kpi-label">Preventivos</div><div className="kpi-value warning">{resultado.preventivas.length}</div><div className="kpi-sub">Se agotan antes de la reposición</div></div>
            <div className="kpi-card"><div className="kpi-label">Sin rotación</div><div className="kpi-value">{resultado.sin_rotacion.length}</div><div className="kpi-sub">Sin consumo en 90 días</div></div>
            <div className="kpi-card"><div className="kpi-label">Pendientes de configuración</div><div className="kpi-value">{resultado.pendientes_configuracion.length}</div><div className="kpi-sub">Sin proveedor con plazo</div></div>
          </div>
          <TablaEnRiesgo criticas={resultado.criticas} preventivas={resultado.preventivas} />
          <ListaProductos titulo="Pendientes de configuración" conMotivo items={resultado.pendientes_configuracion}
            ayuda="No se puede proyectar la reposición: registre un proveedor con tiempo de reposición en la ficha del producto." />
          <ListaProductos titulo="Sin rotación" items={resultado.sin_rotacion}
            ayuda="Sin consumo en los últimos 90 días: no se pueden calcular los días de stock restante y no generan alerta." />
        </>
      )}

      {/* CU-48: panel permanente de alertas de reposición */}
      {puedeEvaluar && alertasRepo !== null && <TablaAlertasReposicion alertas={alertasRepo} />}
    </>
  );
}

/** CU-55: duración legible ("2 d 3 h", "45 min", "menos de 1 min"). */
function duracion(segundos) {
  if (segundos == null) return '—';
  const min = Math.floor(segundos / 60);
  if (min < 1) return 'menos de 1 min';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** Fecha local YYYY-MM-DD (nunca desde toISOString(), que es UTC). */
function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const fechaHora = (v) => (v ? new Date(v).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * CU-55: historial de alertas (resueltas y pendientes) con el tiempo de resolución
 * y quién la resolvió. Filtros por fechas de generación, tipo y producto.
 */
function HistorialAlertas({ tipos }) {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [tipo, setTipo] = useState('');
  const [producto, setProducto] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const hoy = hoyLocal();

  // Exc 2: rango incoherente o con fechas futuras. Se bloquea la consulta.
  const errorRango = desde && hasta && desde > hasta
    ? 'La fecha de inicio es posterior a la fecha de fin. Corrija el rango.'
    : (desde > hoy || hasta > hoy) ? 'El rango incluye fechas futuras. Corrija el rango.' : '';

  useEffect(() => {
    if (errorRango) return undefined;
    let cancelado = false;
    API.alertas.historial({ desde, hasta, tipo, producto: producto.trim() })
      .then(d => { if (!cancelado) { setData(d); setError(''); } })
      .catch(err => { if (!cancelado) setError('Error cargando el historial: ' + err.message); });
    return () => { cancelado = true; };
  }, [desde, hasta, tipo, producto, errorRango]);

  const pag = usePagination(data?.alertas, 20);
  const hayFiltros = Boolean(desde || hasta || tipo || producto);
  const limpiar = () => { setDesde(''); setHasta(''); setTipo(''); setProducto(''); };

  // CU-76: la vista muestra 500; el CSV vuelve a pedir TODO lo filtrado (hasta 10.000)
  const [exportando, setExportando] = useState(false);
  const exportar = async () => {
    setExportando(true);
    try {
      const d = await API.alertas.historial({ desde, hasta, tipo, producto: producto.trim(), exportar: 1 });
      if (d.resumen.total > LIMITE_FILAS) {
        throw new ErrorExportacion(
          `El historial filtrado tiene ${d.resumen.total.toLocaleString('es-CL')} alertas y el límite de exportación es ` +
          `${LIMITE_FILAS.toLocaleString('es-CL')}. Acote los filtros antes de descargar.`);
      }
      const headers = ['ID', { titulo: 'Generada', formato: 'timestamp' }, { titulo: 'Resuelta', formato: 'timestamp' },
                       'SKU', 'Producto', 'Tipo', 'Severidad', 'Estado',
                       { titulo: 'Tiempo de resolución (horas)', formato: 'numero' }, 'Resuelta por'];
      const rows = d.alertas.map(a => [
        a.id, a.fecha_generacion, a.en_curso ? '' : a.fecha_resolucion, a.sku, a.producto, a.tipo, a.severidad,
        a.estado, a.tiempo_resolucion_segundos == null ? '' : Math.round(a.tiempo_resolucion_segundos / 36) / 100,
        a.en_curso ? '' : a.resuelta_por,
      ]);
      exportarCSV('historial-alertas', headers, rows);
      setError('');
    } catch (err) {
      setError(err instanceof ErrorExportacion ? err.message : 'No se pudo generar el archivo: ' + err.message);
    } finally {
      setExportando(false);
    }
  };

  // Exc 1: no hay alertas en el sistema → no se despliega la tabla
  if (data && data.total_sistema === 0) {
    return (
      <div className="card"><div className="empty-state">
        <div className="empty-state-icon">📭</div>
        <p style={{ fontSize: 16, fontWeight: 600 }}>Sin historial de alertas</p>
        <p style={{ marginTop: 8 }}>Todavía no se ha registrado ninguna alerta en el sistema.</p>
      </div></div>
    );
  }

  const r = data?.resumen;
  return (
    <>
      {/* Filtros en una tarjeta, como en Productos y Movimientos: así la búsqueda no se funde con el fondo */}
      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
          <div className="search-bar" style={{ flex: 1, minWidth: 200 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="hist-producto" placeholder="Producto (SKU o nombre)…" autoComplete="off" value={producto} onChange={e => setProducto(e.target.value)} />
          </div>
          <select className="form-control" id="hist-tipo" style={{ width: 'auto' }} value={tipo} onChange={e => setTipo(e.target.value)}>
            <option value="">Todos los tipos</option>
            {tipos.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input type="date" className="form-control" id="hist-desde" title="Generadas desde" max={hoy} style={{ width: 'auto', ...(errorRango && { borderColor: 'var(--danger)' }) }} value={desde} onChange={e => setDesde(e.target.value)} />
          <input type="date" className="form-control" id="hist-hasta" title="Generadas hasta" max={hoy} style={{ width: 'auto', ...(errorRango && { borderColor: 'var(--danger)' }) }} value={hasta} onChange={e => setHasta(e.target.value)} />
          {hayFiltros && <button className="btn btn-ghost btn-sm" onClick={limpiar}>Limpiar filtros</button>}
          <BotonExportar className="btn btn-secondary btn-sm" onClick={exportar} cargando={exportando}
                         filas={data ? (errorRango ? 0 : data.alertas.length) : null} />
        </div>
      </div>

      {errorRango && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{errorRango}</div>}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {r && !errorRango && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi-card"><div className="kpi-label">Alertas</div><div className="kpi-value">{r.total}</div><div className="kpi-sub">{hayFiltros ? 'Con los filtros aplicados' : 'Todas las registradas'}</div></div>
          <div className="kpi-card kpi-success"><div className="kpi-label">Resueltas</div><div className="kpi-value" style={{ color: 'var(--success)' }}>{r.resueltas}</div><div className="kpi-sub">{r.resueltas_con_tiempo} con tiempo registrado</div></div>
          <div className="kpi-card kpi-warning"><div className="kpi-label">Pendientes</div><div className="kpi-value warning">{r.pendientes}</div><div className="kpi-sub">Resolución en curso</div></div>
          <div className="kpi-card"><div className="kpi-label">Tiempo promedio de resolución</div><div className="kpi-value" style={{ fontSize: 22 }}>{duracion(r.tiempo_promedio_segundos)}</div><div className="kpi-sub">Sin pendientes ni resueltas sin fecha</div></div>
        </div>
      )}

      {data && !errorRango && (
        <div className="card">
          {data.limitado && (
            <div className="alert alert-warning" style={{ marginBottom: 12 }}>
              Se muestran las 500 alertas más recientes de {r.total}. Acote los filtros para ver las anteriores; los indicadores sí consideran todas.
            </div>
          )}
          {data.alertas.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🔍</div>
              <p style={{ fontSize: 16, fontWeight: 600 }}>Sin coincidencias</p>
              <p style={{ marginTop: 8 }}>Ninguna alerta coincide con los filtros aplicados.</p>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={limpiar}>Limpiar filtros</button>
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th><th>Generada</th><th>Resuelta</th><th>Producto</th><th>Tipo</th><th>Severidad</th>
                      <th>Estado</th><th>Tiempo de resolución</th><th>Resuelta por</th>
                    </tr>
                  </thead>
                  <tbody id="tbody-historial">
                    {pag.items.map(a => (
                      <tr key={a.id}>
                        <td><span className="td-mono" style={{ fontSize: 11 }}>{a.id}</span></td>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fechaHora(a.fecha_generacion)}</td>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{a.en_curso ? '—' : fechaHora(a.fecha_resolucion)}</td>
                        <td style={{ fontSize: 13 }}><div style={{ fontWeight: 500 }}>{a.producto}</div><div style={{ fontSize: 11, color: '#aaa' }}>{a.sku}</div></td>
                        <td style={{ fontSize: 13 }}>{a.tipo}</td>
                        <td><span className={`badge ${getPrioridadCls(a.severidad)}`}>{a.severidad}</span></td>
                        <td><span className={`badge ${a.en_curso ? 'badge-warning' : 'badge-success'}`}>{a.estado}</span></td>
                        <td style={{ fontSize: 13 }}>
                          {a.en_curso ? <span style={{ color: 'var(--warning)', fontWeight: 600 }}>En curso</span>
                            : a.tiempo_resolucion_segundos == null ? <span style={{ color: 'var(--gray)' }}>Sin registro</span>
                            : duracion(a.tiempo_resolucion_segundos)}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {a.resuelta_por == null ? '—'
                            : a.resuelta_por === 'Sistema' ? <span title="Cerrada automáticamente al normalizarse el stock o al reevaluar la cobertura">Sistema</span>
                            : a.resuelta_por === 'Sin registro' ? <span style={{ color: 'var(--gray)' }} title="Resuelta antes de que se registrara quién y cuándo">Sin registro</span>
                            : a.resuelta_por}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination {...pag} />
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Centro de Alertas — conversión 1:1 de alertas/alertas.html (?detalle=ID abre el modal) */
export default function Alertas() {
  usePageTitle('Alertas');
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const [params] = useSearchParams();
  // CU-47 / CU-55: pestañas (?tab=reposicion o ?tab=historial la abren directamente)
  const [tab, setTab] = useState(['reposicion', 'historial'].includes(params.get('tab')) ? params.get('tab') : 'alertas');

  const [alertas, setAlertas] = useState(null);
  const [fp, setFp] = useState('');
  // CU-55: esta pestaña muestra solo activas; las resueltas se consultan en "Historial"
  const [ft, setFt] = useState('');            // tipo de alerta (OPUS-17)
  const [fc, setFc] = useState(false);         // solo materiales críticos (OPUS-17)
  const [tipos, setTipos] = useState([]);
  const [detalle, setDetalle] = useState(null); // null | 'no-encontrada' | alerta
  const detalleAbierto = useRef(false);
  // CU-55: total de resueltas (del historial) para el indicador que lleva a la pestaña Historial
  const [resueltas, setResueltas] = useState(null);
  const [recargaResueltas, setRecargaResueltas] = useState(0);

  const cargarAlertas = useCallback(async () => {
    try {
      const data = await API.alertas.listar({
        prioridad: fp || null,
        estado: 'activa',
        tipo: ft || null,
        solo_criticos: fc || null,
      });
      const lista = Array.isArray(data) ? data : [];
      setAlertas(lista);
      return lista;
    } catch (err) {
      showAlert('danger', 'Error cargando alertas: ' + err.message);
    }
  }, [fp, ft, fc, showAlert]);

  // Catálogo de tipos para el filtro; si falla, el select queda solo con "Todos los tipos"
  useEffect(() => {
    API.alertas.tipos().then(t => setTipos(Array.isArray(t) ? t : [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelado = false;
    API.alertas.historial()
      .then(d => { if (!cancelado) setResueltas(d?.resumen?.resueltas ?? null); })
      .catch(() => {});
    return () => { cancelado = true; };
  }, [recargaResueltas]);

  // Generar alertas al cargar y luego mostrarlas; ?detalle=ID abre el modal (desde el dashboard)
  useEffect(() => {
    let cancelado = false;
    API.alertas.generar().catch(() => {}).finally(async () => {
      if (cancelado) return;
      const lista = await cargarAlertas();
      const detalleId = params.get('detalle');
      if (detalleId && lista && !detalleAbierto.current) {
        detalleAbierto.current = true;
        const id = parseInt(detalleId);
        const a = lista.find(x => x.id === id || x.id === String(id));
        setDetalle(a || 'no-encontrada');
      }
    });
    return () => { cancelado = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargarAlertas]);

  const limpiarFiltros = () => { setFp(''); setFt(''); setFc(false); };

  const verDetalleAlerta = (id) => {
    const a = (alertas || []).find(x => x.id === id || x.id === String(id));
    setDetalle(a || 'no-encontrada');
  };

  const resolverAlerta = async (id) => {
    if (!(await confirm('¿Confirma que desea marcar esta alerta como resuelta?', 'Resolver alerta'))) return;
    try {
      await API.alertas.resolver(id);
      showAlert('success', 'Alerta marcada como resuelta.');
      cargarAlertas();
      setRecargaResueltas(n => n + 1);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  const lista = alertas || [];
  const activas = lista.filter(a => a.estado === 'activa');
  const hayFiltros = !!(fp || ft || fc);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Centro de Alertas</div>
          <div className="page-subtitle">Alertas ordenadas por prioridad: urgente → alta → media</div>
        </div>
        <Link to="/alertas/faltantes" className="btn btn-secondary">Ver alertas de faltantes</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* CU-47: pestañas */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <div className={'tab' + (tab === 'alertas' ? ' active' : '')} id="tab-alertas" onClick={() => setTab('alertas')}>🔔 Alertas</div>
        <div className={'tab' + (tab === 'reposicion' ? ' active' : '')} id="tab-reposicion" onClick={() => setTab('reposicion')}>🚚 Reposición</div>
        <div className={'tab' + (tab === 'historial' ? ' active' : '')} id="tab-historial" onClick={() => setTab('historial')}>🕘 Historial</div>
      </div>

      {tab === 'reposicion' && <PanelReposicion onEvaluado={cargarAlertas} />}

      {tab === 'alertas' && (<>
      {/* KPIs de alertas activas por PRIORIDAD (sesión 15: incluyen conteo, reposición y retiro, no solo stock;
          mientras carga se muestra "—", antes un 1 fijo) */}
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card kpi-danger">
          <div className="kpi-label">Urgentes</div>
          <div className="kpi-value danger" id="kpi-urgente">{alertas === null ? '—' : lista.filter(a => a.prioridad === 'urgente' && a.estado === 'activa').length}</div>
          <div className="kpi-sub">Alertas activas de prioridad urgente</div>
        </div>
        <div className="kpi-card kpi-warning">
          <div className="kpi-label">Altas</div>
          <div className="kpi-value warning" id="kpi-alta">{alertas === null ? '—' : lista.filter(a => a.prioridad === 'alta' && a.estado === 'activa').length}</div>
          <div className="kpi-sub">Alertas activas de prioridad alta</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Medias</div>
          <div className="kpi-value" id="kpi-media">{alertas === null ? '—' : lista.filter(a => a.prioridad === 'media' && a.estado === 'activa').length}</div>
          <div className="kpi-sub">Alertas activas de prioridad media</div>
        </div>
        {/* CU-55: las resueltas se consultan en la pestaña Historial */}
        <div className="kpi-card kpi-success" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
          title="Ver las alertas resueltas y sus tiempos de resolución"
          onClick={() => setTab('historial')}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab('historial'); } }}>
          <div className="kpi-label">Resueltas</div>
          <div className="kpi-value" id="kpi-resuelta" style={{ color: 'var(--success)' }}>{resueltas ?? '—'}</div>
          <div className="kpi-sub" style={{ color: 'var(--orange)', fontWeight: 600 }}>Ver historial →</div>
        </div>
      </div>

      {/* Filtro */}
      <div className="filter-row" style={{ marginBottom: 16 }}>
        <select className="form-control" id="filter-prioridad" style={{ width: 'auto' }} value={fp} onChange={e => setFp(e.target.value)}>
          <option value="">Todas las prioridades</option>
          <option value="urgente">Urgente</option>
          <option value="alta">Alta</option>
          <option value="media">Media</option>
        </select>
        <select className="form-control" id="filter-tipo" style={{ width: 'auto' }} value={ft} onChange={e => setFt(e.target.value)}>
          <option value="">Todos los tipos</option>
          {tipos.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <label htmlFor="filter-criticos" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" id="filter-criticos" checked={fc} onChange={e => setFc(e.target.checked)} />
          Solo materiales críticos
        </label>
        {hayFiltros && (
          <button className="btn btn-ghost btn-sm" onClick={limpiarFiltros}>Limpiar filtros</button>
        )}
      </div>

      {/* Lista de alertas */}
      <div id="alertas-list" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
        {alertas !== null && activas.length === 0 && (
          <div className="card"><div className="empty-state">
            <div className="empty-state-icon">{hayFiltros ? '🔍' : '✅'}</div>
            {hayFiltros
              ? <><p style={{ fontSize: 16, fontWeight: 600 }}>Sin coincidencias</p><p style={{ marginTop: 8 }}>Ninguna alerta activa coincide con los filtros aplicados.</p></>
              : <><p style={{ fontSize: 16, fontWeight: 600, color: 'var(--success)' }}>Inventario bajo control</p><p style={{ marginTop: 8 }}>No hay alertas activas.</p></>}
          </div></div>
        )}
        {activas.map(a => (
          <div key={a.id} className="card card-sm" style={{ borderLeft: `4px solid ${BORDER[a.prioridad] || 'var(--gray-mid)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span className={`badge ${getPrioridadCls(a.prioridad)}`}>{(a.prioridad || 'media').toUpperCase()}</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{a.producto}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--gray)' }}>
                  <span className="td-mono">{a.sku}</span> · {a.tipo}
                  {a.conteo_id ? (
                    // CU-57: alerta por diferencia de conteo
                    <>
                      {' '}· {a.bodega} · Diferencia: <strong style={{ color: a.prioridad === 'urgente' ? 'var(--danger)' : '#000' }}>{difConteo(a)}</strong>
                      {' '}· <Link to={`/conteos/${a.conteo_id}`}>Conteo #{a.conteo_id}</Link>
                      {' '}· {fecha(a)}
                    </>
                  ) : (
                    <>
                      {' '}· Stock actual: <strong style={{ color: a.prioridad === 'urgente' ? 'var(--danger)' : '#000' }}>{parseFloat(a.stock_actual || 0)}</strong>
                      {' '}(mín. {parseFloat(a.stock_minimo || 0)})
                      {' '}· {fecha(a)}
                      {a.tiempo_reposicion ? <> · Tiempo reposición: <strong>{a.tiempo_reposicion} días</strong></> : null}
                      {a.proveedor ? <> · Proveedor: {a.proveedor}</> : null}
                    </>
                  )}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => verDetalleAlerta(a.id)}>Ver detalle</button>
              <button className="btn btn-secondary btn-sm" onClick={() => resolverAlerta(a.id)}>Marcar resuelta</button>
            </div>
          </div>
        ))}
      </div>

      {/* CU-55: el historial completo pasó a la pestaña "Historial" */}
      </>)}

      {tab === 'historial' && <HistorialAlertas tipos={tipos} />}

      {/* Modal detalle de alerta (CU-117) */}
      {detalle && (
        <div className="modal-overlay" id="modal-detalle" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <div className="modal-title">Detalle de alerta</div>
              <button className="modal-close" onClick={() => setDetalle(null)}>×</button>
            </div>
            <div className="modal-body" id="modal-detalle-body">
              {detalle === 'no-encontrada' && <div style={{ color: 'var(--danger)' }}>Alerta no encontrada</div>}
              {detalle !== 'no-encontrada' && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <span className={`badge ${getPrioridadCls(detalle.prioridad)}`} style={{ marginRight: 8 }}>{(detalle.prioridad || 'media').toUpperCase()}</span>
                    <strong>{detalle.producto || detalle.sku}</strong>
                    <span style={{ fontSize: 12, color: 'var(--gray)', marginLeft: 8 }}>{detalle.sku || ''}</span>
                  </div>
                  {detalle.conteo_id ? (
                    // CU-57: alerta por diferencia de conteo
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16, fontSize: 13 }}>
                      <div><span style={{ color: 'var(--gray)' }}>Tipo:</span> {detalle.tipo}</div>
                      <div><span style={{ color: 'var(--gray)' }}>Estado:</span> {detalle.estado}</div>
                      <div><span style={{ color: 'var(--gray)' }}>Bodega:</span> {detalle.bodega}</div>
                      <div><span style={{ color: 'var(--gray)' }}>Diferencia:</span> <strong>{difConteo(detalle)}</strong></div>
                      <div><span style={{ color: 'var(--gray)' }}>Conteo:</span> <Link to={`/conteos/${detalle.conteo_id}`}>#{detalle.conteo_id}</Link></div>
                      <div><span style={{ color: 'var(--gray)' }}>Generada:</span> {fecha(detalle)}</div>
                      <div style={{ gridColumn: '1 / -1', color: 'var(--gray)' }}>{detalle.mensaje}</div>
                    </div>
                  ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16, fontSize: 13 }}>
                    <div><span style={{ color: 'var(--gray)' }}>Tipo:</span> {detalle.tipo || '—'}</div>
                    <div><span style={{ color: 'var(--gray)' }}>Estado:</span> {detalle.estado}</div>
                    <div><span style={{ color: 'var(--gray)' }}>Stock actual:</span> <strong style={{ color: detalle.prioridad === 'urgente' ? 'var(--danger)' : 'inherit' }}>{parseFloat(detalle.stock_actual || 0)}</strong></div>
                    <div><span style={{ color: 'var(--gray)' }}>Stock mínimo:</span> {parseFloat(detalle.stock_minimo || 0)}</div>
                    <div><span style={{ color: 'var(--gray)' }}>Generada:</span> {fecha(detalle)}</div>
                    <div><span style={{ color: 'var(--gray)' }}>Proveedor:</span> {detalle.proveedor || 'Sin proveedor'}</div>
                    {detalle.tiempo_reposicion
                      ? <div><span style={{ color: 'var(--gray)' }}>Tiempo repos.:</span> <strong>{detalle.tiempo_reposicion} días</strong></div>
                      : <div><span style={{ color: 'var(--gray)' }}>Tiempo repos.:</span> <span style={{ color: 'var(--warning)' }}>No registrado</span></div>}
                    {/* CU-48: datos de la evaluación de cobertura (CU-47) */}
                    {detalle.cantidad_sugerida != null && (
                      <>
                        <div><span style={{ color: 'var(--gray)' }}>Cantidad sugerida:</span> <strong>{num(detalle.cantidad_sugerida)}</strong></div>
                        <div style={{ gridColumn: '1 / -1', color: 'var(--gray)' }}>{detalle.mensaje}</div>
                      </>
                    )}
                  </div>
                  )}
                  {!detalle.conteo_id && !detalle.proveedor && <div style={{ padding: 8, background: '#FFF3CD', borderRadius: 6, fontSize: 12, color: '#856404', marginBottom: 8 }}>Este producto no tiene proveedores asociados. Se recomienda registrar uno para evaluar abastecimiento.</div>}
                  {!detalle.conteo_id && detalle.proveedor && !detalle.tiempo_reposicion && <div style={{ padding: 8, background: '#FFF3CD', borderRadius: 6, fontSize: 12, color: '#856404', marginBottom: 8 }}>El proveedor no tiene tiempo de entrega registrado. La viabilidad temporal no puede evaluarse.</div>}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                    <button className="btn btn-ghost" onClick={() => setDetalle(null)}>Cerrar</button>
                    <button className="btn btn-secondary" onClick={() => { const id = detalle.id; setDetalle(null); resolverAlerta(id); }}>Marcar resuelta</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
