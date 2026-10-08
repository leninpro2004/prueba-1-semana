import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { useConfirm } from '../../hooks/useDialog';
import { formatQty } from '../../utils/format';
import { fechaHora } from './formatoInstalacion';

/**
 * CU-125: inicio de la carga en el transporte. Se registra el trabajador responsable (un
 * empleado activo) y el pedido pasa a "En carga". Se puede sumar otro responsable; nunca se
 * reemplaza (Exc 2). Solo con todos los insumos retirados (Exc 3, CU-126).
 * D47: del empleado se muestra el nombre (y el cargo si hay homónimos), nunca el RUT.
 */
export default function CargaTransporte({ ventaId, venta, detalle, responsables, onCambio, showAlert }) {
  const confirm = useConfirm();
  const [empleados, setEmpleados] = useState(null);
  const [rut, setRut] = useState('');
  const [guardando, setGuardando] = useState(false);

  const abierta = ['preparado', 'en_carga'].includes(venta.estado_despacho);
  const enCarga = venta.estado_despacho === 'en_carga';

  useEffect(() => {
    if (!abierta) return;
    API.pedidosVenta.empleados().then(e => setEmpleados(e || [])).catch(() => setEmpleados([]));
  }, [abierta]);

  const sinRetirar = detalle.filter(x => x.retirada < x.requerida - 1e-9);
  const repetidos = new Set((empleados || []).map(e => e.nombre).filter((n, i, a) => a.indexOf(n) !== i));
  const etiqueta = (e) => (repetidos.has(e.nombre) ? `${e.nombre} — ${e.cargo || 'sin cargo'}` : e.nombre);
  const nombreDe = (r) => (empleados || []).find(e => e.rut === r)?.nombre || 'el trabajador';
  const listaResp = (rs) => rs.map(x => x.nombre).join(', ');

  const registrar = async (sumar) => {
    if (!rut) { showAlert('warning', 'Seleccione el trabajador responsable de la carga.'); return; }
    setGuardando(true);
    try {
      let r = await API.pedidosVenta.iniciarCarga(ventaId, rut, sumar);
      // Exc 2: otra persona inició la carga mientras tanto → se muestra y se ofrece sumar
      if (r?.codigo === 'CARGA_INICIADA') {
        const ok = await confirm(
          `La carga de este pedido ya fue iniciada por: ${listaResp(r.responsables)}. ` +
          `¿Sumar a ${nombreDe(rut)} como otro responsable? No se reemplaza a nadie.`, 'Carga ya iniciada');
        if (!ok) { onCambio(); return; }
        r = await API.pedidosVenta.iniciarCarga(ventaId, rut, true);
      }
      if (r?.error) { showAlert(r.codigo === 'YA_RESPONSABLE' ? 'info' : 'danger', r.error); onCambio(); return; }
      showAlert('success', r.message);
      setRut('');
      onCambio();
    } catch (err) {
      showAlert('danger', err.message);   // Exc 1 y 3: el backend explica el motivo
    } finally {
      setGuardando(false);
    }
  };

  const disponibles = (empleados || []).filter(e => !responsables.some(x => x.nombre === e.nombre && (x.cargo || null) === (e.cargo || null)));

  return (
    <div className="card" id="carga-transporte" style={{ marginTop: 16 }}>
      <div className="section-label" style={{ marginBottom: 2 }}>Carga en transporte</div>

      {responsables.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }} id="responsables-carga">
          {responsables.map((x, i) => (
            <li key={i}>
              <strong>{x.nombre}</strong>{repetidos.has(x.nombre) && x.cargo ? ` (${x.cargo})` : ''}
              <span style={{ color: 'var(--gray)' }}> · desde {fechaHora(x.fecha)} · registró {x.registrado_por || '—'}</span>
            </li>
          ))}
        </ul>
      )}

      {!abierta && responsables.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--gray)', marginTop: 6 }}>Sin registro de carga.</div>
      )}

      {abierta && sinRetirar.length > 0 && (
        <div style={{ fontSize: 13, color: 'var(--danger)', marginTop: 8 }} id="carga-bloqueada">
          No se puede iniciar la carga: faltan por retirar {sinRetirar.map(x => `${x.nombre} (${formatQty(x.requerida - x.retirada)})`).join(', ')}.
        </div>
      )}

      {abierta && sinRetirar.length === 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
          <div>
            <label className="form-label" htmlFor="carga-empleado" style={{ marginBottom: 4 }}>
              {enCarga ? 'Sumar otro responsable' : 'Trabajador responsable de la carga'}
            </label>
            <select className="form-control" id="carga-empleado" value={rut} onChange={ev => setRut(ev.target.value)}
              disabled={empleados === null} style={{ minWidth: 240 }}>
              <option value="">{empleados === null ? 'Cargando…' : 'Seleccione...'}</option>
              {disponibles.map(e => <option key={e.rut} value={e.rut}>{etiqueta(e)}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-primary" id="btn-carga" disabled={guardando || !rut}
            onClick={() => registrar(enCarga)}>
            {enCarga ? 'Sumar responsable' : 'Iniciar carga'}
          </button>
        </div>
      )}
    </div>
  );
}
