import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import { useConfirm } from '../../hooks/useDialog';
import Alert, { useAlert } from '../../components/Alert';
import { formatQty } from '../../utils/format';

/**
 * CU-131: reservar stock para una venta aprobada. Solo el material suelto de la venta
 * (líneas con SKU, D16); las puertas van por OT y por el pedido de instalación (CU-120).
 * Se reserva lo PENDIENTE de cada línea (D49): lo pedido menos lo ya reservado para esa venta.
 * Sin stock suficiente se puede reservar lo disponible (parcial) o cancelar (Exc 2).
 */

const fechaCorta = (v) => {
  if (!v) return '—';
  const [a, m, d] = String(v).slice(0, 10).split('-');
  return `${d}-${m}-${a}`;
};

export default function ReservarVenta() {
  usePageTitle('Reservar para venta');
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const [ventas, setVentas] = useState(null);
  const [ventaId, setVentaId] = useState('');
  const [preview, setPreview] = useState(null);
  const [guardando, setGuardando] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const recargar = useCallback(() => setRecarga(n => n + 1), []);

  useEffect(() => {
    let cancelado = false;
    API.reservas.ventas()
      .then(v => { if (!cancelado) setVentas(Array.isArray(v) ? v : []); })
      .catch(err => { if (!cancelado) { setVentas([]); showAlert('danger', 'Error cargando las ventas: ' + err.message); } });
    return () => { cancelado = true; };
  }, [recarga, showAlert]);

  useEffect(() => {
    if (!ventaId) return;
    let cancelado = false;
    API.reservas.ventaPreview(ventaId)
      .then(p => { if (!cancelado) setPreview(p); })
      .catch(err => { if (!cancelado) showAlert('danger', err.message); });
    return () => { cancelado = true; };
  }, [ventaId, recarga, showAlert]);

  // "Ver" abre la venta; sobre la venta abierta la cierra (sin esto, el tercer clic no volvía a consultar)
  const elegir = (id) => { setPreview(null); setVentaId(v => (v === id ? '' : id)); };

  const reservar = async () => {
    const reservables = preview.lineas.filter(l => !l.problema && l.pendiente > 0);
    if (!(await confirm(
      `Se reservará para la venta ${preview.venta.numero}: ${reservables.map(l => `${l.nombre} ${formatQty(Math.min(l.pendiente, l.disponible))}`).join(', ')}. ` +
      'El stock reservado deja de estar disponible para otras ventas y órdenes de trabajo. ¿Continuar?', 'Reservar para venta'))) return;

    setGuardando(true);
    try {
      let r = await API.reservas.reservarVenta(ventaId);
      // Exc 2: no alcanza → reservar lo disponible o cancelar
      if (r?.codigo === 'STOCK_INSUFICIENTE') {
        const ok = await confirm(
          `Stock insuficiente: ${r.insuficientes.map(x => `${x.nombre}: pendiente ${formatQty(x.pendiente)}, disponible ${formatQty(x.disponible)}`).join('; ')}. ` +
          '¿Registrar una reserva parcial con lo disponible? Lo que falte podrá reservarse cuando llegue stock.', 'Reserva parcial');
        if (!ok) { showAlert('info', 'Operación cancelada: no se reservó nada.'); return; }
        r = await API.reservas.reservarVenta(ventaId, true);
      }
      if (r?.error) { showAlert(r.codigo === 'YA_RESERVADA' ? 'info' : 'danger', r.error); recargar(); return; }
      showAlert(r.parcial || r.omitidas?.length ? 'warning' : 'success', r.message);
      recargar();
    } catch (err) {
      showAlert('danger', err.message);   // Exc 3: venta no aprobada
    } finally {
      setGuardando(false);
    }
  };

  const reservables = preview ? preview.lineas.filter(l => !l.problema && l.pendiente > 0) : [];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Reservar para venta</div>
          <div className="page-subtitle">Material suelto de ventas aprobadas (CU-131). Las puertas se reservan por OT y por el pedido de instalación.</div>
        </div>
        <Link to="/reservas" className="btn btn-ghost">← Reservas</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div className="card">
        <div className="section-label">Ventas aprobadas</div>
        <div style={{ fontSize: 12, color: 'var(--gray)' }}>
          Se muestran solo las ventas aprobadas: una venta pendiente, en borrador o cancelada no se reserva.
        </div>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table id="tabla-ventas-reservables">
            <thead>
              <tr><th>Venta</th><th>Cliente</th><th>Entrega</th><th>Materiales</th><th>Reserva</th><th /></tr>
            </thead>
            <tbody>
              {ventas === null ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--gray)' }}>Cargando…</td></tr>
              ) : ventas.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--gray)' }}>No hay ventas aprobadas con material suelto.</td></tr>
              ) : ventas.map(v => (
                <tr key={v.id} style={String(v.id) === String(ventaId) ? { background: 'var(--bg-hover, #f5f7fa)' } : undefined}>
                  <td style={{ fontWeight: 500 }}>{v.numero}</td>
                  <td>{v.cliente || '—'}</td>
                  <td>{fechaCorta(v.fecha_max_entrega)}</td>
                  <td>{v.lineas}</td>
                  <td>
                    {v.reservada_completa
                      ? <span className="badge badge-success">Reservada</span>
                      : <span className="badge badge-warning">{v.pendientes} pendiente(s)</span>}
                  </td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => elegir(String(v.id))}>
                      {String(v.id) === ventaId ? 'Ocultar' : 'Ver'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {preview && (
        <div className="card" id="reserva-venta" style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 2 }}>Venta {preview.venta.numero}</div>
          <div style={{ fontSize: 12, color: 'var(--gray)' }}>
            {preview.venta.cliente || '—'} · venta "{preview.venta.estado_pedido}". El disponible ya descuenta lo reservado para otras ventas y OT.
          </div>
          {!preview.aprobada && (
            <Alert type="warning" message={`La venta está "${preview.venta.estado_pedido}": solo se reservan ventas aprobadas.`} style={{ marginTop: 10 }} />
          )}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table id="tabla-lineas-venta">
              <thead>
                <tr>
                  <th>Material</th>
                  <th style={{ textAlign: 'right' }}>Pedido</th>
                  <th style={{ textAlign: 'right' }}>Ya reservado</th>
                  <th style={{ textAlign: 'right' }}>Pendiente</th>
                  <th style={{ textAlign: 'right' }}>Disponible</th>
                  <th>Situación</th>
                </tr>
              </thead>
              <tbody>
                {preview.lineas.map(l => (
                  <tr key={l.sku}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{l.nombre || l.sku}</div>
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}><code>{l.sku}</code>{l.unidad ? ` · ${l.unidad}` : ''}</div>
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatQty(l.pedida)}</td>
                    <td style={{ textAlign: 'right' }}>{l.reservada > 0 ? formatQty(l.reservada) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(l.pendiente)}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(l.disponible)}</td>
                    <td>
                      {l.problema ? <span className="badge badge-danger">{l.problema}</span>
                        : l.pendiente <= 0 ? <span className="badge badge-success">Reservado</span>
                          : l.faltante > 0 ? <span className="badge badge-warning">Faltan {formatQty(l.faltante)}</span>
                            : <span className="badge badge-info">Alcanza</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn btn-primary" id="btn-reservar-venta"
              onClick={reservar} disabled={guardando || !preview.aprobada || reservables.length === 0}
              title={reservables.length === 0 ? 'No queda nada pendiente que reservar' : undefined}>
              {guardando ? 'Reservando…' : 'Reservar'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
