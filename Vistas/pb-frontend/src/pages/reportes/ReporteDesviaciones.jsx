import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { usePagination } from '../../hooks/usePagination';

/**
 * CU-104 — Ranking de desviaciones críticas por impacto (gerencia y jop).
 * Lee los diferenciales procesados en CU-103 (detalle de la OT → Desviaciones) de
 * las OTs del período, opcionalmente de un área. Solo pérdidas: sobregasto y
 * consumo no planificado, del mayor impacto en CLP al menor. El backend no envía
 * los montos a jop (D36) pero le entrega el mismo orden.
 */

/** 'YYYY-MM-DD' local de hoy + n días (nunca toISOString, que es UTC). */
function fechaLocal(n = 0) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** dd/mm/aaaa a partir de 'YYYY-MM-DD'. */
const ddmmaaaa = (iso) => iso ? iso.split('-').reverse().join('/') : '';

const TIPOS = {
  sobre_gasto: { etiqueta: 'Sobregasto',     badge: 'badge-danger' },
  sin_base:    { etiqueta: 'No planificado', badge: 'badge-orange' },
};

const formatPct = (v) => v == null ? 'Sin base'
  : (v > 0 ? '+' : '') + v.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
const conSigno = (v) => (v > 0 ? '+' : '') + formatQty(v);

export default function ReporteDesviaciones() {
  usePageTitle('Desviaciones de consumo');
  const { alert, showAlert, clearAlert } = useAlert();

  const [desde, setDesde] = useState(fechaLocal(-89));
  const [hasta, setHasta] = useState(fechaLocal(0));
  const [areaId, setAreaId] = useState('');
  const [areas, setAreas] = useState([]);
  const [res, setRes] = useState(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    API.reportes.listarAreas().then(setAreas).catch(() => setAreas([]));
  }, []);

  const consultar = async () => {
    // Exc 1: se valida aquí para avisar rápido; el backend vuelve a validar
    if (!desde || !hasta) { showAlert('danger', 'Ingrese la fecha de inicio y la fecha de fin.'); return; }
    if (desde > hasta) { showAlert('danger', 'La fecha de inicio no puede ser posterior a la fecha de fin. Corrija las fechas.'); return; }
    setCargando(true);
    try {
      const data = await API.reportes.desviaciones({ desde, hasta, area_id: areaId });
      setRes(data);
      clearAlert();
    } catch (err) {
      setRes(null);
      showAlert('danger', err.message || 'No se pudo generar el ranking.');
    } finally {
      setCargando(false);
    }
  };

  const ranking = res?.ranking || [];
  const pag = usePagination(res ? ranking : null, 20);
  const r = res?.resumen || {};
  // El backend decide: a jop no le llegan los montos
  const conMontos = res != null && 'impacto_total_clp' in r;

  const alcance = res
    ? `Período ${ddmmaaaa(res.periodo.desde)} al ${ddmmaaaa(res.periodo.hasta)} · ${res.area ? 'Área ' + res.area.nombre : 'Todas las áreas'}`
    : '';

  // Mismas columnas para el CSV y el PDF (D35)
  const tabla = () => {
    const num = (titulo) => ({ titulo, formato: 'numero' });
    return {
      headers: ['N°', 'OT', { titulo: 'Fecha OT', formato: 'fecha' }, 'Área', 'SKU', 'Producto', 'Unidad',
                num('Estimado'), num('Real'), num('Desviación (unidades)'), 'Desviación %', 'Tipo',
                ...(conMontos ? [{ titulo: 'Impacto CLP', formato: 'clp' }] : [])],
      rows: ranking.map(i => [
        i.posicion, i.ot_id, i.ot_fecha, i.area, i.sku, i.nombre, i.unidad || '',
        i.estimado, i.real, i.desviacion_abs, formatPct(i.desviacion_pct), TIPOS[i.tipo].etiqueta,
        ...(conMontos ? [i.sin_precio ? 'Sin precio' : i.impacto_clp] : []),
      ]),
    };
  };
  const nombreArchivo = () => `desviaciones-${res.periodo.desde}-a-${res.periodo.hasta}` +
                              (res.area ? `-area-${res.area.id}` : '');
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV(nombreArchivo(), headers, rows); }
    catch (e) { showAlert('danger', e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    try {
      await exportarPDF({
        tipo: nombreArchivo(), titulo: 'Desviaciones críticas por impacto',
        subtitulo: alcance + ' · Del mayor al menor sobregasto',
        resumen: [
          ['Ítems con pérdida', String(r.items ?? 0)], ['Órdenes de trabajo', String(r.ots ?? 0)],
          ['Sobregasto', String(r.sobre_gasto ?? 0)], ['No planificado', String(r.sin_base ?? 0)],
          ...(conMontos ? [['Impacto total', formatMoney(r.impacto_total_clp)]] : []),
          ['Ahorros (fuera del ranking)', String(r.ahorro ?? 0)],
        ],
        ...tabla(),
        notas: [
          'Fuente: diferenciales de consumo procesados por OT finalizada (real - estimado de la OT). Se filtra por la ' +
          'fecha de la OT y, si se elige, por su área.',
          'Solo pérdidas: sobregasto y consumo no planificado (sin estimado). El impacto es la desviación por el precio ' +
          'vigente a la fecha de la OT; los ítems sin precio van al final.',
        ],
      });
    } catch (e) { showAlert('danger', e.message); }
    finally { setGenerandoPdf(false); }
  };

  const kpi = (etiqueta, valor, sub, color) => (
    <div className="kpi-card">
      <div className="kpi-label">{etiqueta}</div>
      <div className="kpi-value" style={{ color }}>{valor}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );

  const filasExportables = res && !res.mensaje ? ranking.length : null;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Desviaciones de consumo</div>
          <div className="page-subtitle">Dónde se producen las mayores mermas o ineficiencias, ordenadas por impacto económico</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          <BotonExportar onClick={exportar} filas={filasExportables} />
          <BotonExportar onClick={exportarPdf} cargando={generandoPdf} filas={filasExportables} etiqueta="Exportar PDF" />
        </div>
      </div>

      <Alert {...alert} />

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Criterios</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Fecha inicio (de la OT)</label>
            <input className="form-control" type="date" value={desde} onChange={e => setDesde(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Fecha fin (de la OT)</label>
            <input className="form-control" type="date" value={hasta} onChange={e => setHasta(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
            <label className="form-label">Área de producción (opcional)</label>
            <select className="form-control" value={areaId} onChange={e => setAreaId(e.target.value)}>
              <option value="">Todas las áreas</option>
              {areas.map(a => (
                <option key={a.id} value={a.id}>{a.nombre}{a.activo === false ? ' (inactiva)' : ''}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={consultar} disabled={cargando}>
            {cargando ? 'Consultando…' : 'Consultar ranking'}
          </button>
        </div>
      </div>

      {!res && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: .3 }}>📉</div>
          <p style={{ fontSize: 14 }}>Elija el período y presione <strong>Consultar ranking</strong></p>
          <p style={{ fontSize: 12 }}>Solo aparecen las OTs finalizadas cuyos diferenciales ya se procesaron (detalle de la OT → Desviaciones).</p>
        </div>
      )}

      {res?.mensaje && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 36, marginBottom: 10, opacity: .4 }}>📭</div>
          <p style={{ fontSize: 14 }}>{res.mensaje}</p>
          <p style={{ fontSize: 12 }}>{alcance}. Pruebe con otro período u otra área.</p>
        </div>
      )}

      {res && !res.mensaje && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 16, marginBottom: 16 }}>
            {kpi('Ítems con pérdida', r.items, `en ${r.ots} OT(s)`, 'var(--danger)')}
            {kpi('Sobregasto', r.sobre_gasto, 'real mayor que lo estimado')}
            {kpi('No planificado', r.sin_base, 'consumido sin estimado')}
            {conMontos && kpi('Impacto total', formatMoney(r.impacto_total_clp),
                              r.sin_precio > 0 ? `${r.sin_precio} ítem(s) sin precio no suman` : 'pérdida valorizada', 'var(--danger)')}
            {kpi('Ahorros', r.ahorro, 'fuera del ranking', 'var(--success)')}
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 12 }}>
              {ranking.length} ítem(s) · {alcance} · del mayor al menor impacto
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>N°</th><th>OT</th><th>Área</th><th>Producto</th>
                    <th>Estimado</th><th>Real</th><th>Desviación</th><th>Desviación %</th><th>Tipo</th>
                    {conMontos && <th>Impacto</th>}
                  </tr>
                </thead>
                <tbody>
                  {pag.items.map(i => (
                    <tr key={`${i.ot_id}-${i.sku}`}>
                      <td style={{ fontWeight: 700 }}>{i.posicion}</td>
                      <td>
                        <Link to={`/ordenes/${i.ot_id}`} className="td-mono">OT #{i.ot_id}</Link>
                        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{ddmmaaaa(i.ot_fecha)}</div>
                      </td>
                      <td style={{ fontSize: 13 }}>{i.area}</td>
                      <td style={{ fontSize: 13 }}>
                        <span style={{ fontWeight: 500 }}>{i.nombre}</span>
                        <div className="td-mono" style={{ fontSize: 11 }}>{i.sku}</div>
                      </td>
                      <td>{formatQty(i.estimado)}</td>
                      <td>{formatQty(i.real)}</td>
                      <td style={{ fontWeight: 600 }}>
                        {conSigno(i.desviacion_abs)} <span style={{ fontSize: 11, color: 'var(--gray)' }}>{i.unidad || ''}</span>
                      </td>
                      <td>{formatPct(i.desviacion_pct)}</td>
                      <td><span className={'badge ' + TIPOS[i.tipo].badge}>{TIPOS[i.tipo].etiqueta}</span></td>
                      {conMontos && (
                        <td style={{ fontWeight: 700 }}>
                          {i.sin_precio ? <span className="badge badge-gray" title="El material no tenía precio a la fecha de la OT">Sin precio</span>
                                        : formatMoney(i.impacto_clp)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...pag} />
          </div>

          <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.6 }}>
            <strong>Cómo se calcula.</strong> Desviación = consumo real − estimado de la OT; % = desviación ÷ estimado × 100
            (sin estimado es "no planificado", sin porcentaje). El impacto es la desviación por el precio vigente a la fecha
            de la OT. Solo entran las pérdidas; los ítems sin precio van al final, ordenados por desviación %. Si el consumo
            de una OT cambia, vuelva a procesar sus diferenciales desde el detalle de la OT.
          </div>
        </>
      )}
    </>
  );
}
