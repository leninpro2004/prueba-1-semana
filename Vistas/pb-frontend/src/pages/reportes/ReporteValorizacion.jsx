import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import { exportarPDF } from '../../utils/pdfExport';
import { usePageTitle } from '../../contexts/TitleContext';
import BotonExportar from '../../components/BotonExportar';
import Alert, { useAlert } from '../../components/Alert';

/** Valorización de Inventario — conversión 1:1 de reportes/valorizacion.html */
export default function ReporteValorizacion() {
  usePageTitle('Valorización de Inventario');
  const { alert, showAlert } = useAlert();

  const [resumen, setResumen] = useState(null);  // null = KPIs ocultos
  const [detalle, setDetalle] = useState(null);  // null = Cargando…

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const data = await API.reportes.valorizacion();
        if (cancelado) return;
        if (data?.error) { showAlert('danger', data.error); return; }
        setResumen(data.resumen || {});
        setDetalle(Array.isArray(data.detalle) ? data.detalle : []);
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [showAlert]);

  // SONNET-7 / CU-76: mismas columnas para el CSV y el PDF (D35)
  const tabla = () => ({
    headers: ['SKU', 'Producto', 'Categoría', 'Crítico', { titulo: 'Stock', formato: 'numero' }, 'Unidad',
              { titulo: 'Precio unitario', formato: 'clp' }, { titulo: 'Valor línea', formato: 'clp' }],
    rows: (detalle || []).map(d => [
      d.sku || '',
      d.nombre || '',
      d.categoria || '',
      d.es_critico ? 'Sí' : 'No',
      d.stock_total ?? 0,
      d.unidad || '',
      d.sin_precio ? '' : d.precio_unitario,
      d.valor_linea,
    ]),
  });
  const exportar = () => {
    const { headers, rows } = tabla();
    try { exportarCSV('valorizacion', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };
  const [generandoPdf, setGenerandoPdf] = useState(false);
  const exportarPdf = async () => {
    setGenerandoPdf(true);
    try {
      await exportarPDF({
        tipo: 'valorizacion', titulo: 'Valorización de Inventario',
        subtitulo: 'Valor económico del stock actual, con el precio referencial del proveedor principal',
        resumen: [
          ['Valor total', formatMoney(resumen?.valor_total || 0)],
          ['Productos con stock', String(resumen?.total_productos ?? 0)],
          ['Sin precio', String(resumen?.sin_precio ?? 0)],
          ['Estado', resumen?.estado || ''],
        ],
        ...tabla(),
        notas: resumen?.sin_precio > 0
          ? ['Los productos sin precio referencial no suman al valor total: la valorización es estimada o incompleta.'] : [],
      });
    } catch (e) { showAlert('danger', e.message); }
    finally { setGenerandoPdf(false); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Valorización de Inventario</div>
          <div className="page-subtitle">Valor económico total del stock actual</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          <Link to="/reportes/mermas" className="btn btn-ghost">Mermas</Link>
          <Link to="/reportes/consumo-area" className="btn btn-ghost">Consumo por área</Link>
          <Link to="/reportes/programacion" className="btn btn-ghost">Programación</Link>
          <BotonExportar id="btn-exportar" onClick={exportar} filas={detalle == null ? null : detalle.length} />
          <BotonExportar id="btn-exportar-pdf" onClick={exportarPdf} cargando={generandoPdf}
                         filas={detalle == null ? null : detalle.length} etiqueta="Exportar PDF" />
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* KPIs */}
      {resumen && (
        <div id="kpis" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Valor total</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--primary)' }} id="kpi-valor">{formatMoney(resumen.valor_total)}</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Productos con stock</div>
              <div style={{ fontSize: 24, fontWeight: 700 }} id="kpi-productos">{resumen.total_productos || 0}</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Sin precio referencial</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--warning)' }} id="kpi-sin-precio">{resumen.sin_precio || 0}</div>
            </div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Estado</div>
              <div style={{ fontSize: 14, fontWeight: 600 }} id="kpi-estado">{resumen.estado || '—'}</div>
            </div>
          </div>
        </div>
      )}

      {/* CU-68: banner de advertencia cuando hay productos sin precio */}
      {resumen && resumen.sin_precio > 0 && (
        <div id="banner-parcial" style={{
          padding: '12px 16px', background: '#FFF3CD', border: '1px solid #FFECB5', borderRadius: 8,
          marginBottom: 16, fontSize: 13, color: '#856404', display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <strong>⚠ Valorización parcial:</strong> {resumen.sin_precio} producto(s) no tienen precio referencial asignado. El valor total mostrado es una estimación incompleta.
        </div>
      )}

      {/* Tabla */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table" id="tabla-val">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th>Categoría</th>
                <th>Crítico</th>
                <th>Stock</th>
                <th>Unidad</th>
                <th style={{ textAlign: 'right' }}>Precio unit.</th>
                <th style={{ textAlign: 'right' }}>Valor línea</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {detalle === null && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando valorización…</td></tr>
              )}
              {detalle !== null && detalle.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>No hay productos con stock registrado</td></tr>
              )}
              {detalle !== null && detalle.map(d => (
                <tr key={d.sku}>
                  <td><code>{d.sku}</code></td>
                  <td>{d.nombre}</td>
                  <td>{d.categoria || '—'}</td>
                  <td>{d.es_critico ? <span className="badge badge-danger">Sí</span> : '—'}</td>
                  <td>{formatQty(d.stock_total)}</td>
                  <td>{d.unidad || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {d.sin_precio ? <span style={{ color: 'var(--warning)' }}>Sin precio</span> : formatMoney(d.precio_unitario)}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(d.valor_linea)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
