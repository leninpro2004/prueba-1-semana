import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';

/* ── Helpers copiados de lista.html ─────────────────── */
function getStockStatus(p) {
  if (p.especial)                      return { label: 'Especial',     cls: 'badge-gray'    };   // CU-123
  if (!p.stockMin && !p.stockCritico)  return { label: 'Sin umbrales', cls: 'badge-orange'  };
  if (p.stockActual <= p.stockCritico) return { label: 'Crítico',      cls: 'badge-danger'  };
  if (p.stockActual <= p.stockMin)     return { label: 'Bajo mínimo',  cls: 'badge-warning' };
  if (p.stockActual >= p.stockMax)     return { label: 'Sobrestock',   cls: 'badge-info'    };
  return                                      { label: 'Normal',       cls: 'badge-success' };
}

function getStockKey(p) {
  if (p.especial)                      return 'especial';
  if (!p.stockMin && !p.stockCritico)  return 'sin_umbrales';
  if (p.stockActual <= p.stockCritico) return 'critico';
  if (p.stockActual <= p.stockMin)     return 'bajo';
  if (p.stockActual >= p.stockMax)     return 'sobrestock';
  return 'normal';
}

const normalizar = (p) => ({
  sku:         p.sku,
  nombre:      p.nombre,
  categoria:   p.categoria_general || 'Sin categoría',
  funcional:   p.categoria_funcional || '',
  unidad:      p.unidad_medida || '',
  stockMin:    parseFloat(p.stock_minimo)  || 0,
  stockMax:    parseFloat(p.stock_maximo)  || 0,
  stockCritico:parseFloat(p.stock_critico) || 0,
  stockActual: (parseFloat(p.stock_total) || 0) - (parseFloat(p.stock_reservado) || 0),
  stockReservado: parseFloat(p.stock_reservado) || 0,
  critico:     p.es_critico,
  especial:    p.es_rotativo === false,   // CU-123: insumo especial / no rotativo
  descontinuado: p.descontinuado === true, // CU-122: ya no se compra
  estado:      p.estado,
});

const CATS_INICIALES = ['Materia Prima', 'Material Crítico'];

/**
 * Catálogo de Productos — conversión 1:1 de productos/lista.html.
 * Reglas de rol preservadas del original:
 *  - data-rol="gerencia" (botón "Nuevo producto"): oculto si rol === 'jop'
 *  - acciones de fila (editar/duplicar/historial/reactivar/eliminar): solo si rol === 'gerencia'
 */
export default function ProductoLista() {
  usePageTitle('Productos');
  const { user } = useAuth();
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const isGerencia = user?.rol === 'gerencia';

  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState(CATS_INICIALES);

  // Filtros (en tiempo real)
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterSt, setFilterSt] = useState('');
  const [filterCrit, setFilterCrit] = useState('');
  const [filterEst, setFilterEst] = useState('activo');

  const cargarProductos = useCallback(async () => {
    try {
      // Cargar categorías reales para el filtro
      const cats = await API.materiales.categorias();
      setCategorias((cats?.generales || []).map(c => c.nombre));

      const lista = await API.materiales.listar();
      setProductos((Array.isArray(lista) ? lista : []).map(normalizar));
    } catch (err) {
      showAlert('danger', 'Error cargando productos: ' + err.message);
    }
  }, [showAlert]);

  useEffect(() => { cargarProductos(); }, [cargarProductos]);

  // CU-02: mínimo 3 caracteres para buscar
  const searchCorta = search.length > 0 && search.length < 3;

  const filtered = useMemo(() => {
    if (searchCorta) return [];
    const s = search.toLowerCase();
    return productos.filter(p => {
      // CU-59: se busca por SKU, nombre parcial o categoria
      const matchSearch = !s || String(p.sku || '').toLowerCase().includes(s) || String(p.nombre || '').toLowerCase().includes(s)
        || String(p.categoria || '').toLowerCase().includes(s);
      const matchCat    = !filterCat  || p.categoria === filterCat;
      // CU-122: un descontinuado también es especial, así que se filtra aparte
      const matchSt     = !filterSt   || (filterSt === 'descontinuado' ? p.descontinuado : getStockKey(p) === filterSt);
      const matchCrit   = !filterCrit || (filterCrit === 'si' ? p.critico : !p.critico);
      const matchEst    = !filterEst  || p.estado === filterEst;
      return matchSearch && matchCat && matchSt && matchCrit && matchEst;
    });
  }, [productos, search, searchCorta, filterCat, filterSt, filterCrit, filterEst]);

  const pag = usePagination(filtered, 20);

  /* ── Eliminar ── */
  const [toDelete, setToDelete] = useState(null); // { sku, nombre }
  const [deleting, setDeleting] = useState(false);

  const confirmarEliminar = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const result = await API.materiales.eliminar(toDelete.sku);
      setToDelete(null);
      if (result?.eliminado) showAlert('success', result.message);
      else showAlert('warning', result?.message);
      cargarProductos();
    } catch (err) {
      setToDelete(null);
      showAlert('danger', 'Error: ' + err.message);
    } finally {
      setDeleting(false);
    }
  };

  /* ── CU-05: Reactivar ── */
  const reactivarProducto = async (sku) => {
    if (!(await confirm('¿Reactivar el producto ' + sku + '? Será reincorporado al catálogo operativo.', 'Reactivar producto'))) return;
    try {
      const resp = await API.materiales.reactivar(sku);
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      cargarProductos();
    } catch (err) { showAlert('danger', 'Error: ' + err.message); }
  };

  /* ── CU-06: Duplicar ── */
  const [dup, setDup] = useState(null); // { sku, nombre }
  const [dupSkuNuevo, setDupSkuNuevo] = useState('');
  const [dupError, setDupError] = useState('');

  const abrirDuplicar = (sku, nombre) => {
    setDup({ sku, nombre });
    setDupSkuNuevo('');
    setDupError('');
  };

  const duplicar = async () => {
    const sku_nuevo = dupSkuNuevo.trim();
    if (!sku_nuevo) { setDupError('Ingrese el nuevo SKU.'); return; }
    try {
      const resp = await API.materiales.duplicar({ sku_base: dup.sku, sku_nuevo });
      if (resp?.error) { setDupError(resp.error); return; }
      setDup(null);
      showAlert('success', resp?.message);
      cargarProductos();
    } catch (err) { setDupError('Error: ' + err.message); }
  };

  /* ── CU-18: Historial de precios ── */
  const [historial, setHistorial] = useState(null); // null = cerrado; { loading, error, mensaje, precio_actual, historial }

  const verHistorialPrecios = async (sku) => {
    setHistorial({ loading: true });
    try {
      const data = await API.materiales.historialPrecios(sku);
      if (data?.error) { setHistorial({ error: data.error }); return; }
      if (data?.mensaje) { setHistorial({ mensaje: data.mensaje, precio_actual: data.precio_actual }); return; }
      setHistorial({ historial: data?.historial || [] });
    } catch (err) { setHistorial({ error: 'Error: ' + err.message }); }
  };

  // CU-59 Exc 1: catalogo vacio. Exc 2: la busqueda no retorna resultados.
  const emptyMsg = productos.length === 0
    ? <>No hay productos registrados en el catálogo.{user?.rol !== 'jop' && <> Cree uno con <Link to="/productos/crear">Nuevo producto</Link>.</>}</>
    : <>No se encontraron productos{search ? <> con «{search}»</> : ''}. Intente con otro SKU, nombre o categoría, o quite algunos filtros.</>;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Catálogo de Productos</div>
          <div className="page-subtitle">Gestión de materiales, insumos y herramientas</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* CU-30: etiquetas de los productos que muestra el filtro actual */}
          <Link to={'/productos/etiquetas?sku=' + encodeURIComponent(filtered.map(p => p.sku).join(','))}
            className="btn btn-secondary" id="btn-etiquetas">
            Imprimir etiquetas
          </Link>
          {/* Solo gerencia puede crear (data-rol="gerencia") */}
          {user?.rol !== 'jop' && (
            <Link to="/productos/crear" className="btn btn-primary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Nuevo producto
            </Link>
          )}
        </div>
      </div>

      {/* Alertas / notificaciones */}
      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-bar" style={{ flex: 1 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-input" placeholder="Buscar por SKU, nombre o categoría (mín. 3 caracteres)..." autoComplete="off"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {searchCorta && (
            <div id="search-hint" style={{ fontSize: 11, color: 'var(--orange)', padding: '4px 8px' }}>
              Ingresa al menos 3 caracteres para buscar
            </div>
          )}
          <select className="form-control" id="filter-cat" style={{ width: 'auto' }} value={filterCat} onChange={e => setFilterCat(e.target.value)}>
            <option value="">Todas las categorías</option>
            {categorias.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="form-control" id="filter-stock" style={{ width: 'auto' }} value={filterSt} onChange={e => setFilterSt(e.target.value)}>
            <option value="">Todos los estados</option>
            <option value="critico">Crítico</option>
            <option value="bajo">Bajo mínimo</option>
            <option value="normal">Normal</option>
            <option value="sobrestock">Sobrestock</option>
            <option value="especial">Insumos especiales</option>
            <option value="descontinuado">Descontinuados</option>
          </select>
          <select className="form-control" id="filter-critico" style={{ width: 'auto' }} value={filterCrit} onChange={e => setFilterCrit(e.target.value)}>
            <option value="">Todos los productos</option>
            <option value="si">Solo críticos ⚡</option>
            <option value="no">No críticos</option>
          </select>
          <select className="form-control" id="filter-estado" style={{ width: 'auto' }} value={filterEst} onChange={e => setFilterEst(e.target.value)}>
            <option value="activo">Activos</option>
            <option value="">Todos (incl. desactivados)</option>
            {/* El backend guarda los productos dados de baja como 'inactivo' (antes se filtraba por 'desactivado') */}
            <option value="inactivo">Solo desactivados</option>
          </select>
        </div>
      </div>

      {/* Tabla */}
      <div className="card">
        <div className="table-wrap">
          <table id="table-productos">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Categoría</th>
                <th>Funcional</th>
                <th>Unidad</th>
                <th>Stock actual</th>
                <th>Estado stock</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tbody-productos">
              {!searchCorta && filtered.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary,#888)' }}></td></tr>
              )}
              {pag.items.map(p => {
                const st = getStockStatus(p);
                return (
                  <tr key={p.sku}>
                    <td><span className="td-mono">{p.sku}</span></td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {p.nombre}
                        {p.descontinuado && <span className="badge badge-danger" style={{ fontSize: 10, marginLeft: 6 }}>Descontinuado</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>{p.funcional}{p.critico ? ' · ⚡ Crítico' : ''}</div>
                    </td>
                    <td><span className="badge badge-gray">{p.categoria}</span></td>
                    <td style={{ fontSize: 13, color: 'var(--gray)' }}>{p.funcional}</td>
                    <td style={{ fontSize: 13 }}>{p.unidad}</td>
                    <td>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{p.stockActual}</span>
                      {p.stockReservado > 0 && <span style={{ color: 'var(--orange)', fontSize: 11 }}> ({p.stockReservado} reserv.)</span>}
                      <span style={{ color: '#aaa', fontSize: 11 }}> / mín {p.stockMin}</span>
                    </td>
                    <td><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    {/* CU-59: estado del producto en el catalogo */}
                    <td>
                      {p.estado === 'activo'
                        ? <span className="badge badge-success">Activo</span>
                        : <span className="badge badge-gray">{p.estado === 'inactivo' ? 'Inactivo' : (p.estado || '—')}</span>}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <Link to={`/productos/${p.sku}`} className="btn btn-ghost btn-sm btn-icon" title="Ver detalle">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        </Link>
                        {isGerencia && (
                          <>
                            <Link to={`/productos/${p.sku}/editar`} className="btn btn-ghost btn-sm btn-icon" title="Editar">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </Link>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Duplicar" onClick={() => abrirDuplicar(p.sku, p.nombre)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                            </button>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Historial precios" onClick={() => verHistorialPrecios(p.sku)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                            </button>
                            {p.estado !== 'activo' && (
                              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--success)', fontSize: 11 }} onClick={() => reactivarProducto(p.sku)}>Reactivar</button>
                            )}
                            <button className="btn btn-ghost btn-sm btn-icon" style={{ color: 'var(--danger)' }} title="Eliminar" onClick={() => setToDelete({ sku: p.sku, nombre: p.nombre })}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
        {!searchCorta && filtered.length === 0 && (
          <div id="empty-state" className="empty-state">
            <div className="empty-state-icon">📦</div>
            <p>{emptyMsg}</p>
          </div>
        )}
      </div>

      {/* Modal confirmación eliminar */}
      {toDelete && (
        <div className="modal-backdrop show" id="modal-delete" onClick={e => { if (e.target === e.currentTarget) setToDelete(null); }}>
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Eliminar producto</div>
                <div className="modal-subtitle" id="delete-subtitle">Producto: {toDelete.nombre}</div>
              </div>
              <button className="modal-close" onClick={() => setToDelete(null)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div className="alert alert-danger">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Esta acción no se puede deshacer. Si el producto tiene movimientos asociados, solo podrá desactivarse.
              </div>
              <p style={{ fontSize: 14, color: 'var(--gray)', lineHeight: 1.6 }}>¿Estás seguro de que deseas eliminar este producto del catálogo?</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setToDelete(null)}>Cancelar</button>
              <button className="btn btn-danger" id="btn-confirm-delete" onClick={confirmarEliminar} disabled={deleting}>
                {deleting ? 'Procesando...' : 'Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal duplicar (CU-06) */}
      {dup && (
        <div className="modal-backdrop show" id="modal-duplicar" onClick={e => { if (e.target === e.currentTarget) setDup(null); }}>
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Duplicar producto</div>
                <div className="modal-subtitle">Crear nuevo producto a partir de: <strong id="dup-nombre">{dup.nombre}</strong></div>
              </div>
              <button className="modal-close" onClick={() => setDup(null)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div id="modal-dup-alert">
                {dupError && <div className="alert alert-danger">{dupError}</div>}
              </div>
              <div className="form-group">
                <label className="form-label">SKU base</label>
                <input className="form-control" id="dup-sku-base-visible" readOnly value={dup.sku}
                  style={{ background: 'var(--gray-light,#f5f5f5)', cursor: 'default' }} />
              </div>
              <div className="form-group">
                <label className="form-label">Nuevo SKU <span className="required">*</span></label>
                <input className="form-control" id="dup-sku-nuevo" placeholder="Ej: ACR-002"
                  value={dupSkuNuevo} onChange={e => setDupSkuNuevo(e.target.value)} />
                <div className="form-hint">Debe ser único en el sistema</div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDup(null)}>Cancelar</button>
              <button className="btn btn-primary" id="btn-duplicar" onClick={duplicar}>Duplicar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal historial precios (CU-18) */}
      {historial && (
        <div className="modal-overlay" id="modal-historial" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 700 }}>
            <div className="modal-header">
              <div className="modal-title">Historial de precios</div>
              <button className="modal-close" onClick={() => setHistorial(null)}>×</button>
            </div>
            <div className="modal-body" id="historial-body">
              {historial.loading && 'Cargando…'}
              {historial.error}
              {historial.mensaje && (
                <>
                  <div style={{ color: 'var(--warning)', marginBottom: 12 }}>{historial.mensaje}</div>
                  {historial.precio_actual && (
                    <div>Precio referencial actual: <strong>{formatMoney(historial.precio_actual.precio)}</strong> ({historial.precio_actual.proveedor})</div>
                  )}
                </>
              )}
              {historial.historial && (
                <table className="table" style={{ fontSize: 13 }}>
                  <thead><tr><th>Fecha</th><th>Precio unit.</th><th>Lote</th><th>Proveedor</th><th>Factura</th></tr></thead>
                  <tbody>
                    {historial.historial.map((h, i) => (
                      <tr key={i}>
                        <td>{h.fecha ? new Date(h.fecha).toLocaleDateString('sv-SE') : '—'}</td>
                        <td style={{ fontWeight: 600 }}>{formatMoney(h.precio_unitario)}</td>
                        <td>{h.lote || '—'}</td>
                        <td>{h.proveedor || '—'}</td>
                        <td>{h.factura || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
