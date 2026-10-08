import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import EscanerCodigo from '../../components/EscanerCodigo';
import SelectorProducto from '../../components/SelectorProducto';
import ModalVincularInsumo from '../../components/ModalVincularInsumo';
import { ERR_BORDER, ERR_FULL } from '../productos/clasificacion';

// CU-62: fecha LOCAL. Con toISOString() (UTC) desde las 21:00 en Chile daba el día
// siguiente, y ahora esta fecha se guarda como recepción (el backend rechaza futuras).
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esActiva = (b) => ['activo', 'activa'].includes(b.estado);

/** Registrar Entrada — conversión 1:1 de movimientos/entrada.html */
export default function MovimientoEntrada() {
  usePageTitle('Registrar Entrada');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();

  const [materiales, setMateriales] = useState(null);
  const [bodegas, setBodegas] = useState(null);
  const [proveedores, setProveedores] = useState(null);
  const [tipoEntradaId, setTipoEntradaId] = useState(null);

  const [sku, setSku] = useState('');
  const [bodega, setBodega] = useState('');
  // OPUS-5: anaqueles de la bodega elegida (destino fisico del stock, opcional)
  const [anaqueles, setAnaqueles] = useState([]);
  const [anaquel, setAnaquel] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [fecha, setFecha] = useState(hoy());
  const [proveedor, setProveedor] = useState('');
  const [facturaNumero, setFacturaNumero] = useState('');
  const [facturaFecha, setFacturaFecha] = useState('');
  const [fechaPedido, setFechaPedido] = useState('');
  const [precioUnitario, setPrecioUnitario] = useState('');
  // D66: compra (proveedor, precio, pedido y factura obligatorios) o devolución de obra
  const [tipoEntrada, setTipoEntrada] = useState('compra');
  const [descripcion, setDescripcion] = useState('');
  // D57: proveedores asociados al SKU (null = aún no se elige producto) y el recurso "mostrar todos"
  const [provsSku, setProvsSku] = useState(null);
  const [mostrarTodos, setMostrarTodos] = useState(false);
  const esCompra = tipoEntrada === 'compra';
  const [errStyles, setErrStyles] = useState({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // null | 'error' | { total, min, unidad }
  const cantidadRef = useRef(null); // CU-30: tras escanear, el cursor va a la cantidad
  // Sesión 15 (CU-30): Enter en Cantidad no envía el formulario y vuelve al escáner (como en el conteo):
  // así un segundo escaneo no escribe el código en la cantidad ni registra el movimiento por error.
  const volverAlEscaner = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const el = document.getElementById('escaner-codigo');
    if (el) { el.focus(); el.select?.(); }
  };
  // CU-124: recepción de un insumo especial pendiente de vincular a sus ventas
  const [recepcion, setRecepcion] = useState(null);

  // OPUS-5: al elegir bodega se cargan sus anaqueles (GET /api/bodegas/:id ya los trae)
  useEffect(() => {
    let cancelado = false;
    setAnaquel('');
    if (!bodega) { setAnaqueles([]); return; }
    (async () => {
      try {
        const d = await API.bodegas.obtener(bodega);
        if (!cancelado) setAnaqueles(d?.anaqueles || []);
      } catch {
        if (!cancelado) setAnaqueles([]);   // sin anaqueles la entrada igual se puede registrar
      }
    })();
    return () => { cancelado = true; };
  }, [bodega]);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [m, b, p, catalogos] = await Promise.all([
          API.materiales.listar({ estado: 'activo' }),   // CU-30 Exc 3: un inactivo no admite movimientos
          API.bodegas.listar(),
          API.proveedores.listar(),
          API.movimientos.catalogos(),
        ]);
        if (cancelado) return;
        setMateriales(m || []);
        setBodegas((b || []).filter(esActiva));
        setProveedores(p || []);
        // Tipo movimiento: solo entradas
        const tipos = (catalogos?.tipos || []).filter(t => t.nombre.toLowerCase().includes('entrada'));
        setTipoEntradaId(tipos[0]?.id ?? null);
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error cargando catálogos: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [showAlert]);

  // Preview stock al seleccionar producto
  const onSkuChange = async (val) => {
    setSku(val);
    setMostrarTodos(false);
    if (!val) { setPreview(null); setProvsSku(null); return; }
    try {
      const mat = await API.materiales.obtener(val);
      // D57: solo los proveedores del producto, con el principal preelegido
      const provs = mat.proveedores || [];
      setProvsSku(provs);
      setProveedor(provs.length ? String(provs[0].id) : '');
      const total = parseFloat(mat.stock_por_bodega?.reduce((s, b) => s + parseFloat(b.cantidad_fisica || 0), 0) || 0);
      const min = parseFloat(mat.stock_minimo || 0);
      setPreview({ total, min, unidad: mat.unidad_medida || 'unidades' });
    } catch {
      setPreview('error');
    }
  };

  // CU-30: producto leído por escáner → autocompleta producto y bodega, cursor en cantidad
  const onProductoEscaneado = (p) => {
    onSkuChange(p.sku);
    const conStock = (p.bodegas || []).filter(b => (bodegas || []).some(x => String(x.id) === String(b.bodega_id)));
    if (conStock.length === 1) setBodega(String(conStock[0].bodega_id));
    requestAnimationFrame(() => cantidadRef.current?.focus());
  };

  // D57: los proveedores del producto (el principal marcado); todos solo si no tiene y se pide
  const listaProveedores = provsSku === null ? []
    : mostrarTodos ? (proveedores || [])
    : provsSku.map(p => ({ id: p.id, nombre: p.nombre + (p.es_principal ? ' (principal)' : '') }));

  // Cálculo tiempo entrega (FR-41)
  let tiempoEntrega = null;
  if (fechaPedido && fecha) {
    const dias = Math.round((new Date(fecha) - new Date(fechaPedido)) / 86400000);
    tiempoEntrega = dias < 0
      ? <span style={{ color: 'var(--danger)' }}>La fecha del pedido no puede ser posterior a la recepción.</span>
      : <>Tiempo de entrega: <strong>{dias} día(s) corridos</strong> <span style={{ color: 'var(--gray)' }}>(el cumplimiento del proveedor se mide en días hábiles)</span></>;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    const cant = parseFloat(cantidad);
    const lote = null; // el HTML leía #lote opcionalmente; no existe en el formulario
    const errs = {};
    let errE = null;
    if (!sku)                          { errs.sku = ERR_BORDER; errE = 'Selecciona un producto.'; }
    else if (!bodega)                  { errs.bodega = ERR_BORDER; errE = 'Selecciona la bodega de destino.'; }
    else if (isNaN(cant) || cant <= 0) { errs.cantidad = ERR_FULL; errE = 'La cantidad debe ser mayor que 0.'; }
    else if (esCompra && !proveedor)   { errs.proveedor = ERR_BORDER; errE = 'Debes seleccionar un proveedor.'; }
    // D66 (D56): una compra lleva precio, fecha del pedido y factura; una devolución, de dónde vuelve
    else if (esCompra && !(parseFloat(precioUnitario) > 0)) { errs.precio = ERR_BORDER; errE = 'Ingrese el precio unitario de compra (mayor que 0).'; }
    else if (esCompra && !fechaPedido) { errs.fechaPedido = ERR_BORDER; errE = 'Ingrese la fecha del pedido al proveedor.'; }
    else if (esCompra && (!facturaNumero.trim() || !facturaFecha)) { errs.facturaNumero = ERR_BORDER; errs.facturaFecha = ERR_BORDER; errE = 'Ingrese el número y la fecha de emisión de la factura.'; }
    else if (!esCompra && !descripcion.trim()) { errs.descripcion = ERR_FULL; errE = 'Indique de qué obra o venta vuelve el material.'; }
    else if (!tipoEntradaId)           { errE = 'No se encontró tipo de movimiento "entrada". Verifica la BD.'; }
    setErrStyles(errs);
    if (errE) { showAlert('danger', errE); return; }

    // CU-32: Validar datos de factura (ambos o ninguno)
    const fNum = facturaNumero.trim();
    if (fNum && !facturaFecha) { setErrStyles({ facturaFecha: ERR_BORDER }); showAlert('danger', 'Debe ingresar la fecha de emisión de la factura.'); return; }
    if (!fNum && facturaFecha) { setErrStyles({ facturaNumero: ERR_BORDER }); showAlert('danger', 'Debe ingresar el número de la factura.'); return; }
    // CU-32 Exc 2: fecha de factura no puede ser futura
    if (facturaFecha && facturaFecha > hoy()) { setErrStyles({ facturaFecha: ERR_BORDER }); showAlert('danger', 'La fecha de emisión de la factura no puede ser una fecha futura.'); return; }
    // CU-62: la fecha del movimiento es la recepción del lote; el pedido no puede ser posterior
    if (fecha && fecha > hoy()) { showAlert('danger', 'La fecha del movimiento (recepción) no puede ser una fecha futura.'); return; }
    if (fechaPedido && fechaPedido > (fecha || hoy())) { showAlert('danger', 'La fecha del pedido no puede ser posterior a la recepción.'); return; }

    setSaving(true);
    try {
      const r = await API.movimientos.entrada({
        sku,
        bodega_id:          parseInt(bodega),
        cantidad:           cant,
        numero_lote:        lote,
        tipo_movimiento_id: tipoEntradaId,
        tipo_entrada:       tipoEntrada,   // D66
        ...(esCompra ? {
          proveedor_id:     parseInt(proveedor),
          // CU-32: factura de compra
          factura_numero:   fNum,
          factura_fecha:    facturaFecha,
          // SONNET-9: precio unitario de compra (alimenta el historial de precios)
          precio_unitario:  parseFloat(precioUnitario),
          // CU-62: fecha del pedido (y recepción, abajo)
          fecha_pedido:     fechaPedido,
        } : { descripcion_motivo: descripcion.trim() }),
        ...(fecha && { fecha_recepcion: fecha }),
        // OPUS-5: anaquel destino dentro de la bodega
        ...(anaquel && { anaquel_id: parseInt(anaquel) }),
      });
      // Un 409 (factura ya registrada) llega como datos, no como excepción
      if (r?.error) { showAlert('danger', r.error); setSaving(false); return; }
      showAlert('success', esCompra ? 'Entrada registrada correctamente. El stock ha sido actualizado.' : 'Devolución de obra registrada: el stock volvió a la bodega y se descontó del consumo.');
      // CU-124: un insumo especial se vincula a su venta antes de volver al historial
      if (r?.insumo_especial) { setRecepcion(r.insumo_especial); return; }
      setTimeout(() => navigate('/movimientos/historial'), 1500);
    } catch (err) {
      showAlert('danger', err.message || 'Error al registrar la entrada.');
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Registrar Entrada</div>
          <div className="page-subtitle">Ingreso de stock al inventario (FR-18, FR-22)</div>
        </div>
        <Link to="/movimientos/historial" className="btn btn-secondary">← Volver al historial</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {recepcion && (
        <ModalVincularInsumo
          recepcion={recepcion}
          unidad={preview && preview !== 'error' ? preview.unidad : ''}
          puedeVincular={['gerencia', 'jop'].includes(user?.rol)}
          onClose={(mensaje) => {
            setRecepcion(null);
            showAlert('success', mensaje || 'Entrada registrada. El insumo especial quedó como stock libre: se puede vincular después desde Alertas → Faltantes → Insumos especiales.');
            setTimeout(() => navigate('/movimientos/historial'), 2500);
          }} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>

        <form id="form-entrada" noValidate onSubmit={onSubmit}>
          <EscanerCodigo onProducto={onProductoEscaneado} />

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Datos del producto</div>
            {/* D66: compra al proveedor o devolución de material desde una obra */}
            <div className="form-group">
              <label className="form-label" htmlFor="tipo-entrada">Tipo de entrada <span className="required">*</span></label>
              <select className="form-control" id="tipo-entrada" value={tipoEntrada} onChange={e => setTipoEntrada(e.target.value)}>
                <option value="compra">Compra a proveedor</option>
                <option value="devolucion">Devolución de obra (vuelve material despachado o consumido)</option>
              </select>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="sku">SKU del producto <span className="required">*</span></label>
                {/* Sesión 15 (punto 22): búsqueda por SKU o nombre */}
                <SelectorProducto id="sku" opciones={materiales || []} value={sku} onChange={onSkuChange} style={errStyles.sku}
                  disabled={materiales === null} placeholder={materiales === null ? 'Cargando productos...' : undefined} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="bodega">Bodega de destino <span className="required">*</span></label>
                <select className="form-control" id="bodega" required value={bodega} onChange={e => setBodega(e.target.value)} style={errStyles.bodega}>
                  {bodegas === null
                    ? <option value="">Cargando bodegas...</option>
                    : <><option value="">Seleccionar bodega...</option>{bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}</>}
                </select>
              </div>
            </div>
            {/* OPUS-5: anaquel destino — opcional, depende de la bodega elegida */}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="anaquel">Anaquel de destino</label>
                <select className="form-control" id="anaquel" value={anaquel} onChange={e => setAnaquel(e.target.value)} disabled={!bodega || anaqueles.length === 0}>
                  <option value="">
                    {!bodega ? 'Seleccione primero una bodega'
                      : anaqueles.length === 0 ? 'Esta bodega no tiene anaqueles registrados'
                      : 'Sin asignar'}
                  </option>
                  {anaqueles.map(a => <option key={a.id} value={a.id}>{a.descripcion || ('Anaquel #' + a.id)}</option>)}
                </select>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                  Opcional. Indica en qué anaquel queda físicamente el material.
                </div>
              </div>
              <div className="form-group" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="cantidad">Cantidad ingresada <span className="required">*</span></label>
                <input ref={cantidadRef} className="form-control" id="cantidad" type="number" min={1} placeholder="0" required value={cantidad} onChange={e => setCantidad(e.target.value)} style={errStyles.cantidad} onKeyDown={volverAlEscaner} />
                <div className="form-hint">Enter vuelve al escáner. Para registrar, use el botón.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="fecha">Fecha del movimiento <span className="required">*</span></label>
                <input className="form-control" id="fecha" type="date" required value={fecha} onChange={e => setFecha(e.target.value)} />
              </div>
            </div>
          </div>

          {esCompra ? (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Proveedor (FR-22)</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="proveedor" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Proveedor asociado <span className="required">*</span></span>
                  <a href="/proveedores" target="_blank" rel="noopener" style={{ fontSize: 11, fontWeight: 400, color: 'var(--orange)' }}
                    onClick={e => { e.preventDefault(); window.open('/proveedores', '_blank'); }}>
                    + Crear nuevo proveedor
                  </a>
                </label>
                {/* D57: solo los proveedores asociados al producto; si no tiene, aviso y "mostrar todos" */}
                <select className="form-control" id="proveedor" required value={proveedor} onChange={e => setProveedor(e.target.value)} style={errStyles.proveedor}
                  disabled={proveedores === null || (provsSku !== null && provsSku.length === 0 && !mostrarTodos)}>
                  {proveedores === null
                    ? <option value="">Cargando proveedores...</option>
                    : <><option value="">{provsSku === null ? 'Elija primero el producto' : 'Seleccionar proveedor...'}</option>
                        {listaProveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</>}
                </select>
                {provsSku !== null && provsSku.length === 0 && !mostrarTodos && (
                  <div className="form-hint" id="aviso-sin-proveedor" style={{ color: 'var(--orange)' }}>
                    Este producto no tiene proveedores asociados.{' '}
                    <a href="#" onClick={e => { e.preventDefault(); setMostrarTodos(true); }}>Mostrar todos los proveedores</a>
                  </div>
                )}
                {/* CU-29 Excepción 1: hint si no hay proveedores */}
                {proveedores !== null && proveedores.length === 0 && (
                  <div className="form-hint" id="hint-proveedor-nuevo" style={{ color: 'var(--orange)' }}>
                    ¿No encuentras el proveedor? Créalo y vuelve a esta pantalla — se cargará automáticamente.
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="factura-numero">Nº Factura de compra <span className="required">*</span></label>
                <input className="form-control" id="factura-numero" placeholder="FAC-2025-001" value={facturaNumero} onChange={e => setFacturaNumero(e.target.value)} style={errStyles.facturaNumero} />
                <div className="form-hint">Una factura con varios productos se reutiliza en cada entrada (mismo proveedor y fecha)</div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="factura-fecha">Fecha emisión factura <span className="required">*</span></label>
                <input className="form-control" id="factura-fecha" type="date" value={facturaFecha} onChange={e => setFacturaFecha(e.target.value)} style={errStyles.facturaFecha} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="fecha-pedido">Fecha del pedido <span className="required">*</span></label>
                <input className="form-control" id="fecha-pedido" type="date" value={fechaPedido} onChange={e => setFechaPedido(e.target.value)} style={errStyles.fechaPedido} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                <div id="tiempo-entrega-preview" style={{ fontSize: 13, color: 'var(--gray)', paddingBottom: 9 }}>{tiempoEntrega}</div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="precio-unitario">Precio unitario de compra <span className="required">*</span></label>
                <input className="form-control" id="precio-unitario" type="number" min={0} step="0.01" placeholder="18500" value={precioUnitario} onChange={e => setPrecioUnitario(e.target.value)} style={errStyles.precio} />
                <div className="form-hint">Se registra en el historial de precios del producto</div>
              </div>
            </div>
          </div>

          ) : (
          <div className="card" style={{ marginBottom: 16 }} id="card-devolucion">
            <div className="section-label">Devolución de obra (D66)</div>
            <div className="form-group">
              <label className="form-label" htmlFor="descripcion-devolucion">¿De qué obra o venta vuelve? <span className="required">*</span></label>
              <textarea className="form-control" id="descripcion-devolucion" rows={2} maxLength={255} value={descripcion}
                onChange={e => setDescripcion(e.target.value)} style={errStyles.descripcion}
                placeholder="Ej: sobrante de la instalación de la venta NV-2026-015" />
              <div className="form-hint">
                No lleva proveedor, precio ni factura. Se descuenta del consumo (igual que una devolución de OT) y entra como
                un lote nuevo con fecha de hoy.
              </div>
            </div>
          </div>
          )}

          <div className="card">
            <div className="section-label">Responsable</div>
            <div className="form-group">
              <label className="form-label">Usuario responsable</label>
              <input className="form-control" id="usuario" disabled value={user ? (user.username || user.id) : ''} readOnly />
              <div className="form-hint">Se asigna automáticamente con la sesión activa</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <Link to="/movimientos/historial" className="btn btn-secondary">Cancelar</Link>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Registrando...' : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>
                    Registrar entrada
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* Sidebar informativo */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-label">Método FIFO (FR — CU-37)</div>
            <p style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.7 }}>
              Este ingreso creará un nuevo lote con fecha y precio de compra. Al registrar salidas, el sistema descontará primero los lotes más antiguos automáticamente.
            </p>
          </div>
          <div className="card">
            <div className="section-label">Stock actual del producto</div>
            <div id="stock-preview" style={{ textAlign: 'center', padding: '16px 0', color: 'var(--gray)' }}>
              {preview === null && <div style={{ fontSize: 12, color: 'var(--gray)' }}>Selecciona un producto</div>}
              {preview === 'error' && <div style={{ fontSize: 12, color: 'var(--gray)' }}>Error cargando stock</div>}
              {preview && preview !== 'error' && (
                <>
                  <div style={{ fontSize: 36, fontWeight: 700, color: preview.total <= preview.min ? 'var(--danger)' : 'var(--success)' }}>{preview.total}</div>
                  <div style={{ fontSize: 12, color: 'var(--gray)' }}>{preview.unidad} disponibles</div>
                  <div style={{ fontSize: 11, marginTop: 4, color: 'var(--gray)' }}>mínimo: {preview.min}</div>
                </>
              )}
            </div>
          </div>
        </div>

      </div>
    </>
  );
}
