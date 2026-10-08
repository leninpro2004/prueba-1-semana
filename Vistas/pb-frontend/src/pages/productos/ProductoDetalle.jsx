import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney, fechaLocal, hoyLocal } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import VariacionPrecio from '../../components/VariacionPrecio';

const DIAS = { semana: 7, mes: 30, trimestre: 90, anio: 365 };

const SIN_DATOS = <span style={{ color: 'var(--gray)', fontStyle: 'italic' }}>Sin datos</span>;
const fmtDias1 = (v) => `${Number(v).toLocaleString('es-CL', { maximumFractionDigits: 1 })} d`;

/**
 * CU-65: tabla comparativa de los proveedores del producto (precio vigente, plazo
 * prometido y real, % de cumplimiento, cantidad mínima) con los destaques de menor
 * costo y menor plazo que calcula el backend. Al rol jop no le llega el precio.
 */
function ComparacionProveedores({ datos, error, esGerencia, onVincular }) {
  const cab = <div className="section-label" style={{ marginBottom: 12 }}>Comparación de proveedores</div>;
  if (error) return <div className="card">{cab}<div className="alert alert-danger">{error}</div></div>;
  if (!datos) return <div className="card">{cab}<p style={{ fontSize: 13, color: 'var(--gray)' }}>Cargando…</p></div>;

  // Exc 2: el producto no tiene proveedores
  if (datos.proveedores.length === 0) {
    return (
      <div className="card">{cab}
        <div className="empty-state">
          <div className="empty-state-icon">🏷️</div>
          <p style={{ fontSize: 15, fontWeight: 600 }}>No hay proveedores registrados para este producto</p>
          <p style={{ marginTop: 6 }}>Vincule al menos uno para poder comparar precios y plazos.</p>
          {esGerencia && <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={onVincular}>+ Vincular proveedor</button>}
        </div>
      </div>
    );
  }

  const conPrecio = datos.proveedores.some(p => 'precio' in p);   // el rol jop no recibe precios
  const costo = new Set((datos.destaques.menor_costo || []).map(String));
  const plazo = new Set((datos.destaques.menor_plazo || []).map(String));

  return (
    <div className="card">{cab}
      {/* Exc 1: un único proveedor */}
      {!datos.alternativas && (
        <div className="alert alert-warning" style={{ marginBottom: 12 }}>
          El producto tiene un único proveedor: no hay alternativas suficientes para realizar la comparación.
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Proveedor</th>
              {conPrecio && <th>Precio unitario</th>}
              <th>Plazo prometido</th><th>Plazo real promedio</th><th>Cumplimiento</th><th>Mín. pedido</th>
            </tr>
          </thead>
          <tbody id="tbody-comparacion">
            {datos.proveedores.map(p => {
              const id = String(p.proveedor_id);
              const destacado = costo.has(id) || plazo.has(id);
              return (
                <tr key={id} style={destacado ? { background: 'rgba(92, 184, 92, 0.08)' } : undefined}>
                  <td>
                    <Link to={`/proveedores/${p.proveedor_id}`} style={{ fontWeight: 500 }}>{p.nombre}</Link>
                    {p.es_principal && <> <span className="badge badge-warning" style={{ fontSize: 10 }}>Principal</span></>}
                    {p.estado !== 'activo' && <> <span className="badge badge-gray" style={{ fontSize: 10 }}>Inactivo</span></>}
                    <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                      {costo.has(id) && <span className="badge badge-success" style={{ fontSize: 10 }}>Menor costo</span>}
                      {plazo.has(id) && <span className="badge badge-success" style={{ fontSize: 10 }}>Menor plazo</span>}
                    </div>
                  </td>
                  {conPrecio && <td style={{ fontWeight: 600 }}>{p.precio != null ? formatMoney(p.precio) : SIN_DATOS}</td>}
                  <td>{p.plazo_prometido != null ? `${p.plazo_prometido} días hábiles` : SIN_DATOS}</td>
                  <td>{p.plazo_real_promedio != null ? fmtDias1(p.plazo_real_promedio) : SIN_DATOS}</td>
                  <td>
                    {p.cumplimiento_pct != null
                      ? <>{Number(p.cumplimiento_pct).toLocaleString('es-CL')} %<div style={{ fontSize: 11, color: 'var(--gray)' }}>{p.entregas} entrega(s)</div></>
                      : p.entregas > 0 ? <>{SIN_DATOS}<div style={{ fontSize: 11, color: 'var(--gray)' }}>{p.entregas} entrega(s), sin plazo prometido</div></> : SIN_DATOS}
                  </td>
                  <td>{p.cantidad_minima != null ? formatQty(p.cantidad_minima) : SIN_DATOS}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 10, marginBottom: 0 }}>
        {conPrecio ? 'Menor costo: precio unitario vigente más bajo. ' : ''}
        Menor plazo: plazo real promedio más bajo (días hábiles, de las entregas de este producto).
        Un proveedor sin el dato de un criterio queda fuera de ese destaque.
      </p>
    </div>
  );
}

/**
 * Detalle Producto — conversión 1:1 de productos/detalle.html (?sku= → /productos/:sku).
 * data-rol="gerencia": botón Editar, botón "+ Vincular proveedor" y su formulario (ocultos si rol === 'jop').
 */
export default function ProductoDetalle() {
  usePageTitle('Detalle Producto');
  const { sku } = useParams();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const esGerenciaVisible = user?.rol !== 'jop';
  // CU-60: vincular y editar proveedores es solo de gerencia (el endpoint exige soloGerencia)
  const esGerencia = user?.rol === 'gerencia';
  // CU-65: las secciones de detalle van en pestañas bajo la ficha (?tab=movimientos|precios|comparar).
  // Precios es solo de gerencia (CU-61).
  const [params, setParams] = useSearchParams();
  const tabsValidas = esGerencia ? ['movimientos', 'precios', 'comparar'] : ['movimientos', 'comparar'];
  const tab = tabsValidas.includes(params.get('tab')) ? params.get('tab') : 'movimientos';
  const cambiarTab = useCallback((t) => {
    setParams(prev => {
      const p = new URLSearchParams(prev);
      if (t === 'movimientos') p.delete('tab'); else p.set('tab', t);
      return p;
    }, { replace: true });
  }, [setParams]);
  const refTabs = useRef(null);
  const [irATabs, setIrATabs] = useState(0);   // el botón "Comparar proveedores" lleva la vista a las pestañas
  const [comparacion, setComparacion] = useState(null);
  const [errComparacion, setErrComparacion] = useState('');
  const confirm = useConfirm();

  const [prod, setProd] = useState(null);
  const [titulo, setTitulo] = useState('Cargando...');
  const [errorCarga, setErrorCarga] = useState('');
  const [periodo, setPeriodo] = useState('mes');
  const [movs, setMovs] = useState(null); // null = Cargando historial…
  const [provs, setProvs] = useState([]);
  const [formProv, setFormProv] = useState(false);
  const [provId, setProvId] = useState('');
  const [provTiempo, setProvTiempo] = useState('');
  const [provPrecio, setProvPrecio] = useState('');
  const [provCantMin, setProvCantMin] = useState('');   // CU-60: cantidad minima de pedido
  const [provErrCampo, setProvErrCampo] = useState(''); // CU-60 Exc 1: campo invalido a marcar
  const [provAlert, setProvAlert] = useState(null); // { type, msg }

  // Historial de precios (SONNET-9)
  const [precios, setPrecios] = useState(null); // null = Cargando…
  const [precioDesde, setPrecioDesde] = useState('');
  const [precioHasta, setPrecioHasta] = useState('');
  const [precioProveedor, setPrecioProveedor] = useState('');

  const cargarDetalle = useCallback(async () => {
    if (!sku) { setTitulo('SKU no especificado'); return; }
    try {
      const p = await API.materiales.obtener(sku);
      console.log('Producto recibido:', p);
      if (!p || p.error) {
        setTitulo('Error');
        showAlert('danger', p?.error || 'No se pudo cargar el producto');
        return;
      }
      setProd(p);
      setTitulo(p.nombre || p.sku);
    } catch (err) {
      console.error('Error en cargarDetalle:', err);
      setTitulo('Error cargando producto');
      setErrorCarga('Error: ' + (err.message || err));
    }
  }, [sku, showAlert]);

  const cargarHistorial = useCallback(async () => {
    const desde = DIAS[periodo] ? hoyLocal(-DIAS[periodo]) : null;
    try {
      const lista = await API.movimientos.listar({ buscar: sku, desde });
      setMovs(Array.isArray(lista) ? lista : []);
    } catch (err) {
      console.warn('Error cargando historial:', err.message);
    }
  }, [sku, periodo]);

  useEffect(() => {
    API.proveedores.listar().then(p => setProvs(p || [])).catch(() => {});
    cargarDetalle();
  }, [cargarDetalle]);

  // CU-65: la comparación se pide al abrir su pestaña y se refresca si el producto se recarga (p. ej. tras vincular)
  useEffect(() => {
    if (tab !== 'comparar' || !prod) return undefined;
    let cancelado = false;
    API.materiales.compararProveedores(sku)
      .then(d => { if (!cancelado) { setComparacion(d); setErrComparacion(''); } })
      .catch(err => { if (!cancelado) setErrComparacion('Error comparando proveedores: ' + err.message); });
    return () => { cancelado = true; };
  }, [tab, prod, sku]);

  // El botón de la tarjeta Proveedores abre la pestaña y lleva la vista hasta ella
  useEffect(() => {
    if (irATabs > 0) refTabs.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [irATabs]);

  // Historial de movimientos (FR-27): al abrir su pestaña y al cambiar el período
  useEffect(() => { if (prod && tab === 'movimientos') cargarHistorial(); }, [prod, tab, cargarHistorial]);

  // Historial de precios (SONNET-9): al cargar el producto y al cambiar los filtros
  const cargarPrecios = useCallback(async () => {
    try {
      const data = await API.materiales.precios(sku, {
        desde: precioDesde || null,
        hasta: precioHasta || null,
        proveedor_id: precioProveedor || null,
      });
      if (data?.error) { setPrecios([]); return; }
      setPrecios(Array.isArray(data.precios) ? data.precios : []);
    } catch (err) {
      console.warn('Error cargando historial de precios:', err.message);
      setPrecios([]);
    }
  }, [sku, precioDesde, precioHasta, precioProveedor]);

  // CU-61: los montos del historial son solo para gerencia (el backend responde 403 al resto)
  // CU-65: se piden recién al abrir la pestaña Precios
  useEffect(() => { if (prod && esGerencia && tab === 'precios') cargarPrecios(); }, [prod, esGerencia, tab, cargarPrecios]);

  const limpiarFiltrosPrecios = () => { setPrecioDesde(''); setPrecioHasta(''); setPrecioProveedor(''); };

  // CU-60: abre el formulario vacio (vincular) o con los valores de un proveedor ya vinculado (editar)
  const abrirFormProv = (p = null) => {
    setProvId(p ? String(p.id) : '');
    setProvPrecio(p?.precio_referencial != null ? String(parseFloat(p.precio_referencial)) : '');
    setProvTiempo(p?.tiempo_reposicion != null ? String(p.tiempo_reposicion) : '');
    setProvCantMin(p?.cantidad_minima != null ? String(parseFloat(p.cantidad_minima)) : '');
    setProvErrCampo('');
    setProvAlert(null);
    setFormProv(true);
  };

  // CU-60 Exc 1: los tres valores son obligatorios y positivos. Devuelve { campo, msg } o null.
  const validarProveedor = () => {
    if (!provId) return { campo: 'proveedor_id', msg: 'Seleccione un proveedor.' };
    const precio = parseFloat(provPrecio);
    if (!(precio > 0)) return { campo: 'precio', msg: 'El precio unitario debe ser un monto mayor a cero.' };
    const tiempo = Number(provTiempo);
    if (!Number.isInteger(tiempo) || tiempo < 1) return { campo: 'tiempo_reposicion', msg: 'El tiempo de reposición debe ser un número entero de días hábiles, de al menos 1.' };
    if (!(parseFloat(provCantMin) >= 1)) return { campo: 'cantidad_minima', msg: 'La cantidad mínima de pedido debe ser al menos 1.' };
    return null;
  };

  // CU-60: vincular proveedor al producto, o actualizar sus valores si ya estaba vinculado
  const vincularProveedor = async () => {
    const invalido = validarProveedor();
    if (invalido) { setProvErrCampo(invalido.campo); setProvAlert({ type: 'danger', msg: invalido.msg }); return; }
    setProvErrCampo('');
    const datos = {
      proveedor_id:      parseInt(provId),
      precio:            parseFloat(provPrecio),
      tiempo_reposicion: Number(provTiempo),
      cantidad_minima:   parseFloat(provCantMin),
    };
    try {
      let resp = await API.materiales.vincularProveedor(sku, datos);
      // CU-60 Exc 2: ya existe la relacion → mostrar los valores vigentes y confirmar
      if (resp?.duplicado) {
        const v = resp.vigentes || {};
        const ok = await confirm(
          <>
            Este proveedor ya está vinculado al producto. Valores vigentes:
            <ul style={{ margin: '8px 0 8px 18px' }}>
              <li>Precio unitario: <strong>{v.precio != null ? formatMoney(v.precio) : '—'}</strong> → {formatMoney(datos.precio)}</li>
              <li>Tiempo de reposición: <strong>{v.tiempo_reposicion ?? '—'} días hábiles</strong> → {datos.tiempo_reposicion}</li>
              <li>Cantidad mínima: <strong>{v.cantidad_minima ?? '—'}</strong> → {datos.cantidad_minima}</li>
            </ul>
            ¿Desea actualizarlos? El precio anterior quedará registrado en el historial de precios.
          </>,
          'Actualizar proveedor'
        );
        if (!ok) return;
        resp = await API.materiales.vincularProveedor(sku, { ...datos, confirmar: true });
      }
      setProvAlert({ type: 'success', msg: resp?.message || 'Proveedor vinculado correctamente.' });
      setFormProv(false);
      cargarDetalle();
      cargarPrecios();
    } catch (err) {
      if (err.payload?.campo) setProvErrCampo(err.payload.campo);
      setProvAlert({ type: 'danger', msg: err.message });
    }
  };
  const errProv = (campo) => (provErrCampo === campo ? { borderColor: 'var(--danger)' } : undefined);

  // CU-30: generar el código de barras interno de un producto creado antes de CU-30
  const [generandoCodigo, setGenerandoCodigo] = useState(false);
  const generarCodigo = async () => {
    setGenerandoCodigo(true);
    try {
      const resp = await API.codigos.generar(prod.sku);
      // Un 409 (ya tenía código) llega como datos, no como excepción
      if (resp?.error) showAlert('warning', resp.error);
      else showAlert('success', `Código generado: ${resp.codigo_barras}. Ya puede imprimir la etiqueta.`);
      cargarDetalle();
    } catch (err) {
      showAlert('danger', err.message || 'No se pudo generar el código.');
    } finally {
      setGenerandoCodigo(false);
    }
  };

  // Derivados de stock
  const stockTotal = (prod?.stock_por_bodega || []).reduce((s, b) => s + parseFloat(b.cantidad_fisica || 0), 0);
  const min = parseFloat(prod?.stock_minimo || 0);
  const max = parseFloat(prod?.stock_maximo || 0);
  const crit = parseFloat(prod?.stock_critico || 0);
  let stockBadge = null;
  if (prod) {
    // CU-123: un insumo especial no tiene umbrales; compararlo contra 0 lo mostraría "Crítico"
    if (prod.es_rotativo === false)        stockBadge = <span className="badge badge-gray">Insumo especial · sin umbrales</span>;
    else if (stockTotal <= crit)           stockBadge = <span className="badge badge-danger">Crítico</span>;
    else if (stockTotal <= min)            stockBadge = <span className="badge badge-warning">Bajo mínimo</span>;
    else if (max > 0 && stockTotal >= max) stockBadge = <span className="badge badge-info">Sobrestock</span>;
    else                                   stockBadge = <span className="badge badge-success">Normal</span>;
  }
  const proveedores = prod?.proveedores || [];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title" id="prod-nombre">{titulo}</div>
          <div className="page-subtitle" id="prod-sku">{prod ? 'SKU: ' + (prod.sku || sku) : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/productos" className="btn btn-secondary">← Volver</Link>
          {esGerenciaVisible && (
            <Link to={prod ? `/productos/${prod.sku}/editar` : '#'} className="btn btn-primary" id="btn-editar">Editar</Link>
          )}
        </div>
      </div>

      <div id="alert-container">
        <Alert {...alert} />
        {errorCarga && (
          <div style={{ padding: 12, background: '#f8d7da', color: '#721c24', borderRadius: 8, marginBottom: 16 }}>{errorCarga}</div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>

        {/* Info principal */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div className="card">
            <div className="section-label">Identificación y clasificación</div>
            <div className="form-row" style={{ marginBottom: 16 }}>
              <div>
                <div className="form-label">SKU</div>
                <span className="td-mono" id="d-sku" style={{ fontSize: 13 }}>{prod?.sku}</span>
              </div>
              <div>
                <div className="form-label">Unidad de medida</div>
                <span style={{ fontSize: 14, fontWeight: 500 }} id="d-unidad">{prod ? (prod.unidad_medida || '—') : ''}</span>
              </div>
            </div>
            <div className="form-row" style={{ marginBottom: 16 }}>
              <div>
                <div className="form-label">Categoría general</div>
                <span className="badge badge-orange" id="d-categoria">{prod ? (prod.categoria_general || '—') : ''}</span>
              </div>
              <div>
                <div className="form-label">Categoría funcional</div>
                <span className="badge badge-gray" id="d-funcional">{prod ? (prod.categoria_funcional || '—') : ''}</span>
              </div>
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <div>
                <div className="form-label">Producto crítico</div>
                <span className={'badge' + (prod ? (prod.es_critico ? ' badge-danger' : ' badge-gray') : '')} id="d-critico">
                  {prod ? (prod.es_critico ? 'Sí — Producto crítico' : 'No') : ''}
                </span>
                {/* CU-123 */}
                <div className="form-label" style={{ marginTop: 10 }}>Insumo especial / No rotativo</div>
                <span className={'badge' + (prod ? (prod.es_rotativo === false ? ' badge-orange' : ' badge-gray') : '')} id="d-especial">
                  {prod ? (prod.es_rotativo === false ? 'Sí — se compra a pedido' : 'No') : ''}
                </span>
                {prod?.descontinuado && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Descontinuado — ya no se compra</span>}
              </div>
              {/* CU-30: código de barras interno y su etiqueta */}
              <div>
                <div className="form-label">Código de barras</div>
                {prod && (prod.codigo_barras ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span className="td-mono" id="d-codigo" style={{ fontSize: 13 }}>{prod.codigo_barras}</span>
                    <Link to={`/productos/etiquetas?sku=${encodeURIComponent(prod.sku)}`} className="btn btn-secondary" id="btn-etiqueta"
                      style={{ padding: '4px 10px', fontSize: 12 }}>
                      Imprimir etiqueta
                    </Link>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: 'var(--gray)' }} id="d-codigo">Sin código</span>
                    {esGerencia && (
                      <button type="button" className="btn btn-primary" id="btn-generar-codigo" onClick={generarCodigo}
                        disabled={generandoCodigo} style={{ padding: '4px 10px', fontSize: 12 }}>
                        {generandoCodigo ? 'Generando...' : 'Generar código'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="section-label">Descripción</div>
            <p style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.7 }} id="d-descripcion">{prod?.descripcion || 'Sin descripción.'}</p>
            {/* CU-19: presentacion comercial */}
            <div className="form-label" style={{ marginTop: 12 }}>Presentación</div>
            <p style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.7, margin: 0 }} id="d-presentacion">
              {prod?.presentacion || 'Sin presentación registrada.'}
            </p>
            {prod?.presentacion_fecha_modificacion && (
              <div className="form-hint">
                Última modificación: {new Date(prod.presentacion_fecha_modificacion).toLocaleString('es-CL', {
                  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            )}
          </div>

        </div>

        {/* Lateral: stock */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-label">Estado de stock</div>

            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1 }} id="d-stockActual">{prod ? formatQty(stockTotal) : '—'}</div>
              <div style={{ fontSize: 13, color: 'var(--gray)', marginTop: 4 }} id="d-unidad-label">{prod ? (prod.unidad_medida || 'unidades') + ' en stock físico' : ''}</div>
              <div style={{ marginTop: 12 }} id="d-stock-badge">{stockBadge}</div>
            </div>

            <div className="divider"></div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--gray)' }}>Stock mínimo</span>
                <span style={{ fontWeight: 600 }} id="d-stockMin">{prod ? formatQty(prod.stock_minimo) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--gray)' }}>Stock máximo</span>
                <span style={{ fontWeight: 600 }} id="d-stockMax">{prod ? formatQty(prod.stock_maximo) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--gray)' }}>Stock crítico</span>
                <span style={{ fontWeight: 600, color: 'var(--danger)' }} id="d-stockCrit">{prod ? formatQty(prod.stock_critico) : '—'}</span>
              </div>
            </div>
          </div>

          {/* Stock por bodega (FR-17) */}
          <div className="card">
            <div className="section-label">Stock por bodega</div>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--gray)', fontSize: 11, textTransform: 'uppercase' }}>
                  <th style={{ textAlign: 'left', padding: '4px 0', fontWeight: 600 }}>Bodega</th>
                  <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 600 }}>Stock físico</th>
                  <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 600 }}>Reservado OT</th>
                </tr>
              </thead>
              <tbody id="tbody-stock-bodega">
                {!prod && <tr><td colSpan={3} style={{ color: 'var(--gray)', fontSize: 12 }}>Cargando...</td></tr>}
                {prod && (!prod.stock_por_bodega || prod.stock_por_bodega.length === 0) && (
                  <tr><td colSpan={3}><div className="empty-state"><p>Sin stock en bodegas.</p></div></td></tr>
                )}
                {prod && (prod.stock_por_bodega || []).map((b, i) => (
                  <tr key={b.bodega_id ?? i}>
                    <td style={{ fontSize: 13, fontWeight: 500 }}>{b.bodega_nombre}</td>
                    <td style={{ fontWeight: 600, textAlign: 'right' }}>{formatQty(b.cantidad_fisica)}</td>
                    <td style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'right' }}>{formatQty(b.cantidad_reservada)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Proveedores del producto (CU-16, CU-17) */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className="section-label" style={{ marginBottom: 0 }}>Proveedores</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {/* CU-65: la tabla se abre debajo, a todo el ancho */}
                <button className="btn btn-ghost btn-sm" id="btn-comparar-prov" style={{ fontSize: 11 }}
                  onClick={() => { cambiarTab('comparar'); setIrATabs(n => n + 1); }}>Comparar proveedores ↓</button>
                {esGerencia && (
                  <button className="btn btn-ghost btn-sm" id="btn-agregar-prov" style={{ fontSize: 11 }}
                    onClick={() => (formProv ? setFormProv(false) : abrirFormProv())}>+ Vincular proveedor</button>
                )}
              </div>
            </div>
            <div id="proveedores-lista" style={{ fontSize: 13 }}>
              {!prod && 'Cargando…'}
              {prod && proveedores.length === 0 && (
                <div style={{ color: 'var(--gray)', fontSize: 12, padding: '8px 0' }}>Sin proveedores vinculados. El producto no tendrá fuentes de reposición configuradas.</div>
              )}
              {prod && proveedores.map((p, i) => (
                <div key={p.id ?? i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      {p.nombre || 'Proveedor #' + p.id}
                      {p.es_principal && <> <span className="badge badge-warning" style={{ fontSize: 10 }}>Principal</span></>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                      Tiempo repos.: {p.tiempo_reposicion ? <strong>{p.tiempo_reposicion} días hábiles</strong> : <span style={{ color: 'var(--warning)' }}>No registrado</span>}
                      {/* El backend no envia el precio al rol JOP */}
                      {'precio_referencial' in p && <>{' '}· Precio: {p.precio_referencial ? formatMoney(p.precio_referencial) : '—'}</>}
                      {' '}· Mín. pedido: {p.cantidad_minima != null ? formatQty(p.cantidad_minima) : '—'}
                    </div>
                  </div>
                  {/* CU-60: editar los valores comerciales de un proveedor ya vinculado */}
                  {esGerencia && (
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => abrirFormProv(p)}>Editar</button>
                  )}
                </div>
              ))}
            </div>
            {/* Form agregar proveedor */}
            {esGerencia && formProv && (
              <div id="add-prov-form" style={{ marginTop: 12, padding: 12, background: 'var(--bg-alt)', borderRadius: 8 }}>
                <div id="add-prov-alert">
                  {provAlert && <div className={`alert alert-${provAlert.type}`} style={{ fontSize: 12 }}>{provAlert.msg}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 140 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Proveedor</label>
                    <select className="form-control" id="add-prov-select" value={provId} style={errProv('proveedor_id')}
                      onChange={e => { setProvId(e.target.value); setProvErrCampo(''); }}>
                      <option value="">Seleccione proveedor</option>
                      {provs.map(p => <option key={p.id} value={p.id}>{p.razon_social || p.nombre}</option>)}
                    </select>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 90 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Precio unitario (CLP) <span className="required">*</span></label>
                    <input className="form-control" type="number" id="add-prov-precio" min={1} step="1" placeholder="15000" value={provPrecio} style={errProv('precio')}
                      onChange={e => { setProvPrecio(e.target.value); setProvErrCampo(''); }} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 90 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Reposición (días hábiles) <span className="required">*</span></label>
                    <input className="form-control" type="number" id="add-prov-tiempo" min={1} step="1" placeholder="5" value={provTiempo} style={errProv('tiempo_reposicion')}
                      onChange={e => { setProvTiempo(e.target.value); setProvErrCampo(''); }} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 90 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Cantidad mínima <span className="required">*</span></label>
                    <input className="form-control" type="number" id="add-prov-cantmin" min={1} placeholder="1" value={provCantMin} style={errProv('cantidad_minima')}
                      onChange={e => { setProvCantMin(e.target.value); setProvErrCampo(''); }} />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={vincularProveedor}>Guardar</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setFormProv(false)}>Cancelar</button>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* CU-65: comparación de proveedores, a todo el ancho */}
      {/* CU-65: secciones de detalle en pestañas, bajo la ficha (?tab=movimientos|precios|comparar) */}
      <div ref={refTabs} style={{ marginTop: 20, scrollMarginTop: 16 }}>
        <div className="tabs" style={{ marginBottom: 16 }}>
          <div className={'tab' + (tab === 'movimientos' ? ' active' : '')} id="tab-movimientos" onClick={() => cambiarTab('movimientos')}>Movimientos</div>
          {esGerencia && <div className={'tab' + (tab === 'precios' ? ' active' : '')} id="tab-precios" onClick={() => cambiarTab('precios')}>Precios</div>}
          <div className={'tab' + (tab === 'comparar' ? ' active' : '')} id="tab-comparar" onClick={() => cambiarTab('comparar')}>Comparar proveedores</div>
        </div>

        {tab === 'movimientos' && (<>
          {/* Historial de movimientos del producto (FR-27) */}
          <div className="card">
            <div className="card-title">
              Historial de movimientos
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-control" id="hist-periodo" style={{ width: 'auto', fontSize: 12, padding: '4px 28px 4px 8px' }}
                  value={periodo} onChange={e => setPeriodo(e.target.value)}>
                  <option value="semana">Última semana</option>
                  <option value="mes">Último mes</option>
                  <option value="trimestre">Último trimestre</option>
                  <option value="anio">Último año</option>
                </select>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Tipo</th><th>Cantidad</th><th>Bodega</th><th>Usuario</th></tr>
                </thead>
                <tbody id="tbody-historial">
                  {movs === null && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--gray)', padding: 16 }}>Cargando historial…</td></tr>
                  )}
                  {movs !== null && movs.length === 0 && (
                    <tr><td colSpan={5}><div className="empty-state"><p>Sin movimientos en este período.</p></div></td></tr>
                  )}
                  {movs !== null && movs.map((m, i) => (
                    <tr key={m.id ?? i}>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{fechaLocal(m.fecha_hora)}</td>
                      <td><span className="badge badge-gray">{m.tipo || '—'}</span></td>
                      <td style={{ fontWeight: 600 }}>{parseFloat(m.cantidad || 0)}</td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.bodega || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>)}

        {tab === 'precios' && esGerencia && (<>
          {/* Historial de precios (SONNET-9). CU-61: solo gerencia */}
          <div className="card">
            <div className="card-title">Historial de precios</div>
            <div className="filter-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
              <select className="form-control" id="precio-filtro-proveedor" style={{ width: 'auto' }}
                value={precioProveedor} onChange={e => setPrecioProveedor(e.target.value)}>
                <option value="">Todos los proveedores</option>
                {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
              </select>
              <input className="form-control" type="date" style={{ width: 'auto' }} value={precioDesde} onChange={e => setPrecioDesde(e.target.value)} />
              <input className="form-control" type="date" style={{ width: 'auto' }} value={precioHasta} onChange={e => setPrecioHasta(e.target.value)} />
              <button className="btn btn-ghost btn-sm" type="button" onClick={limpiarFiltrosPrecios}>Limpiar filtros</button>
            </div>

            {/* Mini-gráfico de tendencia */}
            {precios && precios.length > 1 && (() => {
              const cronologico = precios.slice().reverse();
              const maxPrecio = Math.max(...cronologico.map(p => parseFloat(p.precio_unitario || 0)));
              return (
                <div style={{ marginBottom: 16, padding: '4px 0' }}>
                  <div style={{ fontSize: 11, color: 'var(--gray)', marginBottom: 6 }}>Tendencia (más antiguo → más reciente)</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 60 }}>
                    {cronologico.map((p, i) => (
                      <div key={p.id ?? i} title={`${fechaLocal(p.fecha)}: ${formatMoney(p.precio_unitario)}`}
                        style={{
                          flex: 1, minWidth: 4, borderRadius: '2px 2px 0 0', background: 'var(--orange)',
                          height: maxPrecio > 0 ? `${Math.max((parseFloat(p.precio_unitario || 0) / maxPrecio) * 100, 4)}%` : '4%',
                        }} />
                    ))}
                  </div>
                </div>
              );
            })()}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Precio anterior</th><th>Precio unitario</th><th>Variación</th><th>Proveedor</th><th>Fuente</th><th>Factura</th></tr>
                </thead>
                <tbody id="tbody-precios">
                  {precios === null && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--gray)', padding: 16 }}>Cargando historial de precios…</td></tr>
                  )}
                  {precios !== null && precios.length === 0 && (
                    <tr><td colSpan={7}><div className="empty-state"><p>Sin historial de precios para este producto.</p></div></td></tr>
                  )}
                  {precios !== null && precios.map((p, i) => (
                    <tr key={p.id ?? i}>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{fechaLocal(p.fecha)}</td>
                      {/* CU-64: variacion respecto del precio anterior del mismo proveedor */}
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{p.precio_anterior != null ? formatMoney(p.precio_anterior) : '—'}</td>
                      <td style={{ fontWeight: 600 }}>{formatMoney(p.precio_unitario)}</td>
                      <td><VariacionPrecio abs={p.variacion_abs} pct={p.variacion_pct} anterior={p.precio_anterior} registros={p.registros_producto} /></td>
                      <td style={{ fontSize: 13 }}>{p.proveedor || '—'}</td>
                      <td><span className="badge badge-gray" style={{ fontSize: 10 }}>{p.fuente || '—'}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{p.factura || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>)}

        {tab === 'comparar' && (
          <ComparacionProveedores datos={comparacion} error={errComparacion} esGerencia={esGerencia}
            onVincular={() => { abrirFormProv(); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
        )}
      </div>
    </>
  );
}
