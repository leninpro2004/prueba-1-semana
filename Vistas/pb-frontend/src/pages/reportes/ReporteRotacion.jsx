import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { usePagination } from '../../hooks/usePagination';

/**
 * CU-71 — Índice de rotación por producto (gerencia y jop).
 * Índice = consumo del período ÷ stock promedio ((inicio + fin) ÷ 2). El nivel se
 * decide con el índice mensualizado, así no depende del largo del período.
 * Los productos con stock promedio cero van aparte como "N/A" (Exc 2).
 */

/** 'YYYY-MM-DD' local de hoy + n días (nunca toISOString, que es UTC). */
function fechaLocal(n = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** dd/mm/aaaa a partir de 'YYYY-MM-DD'. */
const ddmmaaaa = (iso) => iso ? iso.split('-').reverse().join('/') : '';

const NIVELES = {
  alta:         { etiqueta: 'Alta',         badge: 'badge-success' },
  media:        { etiqueta: 'Media',        badge: 'badge-info' },
  baja:         { etiqueta: 'Baja',         badge: 'badge-warning' },
  sin_rotacion: { etiqueta: 'Sin rotación', badge: 'badge-danger' },
  na:           { etiqueta: 'N/A',          badge: 'badge-gray' },
};

const formatIndice = (v) => v == null ? 'N/A'
  : v.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function AvisoHistorial() {
  return (
    <span className="badge badge-orange" style={{ marginLeft: 6 }}
          title="El stock reconstruido para este período da negativo: hay cambios de stock antiguos sin movimiento registrado. Tome el índice con cautela.">
      ⚠ historial incompleto
    </span>
  );
}

export default function ReporteRotacion() {
  usePageTitle('Índice de rotación');
  const { alert, showAlert, clearAlert } = useAlert();

  const hoy = fechaLocal(0);
  const [desde, setDesde] = useState(fechaLocal(-89));
  const [hasta, setHasta] = useState(hoy);
  const [nivel, setNivel] = useState('');
  const [res, setRes] = useState(null);
  const [cargando, setCargando] = useState(false);

  const calcular = async () => {
    // Exc 1: se valida aquí para avisar rápido; el backend vuelve a validar
    if (!desde || !hasta) { showAlert('danger', 'Ingrese la fecha de inicio y la fecha de fin.'); return; }
    if (desde > hasta) { showAlert('danger', 'La fecha de inicio no puede ser posterior a la fecha de fin. Reingrese el período.'); return; }
    if (hasta > hoy) { showAlert('danger', 'La fecha de fin no puede ser futura. Reingrese el período.'); return; }
    setCargando(true);
    try {
      const data = await API.reportes.rotacion({ desde, hasta });
      setRes(data);
      setNivel('');
      clearAlert();
    } catch (err) {
      setRes(null);
      showAlert('danger', err.message || 'No se pudo calcular la rotación.');
    } finally {
      setCargando(false);
    }
  };

  const productos = useMemo(
    () => (res?.productos || []).filter(p => !nivel || p.nivel === nivel),
    [res, nivel]
  );
  const pag = usePagination(res ? productos : null, 20);
  const r = res?.resumen || {};
  const u = res?.umbrales;

  // CU-76: la tabla filtrada por nivel y, al final, los N/A
  const filasExportables = res && !res.mensaje ? [...productos, ...(nivel ? [] : res.no_calculables)] : [];
  // Mismas columnas para el CSV y el PDF (D35)
  const tabla = () => {
    const num = (titulo) => ({ titulo, formato: 'numero' });
    return {
      headers: ['SKU', 'Producto', 'Categoría', 'Unidad', num('Stock inicio'), num('Stock fin'), num('Stock promedio'),
                num('Consumo'), num('Índice'), num('Índice mensual'), 'Nivel', 'Historial incompleto'],
      rows: filasExportables.map(p => [
        p.sku, p.nombre, p.categoria || '', p.unidad || '', p.stock_inicio, p.stock_final, p.stock_promedio,
        p.consumo, p.indice ?? 'N/A', p.indice_mensual ?? 'N/A', NIVELES[p.nivel].etiqueta, p.historial_incompleto ? 'Sí' : 'No',
      ]),
    };
  };
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV(`rotacion-${res.periodo.desde}-a-${res.periodo.hasta}`, headers, rows); }
    catch (e) { showAlert('danger', e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    try {
      await exportarPDF({
        tipo: `rotacion-${res.periodo.desde}-a-${res.periodo.hasta}`, titulo: 'Índice de rotación',
        subtitulo: `Período ${ddmmaaaa(res.periodo.desde)} al ${ddmmaaaa(res.periodo.hasta)} (${res.periodo.dias} días)` +
                   (nivel ? ` · Solo nivel ${NIVELES[nivel].etiqueta.toLowerCase()}` : '') + ' · De menor a mayor rotación',
        resumen: [
          ['Alta', String(r.alta ?? 0)], ['Media', String(r.media ?? 0)],
          ['Baja', String(r.baja ?? 0)], ['Sin rotación', String(r.sin_rotacion ?? 0)],
          ['N/A (stock promedio cero)', String(r.na ?? 0)], ['Historial incompleto', String(r.historial_incompleto ?? 0)],
        ],
        ...tabla(),
        notas: [
          'Índice = consumo del período / stock promedio. El stock promedio es una simplificación: (stock al inicio + ' +
          'stock al fin) / 2, sin ponderar por días. El consumo es neto: salidas sin traslados ni movimientos anulados, ' +
          'menos las devoluciones de consumo.',
          `Nivel según el índice mensual (índice x ${u.base_dias} / días del período): alta >= ${formatIndice(u.alta)}, ` +
          `media >= ${formatIndice(u.media)}, baja por debajo; sin rotación si no hubo consumo.`,
          ...(r.historial_incompleto > 0 ? ['Historial incompleto: hay cambios de stock antiguos sin movimiento registrado; ' +
            'el índice de esos productos puede no ser confiable.'] : []),
        ],
      });
    } catch (e) { showAlert('danger', e.message); }
    finally { setGenerandoPdf(false); }
  };

  const kpi = (clave, color) => (
    <button type="button" className="kpi-card" onClick={() => setNivel(nivel === clave ? '' : clave)}
            style={{ textAlign: 'left', cursor: 'pointer', border: nivel === clave ? '2px solid var(--orange)' : undefined }}
            title="Filtrar la tabla por este nivel">
      <div className="kpi-label">{NIVELES[clave].etiqueta}</div>
      <div className="kpi-value" style={{ color }}>{r[clave] ?? 0}</div>
      <div className="kpi-sub">producto(s)</div>
    </button>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Índice de rotación</div>
          <div className="page-subtitle">Frecuencia de uso de cada producto en el período, para detectar stock que no se mueve</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          <Link to="/reportes/consumo-area" className="btn btn-ghost">Consumo por área</Link>
          <BotonExportar onClick={exportar} filas={res ? filasExportables.length : null} />
          <BotonExportar onClick={exportarPdf} cargando={generandoPdf} filas={res ? filasExportables.length : null}
                         etiqueta="Exportar PDF" />
        </div>
      </div>

      <Alert {...alert} />

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Período de análisis</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Fecha inicio</label>
            <input className="form-control" type="date" value={desde} max={hoy} onChange={e => setDesde(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Fecha fin</label>
            <input className="form-control" type="date" value={hasta} max={hoy} onChange={e => setHasta(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={calcular} disabled={cargando}>
            {cargando ? 'Calculando…' : 'Calcular rotación'}
          </button>
        </div>
      </div>

      {!res && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: .3 }}>🔄</div>
          <p style={{ fontSize: 14 }}>Elija el período y presione <strong>Calcular rotación</strong></p>
        </div>
      )}

      {res?.mensaje && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 36, marginBottom: 10, opacity: .4 }}>📭</div>
          <p style={{ fontSize: 14 }}>{res.mensaje}</p>
          <p style={{ fontSize: 12 }}>Período: {ddmmaaaa(res.periodo.desde)} al {ddmmaaaa(res.periodo.hasta)}. Pruebe con un período más amplio.</p>
        </div>
      )}

      {res && !res.mensaje && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 16, marginBottom: 16 }}>
            {kpi('alta', 'var(--success)')}
            {kpi('media', 'var(--info, #2d7dd2)')}
            {kpi('baja', 'var(--warning)')}
            {kpi('sin_rotacion', 'var(--danger)')}
          </div>

          {r.historial_incompleto > 0 && (
            <div style={{ padding: '12px 16px', background: '#FFF3CD', border: '1px solid #FFECB5', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#856404' }}>
              <strong>⚠ Historial incompleto en {r.historial_incompleto} producto(s):</strong> hay cambios de stock antiguos
              que no quedaron registrados como movimiento, y el stock reconstruido del período da negativo. Su índice
              puede no ser confiable.
            </div>
          )}

          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--gray)' }}>
                {productos.length} producto(s){nivel && ` de rotación ${NIVELES[nivel].etiqueta.toLowerCase()}`} · {ddmmaaaa(res.periodo.desde)} al {ddmmaaaa(res.periodo.hasta)} ({res.periodo.dias} días) · de menor a mayor rotación
              </div>
              <select className="form-control" style={{ width: 'auto' }} value={nivel} onChange={e => setNivel(e.target.value)}>
                <option value="">Todos los niveles</option>
                {['alta', 'media', 'baja', 'sin_rotacion'].map(n => <option key={n} value={n}>{NIVELES[n].etiqueta}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th><th>Producto</th><th>Categoría</th>
                    <th>Stock inicio</th><th>Stock fin</th><th>Stock promedio</th><th>Consumo</th>
                    <th>Índice</th><th>Índice mensual</th><th>Nivel</th>
                  </tr>
                </thead>
                <tbody>
                  {productos.length === 0 && <EmptyRow colSpan={10} emptyMsg="Ningún producto en este nivel." />}
                  {pag.items.map(p => (
                    <tr key={p.sku}>
                      <td><span className="td-mono">{p.sku}</span></td>
                      <td style={{ fontWeight: 500, fontSize: 13 }}>
                        {p.nombre}{p.es_critico && <span className="badge badge-danger" style={{ marginLeft: 6 }}>crítico</span>}
                        {p.historial_incompleto && <AvisoHistorial />}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{p.categoria || '—'}</td>
                      <td>{formatQty(p.stock_inicio)}</td>
                      <td>{formatQty(p.stock_final)}</td>
                      <td>{formatQty(p.stock_promedio)} <span style={{ fontSize: 11, color: 'var(--gray)' }}>{p.unidad || ''}</span></td>
                      <td>{formatQty(p.consumo)}</td>
                      <td style={{ fontWeight: 700 }}>{formatIndice(p.indice)}</td>
                      <td>{formatIndice(p.indice_mensual)}</td>
                      <td><span className={'badge ' + NIVELES[p.nivel].badge}>{NIVELES[p.nivel].etiqueta}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...pag} />
          </div>

          {res.no_calculables.length > 0 && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Sin índice (N/A): {res.no_calculables.length} producto(s)</div>
              <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 12 }}>
                Su stock promedio en el período es cero o menor, así que el índice no se puede calcular. Quedan fuera del orden.
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>SKU</th><th>Producto</th><th>Stock inicio</th><th>Stock fin</th><th>Consumo</th><th>Índice</th></tr>
                  </thead>
                  <tbody>
                    {res.no_calculables.map(p => (
                      <tr key={p.sku}>
                        <td><span className="td-mono">{p.sku}</span></td>
                        <td style={{ fontSize: 13 }}>{p.nombre}{p.historial_incompleto && <AvisoHistorial />}</td>
                        <td>{formatQty(p.stock_inicio)}</td>
                        <td>{formatQty(p.stock_final)}</td>
                        <td>{formatQty(p.consumo)}</td>
                        <td><span className="badge badge-gray">N/A</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {u && (
            <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.6 }}>
              <strong>Cómo se calcula.</strong> Índice = consumo del período ÷ stock promedio. El stock promedio es una
              simplificación: (stock al inicio + stock al fin) ÷ 2, sin ponderar por días. El consumo es neto: salidas
              sin traslados ni movimientos anulados, menos las devoluciones de consumo. El nivel usa el índice mensual
              (índice × {u.base_dias} ÷ días del período): alta ≥ {formatIndice(u.alta)}, media ≥ {formatIndice(u.media)},
              baja por debajo; sin rotación si no hubo consumo.
            </div>
          )}
        </>
      )}
    </>
  );
}
