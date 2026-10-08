import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import JsBarcode from 'jsbarcode';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';

/**
 * CU-30: etiquetas de código de barras para imprimir (decisión D5).
 * Página HTML imprimible + JsBarcode (Code128). Sin ZPL: el navegador no puede
 * mandar comandos directos a la impresora.
 *
 * La etiqueta va en el producto, su caja o su bandeja (D4), no en el anaquel.
 *
 * /productos/etiquetas?sku=A,B  → esos productos marcados
 * /productos/etiquetas          → todo el catálogo, sin marcar
 */

// Tamaños de etiqueta. Las de impresora de etiquetas van una por página (@page = etiqueta);
// la hoja A4 las ordena en grilla (formato de 3 x 7 etiquetas adhesivas).
const TAMANOS = {
  '50x25':  { nombre: '50 × 25 mm (impresora de etiquetas)',  ancho: 50,   alto: 25,   hoja: false },
  '60x40':  { nombre: '60 × 40 mm (impresora de etiquetas)',  ancho: 60,   alto: 40,   hoja: false },
  '100x50': { nombre: '100 × 50 mm (impresora de etiquetas)', ancho: 100,  alto: 50,   hoja: false },
  'A4':     { nombre: 'Hoja A4 — 3 × 7 etiquetas adhesivas',  ancho: 63.5, alto: 38.1, hoja: true  },
};

function CodigoBarras({ codigo }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, codigo, { format: 'CODE128', displayValue: true, fontSize: 14, margin: 0, height: 50, width: 2 });
    } catch {
      /* un código con caracteres fuera de Code128 no se dibuja; el texto legible queda abajo */
    }
  }, [codigo]);
  return <svg ref={ref} style={{ width: '100%', height: '100%' }} preserveAspectRatio="xMidYMid meet" />;
}

export default function ProductoEtiquetas() {
  usePageTitle('Etiquetas de código de barras');
  const [searchParams] = useSearchParams();
  const { alert, showAlert } = useAlert();

  const skusParam = useMemo(
    () => (searchParams.get('sku') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    [searchParams]
  );

  const [productos, setProductos] = useState(null);
  const [marcados, setMarcados] = useState(new Set());
  const [copias, setCopias] = useState(1);
  const [tamano, setTamano] = useState('50x25');

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const todos = await API.materiales.listar();
        if (cancelado) return;
        const lista = skusParam.length
          ? (todos || []).filter(m => skusParam.includes(String(m.sku).toUpperCase()))
          : (todos || []);
        setProductos(lista);
        setMarcados(new Set(skusParam.length ? lista.filter(m => m.codigo_barras).map(m => m.sku) : []));
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error cargando productos: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [skusParam, showAlert]);

  const conCodigo = (productos || []).filter(m => m.codigo_barras);
  const sinCodigo = (productos || []).length - conCodigo.length;
  const todosMarcados = conCodigo.length > 0 && conCodigo.every(m => marcados.has(m.sku));

  const alternar = (sku) => setMarcados(prev => {
    const s = new Set(prev);
    if (s.has(sku)) s.delete(sku); else s.add(sku);
    return s;
  });
  const alternarTodos = () => setMarcados(todosMarcados ? new Set() : new Set(conCodigo.map(m => m.sku)));

  const n = Math.min(Math.max(parseInt(copias) || 1, 1), 100);
  const etiquetas = conCodigo
    .filter(m => marcados.has(m.sku))
    .flatMap(m => Array.from({ length: n }, (_, i) => ({ ...m, clave: m.sku + '-' + i })));

  const t = TAMANOS[tamano];

  const imprimir = () => {
    if (etiquetas.length === 0) { showAlert('danger', 'Marque al menos un producto con código para imprimir.'); return; }
    window.print();
  };

  return (
    <>
      {/* Estilos de impresión: solo se imprime la zona de etiquetas, sin menú ni barra superior */}
      <style>{`
        .etiqueta {
          width: ${t.ancho}mm; height: ${t.alto}mm; box-sizing: border-box;
          padding: 2mm 3mm; display: flex; flex-direction: column; align-items: center;
          justify-content: space-between; overflow: hidden; background: #fff; color: #000;
          font-family: Arial, Helvetica, sans-serif;
        }
        .etiqueta-barras { flex: 1; width: 100%; min-height: 0; }
        .etiqueta-sku    { font-size: 9pt; font-weight: 700; line-height: 1.1; }
        .etiqueta-nombre { font-size: 7pt; line-height: 1.1; width: 100%; text-align: center;
                           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .zona-etiquetas  { display: flex; flex-wrap: wrap; gap: 8px; }
        .zona-etiquetas .etiqueta { border: 1px dashed var(--gray, #999); }
        @media print {
          @page { size: ${t.hoja ? 'A4' : `${t.ancho}mm ${t.alto}mm`}; margin: ${t.hoja ? '10mm 7mm' : '0'}; }
          .sidebar, .topbar, .sidebar-overlay, #inactivity-warning, .no-print { display: none !important; }
          .main-content { margin: 0 !important; }
          .page-body { padding: 0 !important; }
          body { background: #fff !important; }
          .zona-etiquetas { gap: 0; }
          .zona-etiquetas .etiqueta { border: none; }
          ${t.hoja ? '' : '.zona-etiquetas .etiqueta { break-after: page; page-break-after: always; }'}
        }
      `}</style>

      <div className="no-print">
        <div className="page-header">
          <div>
            <div className="page-title">Etiquetas de código de barras</div>
            <div className="page-subtitle">Code128 para el producto, su caja o su bandeja (CU-30)</div>
          </div>
          <Link to="/productos" className="btn btn-secondary">← Volver a productos</Link>
        </div>

        <Alert {...alert} />

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start', marginBottom: 20 }}>
          <div className="card">
            <div className="section-label">Productos</div>
            {productos === null ? (
              <div style={{ color: 'var(--gray)', fontSize: 13 }}>Cargando productos...</div>
            ) : productos.length === 0 ? (
              <div style={{ color: 'var(--gray)', fontSize: 13 }}>No hay productos para mostrar.</div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input type="checkbox" checked={todosMarcados} onChange={alternarTodos} disabled={conCodigo.length === 0} aria-label="Marcar todos" />
                      </th>
                      <th>SKU</th><th>Nombre</th><th>Código</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productos.map(m => (
                      <tr key={m.sku}>
                        <td>
                          <input type="checkbox" checked={marcados.has(m.sku)} onChange={() => alternar(m.sku)}
                            disabled={!m.codigo_barras} aria-label={'Marcar ' + m.sku} />
                        </td>
                        <td><Link to={`/productos/${m.sku}`}>{m.sku}</Link></td>
                        <td>{m.nombre}{m.estado !== 'activo' && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Inactivo</span>}</td>
                        <td style={{ fontFamily: 'monospace' }}>
                          {m.codigo_barras || <span style={{ color: 'var(--gray)', fontFamily: 'inherit' }}>Sin código</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sinCodigo > 0 && (
              <div className="form-hint" style={{ marginTop: 8 }}>
                {sinCodigo} producto(s) sin código. Gerencia puede generarlo desde la ficha del producto.
              </div>
            )}
          </div>

          <div className="card">
            <div className="section-label">Impresión</div>
            <div className="form-group">
              <label className="form-label" htmlFor="tamano">Tamaño de etiqueta</label>
              <select className="form-control" id="tamano" value={tamano} onChange={e => setTamano(e.target.value)}>
                {Object.entries(TAMANOS).map(([k, v]) => <option key={k} value={k}>{v.nombre}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="copias">Copias por producto</label>
              <input className="form-control" id="copias" type="number" min={1} max={100} value={copias} onChange={e => setCopias(e.target.value)} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 12 }}>
              {etiquetas.length} etiqueta(s) a imprimir.
            </div>
            <button type="button" className="btn btn-primary" onClick={imprimir} disabled={etiquetas.length === 0}>
              Imprimir
            </button>
            <div className="form-hint" style={{ marginTop: 8 }}>
              En el diálogo de impresión, elija la impresora de etiquetas y deje la escala en 100 %.
            </div>
          </div>
        </div>

        {etiquetas.length > 0 && <div className="section-label">Vista previa</div>}
      </div>

      <div className="zona-etiquetas">
        {etiquetas.map(m => (
          <div className="etiqueta" key={m.clave}>
            <div className="etiqueta-barras"><CodigoBarras codigo={m.codigo_barras} /></div>
            <div className="etiqueta-sku">{m.sku}</div>
            <div className="etiqueta-nombre">{m.nombre}</div>
          </div>
        ))}
      </div>
    </>
  );
}
