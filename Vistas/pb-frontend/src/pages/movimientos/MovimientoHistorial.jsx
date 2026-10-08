import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { exportarCSV, ErrorExportacion, LIMITE_FILAS } from '../../utils/csvExport';

// CU-31: paginacion en el servidor. Antes se pedian solo los 50 mas recientes y se
// paginaban en el navegador, asi que los movimientos mas antiguos nunca aparecian.
const POR_PAGINA = 50;
// CU-31 Exc 2: sobre este total se sugiere acotar los filtros
const LIMITE_AVISO = 500;

const normalizar = (m) => ({
  id:            m.id,
  fecha:         m.fecha_hora ? new Date(m.fecha_hora).toLocaleDateString('sv-SE') : '',
  hora:          m.fecha_hora ? new Date(m.fecha_hora).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '',
  fechaHora:     m.fecha_hora ? new Date(m.fecha_hora).toLocaleString('es-CL') : '—',
  lote:          m.lote || '—',
  proyecto:      m.proyecto_codigo ? `${m.proyecto_codigo}${m.proyecto_nombre ? ' · ' + m.proyecto_nombre : ''}` : '—',
  tipo:          m.tipo || '',
  // Los tipos vienen en minuscula desde la BD ('entrada', 'salida', 'reverso'...)
  tipoNorm:      (m.tipo || '').toLowerCase(),
  sku:           m.sku || '',
  producto:      m.material_nombre || '',
  bodega:        m.bodega || '—',
  bodegaOrigen:  m.bodega_origen || '—',
  bodegaDestino: m.bodega_destino || '—',
  documentoTipo: m.documento_tipo || null,
  documentoRef:  m.documento_ref || null,
  cantidad:      parseFloat(m.cantidad) || 0,
  clasificacion: m.clasificacion_salida || '—',
  motivo:        m.descripcion_motivo || m.motivo || '—',
  usuario:       m.usuario || '',
  revertido:     m.estado === 'revertido',
  pendiente:     m.estado === 'pendiente_aprobacion',
  rechazado:     m.estado === 'rechazado',
  proveedor:     m.proveedor || '—',
  proyecto_nombre: m.proyecto_nombre || null,
  evidencia_url: m.evidencia_url || null,
  // OPUS-9 (Req #1): OT que originó el movimiento (null si no viene de un consumo)
  orden_trabajo_id: m.orden_trabajo_id || null,
  // CU-44: el inverso apunta al original y el original a su inverso
  revierteA:     m.revierte_a || null,
  revertidoPor:  m.revertido_por || null,
});

const EMPTY_DEFAULT = 'No hay movimientos que coincidan con los filtros aplicados.';

const capitalizar = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** CU-31: documento asociado al movimiento (factura, OT o evidencia de la merma). */
function Documento({ tipo, referencia }) {
  if (tipo === 'factura') return <span style={{ fontSize: 12 }}>Factura N° {referencia}</span>;
  if (tipo === 'ot') {
    return <Link to={`/ordenes/${referencia}`} style={{ fontSize: 12 }} title="Orden de trabajo que originó este movimiento">OT #{referencia}</Link>;
  }
  // Sesión 15: salida del despacho de una venta (CU-127) y mitades de un traslado (D60)
  if (tipo === 'venta') {
    return <Link to={`/instalacion/trazabilidad?q=${encodeURIComponent(referencia)}`} style={{ fontSize: 12 }} title="Despacho de esta venta: ver su trazabilidad">Venta {referencia}</Link>;
  }
  if (tipo === 'traslado') {
    return <span style={{ fontSize: 12 }} title="Traslado entre bodegas: la salida y la entrada con este mismo número son sus dos mitades">Traslado #{referencia}</span>;
  }
  // CU-107: movimiento registrado desde otro módulo, con su referencia ("Terreno: OBRA-2026-015")
  if (tipo === 'origen') {
    return <span style={{ fontSize: 12 }} title="Registrado desde otro módulo">{referencia}</span>;
  }
  if (tipo === 'evidencia') {
    return (
      <a href={referencia} target="_blank" rel="noopener noreferrer" title="Ver evidencia fotográfica de la merma"
        style={{ fontSize: 12, color: 'var(--orange)', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
        📎 Evidencia
      </a>
    );
  }
  return <span style={{ fontSize: 12, color: 'var(--gray)' }}>—</span>;
}

/** CU-31: un dato del detalle desplegable del movimiento. */
function Dato({ etiqueta, children, ancho = false }) {
  return (
    <div style={ancho ? { gridColumn: '1 / -1' } : undefined}>
      <span style={{ color: 'var(--gray)' }}>{etiqueta}: </span>
      <span style={{ fontWeight: 500 }}>{children}</span>
    </div>
  );
}

// Los enlaces y botones de la fila hacen su accion, no abren el detalle
const noAbrir = (e) => e.stopPropagation();

/**
 * Movimientos de Inventario — conversión 1:1 de movimientos/historial.html.
 * Exportar (CU-76): CSV de todo lo filtrado, para todos los roles (no hay montos). Acciones de fila
 * (aprobar/rechazar merma CU-73, revertir FR-30) solo si rol === 'gerencia'.
 */
export default function MovimientoHistorial() {
  usePageTitle('Movimientos');
  const { user } = useAuth();
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const isGerencia = user?.rol === 'gerencia';

  const [movimientos, setMovimientos] = useState([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(1);
  const [emptyMsg, setEmptyMsg] = useState(EMPTY_DEFAULT);
  const [search, setSearch] = useState('');
  const [tipo, setTipo] = useState('');
  const [estado, setEstado] = useState('');
  const [bodega, setBodega] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [tipos, setTipos] = useState([]);
  const [bodegas, setBodegas] = useState([]);
  const [revertir, setRevertir] = useState(null); // movimiento a revertir
  // CU-42: reautenticación dentro del modal de reversión
  const [clave, setClave] = useState('');
  const [errorReauth, setErrorReauth] = useState('');
  const [bloqueado, setBloqueado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [avisoOT, setAvisoOT] = useState(null); // CU-44: consumo de OT que se quiso revertir
  const [abierto, setAbierto] = useState(null);   // CU-31: id del movimiento con el detalle desplegado (uno a la vez)

  // CU-31 Exc 3: rango de fechas incoherente. Se bloquea la consulta.
  const rangoInvalido = Boolean(desde && hasta && desde > hasta);

  // Catalogos de los filtros: tipos de movimiento y bodegas
  useEffect(() => {
    API.movimientos.catalogos().then(c => setTipos(c?.tipos || [])).catch(() => setTipos([]));
    API.bodegas.listar().then(b => setBodegas(Array.isArray(b) ? b : [])).catch(() => setBodegas([]));
  }, []);

  // Al cambiar cualquier filtro se vuelve a la primera pagina (en el mismo evento,
  // no en un efecto: asi se hace una sola consulta y no hay que descartar respuestas)
  const filtro = (setter) => (e) => { setter(e.target.value); setPagina(1); };

  // Solo se aplica la respuesta de la ULTIMA consulta: el buscador consulta con
  // cada tecla y las respuestas podrian llegar en desorden.
  const consultaActual = useRef(0);

  const cargarMovimientos = useCallback(async () => {
    if (rangoInvalido) return;
    const consulta = ++consultaActual.current;
    const s = search.toLowerCase();
    const params = {
      paginado: 1, page: pagina, limit: POR_PAGINA,
      buscar: s || null, tipo: tipo || null, estado: estado || null, bodega_id: bodega || null,
      desde: desde || null, hasta: hasta || null,
    };
    try {
      const data = await API.movimientos.listar(params);
      if (consulta !== consultaActual.current) return;
      const lista = (data?.movimientos || []).map(normalizar);
      setMovimientos(lista);
      setTotal(data?.total || 0);

      // CU-39 CP2/CP3 + CU-40 CP2/CP3: Diferenciar mensaje cuando no hay resultados
      if (lista.length === 0 && s) {
        let encontrado = false;
        try {
          await API.materiales.obtener(s);
          setEmptyMsg(`El producto "${s}" no tiene movimientos registrados.`);
          encontrado = true;
        } catch { /* no es un producto */ }
        if (!encontrado) {
          try {
            const usuarios = await API.usuarios.listar({ buscar: s });
            const exacto = (usuarios || []).find(u => u.username.toLowerCase() === s.toLowerCase());
            if (exacto) {
              setEmptyMsg(`El usuario "${exacto.username}" no tiene actividad registrada.`);
              encontrado = true;
            }
          } catch { /* error consultando usuarios */ }
        }
        if (!encontrado) {
          setEmptyMsg(`No se encontró ningún producto ni usuario con "${s}". Verifique que el SKU o nombre ingresado sea válido.`);
        }
      } else {
        setEmptyMsg(EMPTY_DEFAULT);
      }
    } catch (err) {
      showAlert('danger', 'Error cargando movimientos: ' + err.message);
    }
  }, [search, tipo, estado, bodega, desde, hasta, pagina, rangoInvalido, showAlert]);

  // Carga inicial y al cambiar filtros o pagina (todo se filtra en el servidor)
  useEffect(() => { cargarMovimientos(); }, [cargarMovimientos]);

  // CU-74 CP3: Verificar mermas pendientes >24h y notificar emergencia
  useEffect(() => { API.movimientos.verificarMermasPendientes().catch(() => {}); }, []);

  // CU-76: la vista pagina de a 50; el CSV vuelve a pedir TODO lo filtrado (hasta
  // 10.000) con el detalle completo. Sin montos, así que también lo exporta jop.
  const [exportando, setExportando] = useState(false);
  const exportar = async () => {
    setExportando(true);
    try {
      const data = await API.movimientos.listar({
        paginado: 1, exportar: 1,
        buscar: search.toLowerCase() || null, tipo: tipo || null, estado: estado || null, bodega_id: bodega || null,
        desde: desde || null, hasta: hasta || null,
      });
      if ((data?.total || 0) > LIMITE_FILAS) {
        throw new ErrorExportacion(
          `El historial filtrado tiene ${data.total.toLocaleString('es-CL')} movimientos y el límite de exportación es ` +
          `${LIMITE_FILAS.toLocaleString('es-CL')}. Acote los filtros antes de descargar.`);
      }
      const estadoTexto = (m) => m.revierte_a ? `Reversión de #${m.revierte_a}`
        : m.estado === 'revertido' ? 'Anulado por Reversión'
        : m.estado === 'pendiente_aprobacion' ? 'Pendiente de aprobación'
        : m.estado === 'rechazado' ? 'Rechazado' : 'Vigente';
      const documento = (m) => m.documento_tipo === 'factura' ? `Factura N° ${m.documento_ref}`
        : m.documento_tipo === 'ot' ? `OT #${m.documento_ref}`
        : m.documento_tipo === 'venta' ? `Venta ${m.documento_ref}`
        : m.documento_tipo === 'traslado' ? `Traslado #${m.documento_ref}`
        : m.documento_tipo === 'conteo' ? `Conteo #${m.documento_ref}`
        : m.documento_tipo === 'origen' || m.documento_tipo === 'evidencia' ? m.documento_ref : '';
      const headers = ['ID', { titulo: 'Fecha y hora', formato: 'timestamp' }, 'Tipo', 'Estado', 'SKU', 'Producto',
                       { titulo: 'Cantidad', formato: 'numero' }, 'Bodega origen', 'Bodega destino', 'Lote', 'Motivo',
                       'Clasificación', 'Descripción', 'OT', 'Proyecto', 'Proveedor', 'Documento', 'Usuario', 'Revertido por'];
      const rows = (data?.movimientos || []).map(m => [
        m.id, m.fecha_hora, capitalizar(m.tipo || ''), estadoTexto(m), m.sku, m.material_nombre, m.cantidad,
        m.bodega_origen || '', m.bodega_destino || '', m.lote || '', m.motivo || '', m.clasificacion_salida || '',
        m.descripcion_motivo || '', m.orden_trabajo_id ? `#${m.orden_trabajo_id}` : '',
        m.proyecto_codigo ? `${m.proyecto_codigo}${m.proyecto_nombre ? ' · ' + m.proyecto_nombre : ''}` : '',
        m.proveedor || '', documento(m), m.usuario || '', m.revertido_por ? `#${m.revertido_por}` : '',
      ]);
      exportarCSV('historial-movimientos', headers, rows);
    } catch (err) {
      showAlert('danger', err instanceof ErrorExportacion ? err.message : 'No se pudo generar el archivo: ' + err.message);
    } finally {
      setExportando(false);
    }
  };

  // CU-31: controles de paginacion del servidor, con la forma que espera <Pagination>
  const totalPaginas = Math.ceil(total / POR_PAGINA);
  const pag = {
    pagina, totalPaginas, total,
    prev: () => setPagina(p => (p > 1 ? p - 1 : p)),
    next: () => setPagina(p => (p < totalPaginas ? p + 1 : p)),
  };

  const abrirRevertir = (m) => {
    // CU-44: un consumo de OT se corrige desde la OT. Se avisa sin pedir la
    // contraseña, porque el backend lo rechazaría igual.
    if (m.orden_trabajo_id) { setAvisoOT(m); return; }
    setClave(''); setErrorReauth(''); setBloqueado(false); setEnviando(false);
    setRevertir(m);
  };
  const cerrarRevertir = () => { setRevertir(null); setClave(''); setErrorReauth(''); };

  // CU-42: primero se valida la contraseña; solo con la autorización se revierte
  const confirmarRevertir = async (e) => {
    e.preventDefault();
    if (!clave || enviando || bloqueado) return;
    const id = revertir.id;
    setEnviando(true);
    setErrorReauth('');
    let autorizacion;
    try {
      const r = await API.auth.reautenticar(clave, id);
      if (!r) return; // 401: la sesión expiró y apiFetch ya redirige al login
      autorizacion = r.autorizacion;
    } catch (err) {
      // 403 contraseña incorrecta (quedan intentos) · 423 bloqueo de 15 minutos
      setClave('');
      if (err.status === 423) setBloqueado(true);
      setErrorReauth(err.message);
      return;
    } finally {
      setEnviando(false);
    }

    cerrarRevertir();
    try {
      const resp = await API.movimientos.revertir(id, autorizacion);
      showAlert('success', `${resp?.message || 'Movimiento anulado por reversión.'} El stock fue ajustado y la acción queda registrada en auditoría.`);
      cargarMovimientos();
    } catch (err) {
      showAlert('danger', 'Error al revertir: ' + err.message);
    }
  };

  // CU-73: Aprobar/Rechazar merma de producto crítico
  const aprobarMerma = async (id) => {
    if (!(await confirm('¿Aprobar esta merma de producto crítico? El movimiento quedará registrado definitivamente.', 'Aprobar merma'))) return;
    try {
      const resp = await API.movimientos.aprobarMerma(id);
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      cargarMovimientos();
    } catch (err) { showAlert('danger', 'Error: ' + err.message); }
  };

  const rechazarMerma = async (id) => {
    if (!(await confirm('¿Rechazar esta merma? El stock será devuelto a la bodega.', 'Rechazar merma'))) return;
    try {
      const resp = await API.movimientos.rechazarMerma(id);
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      cargarMovimientos();
    } catch (err) { showAlert('danger', 'Error: ' + err.message); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Movimientos de Inventario</div>
          <div className="page-subtitle">Historial de entradas, salidas y traslados</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/movimientos/entrada" className="btn btn-primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Registrar entrada
          </Link>
          <Link to="/movimientos/salida" className="btn btn-secondary">Registrar salida</Link>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
          <div className="search-bar" style={{ flex: 1, minWidth: 200 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-input" placeholder="Buscar por SKU, producto, usuario..." autoComplete="off" value={search} onChange={filtro(setSearch)} />
          </div>
          <select className="form-control" id="filter-tipo" style={{ width: 'auto' }} value={tipo} onChange={filtro(setTipo)}>
            <option value="">Todos los tipos</option>
            {tipos.map(t => <option key={t.id} value={t.nombre}>{capitalizar(t.nombre)}</option>)}
          </select>
          {/* CU-31: filtro por bodega */}
          <select className="form-control" id="filter-bodega" style={{ width: 'auto' }} value={bodega} onChange={filtro(setBodega)}>
            <option value="">Todas las bodegas</option>
            {bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </select>
          {/* CU-74: Filtro para mermas pendientes de aprobación */}
          <select className="form-control" id="filter-estado-mov" style={{ width: 'auto' }} value={estado} onChange={filtro(setEstado)}>
            <option value="">Todos los estados</option>
            <option value="pendiente_aprobacion">Pendiente aprobación</option>
            <option value="activo">Activos</option>
            <option value="revertido">Anulados por reversión</option>
            <option value="rechazado">Rechazados</option>
          </select>
          <input type="date" className="form-control" id="filter-desde" title="Desde" style={{ width: 'auto', ...(rangoInvalido && { borderColor: 'var(--danger)' }) }} value={desde} onChange={filtro(setDesde)} />
          <input type="date" className="form-control" id="filter-hasta" title="Hasta" style={{ width: 'auto', ...(rangoInvalido && { borderColor: 'var(--danger)' }) }} value={hasta} onChange={filtro(setHasta)} />
          {/* CU-76: exporta todo lo filtrado (sin montos: disponible para todos los roles) */}
          <BotonExportar id="btn-exportar" className="btn btn-secondary btn-sm" onClick={exportar} cargando={exportando}
                         filas={rangoInvalido ? 0 : total} />
        </div>
      </div>

      {/* CU-31 Exc 3: rango de fechas incoherente */}
      {rangoInvalido && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>
          La fecha de inicio es posterior a la fecha de fin. Corrija el rango para consultar.
        </div>
      )}
      {/* CU-31 Exc 2: demasiados registros para un analisis especifico */}
      {!rangoInvalido && total > LIMITE_AVISO && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          La consulta devolvió {total} movimientos. Se muestran paginados; acote los filtros (fechas, tipo, bodega o producto) para un análisis más específico.
        </div>
      )}

      {/* Tabla */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Fecha</th><th>Tipo</th><th>Producto</th><th>Cant.</th>
                <th>Bodega origen</th><th>Bodega destino</th><th>Responsable</th><th>Documento</th>
                <th>Estado</th><th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tbody-movimientos">
              {movimientos.map(m => {
                const tipoCls  = m.tipoNorm === 'entrada' ? 'badge-success' : m.tipoNorm === 'salida' ? 'badge-danger' : 'badge-orange';
                const cantSign = m.tipoNorm === 'entrada' ? '+' + m.cantidad : m.tipoNorm === 'salida' ? '-' + m.cantidad : '' + m.cantidad;
                const estaAbierto = abierto === m.id;
                // D28: 'revertido' se muestra como "Anulado por Reversión" (el valor en BD no cambia)
                const estadoBadge = m.revertido ? <span className="badge badge-gray">Anulado por Reversión</span>
                  : m.pendiente ? <span className="badge badge-warning">Pendiente aprobación</span>
                  : m.rechazado ? <span className="badge badge-danger">Rechazado</span>
                  : <span className="badge badge-success">Activo</span>;
                return (
                  <Fragment key={m.id}>
                  {/* CU-31: clic en la fila abre o cierra el detalle del movimiento */}
                  <tr style={{ opacity: m.revertido ? 0.5 : 1, cursor: 'pointer' }}
                    onClick={() => setAbierto(estaAbierto ? null : m.id)}
                    aria-expanded={estaAbierto}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--gray)', fontSize: 11, marginRight: 4 }}>{estaAbierto ? '▾' : '▸'}</span>
                      <span className="td-mono">{m.id}</span>
                      {/* CU-44: el movimiento inverso indica a cuál revierte */}
                      {m.revierteA && (
                        <div style={{ fontSize: 10, color: 'var(--gray)' }} title="Movimiento inverso generado por una reversión">↺ revierte #{m.revierteA}</div>
                      )}
                      {/* OPUS-9 (Req #1): OT del consumo, si el documento mostrado es otro */}
                      {m.orden_trabajo_id && m.documentoTipo !== 'ot' && (
                        <div style={{ fontSize: 10 }}>
                          <Link to={`/ordenes/${m.orden_trabajo_id}`} onClick={noAbrir} title="Orden de trabajo que originó este movimiento">
                            OT #{m.orden_trabajo_id}
                          </Link>
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>
                      {m.fecha}<div style={{ fontSize: 11, color: '#aaa' }}>{m.hora}</div>
                    </td>
                    <td><span className={`badge ${tipoCls}`}>{capitalizar(m.tipo)}</span></td>
                    <td><div style={{ fontWeight: 500, fontSize: 13 }}>{m.producto}</div><div style={{ fontSize: 11, color: '#aaa' }}>{m.sku}</div></td>
                    <td style={{ fontWeight: 600 }}>{cantSign}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.bodegaOrigen}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.bodegaDestino}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario}</td>
                    <td onClick={noAbrir}><Documento tipo={m.documentoTipo} referencia={m.documentoRef} /></td>
                    <td>{estadoBadge}</td>
                    <td onClick={noAbrir}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {/* SONNET-8 (Req #2): evidencia de la merma, si el documento mostrado es otro */}
                        {m.evidencia_url && m.documentoTipo !== 'evidencia' && (
                          <a href={m.evidencia_url} target="_blank" rel="noopener noreferrer" title="Ver evidencia fotográfica"
                            style={{ fontSize: 11, color: 'var(--orange)', textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                            📎 Evidencia
                          </a>
                        )}
                        {isGerencia && m.pendiente && (
                          <>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)', fontSize: 11 }} onClick={() => aprobarMerma(m.id)}>Aprobar</button>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)', fontSize: 11 }} onClick={() => rechazarMerma(m.id)}>Rechazar</button>
                          </>
                        )}
                        {/* CU-44: el inverso no se revierte; los consumos de OT se corrigen desde la OT */}
                        {isGerencia && !m.revertido && !m.pendiente && !m.rechazado && !m.revierteA && (
                          <button className="btn btn-ghost btn-sm btn-icon" title="Revertir" onClick={() => abrirRevertir(m)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* CU-31: detalle del movimiento, debajo de la fila */}
                  {estaAbierto && (
                    <tr style={{ background: 'var(--gray-light, #f5f5f5)' }}>
                      <td colSpan={11} style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px 24px', fontSize: 12 }}>
                          <Dato etiqueta="Clasificación">{m.clasificacion}</Dato>
                          <Dato etiqueta="Lote">{m.lote}</Dato>
                          <Dato etiqueta="Fecha y hora">{m.fechaHora}</Dato>
                          <Dato etiqueta="Motivo" ancho>{m.motivo}</Dato>
                          <Dato etiqueta="Proveedor">{m.proveedor}</Dato>
                          <Dato etiqueta="Proyecto">{m.proyecto}</Dato>
                          {m.revierteA && <Dato etiqueta="Reversión" ancho>Movimiento inverso del #{m.revierteA}</Dato>}
                          {m.revertidoPor && <Dato etiqueta="Anulado por reversión" ancho>Movimiento inverso #{m.revertidoPor}</Dato>}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
        {/* CU-31 Exc 1: sin registros para los filtros aplicados */}
        {movimientos.length === 0 && !rangoInvalido && (
          <div id="empty-state" className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p id="empty-state-msg">{emptyMsg}</p>
          </div>
        )}
      </div>

      {/* CU-44: aviso al intentar revertir un consumo de OT, con acceso directo a la OT */}
      {avisoOT && (
        <div className="modal-backdrop show" id="modal-aviso-ot" onClick={e => { if (e.target === e.currentTarget) setAvisoOT(null); }}>
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Este movimiento pertenece a una orden de trabajo</div>
                <div className="modal-subtitle">Movimiento #{avisoOT.id}</div>
              </div>
              <button type="button" className="modal-close" onClick={() => setAvisoOT(null)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                Es un consumo de la <strong>OT #{avisoOT.orden_trabajo_id}</strong> ({avisoOT.producto || avisoOT.sku}, {avisoOT.cantidad} unidades).
                Para anularlo o corregirlo, hágalo desde la OT: así el consumo registrado y el stock siguen cuadrando.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setAvisoOT(null)}>Cancelar</button>
              <Link to={`/ordenes/${avisoOT.orden_trabajo_id}`} className="btn btn-primary" id="btn-ir-ot">
                Ir a la OT #{avisoOT.orden_trabajo_id}
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Modal revertir (FR-30, solo gerencia) · CU-42: detalle completo + reautenticación */}
      {revertir && (
        <div className="modal-backdrop show" id="modal-revertir" onClick={e => { if (e.target === e.currentTarget) cerrarRevertir(); }}>
          <form className="modal" onSubmit={confirmarRevertir}>
            <div className="modal-header">
              <div>
                <div className="modal-title">Revertir movimiento</div>
                <div className="modal-subtitle" id="rev-subtitle">Movimiento #{revertir.id}</div>
              </div>
              <button type="button" className="modal-close" onClick={cerrarRevertir}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 24px', fontSize: 13, marginBottom: 16 }}>
                <Dato etiqueta="Fecha y hora">{revertir.fechaHora}</Dato>
                <Dato etiqueta="Tipo">{capitalizar(revertir.tipo)}</Dato>
                <Dato etiqueta="Producto">{revertir.producto} ({revertir.sku})</Dato>
                <Dato etiqueta="Cantidad">{revertir.cantidad}</Dato>
                <Dato etiqueta="Bodega">{revertir.bodega}</Dato>
                <Dato etiqueta="Responsable">{revertir.usuario || '—'}</Dato>
              </div>
              <div className="alert alert-warning">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                La reversión ajusta el stock y queda registrada en auditoría. Para autorizarla, reingrese su contraseña.
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" htmlFor="rev-clave">Contraseña</label>
                <input type="password" className="form-control" id="rev-clave" autoComplete="current-password" autoFocus
                  value={clave} onChange={e => setClave(e.target.value)} disabled={bloqueado || enviando} />
              </div>
              {errorReauth && (
                <div className={`alert ${bloqueado ? 'alert-danger' : 'alert-warning'}`} style={{ marginTop: 12, marginBottom: 0 }}>
                  {errorReauth}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={cerrarRevertir}>Cancelar</button>
              <button type="submit" className="btn btn-primary" id="btn-confirmar-revertir" disabled={!clave || bloqueado || enviando}>
                {enviando ? 'Validando…' : 'Autorizar reversión'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
