import { useState } from 'react';
import { API } from '../../services/api';
import { useConfirm } from '../../hooks/useDialog';
import { formatQty } from '../../utils/format';
import { fechaHora } from './formatoInstalacion';

/**
 * CU-127: confirmación de carga y salida del transporte. Con la carga iniciada (CU-125) se
 * confirma que todo subió al camión: el pedido pasa a "En tránsito", se descuenta el stock
 * de los lotes reservados (salida definitiva, motivo despacho_venta) y las reservas se
 * liberan en la misma operación (D20). Después queda en solo lectura con lo que salió.
 */
export default function SalidaTransporte({ ventaId, venta, detalle, responsables, despacho, onCambio, showAlert }) {
  const confirm = useConfirm();
  const [observacion, setObservacion] = useState('');
  const [guardando, setGuardando] = useState(false);

  const enCarga = venta.estado_despacho === 'en_carga';

  const despachar = async () => {
    const ok = await confirm(
      `Se confirmará que todo el material del pedido ${venta.numero} subió al transporte. El pedido pasará a "En tránsito" ` +
      `y se descontará definitivamente del stock: ${detalle.map(x => `${x.nombre} ${formatQty(x.requerida)}`).join(', ')}. ` +
      'Esta acción no se deshace desde aquí. ¿Continuar?', 'Confirmar salida');
    if (!ok) return;
    setGuardando(true);
    try {
      const r = await API.pedidosVenta.despachar(ventaId, observacion.trim());
      if (r?.codigo === 'YA_DESPACHADO') {
        showAlert('info', `${r.error} Despachado el ${fechaHora(r.fecha_despacho)} por ${r.despachado_por || '—'}.`);
      } else if (r?.error) {
        showAlert('danger', r.error);
      } else {
        showAlert('success', r.message);
        setObservacion('');
      }
      onCambio();
    } catch (err) {
      showAlert('danger', err.message);   // Exc 1 e inconsistencias: el backend explica el motivo
    } finally {
      setGuardando(false);
    }
  };

  if (despacho) {
    return (
      <div className="card" id="salida-transporte" style={{ marginTop: 16 }}>
        <div className="section-label" style={{ marginBottom: 2 }}>Salida del transporte</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          Despachado el <strong>{fechaHora(despacho.fecha)}</strong> por {despacho.usuario || '—'}.
          {despacho.observacion && <div style={{ color: 'var(--gray)' }}>Observación: {despacho.observacion}</div>}
        </div>
        {despacho.movimientos.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table id="tabla-salidas">
              <thead>
                <tr><th>Movimiento</th><th>Insumo</th><th>Bodega</th><th>Lote</th><th style={{ textAlign: 'right' }}>Cantidad</th></tr>
              </thead>
              <tbody>
                {despacho.movimientos.map(m => (
                  <tr key={m.id}>
                    <td>#{m.id}</td>
                    <td>{m.nombre} <code style={{ fontSize: 11 }}>{m.sku}</code></td>
                    <td>{m.bodega || '—'}</td>
                    <td>{m.lote || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(m.cantidad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  if (!enCarga) return null;

  return (
    <div className="card" id="salida-transporte" style={{ marginTop: 16 }}>
      <div className="section-label" style={{ marginBottom: 2 }}>Salida del transporte</div>
      <div style={{ fontSize: 12, color: 'var(--gray)' }}>
        Carga a cargo de {responsables.map(x => x.nombre).join(', ') || '—'}. Al confirmar, el pedido queda "En tránsito"
        y el stock se descuenta de forma definitiva.
      </div>
      <div style={{ marginTop: 10 }}>
        <label className="form-label" htmlFor="salida-observacion" style={{ marginBottom: 4 }}>Observaciones del despacho (opcional)</label>
        <textarea className="form-control" id="salida-observacion" rows={2} maxLength={1000}
          placeholder="Ej: patente del camión, conductor, bultos" value={observacion} onChange={ev => setObservacion(ev.target.value)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="btn btn-primary" id="btn-salida" onClick={despachar} disabled={guardando}>
          {guardando ? 'Confirmando...' : 'Confirmar salida'}
        </button>
      </div>
    </div>
  );
}
