import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import BotonExportar from '../../components/BotonExportar';
import { BarrasAgrupadas, BarrasHorizontales, LineaTemporal, descargarGrafico } from '../../components/Charts';
import { ocultaMontos } from '../../utils/user';

const MSG_INICIAL = 'Seleccione fechas y presione "Generar reporte"';

/** Presets de período (OPUS-12). 'personalizado' deja las fechas como estén. */
// toISOString() devuelve la fecha en UTC: de tarde en Chile (UTC-4/-3) ya es el
// día siguiente, así que "hasta" salía un día adelantado. Se arma en local.
const aISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hoyISO = () => aISO(new Date());
const primerDiaMes = (d = new Date()) => aISO(new Date(d.getFullYear(), d.getMonth(), 1));
const restarMeses = (n) => {
  const d = new Date();
  return aISO(new Date(d.getFullYear(), d.getMonth() - n, d.getDate()));
};
const PERIODOS = {
  mes:          { etiqueta: 'Mes actual',    rango: () => ({ desde: primerDiaMes(), hasta: hoyISO() }) },
  trimestre:    { etiqueta: 'Últimos 3 meses', rango: () => ({ desde: restarMeses(3), hasta: hoyISO() }) },
  semestre:     { etiqueta: 'Últimos 6 meses', rango: () => ({ desde: restarMeses(6), hasta: hoyISO() }) },
  anio:         { etiqueta: 'Último año',    rango: () => ({ desde: restarMeses(12), hasta: hoyISO() }) },
  personalizado:{ etiqueta: 'Personalizado', rango: null },
};

/** Montos abreviados para los ejes: 1.181.600 no cabe repetido 5 veces. */
const montoEje = (v) => {
  const n = Math.round(v);
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n;
};

/** Consumo por Área — conversión 1:1 de reportes/consumo-area.html. data-rol="gerencia": enlace Valorización. */
export default function ReporteConsumoArea() {
  usePageTitle('Consumo por Área');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  // Montos ocultos a jop: el backend no le envía precios ni costos y mide en cantidad
  const verCostos = !ocultaMontos(user);

  const [areas, setAreas] = useState([]);
  const [areaId, setAreaId] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [resumen, setResumen] = useState(null);     // resumen_por_area o null (oculto)
  const [consumos, setConsumos] = useState(null);   // null = mensaje de tabla
  const [msgTabla, setMsgTabla] = useState(MSG_INICIAL);

  // OPUS-12 (Req #4): vista de gráficos
  const [vista, setVista] = useState('tabla');      // 'tabla' | 'graficos'
  const [periodo, setPeriodo] = useState('personalizado');
  const [gArea, setGArea] = useState(null);
  const [gMaterial, setGMaterial] = useState(null);
  const [gMes, setGMes] = useState(null);
  const refArea = useRef(null);
  const refMaterial = useRef(null);
  const refMes = useRef(null);

  // CU-69: Cargar áreas al iniciar
  useEffect(() => { API.reportes.listarAreas().then(a => setAreas(a || [])).catch(() => {}); }, []);

  const aplicarPeriodo = (clave) => {
    setPeriodo(clave);
    const p = PERIODOS[clave];
    if (p?.rango) {
      const { desde: d, hasta: h } = p.rango();
      setDesde(d);
      setHasta(h);
    }
  };

  // Los tres gráficos se piden juntos: son tres agrupaciones del mismo período
  const cargarGraficos = useCallback(async () => {
    try {
      const [a, m, mes] = await Promise.all([
        API.reportes.consumoAreaGrafico({ desde, hasta, agrupar: 'area' }),
        API.reportes.consumoAreaGrafico({ desde, hasta, agrupar: 'material' }),
        API.reportes.consumoAreaGrafico({ desde, hasta, agrupar: 'mes' }),
      ]);
      setGArea(a); setGMaterial(m); setGMes(mes);
    } catch (err) {
      showAlert('danger', 'Error cargando los gráficos: ' + err.message);
    }
  }, [desde, hasta, showAlert]);

  useEffect(() => { if (vista === 'graficos') cargarGraficos(); }, [vista, cargarGraficos]);

  const generarReporte = async () => {
    try {
      const data = await API.reportes.consumoArea({ area_id: areaId, desde, hasta });
      if (data?.error) { setResumen(null); setConsumos(null); setMsgTabla('Sin resultados'); showAlert('danger', data.error); return; }
      if (data?.mensaje) { setResumen(null); setConsumos(null); setMsgTabla('Sin resultados para los filtros aplicados'); showAlert('info', data.mensaje); return; }
      const { consumos: c, resumen_por_area } = data;
      const hayResumen = resumen_por_area && resumen_por_area.length > 0;
      setResumen(hayResumen ? resumen_por_area : null);
      if (!c || c.length === 0) {
        setConsumos(null);
        setMsgTabla('No hay datos de consumo para mostrar con los filtros aplicados');
        return;
      }
      setConsumos(c);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  const limpiar = () => {
    setAreaId(''); setDesde(''); setHasta(''); setResumen(null); setConsumos(null);
    setMsgTabla(MSG_INICIAL); setPeriodo('personalizado');
  };

  // OPUS-12: exportar la tabla resumen de los gráficos (área, %, variación)
  const exportarResumenGrafico = () => {
    const headers = verCostos
      ? ['Área', { titulo: 'Costo', formato: 'clp' }, { titulo: '% del total', formato: 'numero' },
         { titulo: 'Cantidad consumida', formato: 'numero' }, 'Materiales',
         { titulo: 'Costo período anterior', formato: 'clp' }, { titulo: 'Variación %', formato: 'numero' }]
      : ['Área', { titulo: '% del total (cantidad)', formato: 'numero' }, { titulo: 'Cantidad consumida', formato: 'numero' },
         'Materiales', { titulo: 'Cantidad período anterior', formato: 'numero' }, { titulo: 'Variación %', formato: 'numero' }];
    const rows = (gArea?.areas || []).map(a => (verCostos
      ? [a.area, a.costo, a.porcentaje, a.cantidad, a.materiales, a.costo_periodo_anterior ?? '', a.variacion_pct ?? '']
      : [a.area, a.porcentaje, a.cantidad, a.materiales, a.cantidad_periodo_anterior ?? '', a.variacion_pct ?? '']));
    try { exportarCSV('consumo-area-grafico', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  // SONNET-7: exportar CSV con los datos ya cargados
  const exportar = () => {
    const headers = ['Área', 'SKU', 'Material', 'Unidad', { titulo: 'Total consumido', formato: 'numero' },
                     ...(verCostos ? [{ titulo: 'Precio unitario', formato: 'clp' }, { titulo: 'Costo total', formato: 'clp' }] : []),
                     'OTs'];
    const rows = (consumos || []).map(c => [
      c.area_nombre || '',
      c.sku || '',
      c.material_nombre || '',
      c.unidad || '',
      c.total_consumido ?? 0,
      ...(verCostos ? [c.precio_unitario, parseFloat(c.total_consumido || 0) * parseFloat(c.precio_unitario || 0)] : []),
      c.ordenes_involucradas ?? '',
    ]);
    try { exportarCSV('consumo-area', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Consumo por Área de Trabajo</div>
          <div className="page-subtitle">Análisis de materiales consumidos por área y período</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          <Link to="/reportes/mermas" className="btn btn-ghost">Mermas</Link>
          {!ocultaMontos(user) && <Link to="/reportes/valorizacion" className="btn btn-ghost">Valorización</Link>}
          <Link to="/reportes/programacion" className="btn btn-ghost">Programación</Link>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Filtros</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
            <label className="form-label">Área</label>
            <select className="form-control" id="filter-area" value={areaId} onChange={e => setAreaId(e.target.value)}>
              <option value="">Todas las áreas</option>
              {areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label className="form-label">Desde</label><input className="form-control" type="date" id="filter-desde" value={desde} onChange={e => setDesde(e.target.value)} /></div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label className="form-label">Hasta</label><input className="form-control" type="date" id="filter-hasta" value={hasta} onChange={e => setHasta(e.target.value)} /></div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 150 }}>
            <label className="form-label">Período</label>
            <select className="form-control" id="filter-periodo" value={periodo} onChange={e => aplicarPeriodo(e.target.value)}>
              {Object.entries(PERIODOS).map(([k, p]) => <option key={k} value={k}>{p.etiqueta}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" id="btn-generar" onClick={generarReporte}>Generar reporte</button>
          <button className="btn btn-ghost" id="btn-limpiar-filtros" type="button" onClick={limpiar}>Limpiar filtros</button>
          <BotonExportar id="btn-exportar" onClick={exportar} filas={consumos == null ? null : consumos.length} />
        </div>
      </div>

      {/* OPUS-12 (Req #4): alternar entre el detalle tabular y los gráficos */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)' }}>
        {[['tabla', 'Detalle'], ['graficos', 'Gráficos']].map(([k, label]) => (
          <button key={k} className={'btn btn-ghost tab-btn' + (vista === k ? ' active' : '')}
            id={'vista-' + k}
            style={{ borderRadius: 0, marginBottom: -2, borderBottom: vista === k ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setVista(k)}>{label}</button>
        ))}
      </div>

      {/* Resumen por área */}
      {resumen && (
        <div id="resumen-areas" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Resumen por área</div>
          <div id="areas-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
            {resumen.map((a, i) => (
              <div key={a.area ?? i} className="card" style={{ padding: 14, ...(a.alerta_anomalia ? { borderLeft: '4px solid var(--danger)' } : {}) }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{a.area}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{a.materiales} material(es)</div>
                {a.costo_total != null && <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--primary)' }}>{formatMoney(a.costo_total)}</div>}
                {a.promedio_historico != null && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Promedio histórico: {formatMoney(a.promedio_historico)}</div>}
                {a.alerta_anomalia && <div style={{ marginTop: 6, padding: '6px 8px', background: '#FFF3CD', borderRadius: 4, fontSize: 11, color: '#856404', fontWeight: 600 }}>⚠ {a.mensaje_anomalia} (+{a.desviacion_pct}%)</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── OPUS-12 (Req #4): gráficos ── */}
      {vista === 'graficos' && (
        <div id="bloque-graficos">
          {/* 1. Costo por área */}
          <div className="card" style={{ marginBottom: 16, padding: 18 }} id="grafico-areas">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {verCostos ? 'Costo de consumo por área' : 'Cantidad consumida por área'}
                {verCostos && gArea?.total_costo > 0 && (
                  <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {' · '}total {formatMoney(gArea.total_costo)}
                  </span>
                )}
              </div>
              <button className="btn btn-ghost btn-sm" id="btn-img-area" disabled={!gArea?.areas?.length}
                onClick={() => descargarGrafico(refArea.current, 'consumo-por-area')}>Descargar imagen</button>
            </div>
            {!gArea && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Cargando…</div>}
            {gArea && gArea.areas.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>
                No hay consumos registrados en este período.
              </div>
            )}
            {gArea && gArea.areas.length > 0 && (
              <BarrasHorizontales svgRef={refArea} formato={verCostos ? formatMoney : formatQty}
                datos={gArea.areas.map(a => ({ label: a.area, valor: verCostos ? a.costo : a.cantidad }))} />
            )}
          </div>

          {/* 2. Top materiales, desglosado por área */}
          <div className="card" style={{ marginBottom: 16, padding: 18 }} id="grafico-materiales">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Materiales más consumidos
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}> · top 10, por área</span>
              </div>
              <button className="btn btn-ghost btn-sm" id="btn-img-material" disabled={!gMaterial?.labels?.length}
                onClick={() => descargarGrafico(refMaterial.current, 'materiales-por-area')}>Descargar imagen</button>
            </div>
            {!gMaterial && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Cargando…</div>}
            {gMaterial && gMaterial.labels.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Sin datos en este período.</div>
            )}
            {gMaterial && gMaterial.labels.length > 0 && (
              <BarrasAgrupadas svgRef={refMaterial} labels={gMaterial.labels} series={gMaterial.datasets} formato={verCostos ? montoEje : formatQty} />
            )}
          </div>

          {/* 3. Evolución mensual */}
          <div className="card" style={{ marginBottom: 16, padding: 18 }} id="grafico-mensual">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Evolución mensual por área
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {desde || hasta ? ' · período filtrado' : ' · últimos 12 meses'}
                </span>
              </div>
              <button className="btn btn-ghost btn-sm" id="btn-img-mes" disabled={!gMes?.labels?.length}
                onClick={() => descargarGrafico(refMes.current, 'consumo-mensual')}>Descargar imagen</button>
            </div>
            {!gMes && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Cargando…</div>}
            {gMes && gMes.labels.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 12 }}>Sin datos en este período.</div>
            )}
            {gMes && gMes.labels.length > 0 && (
              <LineaTemporal svgRef={refMes} labels={gMes.labels} series={gMes.datasets} formato={verCostos ? montoEje : formatQty} />
            )}
          </div>

          {/* 4. Tabla resumen con % y variación */}
          <div className="card" id="tabla-resumen-grafico">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0 10px' }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Resumen comparativo</div>
              <BotonExportar id="btn-exportar-resumen" className="btn btn-secondary btn-sm" onClick={exportarResumenGrafico}
                filas={gArea == null ? null : (gArea.areas?.length || 0)} />
            </div>
            {gArea?.periodo?.anterior && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Comparado contra {gArea.periodo.anterior.desde} → {gArea.periodo.anterior.hasta}
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Área</th>
                    {verCostos && <th style={{ textAlign: 'right' }}>Costo</th>}
                    <th style={{ textAlign: 'right' }}>% del total</th>
                    <th style={{ textAlign: 'right' }}>Cantidad</th>
                    <th style={{ textAlign: 'right' }}>Materiales</th>
                    <th style={{ textAlign: 'right' }}>{verCostos ? 'Período anterior' : 'Cantidad período anterior'}</th>
                    <th style={{ textAlign: 'right' }}>Variación</th>
                  </tr>
                </thead>
                <tbody id="resumen-grafico-body">
                  {(!gArea || gArea.areas.length === 0) && (
                    <tr><td colSpan={verCostos ? 7 : 6} style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>Sin datos.</td></tr>
                  )}
                  {gArea?.areas.map(a => {
                    const anterior = verCostos ? a.costo_periodo_anterior : a.cantidad_periodo_anterior;
                    const actual = verCostos ? a.costo : a.cantidad;
                    return (
                    <tr key={a.area_id}>
                      <td style={{ fontWeight: 500 }}>{a.area}</td>
                      {verCostos && <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(a.costo)}</td>}
                      <td style={{ textAlign: 'right' }}>{a.porcentaje}%</td>
                      <td style={{ textAlign: 'right' }}>{formatQty(a.cantidad)}</td>
                      <td style={{ textAlign: 'right' }}>{a.materiales}</td>
                      <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--gray)' }}>
                        {anterior != null ? (verCostos ? formatMoney(anterior) : formatQty(anterior)) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600,
                        color: a.variacion_pct > 0 ? 'var(--danger)' : a.variacion_pct < 0 ? 'var(--success)' : undefined }}>
                        {a.variacion_pct != null
                          ? (a.variacion_pct > 0 ? '+' : '') + a.variacion_pct + '%'
                          : anterior === 0 && actual > 0
                            ? <span title="No hubo consumo en el período anterior" style={{ fontWeight: 400, color: 'var(--gray)' }}>sin base</span>
                            : '—'}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tabla detalle */}
      {vista === 'tabla' && (
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Área</th><th>SKU</th><th>Material</th><th>Unidad</th>
                <th style={{ textAlign: 'right' }}>Total consumido</th>
                {verCostos && <th style={{ textAlign: 'right' }}>Precio unit.</th>}
                {verCostos && <th style={{ textAlign: 'right' }}>Costo total</th>}
                <th style={{ textAlign: 'right' }}>OTs</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {!consumos && <tr><td colSpan={verCostos ? 8 : 6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>{msgTabla}</td></tr>}
              {(consumos || []).map((c, i) => {
                const consumido = parseFloat(c.total_consumido || 0);
                const precio = parseFloat(c.precio_unitario || 0);
                return (
                  <tr key={`${c.area_nombre}-${c.sku}-${i}`}>
                    <td>{c.area_nombre}</td>
                    <td><code>{c.sku}</code></td>
                    <td>{c.material_nombre}</td>
                    <td>{c.unidad || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(consumido)}</td>
                    {verCostos && <td style={{ textAlign: 'right' }}>{precio ? formatMoney(precio) : '—'}</td>}
                    {verCostos && <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(consumido * precio)}</td>}
                    <td style={{ textAlign: 'right' }}>{c.ordenes_involucradas}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </>
  );
}
