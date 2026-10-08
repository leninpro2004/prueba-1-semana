import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import EscanerCodigo from '../../components/EscanerCodigo';
import SelectorProducto from '../../components/SelectorProducto';
import { ERR_BORDER, ERR_FULL } from '../productos/clasificacion';

// Fecha LOCAL (con toISOString(), que es UTC, desde las 21:00 en Chile mostraba el día siguiente)
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// D61: motivos de otros flujos, que esta pantalla no ofrece
const MOTIVOS_DE_OTRO_FLUJO = ['traslado_bodega', 'despacho_venta'];
const esActiva = (b) => ['activo', 'activa'].includes(b.estado);

/** Registrar Salida — conversión 1:1 de movimientos/salida.html */
export default function MovimientoSalida() {
  usePageTitle('Registrar Salida');
  const navigate = useNavigate();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();

  const [materiales, setMateriales] = useState(null);
  const [bodegas, setBodegas] = useState(null);
  const [catalogos, setCatalogos] = useState({ clasificaciones: null, motivos: [], tipos: [] });
  const [bodegasDestino, setBodegasDestino] = useState(null); // se cargan al elegir traslado (CU-19)

  const [sku, setSku] = useState('');
  const [bodega, setBodega] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [clasifId, setClasifId] = useState('');
  const [bodegaDest, setBodegaDest] = useState('');
  const [motivoId, setMotivoId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [evidenciaUrl, setEvidenciaUrl] = useState('');
  const [motivoPlaceholder, setMotivoPlaceholder] = useState('Ej: Producto dañado durante transporte hacia obra, lote 2025-05.');
  const [errStyles, setErrStyles] = useState({});
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // null | 'error' | { disponible, fisico, reservado, min, critico, unidad }
  const [stockDisponible, setStockDisponible] = useState(null);
  // CU-30: bodegas con stock del producto escaneado, cuando son varias
  const [bodegasEscaneo, setBodegasEscaneo] = useState([]);
  const cantidadRef = useRef(null);
  // Sesión 15 (CU-30): Enter en Cantidad no envía el formulario y vuelve al escáner (como en el conteo):
  // así un segundo escaneo no escribe el código en la cantidad ni registra el movimiento por error.
  const volverAlEscaner = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const el = document.getElementById('escaner-codigo');
    if (el) { el.focus(); el.select?.(); }
  };

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [m, b, c] = await Promise.all([
          API.materiales.listar({ estado: 'activo' }),   // CU-30 Exc 3: un inactivo no admite movimientos
          API.bodegas.listar(),
          API.movimientos.catalogos(),
        ]);
        if (cancelado) return;
        setMateriales(m || []);
        setBodegas((b || []).filter(esActiva));
        setCatalogos({
          clasificaciones: c?.clasificaciones || [],
          motivos: c?.motivos || [],
          tipos: c?.tipos || [],
        });
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error cargando catálogos: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [showAlert]);

  const tipoSalidaId = catalogos.tipos.find(t => t.nombre.toLowerCase().includes('salida'))?.id;

  // Preview stock al seleccionar producto
  const onSkuChange = async (val) => {
    setSku(val);
    if (!val) { setPreview(null); return; }
    try {
      const mat = await API.materiales.obtener(val);
      const fisico = parseFloat(mat.stock_por_bodega?.reduce((s, b) => s + parseFloat(b.cantidad_fisica || 0), 0) || 0);
      const reservado = parseFloat(mat.stock_por_bodega?.reduce((s, b) => s + parseFloat(b.cantidad_reservada || 0), 0) || 0);
      const disponible = fisico - reservado;
      setPreview({
        disponible, fisico, reservado,
        min: parseFloat(mat.stock_minimo || 0),
        critico: parseFloat(mat.stock_critico || 0),
        unidad: mat.unidad_medida || 'unidades',
      });
      setStockDisponible(disponible);
    } catch {
      setPreview('error');
    }
  };

  // CU-30: producto leído por escáner → autocompleta producto y bodega, cursor en cantidad.
  // Con stock en una sola bodega queda preseleccionada; con varias se listan para elegir.
  const onProductoEscaneado = (p) => {
    onSkuChange(p.sku);
    const conStock = (p.bodegas || []).filter(b => (bodegas || []).some(x => String(x.id) === String(b.bodega_id)));
    if (conStock.length === 1) {
      setBodega(String(conStock[0].bodega_id));
      setBodegasEscaneo([]);
    } else {
      setBodega('');
      setBodegasEscaneo(conStock);
    }
    requestAnimationFrame(() => cantidadRef.current?.focus());
  };

  // Motivos según clasificación + bodega destino para traslados (CU-19)
  const nombreClasif = (catalogos.clasificaciones || []).find(c => String(c.id) === String(clasifId))?.nombre?.toLowerCase() || '';
  const esTraslado = nombreClasif.includes('traslado');
  // SONNET-8 (Req #2): merma/pérdida requiere enlace a evidencia fotográfica
  const esMerma = nombreClasif.includes('pérdida') || nombreClasif.includes('perdida') || nombreClasif.includes('merma');
  const motivos = clasifId
    ? catalogos.motivos.filter(m => String(m.clasificacion_id) === String(clasifId) && !MOTIVOS_DE_OTRO_FLUJO.includes(m.nombre))
    : [];

  const onClasifChange = (val) => {
    setClasifId(val);
    setMotivoId('');
    const nombre = (catalogos.clasificaciones || []).find(c => String(c.id) === String(val))?.nombre?.toLowerCase() || '';
    if (nombre.includes('traslado') && bodegasDestino === null) {
      // Poblar bodegas destino si aún no están cargadas
      API.bodegas.listar().then(bs => setBodegasDestino((bs || []).filter(esActiva))).catch(() => {});
    }
  };

  const onMotivoSelect = (val) => {
    setMotivoId(val);
    // Solo pre-rellenar (placeholder) si el usuario no ha escrito nada propio
    if (val && !motivo.trim()) {
      const motivoObj = motivos.find(m => String(m.id) === val);
      if (motivoObj) setMotivoPlaceholder(motivoObj.nombre);
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const cant = parseFloat(cantidad);
    const motivoTexto = motivo.trim();
    const errs = {};
    let errS = null;
    if (!sku)                          { errs.sku = ERR_BORDER; errS = 'Selecciona un producto.'; }
    else if (!bodega)                  { errs.bodega = ERR_BORDER; errS = 'Selecciona la bodega de origen.'; }
    else if (isNaN(cant) || cant <= 0) { errs.cantidad = ERR_FULL; errS = 'La cantidad debe ser mayor que 0.'; }
    else if (!clasifId)                { errs.clasificacion = ERR_BORDER; errS = 'Selecciona la clasificación de la salida.'; }
    // D61: el motivo decide si es merma (evidencia y aprobación) y si cuenta como consumo
    else if (!esTraslado && !motivoId) { errs.motivoId = ERR_BORDER; errS = motivos.length ? 'Selecciona el motivo de la salida.' : 'Esta categoría no tiene motivos configurados: elige otra o pide a gerencia que agregue uno.'; }
    else if (!motivoTexto)             { errs.motivo = ERR_FULL; errS = 'El motivo de la salida es obligatorio.'; }
    setErrStyles(errs);
    if (errS) { showAlert('danger', errS); return; }
    if (esTraslado && !bodegaDest)           { showAlert('danger', 'Debes seleccionar la bodega destino para un traslado.'); return; }
    if (esTraslado && bodegaDest === bodega) { showAlert('danger', 'La bodega destino debe ser distinta a la bodega origen.'); return; }
    if (!tipoSalidaId)                       { showAlert('danger', 'No se encontró tipo de movimiento "salida" en el sistema.'); return; }
    if (esMerma && !evidenciaUrl.trim())     { showAlert('danger', 'Debes adjuntar un enlace a evidencia fotográfica para registrar una merma o pérdida.'); return; }
    if (esMerma && !/^https?:\/\//i.test(evidenciaUrl.trim())) { showAlert('danger', 'El enlace de evidencia debe ser una URL válida (debe comenzar con http:// o https://).'); return; }
    if (stockDisponible != null && cant > stockDisponible) {
      showAlert('danger', <>Stock insuficiente. Disponible: <strong>{stockDisponible}</strong> unidades.</>);
      return;
    }

    setSaving(true);
    try {
      // D60: el traslado es UNA operación en el backend (salida + entrada del mismo lote,
      // en una transacción, sin contar como consumo). Antes eran dos llamadas sueltas.
      if (esTraslado) {
        const r = await API.movimientos.traslado({
          sku,
          bodega_origen_id:   parseInt(bodega),
          bodega_destino_id:  parseInt(bodegaDest),
          cantidad:           cant,
          descripcion_motivo: motivoTexto,
        });
        if (r?.error) { showAlert('danger', r.error); setSaving(false); return; }
        showAlert('success', r?.message || 'Traslado registrado.');
      } else {
        await API.movimientos.salida({
          sku,
          bodega_id:          parseInt(bodega),
          cantidad:           cant,
          tipo_movimiento_id: tipoSalidaId,
          motivo_id:          motivoId ? parseInt(motivoId) : null,
          descripcion_motivo: motivoTexto,
          evidencia_url:      esMerma ? evidenciaUrl.trim() : null,
        });
        showAlert('success', 'Salida registrada correctamente. El stock ha sido descontado aplicando método FIFO.');
      }
      setTimeout(() => navigate('/movimientos/historial'), 1500);
    } catch (err) {
      showAlert('danger', err.message || 'Error al registrar la salida.');
      setSaving(false);
    }
  };

  let previewColor = 'var(--success)', previewBadge = null;
  if (preview && preview !== 'error') {
    if (preview.disponible <= preview.critico)  { previewColor = 'var(--danger)';  previewBadge = <span className="badge badge-danger" style={{ marginTop: 8 }}>Crítico</span>; }
    else if (preview.disponible <= preview.min) { previewColor = 'var(--warning)'; previewBadge = <span className="badge badge-warning" style={{ marginTop: 8 }}>Bajo mínimo</span>; }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Registrar Salida</div>
          <div className="page-subtitle">Retiro de stock del inventario (FR-19, FR-24, FR-25)</div>
        </div>
        <Link to="/movimientos/historial" className="btn btn-secondary">← Volver al historial</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>

        <form id="form-salida" noValidate onSubmit={onSubmit}>

          <EscanerCodigo onProducto={onProductoEscaneado} />

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Datos del retiro</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="sku">SKU del producto <span className="required">*</span></label>
                {/* Sesión 15 (punto 22): búsqueda por SKU o nombre */}
                <SelectorProducto id="sku" opciones={materiales || []} value={sku} onChange={s => { setBodegasEscaneo([]); onSkuChange(s); }} style={errStyles.sku}
                  disabled={materiales === null} placeholder={materiales === null ? 'Cargando productos...' : undefined} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="bodega">Bodega origen <span className="required">*</span></label>
                <select className="form-control" id="bodega" required value={bodega} onChange={e => setBodega(e.target.value)} style={errStyles.bodega}>
                  {bodegas === null
                    ? <option value="">Cargando bodegas...</option>
                    : <><option value="">Seleccionar bodega...</option>{bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}</>}
                </select>
                {/* CU-30: el producto escaneado tiene stock en varias bodegas */}
                {bodegasEscaneo.length > 1 && (
                  <div className="form-hint" id="bodegas-con-stock">
                    Con stock en:{' '}
                    {bodegasEscaneo.map((b, i) => (
                      <span key={b.bodega_id}>
                        {i > 0 && ' · '}
                        <a href="#" style={{ color: 'var(--orange)', fontWeight: String(b.bodega_id) === bodega ? 700 : 400 }}
                          onClick={e => { e.preventDefault(); setBodega(String(b.bodega_id)); cantidadRef.current?.focus(); }}>
                          {b.bodega_nombre} ({parseFloat(b.disponible)} disp.)
                        </a>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="cantidad">Cantidad a retirar <span className="required">*</span></label>
                <input ref={cantidadRef} className="form-control" id="cantidad" type="number" min={1} placeholder="0" required value={cantidad} onChange={e => setCantidad(e.target.value)} style={errStyles.cantidad} onKeyDown={volverAlEscaner} />
                <div className="form-hint">Enter vuelve al escáner. Para registrar, use el botón.</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="fecha">Fecha del movimiento</label>
                {/* Punto 3b: se mostraba editable pero nunca se enviaba; la salida se registra con la fecha y hora actuales */}
                <input className="form-control" id="fecha" type="date" value={hoy()} readOnly disabled />
                <div className="form-hint">Se registra con la fecha y hora actuales</div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Clasificación de la salida (FR-25)</div>
            <div className="form-group">
              <label className="form-label" htmlFor="clasificacion">Categoría <span className="required">*</span></label>
              <select className="form-control" id="clasificacion" required value={clasifId} onChange={e => onClasifChange(e.target.value)} style={errStyles.clasificacion}>
                {catalogos.clasificaciones === null
                  ? <option value="">Cargando clasificaciones...</option>
                  : <><option value="">Seleccionar categoría...</option>{catalogos.clasificaciones.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</>}
              </select>
            </div>
            {/* CU-19: Bodega destino solo visible para traslados */}
            {esTraslado && (
              <div className="form-group" id="grupo-bodega-destino">
                <label className="form-label" htmlFor="bodega-destino">Bodega destino <span className="required">*</span></label>
                <select className="form-control" id="bodega-destino" value={bodegaDest} onChange={e => setBodegaDest(e.target.value)}>
                  <option value="">Seleccionar bodega destino...</option>
                  {(bodegasDestino || []).map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
                </select>
                <div className="form-hint">El stock se descontará de la bodega origen y se sumará en la bodega destino</div>
              </div>
            )}
            {/* D61: obligatorio (salvo en traslados, que usan su propio motivo en el backend) */}
            {clasifId && !esTraslado && (
              <div className="form-group" id="grupo-motivo-select">
                <label className="form-label" htmlFor="motivo-select">Motivo <span className="required">*</span></label>
                <select className="form-control" id="motivo-select" value={motivoId} onChange={e => onMotivoSelect(e.target.value)}
                  style={errStyles.motivoId} disabled={motivos.length === 0}>
                  <option value="">{motivos.length ? 'Seleccionar motivo...' : 'Esta categoría no tiene motivos configurados'}</option>
                  {motivos.map(m => <option key={m.id} value={m.id}>{m.nombre}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="card">
            <div className="section-label">Motivo de salida (FR-24)</div>
            <div className="form-group">
              <label className="form-label" htmlFor="motivo">
                Descripción del motivo <span className="required">*</span>
                <span className="hint">(máx. 255 caracteres)</span>
              </label>
              <textarea className="form-control" id="motivo" rows={3} maxLength={255} placeholder={motivoPlaceholder} required
                value={motivo} onChange={e => setMotivo(e.target.value)} style={errStyles.motivo} />
              <div className="form-counter"><span id="motivo-count">{motivo.length}</span>/255</div>
            </div>
            {/* SONNET-8 (Req #2): evidencia fotográfica obligatoria para mermas/pérdidas */}
            {esMerma && (
              <div className="form-group" id="grupo-evidencia">
                <label className="form-label" htmlFor="evidencia-url">
                  Enlace a evidencia fotográfica <span className="required">*</span>
                </label>
                <input className="form-control" id="evidencia-url" type="url" placeholder="https://drive.google.com/..."
                  required value={evidenciaUrl} onChange={e => setEvidenciaUrl(e.target.value)} />
                <div className="form-hint">Adjunta un enlace (Drive, fotos compartidas, etc.) con evidencia fotográfica de la merma o pérdida.</div>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Usuario responsable</label>
              <input className="form-control" id="usuario" disabled value={user ? (user.username || user.id) : ''} readOnly />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <Link to="/movimientos/historial" className="btn btn-secondary">Cancelar</Link>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Registrando...' : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>
                    Registrar salida
                  </>
                )}
              </button>
            </div>
          </div>

        </form>

        {/* Sidebar stock */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="section-label">Stock disponible</div>
            <div id="stock-preview" style={{ textAlign: 'center', padding: '16px 0', color: 'var(--gray)' }}>
              {preview === null && <div style={{ fontSize: 12, color: 'var(--gray)' }}>Selecciona un producto</div>}
              {preview === 'error' && <div style={{ fontSize: 12, color: 'var(--gray)' }}>Error cargando stock</div>}
              {preview && preview !== 'error' && (
                <>
                  <div style={{ fontSize: 36, fontWeight: 700, color: previewColor }}>{preview.disponible}</div>
                  <div style={{ fontSize: 12, color: 'var(--gray)' }}>{preview.unidad} disponibles para despacho</div>
                  <div style={{ fontSize: 11, color: 'var(--gray)', marginTop: 6, display: 'flex', gap: 12 }}>
                    <span>Stock físico: <b>{preview.fisico}</b></span>
                    <span>Reservado OT: <b>{preview.reservado}</b></span>
                  </div>
                  {previewBadge}
                </>
              )}
            </div>
          </div>
          <div className="card">
            <div className="section-label">Método FIFO</div>
            <p style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.7 }}>El sistema descontará automáticamente desde el lote más antiguo con stock disponible.</p>
          </div>
        </div>

      </div>
    </>
  );
}
