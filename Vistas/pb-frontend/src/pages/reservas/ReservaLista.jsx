import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty } from '../../utils/format';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { useAuth } from '../../hooks/useAuth';

/**
 * Reservas de Stock — conversión 1:1 de reservas/lista.html.
 * CU-132: venta asociada (y su estado), filtro por venta, quién la creó, motivo al liberar o
 * anular (D48), y bloqueo de las reservas comprometidas en el despacho (Exc 3). Solo gerencia
 * y jop gestionan.
 */
export default function ReservaLista() {
  usePageTitle('Gestión de Reservas');
  const { alert, showAlert } = useAlert();
  const { user } = useAuth();
  const puedeGestionar = ['gerencia', 'jop'].includes(user?.rol);

  const [estado, setEstado] = useState('activa');
  const [buscar, setBuscar] = useState('');
  const [venta, setVenta] = useState('');
  const [reservas, setReservas] = useState(null); // null = Cargando…
  const [soloCumplidas, setSoloCumplidas] = useState(false);
  const [accionPendiente, setAccionPendiente] = useState(null); // { id, tipo, sku, cantidad }
  const [motivo, setMotivo] = useState('');

  const cargarReservas = useCallback(async () => {
    try {
      const data = await API.reservas.listar({ estado, buscar: buscar.trim(), venta: venta.trim() });
      if (data?.error) { showAlert('danger', data.error); return; }
      setReservas(Array.isArray(data) ? data : []);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [estado, buscar, venta, showAlert]);

  // Carga inicial y al cambiar el select de estado; el buscador requiere Enter o el botón "Filtrar"
  useEffect(() => { cargarReservas(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [estado]);

  const confirmarAccion = (id, tipo, sku, cantidad) => { setMotivo(''); setAccionPendiente({ id, tipo, sku, cantidad }); };
  const cerrarModal = () => setAccionPendiente(null);

  const aceptar = async () => {
    if (!accionPendiente) return;
    const { id, tipo } = accionPendiente;
    const m = motivo.trim();
    setAccionPendiente(null);
    try {
      const resp = tipo === 'liberar' ? await API.reservas.liberar(id, m) : await API.reservas.anular(id, m);
      if (resp?.error) {
        showAlert('danger', resp.error);
      } else {
        showAlert('success', resp?.message);
        cargarReservas();
      }
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  const verbo = accionPendiente?.tipo === 'liberar' ? 'liberar' : 'anular';

  /* `cumplida` lo calcula el backend: reserva activa cuyo consumo real en la OT ya
     alcanzo lo apartado. Es stock retenido sin motivo. */
  const todas = reservas || [];
  const cumplidas = todas.filter(r => r.cumplida);
  const unidadesRetenidas = cumplidas.reduce((a, r) => a + parseFloat(r.cantidad || 0), 0);
  const visibles = soloCumplidas ? cumplidas : todas;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Reservas de Stock</div>
          <div className="page-subtitle">Gestión y liberación de reservas vinculadas a pedidos</div>
        </div>
        {/* CU-131: reservar material suelto de una venta aprobada (gerencia y jop) */}
        {['gerencia', 'jop'].includes(user?.rol) && (
          <Link to="/reservas/venta" className="btn btn-primary">Reservar para venta</Link>
        )}
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Filtros */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
            <label className="form-label">Estado</label>
            <select className="form-control" id="filter-estado" value={estado}
              onChange={e => { setEstado(e.target.value); setSoloCumplidas(false); }}>
              <option value="">Todos</option>
              <option value="activa">Activas</option>
              <option value="liberada">Liberadas</option>
              <option value="anulada">Anuladas</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 200 }}>
            <label className="form-label">Buscar (SKU / nombre)</label>
            <input className="form-control" id="filter-buscar" placeholder="Buscar…" value={buscar} onChange={e => setBuscar(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') cargarReservas(); }} />
          </div>
          {/* CU-132: filtro por venta asociada */}
          <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
            <label className="form-label">Venta</label>
            <input className="form-control" id="filter-venta" placeholder="Ej: NV-PRUEBA-INV-02" value={venta} onChange={e => setVenta(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') cargarReservas(); }} />
          </div>
          <button className="btn btn-primary" id="btn-filtrar" onClick={cargarReservas}>Filtrar</button>
        </div>
      </div>

      {/* Reservas que ya cumplieron su funcion: la OT consumio lo que tenia apartado.
          Registrar el consumo NO libera la reserva, asi que sin este aviso el stock
          queda apartado indefinidamente y el disponible se ve mas bajo de lo real. */}
      {cumplidas.length > 0 && (
        <div className="card card-sm" style={{ marginBottom: 16, borderLeft: '4px solid var(--warning)' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontWeight: 600 }}>
                {cumplidas.length} reserva(s) ya cumplieron su función
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                La orden de trabajo ya consumió el material que tenían apartado. Liberarlas devuelve{' '}
                <strong>{formatQty(unidadesRetenidas)}</strong> unidad(es) al stock disponible.
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" id="btn-ver-cumplidas"
              onClick={() => { setEstado('activa'); setSoloCumplidas(true); }}>
              Ver solo esas
            </button>
          </div>
        </div>
      )}

      {/* Tabla */}
      <div className="card">
        {soloCumplidas && (
          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            Mostrando solo las reservas ya consumidas.{' '}
            <button className="btn btn-ghost btn-sm" onClick={() => setSoloCumplidas(false)}>Ver todas</button>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>SKU</th>
                <th>Material</th>
                <th style={{ textAlign: 'right' }}>Cantidad</th>
                <th>Unidad</th>
                <th>OT</th>
                <th>Asociada a</th>
                <th>Fecha reserva</th>
                <th>Creada por</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {reservas === null && (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando…</td></tr>
              )}
              {reservas !== null && visibles.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
                  {soloCumplidas
                    ? <>No quedan reservas por liberar: todas las que ya se consumieron fueron liberadas.{' '}
                        <button className="btn btn-ghost btn-sm" onClick={() => setSoloCumplidas(false)}>Ver todas</button></>
                    // CU-132 Exc 2
                    : 'No hay reservas con esos filtros. Pruebe cambiando el estado, la venta o la búsqueda.'}
                </td></tr>
              )}
              {reservas !== null && visibles.map(r => {
                const esActiva = r.estado === 'activa';
                const badgeClass = r.estado === 'activa' ? 'badge-warning'
                                 : r.estado === 'liberada' ? 'badge-success'
                                 : 'badge-ghost';
                return (
                  <tr key={r.id} style={r.cumplida ? { background: 'rgba(255,193,7,0.12)' } : undefined}>
                    <td>{r.id}</td>
                    <td><code>{r.sku}</code></td>
                    <td>
                      {r.material_nombre}
                      {r.es_critico && <> <span className="badge badge-danger" style={{ fontSize: 10 }}>Crítico</span></>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatQty(r.cantidad)}</td>
                    <td>{r.unidad || '—'}</td>
                    <td>{r.orden_id ? <Link to={`/ordenes/${r.orden_id}`}>#{r.orden_id}</Link> : '—'}</td>
                    <td>
                      {r.proyecto_codigo ? r.proyecto_codigo + ' ' + (r.proyecto_nombre || '')
                        // CU-124: reserva de un insumo especial para una venta, en su lote
                        : r.venta ? <>Venta {r.venta}{r.lote && <div style={{ fontSize: 11, color: 'var(--gray)' }}>lote {r.lote}</div>}</>
                        : '—'}
                    </td>
                    <td>{new Date(r.fecha_reserva).toLocaleDateString('sv-SE')}</td>
                    <td>{r.creada_por || '—'}</td>
                    <td>
                      <span className={`badge ${badgeClass}`}>{r.estado}</span>
                      {/* CU-132: la venta se canceló → la reserva puede liberarse */}
                      {esActiva && r.venta_cancelada && (
                        <div style={{ marginTop: 4 }}>
                          <span className="badge badge-danger" style={{ fontSize: 10 }}
                            title={`La venta ${r.venta} está "${r.venta_estado}": el material ya no tiene a quién entregarse.`}>venta cancelada</span>
                        </div>
                      )}
                      {r.cumplida && (
                        <div style={{ marginTop: 4 }}>
                          <span className="badge badge-warning" style={{ fontSize: 10 }}
                            title={`La OT #${r.orden_id} ya consumió ${formatQty(r.consumo_real)} de este material. La reserva se puede liberar.`}>
                            ya consumida
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      {esActiva ? (
                        r.comprometida ? (
                          // CU-132 Exc 3: el material ya está comprometido en el despacho del pedido
                          <span style={{ fontSize: 11, color: 'var(--gray)' }}>
                            Comprometida en el despacho de {r.venta} ({r.estado_despacho})
                          </span>
                        ) : puedeGestionar ? (
                          <>
                            <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }}
                              onClick={() => confirmarAccion(r.id, 'liberar', r.sku, r.cantidad)}>Liberar</button>
                            {' '}
                            <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--danger)' }}
                              onClick={() => confirmarAccion(r.id, 'anular', r.sku, r.cantidad)}>Anular</button>
                          </>
                        ) : '—'
                      ) : (
                        <div style={{ fontSize: 12 }}>
                          {r.fecha_liberacion ? new Date(r.fecha_liberacion).toLocaleDateString('sv-SE') : '—'}
                          {r.cerrada_por && <div style={{ color: 'var(--gray)' }}>por {r.cerrada_por}</div>}
                          {r.motivo && <div style={{ color: 'var(--gray)' }} title={r.motivo}>Motivo: {r.motivo}</div>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal confirmación */}
      {accionPendiente && (
        <div className="modal-overlay" id="modal-confirmar" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <div className="modal-title" id="modal-titulo">{accionPendiente.tipo === 'liberar' ? 'Liberar reserva' : 'Anular reserva'}</div>
              <button className="modal-close" id="modal-cerrar" onClick={cerrarModal}>×</button>
            </div>
            <div className="modal-body">
              <p id="modal-mensaje">
                {`¿Confirma que desea ${verbo} la reserva #${accionPendiente.id} de ${accionPendiente.cantidad} unidades de ${accionPendiente.sku}? `}
                {accionPendiente.tipo === 'liberar' ? 'El stock reservado volverá a estar disponible.' : 'Esta acción no se puede deshacer.'}
              </p>
              {/* CU-132: motivo opcional, queda registrado con el usuario (D48) */}
              <label className="form-label" htmlFor="modal-motivo" style={{ marginTop: 8 }}>Motivo (opcional)</label>
              <textarea className="form-control" id="modal-motivo" rows={2} maxLength={500} value={motivo}
                onChange={e => setMotivo(e.target.value)} placeholder="Ej: la venta se canceló" />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn btn-ghost" id="modal-cancelar" onClick={cerrarModal}>Cancelar</button>
                <button className="btn btn-primary" id="modal-aceptar" onClick={aceptar}>Confirmar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
