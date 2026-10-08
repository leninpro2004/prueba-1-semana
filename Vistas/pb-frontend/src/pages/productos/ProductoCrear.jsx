import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { CLAS_VACIA, subcategoriasDe, nivelesDe, ERR_BORDER, ERR_FULL } from './clasificacion';

/** CU-123 Exc 2: el SKU ya existe → se muestra el producto y se sugiere reclasificarlo. */
function mensajeExistente(e) {
  const tipo = e.es_rotativo === false ? 'insumo especial' : 'producto estándar';
  return (
    <>
      El SKU <strong>{e.sku}</strong> ya existe en el catálogo como {tipo}: <strong>{e.nombre}</strong>
      {e.estado && e.estado !== 'activo' ? ` (${e.estado})` : ''}. Si corresponde, cambie su clasificación en lugar
      de crear uno nuevo.{' '}
      <Link to={`/productos/${e.sku}/editar`} style={{ fontWeight: 600, textDecoration: 'underline' }}>Editar ese producto</Link>
    </>
  );
}

/** Nuevo Producto — conversión 1:1 de productos/crear.html */
export default function ProductoCrear() {
  usePageTitle('Nuevo Producto');
  const navigate = useNavigate();
  const { alert, showAlert } = useAlert();

  // Catálogos
  const [unidades, setUnidades] = useState(null);      // null = "Cargando..."
  const [generales, setGenerales] = useState(null);
  const [funcionales, setFuncionales] = useState(null);
  const [clas, setClas] = useState(CLAS_VACIA);

  // Campos
  const [sku, setSku] = useState('');
  const [unidad, setUnidad] = useState('');
  const [nombre, setNombre] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [presentacion, setPresentacion] = useState('');   // CU-19: opcional al crear
  const [categoria, setCategoria] = useState('');
  const [funcional, setFuncional] = useState('');
  const [critico, setCritico] = useState(false);
  // CU-123: insumo especial / no rotativo: sin umbrales y con descripción obligatoria
  const [especial, setEspecial] = useState(false);
  const [clasCat, setClasCat] = useState('');
  const [clasSub, setClasSub] = useState('');
  const [clasNivel, setClasNivel] = useState('');
  const [stockMin, setStockMin] = useState('');
  const [stockMax, setStockMax] = useState('');
  const [stockCritico, setStockCritico] = useState('');

  // Estilos de error por campo (equivale a el.style.borderColor / boxShadow)
  const [errStyles, setErrStyles] = useState({});
  const setErr = (campo, style) => setErrStyles(s => ({ ...s, [campo]: style }));
  const clearErr = (campo) => setErrStyles(s => { const n = { ...s }; delete n[campo]; return n; });

  // CU-01: verificación de SKU en tiempo real
  const [skuHint, setSkuHint] = useState({ text: '', color: '' });
  // CU-123 Exc 2: producto que ya tiene el SKU (para mostrarlo y sugerir reclasificarlo)
  const [existente, setExistente] = useState(null);
  const skuTimer = useRef(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const [u, c] = await Promise.all([API.materiales.unidades(), API.materiales.categorias()]);
        if (cancelado) return;
        setUnidades(u || []);
        setGenerales(c?.generales || []);
        setFuncionales(c?.funcionales || []);
        setClas(c?.clasificacion || CLAS_VACIA);
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error cargando catálogos: ' + err.message);
      }
    })();
    return () => { cancelado = true; clearTimeout(skuTimer.current); };
  }, [showAlert]);

  const onSkuInput = (raw) => {
    const val = raw.trim().toUpperCase(); // forzar mayúsculas
    setSku(val);
    setSkuHint({ text: '', color: '' });
    setExistente(null);
    clearErr('sku');
    clearTimeout(skuTimer.current);
    if (!val || val.length < 4) return;
    if (!/^[A-Z0-9_-]+$/.test(val)) {
      setSkuHint({ text: 'Solo letras, números, guión y guión bajo', color: 'var(--danger)' });
      setErr('sku', ERR_BORDER);
      return;
    }
    setSkuHint({ text: 'Verificando...', color: 'var(--gray)' });
    skuTimer.current = setTimeout(async () => {
      try {
        const p = await API.materiales.obtener(val);
        // Si llega aquí, el SKU ya existe
        setSkuHint({ text: '✗ Este SKU ya está en uso', color: 'var(--danger)' });
        setErr('sku', ERR_FULL);
        setExistente({ sku: p.sku, nombre: p.nombre, estado: p.estado, es_rotativo: p.es_rotativo });
      } catch {
        // 404 o error = disponible
        setSkuHint({ text: '✓ SKU disponible', color: 'var(--success)' });
        setErr('sku', { borderColor: 'var(--success)', boxShadow: '0 0 0 3px rgba(25,135,84,.12)' });
      }
    }, 500);
  };

  // Cascada
  const onClasCat = (v) => { setClasCat(v); setClasSub(''); setClasNivel(''); };
  const onClasSub = (v) => { setClasSub(v); setClasNivel(''); };
  const subs = subcategoriasDe(clas, clasCat);
  const niveles = nivelesDe(clas, clasSub);
  const esColor = subs.find(s => String(s.id) === String(clasSub))?.es_color_custom === true;

  const onSubmit = async (e) => {
    e.preventDefault();
    const skuVal = sku.trim().toUpperCase();
    setSku(skuVal);
    const nombreVal = nombre.trim();
    const stockMinV  = stockMin  !== '' ? parseInt(stockMin)  : null;
    const stockMaxV  = stockMax  !== '' ? parseInt(stockMax)  : null;
    const stockCritV = stockCritico !== '' ? parseInt(stockCritico) : null;
    const descripcionVal = descripcion.trim();
    const presentacionVal = presentacion.trim();

    /* Validaciones */
    // CU-123 Exc 1: se marcan TODOS los obligatorios que faltan, no solo el primero
    const faltan = [
      !skuVal && ['sku', 'SKU'],
      !nombreVal && ['nombre', 'nombre'],
      !unidad && ['unidad', 'unidad de medida'],
      especial && !descripcionVal && ['descripcion', 'descripción'],
    ].filter(Boolean);
    if (faltan.length > 0) {
      faltan.forEach(([campo]) => setErr(campo, ERR_FULL));
      showAlert('danger', `Complete los campos obligatorios: ${faltan.map(f => f[1]).join(', ')}.` +
        (especial && !descripcionVal ? ' En un insumo especial la descripción es obligatoria.' : ''));
      return;
    }
    if (existente) {
      setErr('sku', ERR_FULL);
      showAlert('danger', mensajeExistente(existente));
      return;
    }
    if (skuVal.length < 4 || skuVal.length > 16) { setErr('sku', ERR_BORDER); showAlert('danger', 'El SKU debe tener entre 4 y 16 caracteres alfanuméricos.'); return; }
    if (!nombreVal) { setErr('nombre', ERR_BORDER); showAlert('danger', 'El nombre del producto es obligatorio.'); return; }
    if (nombreVal.length < 3) { setErr('nombre', ERR_BORDER); showAlert('danger', 'El nombre debe tener al menos 3 caracteres.'); return; }
    if (nombreVal.length > 100) { setErr('nombre', ERR_BORDER); showAlert('danger', 'El nombre no puede superar los 100 caracteres.'); return; }
    if (presentacionVal.length > 150) { setErr('presentacion', ERR_FULL); showAlert('danger', 'La presentación no puede superar los 150 caracteres. Acorte la descripción.'); return; }
    if (!categoria || !funcional) { showAlert('danger', 'Debes seleccionar una categoría general y una categoría funcional.'); return; }
    if (!clasNivel) { showAlert('danger', 'Debes seleccionar la clasificación específica (categoría → subcategoría → nivel).'); return; }
    if (!unidad) { showAlert('danger', 'Debes seleccionar la unidad de medida.'); return; }
    // Validar stocks solo si tienen valor (son opcionales)
    if (stockMinV !== null && (isNaN(stockMinV) || stockMinV < 0)) { setErr('stockMin', ERR_FULL); showAlert('danger', 'El stock mínimo no puede ser negativo.'); return; }
    if (stockMaxV !== null && (isNaN(stockMaxV) || stockMaxV < 0)) { setErr('stockMax', ERR_FULL); showAlert('danger', 'El stock máximo no puede ser negativo.'); return; }
    if (stockMaxV !== null && stockMinV !== null && stockMaxV <= stockMinV) { setErr('stockMax', ERR_FULL); showAlert('danger', 'El stock máximo debe ser mayor que el stock mínimo.'); return; }
    if (stockCritV !== null && (isNaN(stockCritV) || stockCritV < 0)) { setErr('stockCritico', ERR_FULL); showAlert('danger', 'El stock crítico no puede ser negativo.'); return; }
    if (stockCritV !== null && stockMinV !== null && stockCritV > stockMinV) { setErr('stockCritico', ERR_FULL); showAlert('danger', 'El stock crítico debe estar entre 0 y el stock mínimo.'); return; }

    setSaving(true);
    try {
      const r = await API.materiales.crear({
        sku: skuVal,
        nombre: nombreVal,
        descripcion:                       descripcionVal || null,
        presentacion:                      presentacionVal || null,
        // CU-123: un insumo especial no tiene umbrales (el backend también los anula)
        stock_minimo:                      especial ? null : stockMinV,
        stock_maximo:                      especial ? null : stockMaxV,
        stock_critico:                     especial ? null : stockCritV,
        es_critico:                        critico,
        es_rotativo:                       !especial,
        estado:                            'activo',
        unidad_medida_id:                  parseInt(unidad),
        categoria_general_id:              parseInt(categoria),
        categoria_funcional_id:            parseInt(funcional),
        clasificacion_nivel_especifico_id: parseInt(clasNivel),
      });
      // apiFetch devuelve el cuerpo de un 409 en vez de lanzar: Exc 2 (SKU repetido)
      if (r?.existente) {
        setExistente(r.existente);
        setErr('sku', ERR_FULL);
        showAlert('danger', mensajeExistente(r.existente));
        setSaving(false);
        return;
      }
      showAlert('success', <>{especial ? 'Insumo especial' : 'Producto'} <strong>{nombreVal}</strong> creado correctamente{especial ? ', con stock 0 y sin umbrales de reposición' : ''}.</>);
      setTimeout(() => navigate('/productos'), 1200);
    } catch (err) {
      showAlert('danger', err.message || 'Error al crear el producto.');
      setSaving(false);
    }
  };

  const opts = (lista, label = 'Seleccionar...') => lista === null
    ? <option value="">Cargando...</option>
    : <><option value="">{label}</option>{lista.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}</>;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Nuevo Producto</div>
          <div className="page-subtitle">Completa todos los campos obligatorios</div>
        </div>
        <Link to="/productos" className="btn btn-secondary">← Volver al catálogo</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <form id="form-producto" noValidate onSubmit={onSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>

          {/* Columna principal */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Identificación */}
            <div className="card">
              <div className="section-label">Identificación</div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="sku">
                    SKU <span className="required">*</span>
                    <span className="hint">(4–16 caracteres alfanuméricos)</span>
                  </label>
                  <input className="form-control" id="sku" name="sku" placeholder="MAT-CEM-001" maxLength={16} required
                    value={sku} onChange={e => onSkuInput(e.target.value)} style={errStyles.sku} />
                  <div className="form-hint" id="hint-sku" style={{ marginTop: 4, color: skuHint.color }}>{skuHint.text}</div>
                  {existente && (
                    <div className="form-hint" style={{ color: 'var(--danger)' }}>{mensajeExistente(existente)}</div>
                  )}
                  <div className="form-hint">Formato sugerido: CATEGORÍA-TIPO-CORRELATIVO</div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="unidad">Unidad de medida <span className="required">*</span></label>
                  <select className="form-control" id="unidad" name="unidad" required value={unidad}
                    onChange={e => { setUnidad(e.target.value); clearErr('unidad'); }} style={errStyles.unidad}>
                    {opts(unidades)}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="nombre">
                  Nombre del producto <span className="required">*</span>
                  <span className="hint">(Tipo · Material · Medida — 3 a 100 caracteres)</span>
                </label>
                <input className="form-control" id="nombre" name="nombre" placeholder="Ej: Tornillo acero inoxidable 5cm" maxLength={100} required
                  value={nombre} onChange={e => { setNombre(e.target.value); clearErr('nombre'); }} style={errStyles.nombre} />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="descripcion">
                  Descripción {especial && <span className="required">*</span>}
                  <span className="hint">{especial ? '(obligatoria en insumos especiales, máx. 500)' : '(máx. 500 caracteres)'}</span>
                </label>
                <textarea className="form-control" id="descripcion" name="descripcion" rows={3} maxLength={500}
                  placeholder="Material, uso específico, condición de uso..." value={descripcion}
                  onChange={e => { setDescripcion(e.target.value); clearErr('descripcion'); }} style={errStyles.descripcion} />
                <div className="form-counter"><span id="desc-count">{descripcion.length}</span>/500</div>
              </div>
              {/* CU-19: presentacion comercial, opcional al crear */}
              <div className="form-group">
                <label className="form-label" htmlFor="presentacion">Presentación <span className="hint">(opcional, formato de empaque, máx. 150)</span></label>
                <input className="form-control" id="presentacion" name="presentacion" placeholder="Ej: Caja x 50 unidades"
                  value={presentacion} onChange={e => { setPresentacion(e.target.value); clearErr('presentacion'); }} style={errStyles.presentacion} />
                <div className="form-counter" style={presentacion.length > 150 ? { color: 'var(--danger)' } : undefined}>
                  <span id="pres-count">{presentacion.length}</span>/150
                </div>
              </div>
            </div>

            {/* Clasificación */}
            <div className="card">
              <div className="section-label">Clasificación</div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="categoria">Categoría general <span className="required">*</span></label>
                  <select className="form-control" id="categoria" name="categoria" required value={categoria} onChange={e => setCategoria(e.target.value)}>
                    {opts(generales)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="funcional">Categoría funcional <span className="required">*</span></label>
                  <select className="form-control" id="funcional" name="funcional" required value={funcional} onChange={e => setFuncional(e.target.value)}>
                    {opts(funcionales)}
                  </select>
                </div>
              </div>
              <label className="form-check">
                <input type="checkbox" id="critico" name="critico" checked={critico} onChange={e => setCritico(e.target.checked)} />
                Marcar como <strong>producto crítico</strong> — genera alertas de prioridad alta
              </label>
              {/* CU-123 */}
              <label className="form-check" style={{ marginTop: 8 }}>
                <input type="checkbox" id="especial" name="especial" checked={especial}
                  onChange={e => {
                    setEspecial(e.target.checked);
                    if (e.target.checked) { setStockMin(''); setStockMax(''); setStockCritico(''); }
                    else clearErr('descripcion');
                  }} />
                <strong>Insumo especial / No rotativo</strong> — se compra a pedido, sin stock habitual
              </label>
            </div>

            {/* Clasificación en cascada */}
            <div className="card">
              <div className="section-label">Clasificación específica</div>
              <div className="form-hint" style={{ marginBottom: 12, fontSize: 12, color: 'var(--gray)' }}>
                Selecciona en orden: categoría → subcategoría → nivel específico
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="clas-categoria">Categoría de clasificación <span className="required">*</span></label>
                <select className="form-control" id="clas-categoria" required value={clasCat} onChange={e => onClasCat(e.target.value)}>
                  {unidades === null
                    ? <option value="">Cargando...</option>
                    : <><option value="">Seleccionar categoría...</option>{clas.categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</>}
                </select>
              </div>
              {clasCat && (
                <div className="form-group" id="grupo-subcategoria">
                  <label className="form-label" htmlFor="clas-subcategoria">Subcategoría <span className="required">*</span></label>
                  <select className="form-control" id="clas-subcategoria" required value={clasSub} onChange={e => onClasSub(e.target.value)}>
                    <option value="">Seleccionar subcategoría...</option>
                    {subs.map(s => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                  </select>
                  {esColor && (
                    <div className="form-hint" id="hint-color-custom" style={{ color: 'var(--orange)' }}>
                      Esta subcategoría admite colores personalizados (ej. pinturas custom)
                    </div>
                  )}
                </div>
              )}
              {clasCat && clasSub && (
                <div className="form-group" id="grupo-nivel">
                  <label className="form-label" htmlFor="clas-nivel">Nivel específico <span className="required">*</span></label>
                  <select className="form-control" id="clas-nivel" required value={clasNivel} onChange={e => setClasNivel(e.target.value)}>
                    <option value="">Seleccionar nivel...</option>
                    {niveles.map(n => <option key={n.id} value={n.id}>{n.nombre}</option>)}
                  </select>
                </div>
              )}
            </div>

          </div>

          {/* Columna lateral: stock */}
          <div>
            <div className="card">
              <div className="section-label">Parámetros de stock</div>

              {especial && (
                <div className="form-hint" style={{ marginBottom: 12, padding: '8px 10px', background: '#FFF3CD', borderRadius: 6, color: '#856404' }}>
                  <strong>Insumo especial:</strong> sin umbrales. No genera alertas de stock mínimo ni de reposición.
                  Stock inicial 0: entra cuando se recibe la compra.
                </div>
              )}

              <div className="form-group">
                <label className="form-label" htmlFor="stockMin">Stock mínimo</label>
                <input className="form-control" id="stockMin" name="stockMin" type="number" min={0} placeholder={especial ? 'No aplica' : 'Opcional'}
                  disabled={especial}
                  value={stockMin} onChange={e => { setStockMin(e.target.value); clearErr('stockMin'); }} style={errStyles.stockMin} />
                <div className="form-hint">Dispara alerta de reposición</div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="stockMax">Stock máximo</label>
                <input className="form-control" id="stockMax" name="stockMax" type="number" min={0} placeholder={especial ? 'No aplica' : 'Opcional'}
                  disabled={especial}
                  value={stockMax} onChange={e => { setStockMax(e.target.value); clearErr('stockMax'); }} style={errStyles.stockMax} />
                <div className="form-hint">Alerta de sobrestock</div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="stockCritico">Stock crítico</label>
                <input className="form-control" id="stockCritico" name="stockCritico" type="number" min={0} placeholder={especial ? 'No aplica' : 'Opcional'}
                  disabled={especial}
                  value={stockCritico} onChange={e => { setStockCritico(e.target.value); clearErr('stockCritico'); }} style={errStyles.stockCritico} />
                <div className="form-hint">Debe ser ≤ stock mínimo</div>
              </div>

              <div className="divider"></div>

              <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={saving}>
                {saving ? 'Guardando...' : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>
                    Guardar producto
                  </>
                )}
              </button>
              <Link to="/productos" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}>Cancelar</Link>
            </div>
          </div>

        </div>
      </form>
    </>
  );
}
