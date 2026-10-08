import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import BotonExportar from '../../components/BotonExportar';
import { LineaTemporal, descargarGrafico } from '../../components/Charts';

/**
 * CU-75 — Evolución histórica del inventario, solo gerencia (montos en CLP).
 * El backend entrega el saldo valorizado al cierre de cada mes, por categoría, y
 * los cierres anuales. Mensual y trimestral se arman aquí; la línea de tendencia
 * es una regresión lineal simple sobre el total.
 */

const ANIO_ACTUAL = new Date().getFullYear();
const ANIOS = Array.from({ length: 10 }, (_, i) => ANIO_ACTUAL - i);
const GRANULARIDADES = { mensual: 'Mensual', trimestral: 'Trimestral', anual: 'Anual' };

/** Montos abreviados para el eje: 1.181.600 no cabe repetido 5 veces. */
const montoEje = (v) => {
  const n = Math.round(v);
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n;
};

const ddmmaaaa = (iso) => iso ? iso.split('-').reverse().join('/') : '';

/** Recta de mínimos cuadrados sobre los valores (x = 0, 1, 2...). null con menos de 2 puntos. */
function regresion(valores) {
  const n = valores.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  const my = valores.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  valores.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  const pendiente = num / den;
  const origen = my - pendiente * mx;
  return { pendiente, puntos: valores.map((_, i) => Math.round(origen + pendiente * i)) };
}

/** Períodos de la granularidad elegida: { etiqueta, cierre, a_la_fecha, con_informacion, total, ... }. */
function periodosDe(res, granularidad) {
  if (granularidad === 'anual') return res.anual.map(a => ({ ...a, con_informacion: true }));
  if (granularidad === 'mensual') return res.meses;
  // Trimestral: cierres de marzo, junio, septiembre y diciembre; en el año en curso,
  // el trimestre abierto se muestra con el último mes disponible ("a la fecha").
  return res.meses
    .filter((m, i) => [3, 6, 9, 12].includes(Number(m.mes.slice(5))) || i === res.meses.length - 1)
    .map(m => {
      const t = Math.ceil(Number(m.mes.slice(5)) / 3);
      return { ...m, etiqueta: `T${t} ${res.anio}` };
    });
}

export default function ReporteHistorico() {
  usePageTitle('Histórico de inventario');
  const { user } = useAuth();
  const { alert, showAlert, clearAlert } = useAlert();
  const esGerencia = user?.rol === 'gerencia';
  const refGrafico = useRef(null);

  const [anio, setAnio] = useState(String(ANIO_ACTUAL));
  const [granularidad, setGranularidad] = useState('mensual');
  const [res, setRes] = useState(null);
  const [cargando, setCargando] = useState(false);

  const generar = async () => {
    setCargando(true);
    try {
      const data = await API.reportes.historico(anio);
      setRes(data);
      clearAlert();
    } catch (err) {
      setRes(null);
      showAlert('danger', err.message || 'No se pudo generar el reporte histórico.');
    } finally {
      setCargando(false);
    }
  };

  const vista = useMemo(() => {
    if (!res || res.mensaje) return null;
    const periodos = periodosDe(res, granularidad);
    const conDatos = periodos.filter(p => p.con_informacion);
    const tendencia = regresion(conDatos.map(p => p.total));
    const series = [
      ...res.categorias
        .filter(c => conDatos.some(p => p.por_categoria[c]))
        .map(c => ({ label: c, data: conDatos.map(p => p.por_categoria[c] || 0) })),
      { label: 'Total', data: conDatos.map(p => p.total) },
      ...(tendencia ? [{ label: 'Tendencia (total)', data: tendencia.puntos, punteada: true }] : []),
    ];
    const primero = conDatos[0]?.total, ultimo = conDatos.at(-1)?.total;
    return {
      periodos, conDatos, series, tendencia,
      variacion: conDatos.length > 1 && primero > 0 ? Math.round(((ultimo / primero) - 1) * 1000) / 10 : null,
      sinPrecio: Math.max(0, ...conDatos.map(p => p.sin_precio || 0)),
      incompleto: Math.max(0, ...conDatos.map(p => p.historial_incompleto || 0)),
    };
  }, [res, granularidad]);

  const unidadPeriodo = { mensual: 'mes', trimestral: 'trimestre', anual: 'año' }[granularidad];

  // CU-76: los períodos de la granularidad elegida; los sin información van marcados y sin montos
  // Mismas columnas para el CSV y el PDF (D35)
  const tabla = () => {
    const clp = (titulo) => ({ titulo, formato: 'clp' });
    return {
      headers: ['Período', { titulo: 'Cierre', formato: 'fecha' }, 'A la fecha', 'Información',
                ...res.categorias.map(clp), clp('Total'), 'Productos sin precio', 'Historial incompleto'],
      rows: vista.periodos.map(p => [
        p.etiqueta, p.cierre, p.a_la_fecha ? 'Sí' : 'No', p.con_informacion ? 'Con información' : 'Sin información',
        ...res.categorias.map(c => (p.con_informacion ? p.por_categoria[c] || 0 : '')),
        p.con_informacion ? p.total : '', p.sin_precio ?? '', p.historial_incompleto ?? '',
      ]),
    };
  };
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV(`historico-${res.anio}-${granularidad}`, headers, rows); }
    catch (e) { showAlert('danger', e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    const ultimo = vista.conDatos.at(-1);
    try {
      await exportarPDF({
        tipo: `historico-${res.anio}-${granularidad}`,
        titulo: `Histórico de inventario ${res.anio}`,
        subtitulo: `Valor del inventario al cierre de cada período, por categoría, en CLP · Vista ${GRANULARIDADES[granularidad].toLowerCase()}`,
        resumen: [
          ['Valor al último cierre', `${formatMoney(ultimo?.total)} (${ultimo?.a_la_fecha ? 'a la fecha' : ddmmaaaa(ultimo?.cierre)})`],
          ['Variación en el período', vista.variacion == null ? '—' : `${vista.variacion > 0 ? '+' : ''}${vista.variacion.toLocaleString('es-CL')}%`],
          ['Tendencia', vista.tendencia
            ? `${vista.tendencia.pendiente >= 0 ? '+' : '-'}${formatMoney(Math.abs(vista.tendencia.pendiente))} por ${unidadPeriodo}` : '—'],
        ],
        graficos: [{ titulo: 'Valor del inventario por categoría', svg: refGrafico.current }],
        ...tabla(),
        notas: [
          'Cada saldo se reconstruye desde los movimientos (sin los anulados) y se valoriza con el precio vigente al cierre: ' +
          'el del proveedor principal en el historial de precios, si no el de otro proveedor, si no el precio referencial actual.',
          'La tendencia es una regresión lineal simple sobre el total de los cierres con información.',
          ...(granularidad !== 'anual' && res.meses_sin_informacion.length > 0
            ? [`Datos parciales: ${res.meses_sin_informacion.length} mes(es) sin información (el primer movimiento registrado es del ${ddmmaaaa(res.primer_movimiento)}).`] : []),
          ...(vista.sinPrecio > 0 ? [`Hasta ${vista.sinPrecio} producto(s) con stock no tienen precio en algún cierre: no suman al valor.`] : []),
          ...(vista.incompleto > 0 ? [`Hasta ${vista.incompleto} producto(s) con historial incompleto se valorizan en $0.`] : []),
        ],
      });
    } catch (e) { showAlert('danger', e.message); }
    finally { setGenerandoPdf(false); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Histórico de inventario</div>
          <div className="page-subtitle">Evolución del valor del inventario al cierre de cada período, por categoría, en CLP</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          <Link to="/reportes/valorizacion" className="btn btn-ghost">Valorización actual</Link>
          {esGerencia && (
            <>
              <BotonExportar onClick={exportar} filas={res == null ? null : (vista?.periodos.length ?? 0)} />
              <BotonExportar onClick={exportarPdf} cargando={generandoPdf} etiqueta="Exportar PDF"
                             filas={res == null ? null : (vista?.periodos.length ?? 0)} />
            </>
          )}
        </div>
      </div>

      <Alert {...alert} />

      {!esGerencia ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--gray)' }}>
          Este reporte muestra montos y está disponible solo para gerencia.
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ marginBottom: 0, minWidth: 140 }}>
                <label className="form-label">Año de análisis</label>
                <select className="form-control" value={anio} onChange={e => setAnio(e.target.value)}>
                  {ANIOS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <button className="btn btn-primary" onClick={generar} disabled={cargando}>
                {cargando ? 'Calculando…' : 'Ver histórico'}
              </button>
              {vista && (
                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }} role="group" aria-label="Granularidad">
                  {Object.entries(GRANULARIDADES).map(([k, v]) => (
                    <button key={k} type="button" onClick={() => setGranularidad(k)}
                            className={'btn btn-sm ' + (granularidad === k ? 'btn-primary' : 'btn-ghost')}>{v}</button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {!res && (
            <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--gray)' }}>
              <div style={{ fontSize: 40, marginBottom: 12, opacity: .3 }}>📈</div>
              <p style={{ fontSize: 14 }}>Elija el año y presione <strong>Ver histórico</strong></p>
            </div>
          )}

          {res?.mensaje && (
            <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--gray)' }}>
              <div style={{ fontSize: 36, marginBottom: 10, opacity: .4 }}>📭</div>
              <p style={{ fontSize: 14 }}>{res.mensaje}</p>
            </div>
          )}

          {vista && (
            <>
              {granularidad !== 'anual' && res.meses_sin_informacion.length > 0 && (
                <div style={{ padding: '12px 16px', background: '#FFF3CD', border: '1px solid #FFECB5', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#856404' }}>
                  <strong>⚠ Datos parciales:</strong> {res.meses_sin_informacion.length} mes(es) de {res.anio} no tienen
                  información, porque el primer movimiento registrado es del {ddmmaaaa(res.primer_movimiento)}. Se
                  muestran marcados en la tabla y no entran al gráfico ni a la tendencia.
                </div>
              )}
              {(vista.sinPrecio > 0 || vista.incompleto > 0) && (
                <div style={{ padding: '12px 16px', background: '#F4F6F8', border: '1px solid var(--gray-mid)', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
                  {vista.sinPrecio > 0 && <div>Hasta {vista.sinPrecio} producto(s) con stock no tienen precio en algún cierre: no suman al valor.</div>}
                  {vista.incompleto > 0 && <div>Hasta {vista.incompleto} producto(s) tienen historial incompleto (stock reconstruido negativo por cambios antiguos sin movimiento): se valorizan en $0.</div>}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginBottom: 20 }}>
                <div className="kpi-card">
                  <div className="kpi-label">Valor al último cierre</div>
                  <div className="kpi-value" style={{ fontSize: 20 }}>{formatMoney(vista.conDatos.at(-1)?.total)}</div>
                  <div className="kpi-sub">{vista.conDatos.at(-1)?.a_la_fecha ? 'A la fecha' : 'Cierre ' + ddmmaaaa(vista.conDatos.at(-1)?.cierre)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Variación en el período</div>
                  <div className="kpi-value" style={{ fontSize: 20, color: vista.variacion > 0 ? 'var(--success)' : vista.variacion < 0 ? 'var(--danger)' : undefined }}>
                    {vista.variacion == null ? '—' : (vista.variacion > 0 ? '+' : '') + vista.variacion.toLocaleString('es-CL') + '%'}
                  </div>
                  <div className="kpi-sub">Primer vs. último cierre con información</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Tendencia</div>
                  <div className="kpi-value" style={{ fontSize: 20 }}>
                    {vista.tendencia ? (vista.tendencia.pendiente >= 0 ? '+' : '−') + formatMoney(Math.abs(vista.tendencia.pendiente)) : '—'}
                  </div>
                  <div className="kpi-sub">{vista.tendencia ? `Por ${unidadPeriodo} (regresión lineal)` : 'Se necesitan al menos 2 cierres'}</div>
                </div>
              </div>

              {vista.conDatos.length > 0 && (
                <div className="card" style={{ marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div className="card-title" style={{ marginBottom: 0 }}>Valor del inventario por categoría — {GRANULARIDADES[granularidad].toLowerCase()}</div>
                    <button className="btn btn-ghost btn-sm" onClick={() => descargarGrafico(refGrafico.current, `historico-${res.anio}-${granularidad}`)}>Descargar imagen</button>
                  </div>
                  <LineaTemporal svgRef={refGrafico} labels={vista.conDatos.map(p => p.etiqueta)} series={vista.series} formato={montoEje} />
                </div>
              )}

              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Período</th><th>Cierre</th>
                        {res.categorias.map(c => <th key={c} style={{ textAlign: 'right' }}>{c}</th>)}
                        <th style={{ textAlign: 'right' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vista.periodos.map(p => (
                        <tr key={p.etiqueta} style={p.con_informacion ? undefined : { color: 'var(--gray)', background: '#FAFAFA' }}>
                          <td style={{ fontWeight: 600 }}>{p.etiqueta}</td>
                          <td style={{ fontSize: 12 }}>{p.a_la_fecha ? `A la fecha (${ddmmaaaa(p.cierre)})` : ddmmaaaa(p.cierre)}</td>
                          {p.con_informacion ? (
                            <>
                              {res.categorias.map(c => <td key={c} style={{ textAlign: 'right' }}>{formatMoney(p.por_categoria[c] || 0)}</td>)}
                              <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatMoney(p.total)}</td>
                            </>
                          ) : (
                            <td colSpan={res.categorias.length + 1} style={{ textAlign: 'center', fontStyle: 'italic' }}>⚠ Sin información</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 12, lineHeight: 1.6 }}>
                  Cada saldo se reconstruye desde los movimientos (sin los anulados) y se valoriza con el precio vigente al
                  cierre: el del proveedor principal en el historial de precios, si no el de otro proveedor, si no el
                  precio referencial actual. {granularidad === 'anual' && (res.anual.length > 1
                    ? `La vista anual compara el cierre de ${res.anio} con los ${res.anual.length - 1} año(s) anteriores que tienen información.`
                    : `La vista anual compara el cierre de ${res.anio} con los años anteriores, pero ninguno tiene información.`)}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
