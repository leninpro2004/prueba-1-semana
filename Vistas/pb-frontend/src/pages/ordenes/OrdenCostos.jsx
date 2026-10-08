import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';

/** Costos — Orden de Trabajo — conversión 1:1 de ordenes/costos.html (?id= → /ordenes/:id/costos) */
export default function OrdenCostos() {
  usePageTitle('Costos Orden de Trabajo');
  const { id: otId } = useParams();
  const { alert, showAlert } = useAlert();

  const [data, setData] = useState(null); // { detalle, resumen, orden }
  const [comp, setComp] = useState(null); // { detalle, resumen } de /comparativo (SONNET-5)
  const [margen, setMargen] = useState('25');
  const [rent, setRent] = useState(null);

  useEffect(() => {
    if (!otId) return;
    let cancelado = false;
    (async () => {
      try {
        const [d, c] = await Promise.all([
          API.ordenesTrabajo.costos(otId),
          API.ordenesTrabajo.comparativo(otId),
        ]);
        if (cancelado) return;
        if (d?.error) { showAlert('danger', d.error); return; }
        setData(d);
        if (!c?.error) setComp(c);
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [otId, showAlert]);

  // SONNET-5: materiales sin consumo real (excluidos del costo) — vienen de /comparativo
  const sinRealDetalle = (comp?.detalle || []).filter(m => m.real == null);
  const totalMateriales = comp?.resumen?.total_materiales ?? null;
  const conReal = totalMateriales != null ? totalMateriales - sinRealDetalle.length : null;
  const costoIncompleto = sinRealDetalle.length > 0;

  // Rentabilidad (CU-94)
  const calcular = async () => {
    const m = parseFloat(margen);
    if (!m || m <= 0) { showAlert('warning', 'Ingrese un margen válido > 0'); return; }
    try {
      const r = await API.ordenesTrabajo.rentabilidad(otId, m);
      if (r?.error) { showAlert('danger', r.error); return; }
      setRent(r);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  const { detalle, resumen, orden } = data || {};

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Costos — Orden de Trabajo <span id="ot-id">#{otId}</span></div>
          <div className="page-subtitle" id="ot-proyecto">{orden ? (orden.proyecto_codigo || '') + ' ' + (orden.proyecto_nombre || '') : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/ordenes" className="btn btn-ghost">← Órdenes de trabajo</Link>
          <Link to={`/ordenes/${otId}`} className="btn btn-ghost" id="link-detalle">Volver a detalle</Link>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* KPIs */}
      {resumen && (
        <div id="kpis" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Costo total materiales</div><div style={{ fontSize: 24, fontWeight: 700, color: 'var(--primary)' }} id="kpi-costo">{formatMoney(resumen.costo_total_materiales)}</div></div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Insumos</div><div style={{ fontSize: 24, fontWeight: 700 }} id="kpi-insumos">{resumen.total_insumos}</div></div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Estado</div><div style={{ fontSize: 14, fontWeight: 600 }} id="kpi-estado">{resumen.estado_calculo}</div></div>
          </div>
        </div>
      )}

      {/* Tabla detalle costos (CU-93) */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Desglose de costos por material</div>
        {/* SONNET-5: advertencia de costo parcial cuando faltan consumos reales */}
        {costoIncompleto && (
          <div className="alert alert-warning" style={{ marginBottom: 12 }}>
            ⚠ Costo parcial: {conReal} de {totalMateriales} materiales tienen consumo real. El costo no incluye {sinRealDetalle.length} material(es).
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th><th>Material</th><th>Unidad</th>
                <th style={{ textAlign: 'right' }}>Cantidad</th>
                <th style={{ textAlign: 'right' }}>Precio unit.</th>
                <th style={{ textAlign: 'right' }}>Costo línea</th>
                <th>Nota</th>
              </tr>
            </thead>
            <tbody id="costos-body">
              {!data && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
              {data && (!detalle || detalle.length === 0) && sinRealDetalle.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }}>Sin consumos reales registrados</td></tr>}
              {(detalle || []).map(d => (
                <tr key={d.sku}>
                  <td><code>{d.sku}</code></td>
                  <td>{d.nombre}</td>
                  <td>{d.unidad || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{formatQty(d.cantidad_real)}</td>
                  <td style={{ textAlign: 'right' }}>{d.sin_precio ? <span style={{ color: 'var(--warning)' }}>Sin precio</span> : formatMoney(d.precio_unitario)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(d.costo_linea)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{d.nota_precio}</td>
                </tr>
              ))}
              {/* SONNET-5: materiales sin consumo real — excluidos del costo, resaltados */}
              {sinRealDetalle.map(m => (
                <tr key={'sin-real-' + m.sku} style={{ background: '#FFF9DB' }}>
                  <td><code>{m.sku}</code></td>
                  <td>{m.nombre}</td>
                  <td>{m.unidad || '—'}</td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td style={{ textAlign: 'right' }}>—</td>
                  <td style={{ fontSize: 12, color: 'var(--warning)' }}>Sin consumo real registrado — no incluido en el costo</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Calculadora de rentabilidad (CU-94) */}
      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Cálculo de Rentabilidad</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 120 }}>
            <label className="form-label">Margen de utilidad (%)</label>
            <input className="form-control" type="number" id="margen" min={1} step={1} value={margen} onChange={e => setMargen(e.target.value)} />
          </div>
          <button className="btn btn-primary" id="btn-calcular" onClick={calcular}>Calcular precio sugerido</button>
        </div>
        {rent && (
          <div id="rentabilidad-result" style={{ marginTop: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
              <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo materiales</div><div style={{ fontSize: 18, fontWeight: 700 }} id="rent-costo">{formatMoney(rent.costo_materiales)}</div></div>
              <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Margen</div><div style={{ fontSize: 18, fontWeight: 700 }} id="rent-margen">{rent.margen_pct}%</div></div>
              <div style={{ padding: 12, border: '2px solid var(--primary)', borderRadius: 8, textAlign: 'center', background: 'var(--bg-alt)' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Precio sugerido</div><div style={{ fontSize: 22, fontWeight: 700, color: 'var(--primary)' }} id="rent-precio">{formatMoney(rent.precio_sugerido)}</div></div>
            </div>
            <div id="rent-advertencia" style={{ marginTop: 8 }}>
              {rent.advertencia && <div style={{ padding: 8, background: 'var(--warning-bg)', borderRadius: 6, fontSize: 12, color: 'var(--warning)' }}>{rent.advertencia}</div>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
