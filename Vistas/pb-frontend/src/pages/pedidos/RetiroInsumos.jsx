import { useState } from 'react';
import { API } from '../../services/api';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { formatQty } from '../../utils/format';
import { fechaHora } from './formatoInstalacion';

/**
 * CU-126: retiro de insumos (picking) de un pedido preparado. Por insumo (D46): se muestra
 * dónde está cada lote reservado (bodega · anaquel · lote; D58: puede haber más de una
 * bodega) y se marca lo que se sacó.
 * Retirar menos que lo pendiente es un retiro parcial (Exc 3: alerta de faltante); si el
 * insumo no está donde dice el sistema se reporta (Exc 1: alerta de ubicación). El retiro
 * no mueve stock: se descuenta al despachar (CU-127).
 * D51: mientras el pedido no salga ("preparado" o "en carga"), lo retirado se puede devolver a bodega: el insumo
 * vuelve a quedar pendiente de retiro (paso previo a volver el pedido a "vinculado").
 */

const CANTIDAD_OK = /^\d+([.,]\d{1,4})?$/;
const num = (v) => Number(String(v ?? '').trim().replace(',', '.'));
const r4 = (x) => Math.round(x * 10000) / 10000;

function estadoRetiro(x) {
  if (x.retirada >= x.requerida - 1e-9) return { texto: 'Retirado', badge: 'badge-success' };
  if (x.retirada > 0) return { texto: 'Parcial', badge: 'badge-warning' };
  return { texto: 'Pendiente', badge: 'badge-gray' };
}

export default function RetiroInsumos({ ventaId, venta, detalle, onCambio, showAlert }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [cantidades, setCantidades] = useState({});   // sku -> texto; sin valor = lo pendiente
  const [ocupado, setOcupado] = useState(null);       // sku en curso

  const abierto = venta.estado_despacho === 'preparado';
  const devolvible = ['preparado', 'en_carga'].includes(venta.estado_despacho);   // D51
  const completos = detalle.filter(x => x.retirada >= x.requerida - 1e-9).length;

  /** Respuestas que llegan como datos (409): Exc 2 y pedido ya en carga. */
  const conflicto = (r) => {
    if (r?.codigo === 'YA_RETIRADO') {
      showAlert('info', `${r.error} Lo retiró ${r.retirado_por || '—'} el ${fechaHora(r.fecha_retiro)}.`);
      return true;
    }
    if (r?.error) { showAlert('danger', r.error); return true; }
    return false;
  };

  const retirar = async (x) => {
    const pendiente = r4(x.requerida - x.retirada);
    const txt = String(cantidades[x.sku] ?? pendiente).trim();
    const cant = num(txt);
    if (!CANTIDAD_OK.test(txt) || cant <= 0) { showAlert('danger', `Revise la cantidad de ${x.nombre}: mayor que 0, hasta 4 decimales.`); return; }
    if (cant > pendiente + 1e-9) { showAlert('danger', `No puede retirar más de lo pendiente de ${x.nombre} (${formatQty(pendiente)}).`); return; }
    if (cant < pendiente - 1e-9 && !(await confirm(
      `Se registrará un retiro parcial de ${x.nombre}: ${formatQty(cant)} de ${formatQty(pendiente)} pendiente(s). ` +
      `Faltarán ${formatQty(r4(pendiente - cant))}: se generará una alerta de faltante para su reposición y se avisará a gerencia. ¿Continuar?`,
      'Retiro parcial'))) return;

    setOcupado(x.sku);
    try {
      const r = await API.pedidosVenta.retirar(ventaId, x.sku, cant);
      if (!conflicto(r)) showAlert(r.parcial ? 'warning' : 'success', r.message);
      setCantidades(c => { const n = { ...c }; delete n[x.sku]; return n; });
      onCambio();
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setOcupado(null);
    }
  };

  const reportar = async (x) => {
    const obs = await prompt(
      `${x.nombre} no está en la ubicación indicada. Se generará una alerta de ubicación incorrecta y se avisará a gerencia; ` +
      'el insumo seguirá pendiente de retiro. Describa lo que encontró (opcional):',
      'No está en la ubicación', 'Ej: el estante está vacío');
    if (obs === null) return;
    setOcupado(x.sku);
    try {
      const r = await API.pedidosVenta.reportarUbicacion(ventaId, x.sku, obs);
      if (!conflicto(r)) showAlert('warning', r.message);
      onCambio();
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setOcupado(null);
    }
  };

  const devolver = async (x) => {
    if (!(await confirm(
      `Se registrará que lo retirado de ${x.nombre} (${formatQty(x.retirada)}) volvió a su ubicación. ` +
      'El insumo queda pendiente de retiro; el stock y la reserva no cambian. ¿Continuar?', 'Devolver a bodega'))) return;
    setOcupado(x.sku);
    try {
      const r = await API.pedidosVenta.devolver(ventaId, x.sku);
      if (!conflicto(r)) showAlert('success', r.message);
      onCambio();
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="card" id="retiro-insumos" style={{ marginTop: 16 }}>
      <div className="section-label" style={{ marginBottom: 2 }}>Retiro de insumos (picking)</div>
      <div style={{ fontSize: 12, color: 'var(--gray)' }}>
        Retire cada insumo de su ubicación y márquelo. El stock se descuenta al confirmar la salida del transporte.
      </div>
      <div style={{ marginTop: 8, fontSize: 13, color: completos === detalle.length ? 'var(--success)' : 'var(--danger)' }} id="progreso-retiro">
        Retiro: {completos} de {detalle.length} insumo(s) retirado(s) completo(s)
      </div>

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table id="tabla-retiro">
          <thead>
            <tr>
              <th>Insumo</th>
              <th>Ubicación</th>
              <th style={{ textAlign: 'right' }}>Requerida</th>
              <th style={{ textAlign: 'right' }}>Retirada</th>
              <th>Estado</th>
              {devolvible && <th style={{ width: 300 }}>{abierto ? 'Retirar' : 'Devolver'}</th>}
            </tr>
          </thead>
          <tbody>
            {detalle.map(x => {
              const e = estadoRetiro(x);
              const pendiente = r4(x.requerida - x.retirada);
              const completo = pendiente <= 1e-9;
              // D58: reservado en varias bodegas → cada lote dice la suya
              const variasBodegas = new Set((x.lotes || []).map(l => l.bodega_id)).size > 1;
              return (
                <tr key={x.sku}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{x.nombre}</div>
                    <div style={{ fontSize: 11, color: 'var(--gray)' }}><code>{x.sku}</code>{x.unidad ? ` · ${x.unidad}` : ''}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {!variasBodegas && <div style={{ fontWeight: 500 }}>{x.lotes?.[0]?.bodega || x.bodega}</div>}
                    {(x.lotes || []).map((l, i) => (
                      <div key={i} style={{ color: 'var(--gray)' }}>
                        {variasBodegas && <strong style={{ color: 'var(--black)'}}>{l.bodega} · </strong>}
                        {l.anaquel || 'Sin anaquel'} · lote {l.lote} · {formatQty(l.cantidad)}
                      </div>
                    ))}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatQty(x.requerida)}</td>
                  <td style={{ textAlign: 'right' }}>{x.retirada > 0 ? formatQty(x.retirada) : '—'}</td>
                  <td>
                    <span className={'badge ' + e.badge}>{e.texto}</span>
                    {x.fecha_retiro && (
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>{x.retirado_por || '—'} · {fechaHora(x.fecha_retiro)}</div>
                    )}
                  </td>
                  {devolvible && (
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        {abierto && !completo && (
                          <>
                            <input className="form-control" inputMode="decimal" aria-label={`Cantidad a retirar de ${x.sku}`}
                              style={{ width: 80, textAlign: 'right' }}
                              value={cantidades[x.sku] ?? String(pendiente)}
                              onChange={ev => setCantidades(c => ({ ...c, [x.sku]: ev.target.value }))} />
                            <button type="button" className="btn btn-primary btn-sm" disabled={ocupado !== null}
                              onClick={() => retirar(x)}>Marcar retirado</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={ocupado !== null}
                              onClick={() => reportar(x)} title="Genera una alerta de ubicación incorrecta">No está en la ubicación</button>
                          </>
                        )}
                        {x.retirada > 0 && (
                          <button type="button" className="btn btn-ghost btn-sm" disabled={ocupado !== null}
                            onClick={() => devolver(x)} title="Lo retirado vuelve a su ubicación (D51)">Devolver a bodega</button>
                        )}
                        {!(abierto && !completo) && !(x.retirada > 0) && <span style={{ fontSize: 12, color: 'var(--gray)' }}>—</span>}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
