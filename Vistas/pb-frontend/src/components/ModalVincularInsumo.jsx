import { useState } from 'react';
import { API } from '../services/api';
import { formatQty } from '../utils/format';
import { overlayStyle, cancelBtnStyle } from './ConfirmDialog';

/**
 * CU-124 — Vincular la recepción de un insumo especial a las ventas que lo esperan.
 * Se abre al registrar la entrada. Las ventas vienen por fecha límite y el reparto
 * se precarga en ese orden (Exc 3: el usuario lo cambia). Parcial = Exc 2.
 * Exc 1: sin ventas, el stock queda transitorio (el backend ya avisó a Gerencia).
 *
 * props: recepcion = { material, cantidad, movimiento_id, pendientes, mensaje }, unidad,
 *        puedeVincular (gerencia o jop), onClose(mensaje | null)
 */
const ddmmaaaa = (iso) => iso ? iso.split('-').reverse().join('/') : '—';
const redondear = (v) => Math.round(v * 1e4) / 1e4;

export default function ModalVincularInsumo({ recepcion, unidad, puedeVincular, onClose }) {
  const { material, cantidad, movimiento_id, pendientes } = recepcion;
  const [asig, setAsig] = useState(() => {
    let resto = cantidad;
    return Object.fromEntries(pendientes.map(p => {
      const c = redondear(Math.max(Math.min(p.pendiente, resto), 0));
      resto = redondear(resto - c);
      return [p.alerta_id, c > 0 ? String(c) : ''];
    }));
  });
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  const total = redondear(Object.values(asig).reduce((s, v) => s + (parseFloat(v) || 0), 0));
  const sinVentas = pendientes.length === 0;

  const vincular = async () => {
    const asignaciones = pendientes
      .map(p => ({ alerta_id: p.alerta_id, cantidad: parseFloat(asig[p.alerta_id]) || 0, p }))
      .filter(a => a.cantidad > 0);
    if (asignaciones.length === 0) { setError('Asigne una cantidad a al menos una venta, o presione "Ahora no".'); return; }
    const excedida = asignaciones.find(a => a.cantidad > a.p.pendiente + 1e-9);
    if (excedida) { setError(`A la venta ${excedida.p.venta} le faltan ${formatQty(excedida.p.pendiente)}: no se le puede asignar más.`); return; }
    if (total > cantidad + 1e-9) { setError(`Se recibieron ${formatQty(cantidad)} y se intenta asignar ${formatQty(total)}.`); return; }
    setGuardando(true);
    try {
      const r = await API.alertasFaltantes.vincularInsumoEspecial({
        movimiento_id, asignaciones: asignaciones.map(({ alerta_id, cantidad: c }) => ({ alerta_id, cantidad: c })),
      });
      if (r?.error) { setError(r.error); return; }
      onClose(r.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div style={overlayStyle}>
      <div style={{ background: 'var(--white,#fff)', borderRadius: 12, padding: 24, maxWidth: 640, width: '94%', boxShadow: '0 12px 40px rgba(0,0,0,.2)' }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Vincular a pedido — insumo especial</div>
        <div style={{ fontSize: 13, color: '#555', marginBottom: 14 }}>
          Se recibieron <strong>{formatQty(cantidad)} {unidad}</strong> de <strong>{material}</strong>.
          {!sinVentas && ' Asigne lo recibido a las ventas que lo esperan (ordenadas por fecha límite).'}
        </div>

        {sinVentas ? (
          <div style={{ padding: '10px 12px', background: '#FFF3CD', borderRadius: 6, color: '#856404', fontSize: 13, marginBottom: 14 }}>
            <strong>Ninguna venta pendiente requiere este insumo.</strong> Queda en stock transitorio y se avisó a Gerencia
            para que indique qué hacer con él.
          </div>
        ) : (
          <table className="table" style={{ fontSize: 13, marginBottom: 12 }}>
            <thead>
              <tr><th>Venta</th><th>Cliente</th><th>Fecha límite</th><th style={{ textAlign: 'right' }}>Falta</th><th style={{ width: 120 }}>Asignar</th></tr>
            </thead>
            <tbody>
              {pendientes.map(p => (
                <tr key={p.alerta_id}>
                  <td><strong>{p.venta}</strong><div style={{ fontSize: 11, color: 'var(--gray)' }}>venta {p.venta_estado}</div></td>
                  <td>{p.cliente || '—'}</td>
                  <td>{ddmmaaaa(p.entrega_maxima)}</td>
                  <td style={{ textAlign: 'right' }}>{formatQty(p.pendiente)}</td>
                  <td>
                    <input className="form-control" type="number" min={0} step="any" disabled={!puedeVincular}
                      value={asig[p.alerta_id]} onChange={e => { setAsig({ ...asig, [p.alerta_id]: e.target.value }); setError(''); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!sinVentas && (
          <div style={{ fontSize: 13, marginBottom: 12, color: total > cantidad + 1e-9 ? 'var(--danger)' : 'var(--gray)' }}>
            Asignado: <strong>{formatQty(total)}</strong> de {formatQty(cantidad)} {unidad}.
            {total < cantidad - 1e-9 && ` Lo no asignado (${formatQty(redondear(cantidad - total))}) queda como stock libre.`}
          </div>
        )}
        {!sinVentas && !puedeVincular && (
          <div style={{ padding: '8px 10px', background: '#E7F1FF', borderRadius: 6, color: '#0B5394', fontSize: 13, marginBottom: 12 }}>
            Pida a JOP o Gerencia que vincule esta recepción desde Alertas → Faltantes → Insumos especiales.
          </div>
        )}
        {error && (
          <div style={{ padding: '8px 10px', background: '#F8D7DA', borderRadius: 6, color: '#842029', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {sinVentas || !puedeVincular
            ? <button className="btn btn-primary" onClick={() => onClose(null)}>Entendido</button>
            : <>
                <button style={cancelBtnStyle} onClick={() => onClose(null)} title="Se puede vincular después desde Insumos especiales">Ahora no</button>
                <button className="btn btn-primary" onClick={vincular} disabled={guardando}>{guardando ? 'Vinculando…' : 'Vincular'}</button>
              </>}
        </div>
      </div>
    </div>
  );
}
