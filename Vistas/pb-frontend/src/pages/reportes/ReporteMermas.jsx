import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney, fechaLocal } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { usePagination } from '../../hooks/usePagination';
import { ocultaMontos } from '../../utils/user';

/**
 * Reporte de Mermas — conversión 1:1 de reportes/mermas.html.
 * data-rol="gerencia" (ocultos si rol === 'jop'): enlace Valorización, Exportar, KPI "Valor total merma",
 * columnas "Precio unitario" y "Valor merma", total monetario.
 */
export default function ReporteMermas() {
  usePageTitle('Reporte de Mermas');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const verCosto = !ocultaMontos(user);

  const [desde, setDesde] = useState('2025-05-01');
  const [hasta, setHasta] = useState('2025-05-31');
  const [motivo, setMotivo] = useState('');
  const [motivos, setMotivos] = useState([]);
  const [res, setRes] = useState(null); // { mermas, resumen, desde, hasta }

  // CU-75: motivos del catálogo cuya clasificación es de merma, con el mismo
  // criterio que la salida (pérdida, perdida o merma). Antes eran opciones fijas
  // que no existían en el catálogo.
  useEffect(() => {
    let cancelado = false;
    API.movimientos.catalogos().then(c => {
      const esMerma = (n) => /p[ée]rdida|merma/i.test(n || '');
      const clasifMerma = new Set((c?.clasificaciones || []).filter(x => esMerma(x.nombre)).map(x => String(x.id)));
      if (!cancelado) setMotivos((c?.motivos || []).filter(m => clasifMerma.has(String(m.clasificacion_id))));
    }).catch(() => { if (!cancelado) setMotivos([]); });
    return () => { cancelado = true; };
  }, []);

  const generarReporte = async () => {
    if (!desde || !hasta) { showAlert('danger', 'Selecciona un rango de fechas.'); return; }
    if (desde > hasta) { showAlert('danger', 'La fecha de inicio no puede ser posterior a la de fin.'); return; }
    const diffDias = Math.ceil((new Date(hasta) - new Date(desde)) / (1000 * 60 * 60 * 24));
    if (diffDias > 90) showAlert('warning', `El rango seleccionado abarca ${diffDias} días. Esto puede tardar más de lo habitual.`);
    try {
      const data = await API.reportes.mermas({ desde, hasta, motivo: motivo || null });
      setRes({ mermas: data?.mermas || [], resumen: data?.resumen || {}, desde, hasta });
    } catch (err) {
      showAlert('danger', 'Error generando reporte: ' + err.message);
    }
  };

  const limpiar = () => { setDesde(''); setHasta(''); setMotivo(''); setRes(null); };

  const pag = usePagination(res?.mermas ?? null, 20);
  const resumen = res?.resumen || {};
  const sinPrecio = resumen.productos_sin_precio || 0;
  const valor = resumen.valor_total_merma != null ? formatMoney(resumen.valor_total_merma) : '—';

  // SONNET-7 / CU-76: mismas columnas para el CSV y el PDF (D35); el estado
  // distingue las pendientes, que no entran a los totales
  const tabla = () => {
    const headers = ['SKU', 'Producto', 'Motivo', 'Estado', { titulo: 'Cantidad perdida', formato: 'numero' }];
    if (verCosto) headers.push({ titulo: 'Precio unitario', formato: 'clp' }, { titulo: 'Valor merma', formato: 'clp' });
    headers.push({ titulo: 'Fecha y hora', formato: 'timestamp' }, 'Registrado por');
    const rows = (res?.mermas || []).map(m => {
      const row = [m.sku || '', m.producto || '', m.motivo || '',
                   m.estado === 'pendiente_aprobacion' ? 'Pendiente de aprobación' : 'Confirmada', m.cantidad];
      if (verCosto) row.push(m.precio_unitario, m.valor_merma);
      row.push(m.fecha || '', m.usuario || '');
      return row;
    });
    return { headers, rows };
  };
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV('mermas', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const ddmm = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    try {
      await exportarPDF({
        tipo: 'mermas', titulo: 'Reporte de Mermas',
        subtitulo: `Período ${ddmm(res.desde)} al ${ddmm(res.hasta)}` + (motivo ? ` · Motivo: ${motivo.replace(/_/g, ' ')}` : ''),
        resumen: [
          ['Eventos de merma', String(resumen.total_eventos || 0)],
          ['Unidades perdidas', String(resumen.total_unidades || 0)],
          ...(verCosto ? [['Valor total merma', valor]] : []),
          ['Productos afectados', String(resumen.skus_afectados || 0)],
          ...(resumen.pendientes > 0 ? [['Pendientes de aprobación', `${resumen.pendientes} (${resumen.unidades_pendientes} u.)`]] : []),
        ],
        ...tabla(),
        notas: [
          ...(resumen.pendientes > 0 ? ['Las mermas pendientes de aprobación se listan, pero no se incluyen en los totales.'] : []),
          ...(verCosto && sinPrecio > 0 ? [`${sinPrecio} producto(s) sin precio referencial: el valor total es una estimación incompleta.`] : []),
        ],
      });
    } catch (e) { showAlert('danger', e.message); }
    finally { setGenerandoPdf(false); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Reporte de Mermas</div>
          <div className="page-subtitle">Pérdidas, daños y productos no recuperables por período</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          {verCosto && <Link to="/reportes/valorizacion" className="btn btn-ghost">Valorización</Link>}
          <Link to="/reportes/consumo-area" className="btn btn-ghost">Consumo por área</Link>
          <Link to="/reportes/programacion" className="btn btn-ghost">Programación</Link>
          {verCosto && (
            <>
              <BotonExportar id="btn-exportar" onClick={exportar} filas={res ? res.mermas.length : null} />
              <BotonExportar id="btn-exportar-pdf" onClick={exportarPdf} cargando={generandoPdf}
                             filas={res ? res.mermas.length : null} etiqueta="Exportar PDF" />
            </>
          )}
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros (FR-50, FR-53) */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Filtrar por período</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label className="form-label">Fecha inicio</label><input className="form-control" type="date" id="filter-desde" value={desde} onChange={e => setDesde(e.target.value)} /></div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label className="form-label">Fecha fin</label><input className="form-control" type="date" id="filter-hasta" value={hasta} onChange={e => setHasta(e.target.value)} /></div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Motivo</label>
            <select className="form-control" id="filter-motivo" value={motivo} onChange={e => setMotivo(e.target.value)}>
              <option value="">Todos los motivos</option>
              {motivos.map(m => <option key={m.id} value={m.nombre}>{m.nombre.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" id="btn-generar" onClick={generarReporte}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Generar reporte
          </button>
          <button className="btn btn-ghost" id="btn-limpiar-filtros" type="button" onClick={limpiar}>Limpiar filtros</button>
        </div>
      </div>

      {!res && (
        <div id="empty-inicial" className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--gray)' }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: .3 }}>📉</div>
          <p style={{ fontSize: 14 }}>Selecciona un rango de fechas y presiona <strong>Generar reporte</strong></p>
        </div>
      )}

      {res && (
        <>
          <div id="kpi-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 20 }}>
            <div className="kpi-card danger"><div className="kpi-label">Eventos de merma</div><div className="kpi-value" id="kpi-eventos" style={{ color: 'var(--danger)' }}>{resumen.total_eventos || 0}</div><div className="kpi-sub">Movimientos clasificados como pérdida</div></div>
            <div className="kpi-card danger"><div className="kpi-label">Unidades perdidas</div><div className="kpi-value" id="kpi-unidades" style={{ color: 'var(--danger)' }}>{resumen.total_unidades || 0}</div><div className="kpi-sub">Total de stock no recuperable</div></div>
            {verCosto && <div className="kpi-card warning"><div className="kpi-label">Valor total merma</div><div className="kpi-value" id="kpi-valor" style={{ color: 'var(--orange-dark)', fontSize: 20 }}>{valor}</div><div className="kpi-sub">Estimado según precio unitario</div></div>}
            {sinPrecio > 0 && <div className="kpi-card" id="kpi-card-precios-warn"><div className="kpi-label">Precios incompletos</div><div className="kpi-value" id="kpi-sin-precio" style={{ color: 'var(--warning)' }}>{sinPrecio}</div><div className="kpi-sub">Productos sin precio referencial</div></div>}
            <div className="kpi-card"><div className="kpi-label">Productos afectados</div><div className="kpi-value" id="kpi-productos">{resumen.skus_afectados || 0}</div><div className="kpi-sub">SKUs distintos con merma</div></div>
          </div>

          {resumen.pendientes > 0 && (
            <div style={{ padding: '12px 16px', background: '#FFF3CD', border: '1px solid #FFECB5', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#856404' }}>
              <strong>⏳ {resumen.pendientes} merma(s) pendiente(s) de aprobación</strong> por {resumen.unidades_pendientes} unidad(es):
              se listan marcadas, pero no se incluyen en los totales hasta que gerencia las apruebe.
            </div>
          )}

          {sinPrecio > 0 && (
            <div id="banner-mermas-parcial" style={{ padding: '12px 16px', background: '#FFF3CD', border: '1px solid #FFECB5', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#856404', display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>⚠ Valorización de mermas parcial:</strong> {sinPrecio} producto(s) no tienen precio referencial asignado. El valor total de merma mostrado es una estimación incompleta.
            </div>
          )}

          <div id="tabla-resultado">
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--gray)' }} id="tabla-titulo">{res.mermas.length} evento(s) de merma entre {res.desde} y {res.hasta}</div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th><th>Nombre del producto</th><th>Motivo</th><th>Cant. perdida</th>
                      {verCosto && <th>Precio unitario</th>}
                      {verCosto && <th>Valor merma (CLP)</th>}
                      <th>Fecha</th><th>Registrado por</th>
                    </tr>
                  </thead>
                  <tbody id="tbody-mermas">
                    {res.mermas.length === 0 && <EmptyRow colSpan={8} emptyMsg={<div className="empty-state"><div className="empty-state-icon">✅</div><p>No se registraron mermas en este período.</p></div>} />}
                    {pag.items.map((m, i) => (
                      <tr key={m.id ?? i} style={m.estado === 'pendiente_aprobacion' ? { opacity: 0.7 } : undefined}>
                        <td><span className="td-mono">{m.sku}</span></td>
                        <td style={{ fontWeight: 500, fontSize: 13, maxWidth: 200 }}>
                          {m.producto}
                          {m.estado === 'pendiente_aprobacion' && <div><span className="badge badge-warning">Pendiente de aprobación</span></div>}
                        </td>
                        <td><span className="badge badge-danger">{m.motivo}</span></td>
                        <td style={{ fontWeight: 700, color: 'var(--danger)', fontSize: 15 }}>{parseFloat(m.cantidad)}</td>
                        {verCosto && <td style={{ fontSize: 13 }}>{m.precio_unitario != null ? formatMoney(m.precio_unitario) : '—'}</td>}
                        {verCosto && <td style={{ fontWeight: 600, fontSize: 13 }}>{m.valor_merma != null ? formatMoney(m.valor_merma) : '—'}</td>}
                        <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>{fechaLocal(m.fecha)}</td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{m.usuario || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination {...pag} />
              {res.mermas.length > 0 && (
                <div id="fila-totales" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--gray-mid)' }}>
                  <div style={{ display: 'flex', gap: 24, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13 }}>Total unidades perdidas: <strong id="total-unidades">{resumen.total_unidades || 0}</strong></div>
                    {verCosto && <div style={{ fontSize: 13 }}>Valor total estimado: <strong id="total-valor" style={{ color: 'var(--danger)' }}>{valor}</strong></div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
