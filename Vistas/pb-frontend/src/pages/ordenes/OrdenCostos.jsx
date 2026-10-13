import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty, formatMoney } from '../../utils/format';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert, AvisoCerrable } from '../../components/Alert';
import NombreCorto from '../../components/NombreCorto';   // F-17

/** Costos — Orden de Trabajo — conversión 1:1 de ordenes/costos.html (?id= → /ordenes/:id/costos) */
export default function OrdenCostos() {
  usePageTitle('Costos Orden de Trabajo');
  const { id: otId } = useParams();
  const { alert, showAlert } = useAlert();

  const [data, setData] = useState(null); // { detalle, resumen, orden }
  const [comp, setComp] = useState(null); // { detalle, resumen } de /comparativo (SONNET-5)
  // F-10 (D75): margen sobre el costo de producción, reserva de negociación y costo adicional por puerta
  const [margen, setMargen] = useState('40');
  const [reserva, setReserva] = useState('0');
  const [adicional, setAdicional] = useState('');
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
    const res = reserva === '' ? 0 : parseFloat(reserva);
    const adi = adicional === '' ? 0 : parseFloat(adicional);
    if (!(m > 0 && m < 100)) { showAlert('warning', 'El margen debe ser mayor que 0 y menor que 100 %.'); return; }
    if (!(res >= 0 && res < 100)) { showAlert('warning', 'La reserva de negociación debe estar entre 0 y menos de 100 %.'); return; }
    if (!(adi >= 0)) { showAlert('warning', 'El costo adicional por puerta debe ser 0 o más.'); return; }
    try {
      const r = await API.ordenesTrabajo.rentabilidad(otId, { margen: m, reserva: res, adicional: adi });
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
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Desglose de costos por material</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          Precios netos (sin IVA): el último precio de compra de cada material; si no tiene compras, el precio referencial del proveedor.
        </div>
        {/* SONNET-5: advertencia de costo parcial cuando faltan consumos reales */}
        {costoIncompleto && (
          <AvisoCerrable className="alert alert-warning" style={{ marginBottom: 12 }}>
            ⚠ Costo parcial: {conReal} de {totalMateriales} materiales tienen consumo real. El costo no incluye {sinRealDetalle.length} material(es).
          </AvisoCerrable>
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
                  <td><NombreCorto texto={d.nombre} /></td>
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
                  <td><NombreCorto texto={m.nombre} /></td>
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
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Cálculo de Rentabilidad</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
          Como en las cotizaciones del cliente: precio = costo de producción ÷ (1 − margen), y luego ÷ (1 − reserva de negociación).
          Montos netos, sin IVA; el IVA, los descuentos y la instalación van en la cotización.
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label" htmlFor="margen">Margen de utilidad (%)</label>
            <input className="form-control" type="number" id="margen" min={1} max={99} step={1} value={margen} onChange={e => setMargen(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label" htmlFor="reserva">Reserva de negociación (%)</label>
            <input className="form-control" type="number" id="reserva" min={0} max={99} step={1} value={reserva} onChange={e => setReserva(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 200 }}>
            <label className="form-label" htmlFor="adicional" title="Mano de obra, consumibles de soldadura, pintura, armado y embalaje: lo que no sale del inventario">
              Costo adicional por puerta ($)
            </label>
            <input className="form-control" type="number" id="adicional" min={0} step={1000} placeholder="Mano de obra, consumibles, pintura, embalaje"
              value={adicional} onChange={e => setAdicional(e.target.value)} />
          </div>
          <button className="btn btn-primary" id="btn-calcular" onClick={calcular}>Calcular precio sugerido</button>
        </div>
        {rent && (
          <div id="rentabilidad-result" style={{ marginTop: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
              <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo materiales</div><div style={{ fontSize: 18, fontWeight: 700 }} id="rent-costo">{formatMoney(rent.costo_materiales)}</div></div>
              <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo adicional</div><div style={{ fontSize: 18, fontWeight: 700 }}>{formatMoney(rent.costo_adicional)}</div><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{rent.puertas} puerta{rent.puertas === 1 ? '' : 's'} × {formatMoney(rent.costo_adicional_puerta)}</div></div>
              <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Costo de producción</div><div style={{ fontSize: 18, fontWeight: 700 }}>{formatMoney(rent.costo_produccion)}</div></div>
              <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Ganancia</div><div style={{ fontSize: 18, fontWeight: 700 }} id="rent-margen">{formatMoney(rent.margen_monto)}</div></div>
              <div style={{ padding: 12, border: '2px solid var(--primary)', borderRadius: 8, textAlign: 'center', background: 'var(--bg-alt)' }}><div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Precio sugerido (neto)</div><div style={{ fontSize: 22, fontWeight: 700, color: 'var(--primary)' }} id="rent-precio">{formatMoney(rent.precio_sugerido)}</div></div>
            </div>
            <div id="rent-formula" style={{ marginTop: 10, fontSize: 13 }}>
              {formatMoney(rent.costo_produccion)} ÷ (1 − {formatQty(rent.margen_pct)} %) = {formatMoney(rent.precio_margen)}
              {rent.reserva_pct > 0 && <> ÷ (1 − {formatQty(rent.reserva_pct)} %) = <strong>{formatMoney(rent.precio_sugerido)}</strong></>}
            </div>
            <div id="rent-advertencia" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
              {(rent.advertencias || []).map(a => (
                <div key={a} style={{ padding: 8, background: 'var(--warning-bg)', borderRadius: 6, fontSize: 12, color: 'var(--warning)' }}>{a}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
