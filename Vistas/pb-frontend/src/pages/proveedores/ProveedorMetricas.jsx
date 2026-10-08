import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import { BarrasHorizontales, descargarGrafico } from '../../components/Charts';
import BotonExportar from '../../components/BotonExportar';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';

// Colores literales (no variables CSS): el SVG se exporta como imagen
const COLOR_BIEN = '#5cb85c', COLOR_REGULAR = '#d4a72c', COLOR_MAL = '#c9526b', COLOR_NEUTRO = '#7a7a7a';
const colorCumplimiento = (pct) => (pct == null ? COLOR_NEUTRO : pct >= 90 ? COLOR_BIEN : pct >= 70 ? COLOR_REGULAR : COLOR_MAL);

const fmtNum = (v) => Number(v).toLocaleString('es-CL', { maximumFractionDigits: 1 });
const fmtDias = (v) => (v == null ? 'Sin datos' : `${fmtNum(v)} d`);
const fmtPct = (v) => (v == null ? 'Sin datos' : `${fmtNum(v)} %`);
const fmtDesv = (v) => (v == null ? 'Sin datos' : `${v > 0 ? '+' : ''}${fmtNum(v)} d`);

/**
 * CU-63: métricas comparativas de cumplimiento entre proveedores (plazo promedio en
 * días hábiles, % a tiempo, % con retraso, desviación promedio), en tabla y gráfico.
 * Reutiliza la consulta base de CU-62. "Pedidos completados" = entregas con recepción.
 */
export default function ProveedorMetricas() {
  usePageTitle('Métricas de proveedores');
  const [proveedores, setProveedores] = useState([]);
  const [fProv, setFProv] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [metrica, setMetrica] = useState('cumplimiento');   // gráfico: 'cumplimiento' | 'plazo'
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  const refGrafico = useRef(null);

  const rangoInvalido = Boolean(desde && hasta && desde > hasta);
  const hayFiltros = Boolean(fProv || desde || hasta);
  const limpiar = () => { setFProv(''); setDesde(''); setHasta(''); };

  useEffect(() => {
    API.proveedores.listar().then(p => setProveedores(Array.isArray(p) ? p : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (rangoInvalido) return undefined;
    let cancelado = false;
    API.proveedores.metricas({ proveedor_id: fProv, desde, hasta })
      .then(d => { if (!cancelado) { setDatos(d); setError(''); } })
      .catch(err => { if (!cancelado) setError('Error cargando las métricas: ' + err.message); });
    return () => { cancelado = true; };
  }, [fProv, desde, hasta, rangoInvalido]);

  const g = datos?.global;
  const lista = datos?.proveedores || [];
  const datosGrafico = lista
    .filter(p => (metrica === 'cumplimiento' ? p.cumplimiento_pct != null : p.promedio_dias != null))
    .map(p => ({
      label: p.proveedor || `Proveedor #${p.proveedor_id}`,
      valor: metrica === 'cumplimiento' ? p.cumplimiento_pct : p.promedio_dias,
      color: colorCumplimiento(p.cumplimiento_pct),
    }));

  // CU-76: la tabla comparativa tal como se ve (días hábiles y porcentajes con coma decimal)
  const exportables = datos && !rangoInvalido && g?.disponible ? lista : [];
  // Mismas columnas para el CSV y el PDF (D35)
  const tabla = () => {
    const num = (titulo) => ({ titulo, formato: 'numero' });
    return {
      headers: ['Proveedor', num('Entregas'), num('Plazo real (días hábiles)'), num('Plazo prometido (días hábiles)'),
                num('A tiempo (%)'), num('Con retraso (%)'), num('Desviación (días)'), num('Pendientes')],
      rows: exportables.map(p => [
        p.proveedor || `Proveedor #${p.proveedor_id}`, p.entregas, p.promedio_dias ?? '', p.plazo_prometido_promedio ?? '',
        p.cumplimiento_pct ?? '', p.retraso_pct ?? '', p.desviacion_promedio_dias ?? '', p.pendientes,
      ]),
    };
  };
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV('metricas-proveedores', headers, rows); setError(''); }
    catch (e) { setError(e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    const ddmm = (iso) => iso.split('-').reverse().join('/');
    const filtros = [
      fProv ? `Proveedor: ${lista[0]?.proveedor || '#' + fProv}` : 'Todos los proveedores',
      desde || hasta ? `Recepción ${desde ? 'desde ' + ddmm(desde) : ''} ${hasta ? 'hasta ' + ddmm(hasta) : ''}`.trim() : 'Todo el período',
    ];
    try {
      await exportarPDF({
        tipo: 'metricas-proveedores', titulo: 'Métricas de cumplimiento de proveedores',
        subtitulo: filtros.join(' · '),
        resumen: [
          ['Entregas completadas', String(g.entregas)],
          ['Plazo promedio', fmtDias(g.promedio_dias)],
          ['A tiempo', fmtPct(g.cumplimiento_pct)],
          ['Con retraso', fmtPct(g.retraso_pct)],
          ['Desviación promedio', fmtDesv(g.desviacion_promedio_dias)],
          ['Plazo prometido promedio', fmtDias(g.plazo_prometido_promedio)],
        ],
        graficos: [{
          titulo: metrica === 'cumplimiento' ? 'Entregas a tiempo por proveedor' : 'Plazo real promedio por proveedor (días hábiles)',
          svg: refGrafico.current,
        }],
        ...tabla(),
        notas: [
          'Días hábiles: lunes a viernes, sin feriados. Plazo real = desde la fecha del pedido hasta la recepción del lote. ' +
          'Plazo prometido = tiempo de reposición vigente del producto con ese proveedor. Los pedidos sin recepción no se incluyen.',
          ...(datos.sin_datos > 0 ? [`${datos.sin_datos} proveedor(es) activo(s) sin entregas completadas en el período no se incluyen.`] : []),
        ],
      });
      setError('');
    } catch (e) { setError(e.message); }
    finally { setGenerandoPdf(false); }
  };

  const kpi = (etiqueta, valor, sub, cls = '') => (
    <div className={`kpi-card ${cls}`}>
      <div className="kpi-label">{etiqueta}</div>
      <div className="kpi-value" style={{ fontSize: 24 }}>{valor}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Métricas de cumplimiento de proveedores</div>
          <div className="page-subtitle">Plazos reales de entrega contra lo prometido, comparados entre proveedores</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/proveedores" className="btn btn-secondary">Volver al directorio</Link>
          <BotonExportar onClick={exportar} filas={datos ? exportables.length : null} />
          <BotonExportar onClick={exportarPdf} cargando={generandoPdf} filas={datos ? exportables.length : null}
                         etiqueta="Exportar PDF" />
        </div>
      </div>

      {/* Filtros en tarjeta, como en el resto de las vistas */}
      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
          <select className="form-control" id="met-proveedor" style={{ width: 'auto', minWidth: 220 }} value={fProv} onChange={e => setFProv(e.target.value)}>
            <option value="">Todos los proveedores</option>
            {proveedores.map(p => <option key={p.id} value={p.id}>{p.razon_social || p.nombre || `Proveedor #${p.id}`}</option>)}
          </select>
          <label style={{ fontSize: 12, color: 'var(--gray)' }}>Recepción desde</label>
          <input type="date" className="form-control" id="met-desde" style={{ width: 'auto', ...(rangoInvalido && { borderColor: 'var(--danger)' }) }} value={desde} onChange={e => setDesde(e.target.value)} />
          <label style={{ fontSize: 12, color: 'var(--gray)' }}>hasta</label>
          <input type="date" className="form-control" id="met-hasta" style={{ width: 'auto', ...(rangoInvalido && { borderColor: 'var(--danger)' }) }} value={hasta} onChange={e => setHasta(e.target.value)} />
          {hayFiltros && <button className="btn btn-ghost btn-sm" onClick={limpiar}>Limpiar filtros</button>}
        </div>
      </div>

      {rangoInvalido && <div className="alert alert-danger" style={{ marginBottom: 16 }}>La fecha de inicio es posterior a la fecha de fin. Corrija el rango.</div>}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Exc 1: no hay ningún pedido completado en el sistema */}
      {datos && !rangoInvalido && datos.total_sistema === 0 && (
        <div className="card"><div className="empty-state">
          <div className="empty-state-icon">📦</div>
          <p style={{ fontSize: 16, fontWeight: 600 }}>No es posible generar los indicadores</p>
          <p style={{ marginTop: 8 }}>No hay pedidos completados registrados: ninguna entrada tiene fecha de pedido y de recepción.
            Ingrese la fecha del pedido al registrar las entradas de mercadería.</p>
        </div></div>
      )}

      {/* Exc 2: hay datos, pero no en el período o proveedor consultado */}
      {datos && !rangoInvalido && datos.total_sistema > 0 && !g?.disponible && (
        <div className="card"><div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <p style={{ fontSize: 16, fontWeight: 600 }}>No hay datos suficientes para el período consultado</p>
          <p style={{ marginTop: 8 }}>Ningún pedido completado coincide con los filtros aplicados.</p>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={limpiar}>Limpiar filtros</button>
        </div></div>
      )}

      {datos && !rangoInvalido && g?.disponible && (
        <>
          <div className="kpi-grid" style={{ marginBottom: 16 }}>
            {kpi('Entregas completadas', g.entregas, `${lista.length} proveedor(es) con datos`)}
            {kpi('Plazo promedio', fmtDias(g.promedio_dias), g.plazo_prometido_promedio != null ? `Prometido: ${fmtDias(g.plazo_prometido_promedio)}` : 'Sin plazos prometidos')}
            {kpi('A tiempo', fmtPct(g.cumplimiento_pct), g.con_plazo ? `${g.a_tiempo} de ${g.con_plazo} con plazo prometido` : null, 'kpi-success')}
            {kpi('Con retraso', fmtPct(g.retraso_pct), g.con_plazo ? `${g.con_retraso} entrega(s)` : null, 'kpi-danger')}
            {kpi('Desviación promedio', fmtDesv(g.desviacion_promedio_dias), 'Real − prometido (negativo = antes de plazo)')}
          </div>

          <div className="card" style={{ marginBottom: 16, padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {metrica === 'cumplimiento' ? 'Entregas a tiempo por proveedor' : 'Plazo real promedio por proveedor (días hábiles)'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="form-control" id="met-grafico" style={{ width: 'auto' }} value={metrica} onChange={e => setMetrica(e.target.value)}>
                  <option value="cumplimiento">% a tiempo</option>
                  <option value="plazo">Plazo promedio</option>
                </select>
                <button className="btn btn-ghost btn-sm" disabled={!datosGrafico.length}
                  onClick={() => descargarGrafico(refGrafico.current, metrica === 'cumplimiento' ? 'cumplimiento-proveedores' : 'plazo-proveedores')}>
                  Descargar imagen
                </button>
              </div>
            </div>
            {datosGrafico.length === 0
              ? <div style={{ textAlign: 'center', padding: 24, color: 'var(--gray)', fontSize: 12 }}>Ningún proveedor tiene productos con plazo prometido para calcular el % a tiempo.</div>
              : <BarrasHorizontales svgRef={refGrafico} datos={datosGrafico}
                  formato={metrica === 'cumplimiento' ? v => `${fmtNum(v)} %` : v => `${fmtNum(v)} d`} />}
            <div style={{ fontSize: 11, color: 'var(--gray)', marginTop: 8 }}>
              Color según el % a tiempo: verde ≥ 90 %, amarillo ≥ 70 %, rojo por debajo; gris sin plazo prometido.
            </div>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Proveedor</th><th>Entregas</th><th>Plazo real</th><th>Prometido</th>
                    <th>A tiempo</th><th>Con retraso</th><th>Desviación</th><th>Pendientes</th>
                  </tr>
                </thead>
                <tbody id="tbody-metricas">
                  {lista.map(p => (
                    <tr key={p.proveedor_id}>
                      <td><Link to={`/proveedores/${p.proveedor_id}`} style={{ fontWeight: 500 }}>{p.proveedor || `Proveedor #${p.proveedor_id}`}</Link></td>
                      <td>{p.entregas}</td>
                      <td style={{ fontWeight: 600 }}>{fmtDias(p.promedio_dias)}</td>
                      <td>{fmtDias(p.plazo_prometido_promedio)}</td>
                      <td><span style={{ fontWeight: 600, color: colorCumplimiento(p.cumplimiento_pct) }}>{fmtPct(p.cumplimiento_pct)}</span></td>
                      <td>{fmtPct(p.retraso_pct)}</td>
                      <td>{fmtDesv(p.desviacion_promedio_dias)}</td>
                      <td>{p.pendientes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {datos.sin_datos > 0 && (
              <p style={{ fontSize: 12, color: 'var(--gray)', margin: '12px 0 0' }}>
                {datos.sin_datos} proveedor(es) activo(s) sin entregas completadas en el período: no se incluyen en la comparación.
              </p>
            )}
          </div>
        </>
      )}

      <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 12 }}>
        Días hábiles: lunes a viernes, sin feriados. Plazo real = desde la fecha del pedido hasta la recepción del lote.
        Plazo prometido = tiempo de reposición vigente del producto con ese proveedor. Los pedidos sin recepción no se incluyen.
      </p>
    </>
  );
}
