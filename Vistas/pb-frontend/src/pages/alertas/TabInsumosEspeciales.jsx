import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty } from '../../utils/format';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { overlayStyle, cancelBtnStyle } from '../../components/ConfirmDialog';
import SelectorProducto from '../../components/SelectorProducto';

/**
 * CU-122 — Insumos especiales vendidos (pestaña de Alertas → Faltantes, gerencia).
 * Al abrir, el backend revisa las ventas de Finanzas (D17) y devuelve las alertas.
 * Exc 1: descontinuado → cancelar el ítem o autorizar un reemplazo.
 * Exc 2: sin proveedor → la alerta pide identificarlo a mano.
 */

const ESTADOS = {
  activa:            { etiqueta: 'Activa',            badge: 'badge-danger' },
  en_gestion:        { etiqueta: 'En gestión',        badge: 'badge-warning' },
  solicitud_emitida: { etiqueta: 'Solicitud emitida', badge: 'badge-info' },
  resuelta:          { etiqueta: 'Resuelta',          badge: 'badge-success' },
  disponible:        { etiqueta: 'Disponible',        badge: 'badge-success' },   // CU-124: todo reservado para la venta
  descartada:        { etiqueta: 'Descartada',        badge: 'badge-gray' },
};
const badgeVenta = (e) => {
  const v = String(e || '').toLowerCase();
  return v === 'aprobada' ? 'badge-success' : ['cancelada', 'cancelado', 'anulada', 'anulado'].includes(v) ? 'badge-danger' : 'badge-gray';
};
const ddmmaaaa = (iso) => iso ? iso.split('-').reverse().join('/') : '—';
const btn = { padding: '4px 8px', fontSize: 12 };
const boxStyle = { background: 'var(--white,#fff)', borderRadius: 12, padding: 24, maxWidth: 480, width: '90%', boxShadow: '0 12px 40px rgba(0,0,0,.2)' };

export default function TabInsumosEspeciales({ esGerencia }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { alert, showAlert } = useAlert();

  const [estado, setEstado] = useState('pendientes');
  const [datos, setDatos] = useState(null);
  const [revisando, setRevisando] = useState(false);
  const [dlgReemplazo, setDlgReemplazo] = useState(null);   // { alerta, materiales, sku, motivo }
  const [dlgVincular, setDlgVincular] = useState(null);     // CU-124: { alerta, lotes, lote, cantidad, error }

  const cargar = useCallback(async (avisarRevision = false) => {
    try {
      const d = await API.alertasFaltantes.insumosEspeciales({ estado });
      setDatos(d);
      if (d.aviso) showAlert('warning', d.aviso);
      else if (avisarRevision && d.revision?.nuevas > 0) {
        showAlert('info', `La revisión de ventas encontró ${d.revision.nuevas} insumo(s) especial(es) vendido(s) sin alerta: ya se agregaron.`);
      }
    } catch (err) {
      setDatos({ alertas: [] });
      showAlert('danger', err.message || 'No se pudieron cargar las alertas de insumos especiales.');
    }
  }, [estado, showAlert]);

  // Al abrir la pestaña y al cambiar el filtro (mismo patrón que Faltantes.jsx)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(true); }, [estado]);
  const lista = datos?.alertas || null;
  const pag = usePagination(lista, 20);

  const revisar = async () => {
    setRevisando(true);
    try {
      const r = await API.alertasFaltantes.revisarInsumosEspeciales();
      showAlert(r.nuevas + r.actualizadas + r.descartadas > 0 ? 'success' : 'info', r.message);
      await cargar();
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setRevisando(false);
    }
  };

  /** Motivo de al menos 10 caracteres (mismo criterio que los faltantes de OT, CU-116). */
  const pedirMotivo = async (titulo, placeholder) => {
    while (true) {
      const m = await prompt('Ingrese el motivo (mínimo 10 caracteres):', titulo, placeholder);
      if (m === null) return null;
      if (m.trim().length >= 10) return m.trim();
      showAlert('warning', 'El motivo debe tener al menos 10 caracteres.');
    }
  };

  const cerrar = async (a, accion, titulo, placeholder) => {
    const motivo = await pedirMotivo(titulo, placeholder);
    if (!motivo) return;
    try {
      const r = await API.alertasFaltantes.resolver(a.id, { accion, motivo });
      if (r?.error) { showAlert('danger', r.error); return; }
      showAlert('success', r.message);
      cargar();
    } catch (err) { showAlert('danger', err.message); }
  };

  const solicitarCompra = async (a) => {
    if (a.sin_proveedor) {
      showAlert('warning', <>{a.material} no tiene proveedor registrado: identifíquelo y <Link to="/proveedores" style={{ fontWeight: 600, textDecoration: 'underline' }}>regístrelo</Link> antes de emitir la solicitud.</>);
      return;
    }
    const ok = await confirm(
      <>
        ¿Emitir la solicitud de compra de {formatQty(a.requerido)} {a.unidad || ''} de {a.material} a {a.proveedor} para
        la venta {a.venta}?
        {a.cubierto_con_stock && (
          <div style={{ marginTop: 10, padding: '8px 10px', background: '#FFF3CD', borderRadius: 6, color: '#856404' }}>
            <strong>⚠ Ojo: hoy hay {formatQty(a.disponible)} {a.unidad || ''} de {a.material} disponibles, que alcanzan para
            esta venta.</strong> Quizás no haga falta comprar.
          </div>
        )}
      </>,
      'Solicitud de compra'
    );
    if (!ok) return;
    try {
      const r = await API.alertasFaltantes.emitirSolicitud(a.id, { proveedor_id: a.proveedor_id });
      if (r?.error) { showAlert('danger', r.error); return; }
      showAlert('success', r.message);
      cargar();
    } catch (err) { showAlert('danger', err.message); }
  };

  const abrirReemplazo = async (a) => {
    try {
      const mats = await API.materiales.listar({ estado: 'activo' });
      setDlgReemplazo({ alerta: a, materiales: (mats || []).filter(m => m.sku !== a.sku), sku: '', motivo: '', error: '' });
    } catch (err) { showAlert('danger', err.message); }
  };
  // Los errores del reemplazo se muestran DENTRO del modal (pedido del usuario)
  const errorReemplazo = (error) => setDlgReemplazo(d => ({ ...d, error }));
  const confirmarReemplazo = async () => {
    const { alerta, sku, motivo } = dlgReemplazo;
    if (!sku) { errorReemplazo('Seleccione el material de reemplazo.'); return; }
    if (motivo.trim().length < 10) {
      errorReemplazo(`El motivo debe tener al menos 10 caracteres (lleva ${motivo.trim().length}).`); return;
    }
    try {
      const r = await API.alertasFaltantes.reemplazarInsumoEspecial(alerta.id, { sku_reemplazo: sku, motivo: motivo.trim() });
      if (r?.error) { errorReemplazo(r.error); return; }
      setDlgReemplazo(null);
      showAlert('success', r.message);
      cargar();
    } catch (err) { errorReemplazo(err.message); }
  };

  // CU-124: vincular después de la entrada, desde un lote con stock libre
  const abrirVincular = async (a) => {
    try {
      const d = await API.alertasFaltantes.lotesInsumoEspecial(a.id);
      if (d?.error) { showAlert('danger', d.error); return; }
      if (!d.lotes.length) {
        showAlert('warning', `No hay stock libre de ${a.material} para vincular: registre primero la entrada de la compra.`);
        return;
      }
      const primero = d.lotes[0];
      setDlgVincular({ alerta: a, lotes: d.lotes, lote: `${primero.lote_id}|${primero.bodega_id}`,
                       cantidad: String(Math.min(a.pendiente, primero.libre)), error: '' });
    } catch (err) { showAlert('danger', err.message); }
  };
  const confirmarVincular = async () => {
    const { alerta, lote, cantidad, lotes } = dlgVincular;
    const [loteId, bodegaId] = lote.split('|');
    const elegido = lotes.find(l => `${l.lote_id}|${l.bodega_id}` === lote);
    const c = parseFloat(cantidad);
    const err = (e) => setDlgVincular(d => ({ ...d, error: e }));
    if (!(c > 0)) { err('Ingrese una cantidad mayor a 0.'); return; }
    if (c > alerta.pendiente + 1e-9) { err(`A la venta ${alerta.venta} le faltan ${formatQty(alerta.pendiente)}.`); return; }
    if (c > elegido.libre + 1e-9) { err(`El lote ${elegido.lote} tiene ${formatQty(elegido.libre)} libres.`); return; }
    try {
      const r = await API.alertasFaltantes.vincularInsumoEspecial({
        lote_id: loteId, bodega_id: bodegaId, asignaciones: [{ alerta_id: alerta.id, cantidad: c }],
      });
      if (r?.error) { err(r.error); return; }
      setDlgVincular(null);
      showAlert('success', r.message);
      cargar();
    } catch (e) { err(e.message); }
  };

  return (
    <>
      <Alert {...alert} />

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 180 }}>
            <label className="form-label">Estado</label>
            <select className="form-control" value={estado} onChange={e => setEstado(e.target.value)}>
              {/* Coinciden con los badges de estado (comentario del usuario al probar CU-124) */}
              <option value="pendientes">Pendientes (activa, en gestión, solicitud emitida)</option>
              <option value="disponibles">Disponibles (vinculadas a su venta)</option>
              <option value="cerradas">Cerradas (resueltas o descartadas)</option>
              <option value="todas">Todas</option>
            </select>
          </div>
          <div style={{ fontSize: 12, color: 'var(--gray)', flex: 1, minWidth: 220 }}>
            Ventas no canceladas de los últimos {datos?.ventana_dias ?? 60} días con insumos especiales (sueltos o dentro de una
            puerta). Se revisan solas cada 5 minutos y al abrir esta pestaña.
          </div>
          <button className="btn btn-secondary" onClick={revisar} disabled={revisando}>
            {revisando ? 'Revisando…' : 'Revisar ventas ahora'}
          </button>
        </div>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Venta</th><th>Insumo</th>
                <th style={{ textAlign: 'right' }}>Requerido</th><th style={{ textAlign: 'right' }}>Disponible</th>
                <th>Proveedor sugerido</th><th>Entrega máx.</th><th>Comprar a más tardar</th><th>Estado</th><th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {lista === null && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Revisando ventas…</td></tr>}
              {lista !== null && lista.length === 0 && (
                <EmptyRow colSpan={9} emptyMsg={estado === 'pendientes' ? 'No hay insumos especiales vendidos pendientes de compra.' : 'Sin alertas en este filtro.'} />
              )}
              {pag.items.map(a => {
                const est = ESTADOS[a.estado] || { etiqueta: a.estado, badge: 'badge-gray' };
                return (
                  <tr key={a.id}>
                    <td style={{ fontSize: 13 }}>
                      <strong>{a.venta || '—'}</strong>
                      <div style={{ fontSize: 12, color: 'var(--gray)' }}>{a.cliente || ''}</div>
                      {a.venta_estado && <span className={'badge ' + badgeVenta(a.venta_estado)} style={{ fontSize: 10 }}>venta {a.venta_estado}</span>}
                    </td>
                    <td style={{ fontSize: 13 }}>
                      <span style={{ fontWeight: 500 }}>{a.material}</span>
                      <div className="td-mono" style={{ fontSize: 11 }}>{a.sku}</div>
                      {a.descontinuado && <span className="badge badge-danger" style={{ fontSize: 10 }}>Descontinuado</span>}
                      {a.es_rotativo && <span className="badge badge-gray" style={{ fontSize: 10, marginLeft: 4 }}>reemplazo (rotativo)</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatQty(a.requerido)} <span style={{ fontSize: 11, color: 'var(--gray)' }}>{a.unidad || ''}</span>
                      {/* CU-124: lo ya reservado para esta venta */}
                      {a.vinculado > 0 && (
                        <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--gray)' }}>vinculado {formatQty(a.vinculado)}</div>
                      )}
                      {a.en_espera_recepcion && a.abierta && (
                        <div><span className="badge badge-warning" style={{ fontSize: 10 }}>En espera de recepción: {formatQty(a.pendiente)}</span></div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatQty(a.disponible)}
                      {a.cubierto_con_stock && <div><span className="badge badge-success" style={{ fontSize: 10 }}>Cubierto con stock</span></div>}
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {a.sin_proveedor
                        ? <span className="badge badge-orange" title="Exc 2: identificar un proveedor de forma manual">Sin proveedor: identificar manualmente</span>
                        : <>{a.proveedor}{a.plazo_dias_habiles != null && <div style={{ fontSize: 11, color: 'var(--gray)' }}>{a.plazo_dias_habiles} días hábiles</div>}</>}
                    </td>
                    <td>{ddmmaaaa(a.entrega_maxima)}</td>
                    <td style={a.compra_atrasada && a.abierta ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                      {a.comprar_antes ? ddmmaaaa(a.comprar_antes) : <span style={{ color: 'var(--gray)' }} title="Falta la fecha de entrega o el plazo del proveedor">—</span>}
                      {a.compra_atrasada && a.abierta && <div style={{ fontSize: 11 }}>atrasada</div>}
                    </td>
                    <td><span className={'badge ' + est.badge}>{est.etiqueta}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* CU-124: gerencia y jop vinculan stock recibido a la venta */}
                      {a.abierta && a.pendiente > 0 && a.disponible > 0 && (
                        <button className="btn btn-ghost" style={btn} onClick={() => abrirVincular(a)}>Vincular stock</button>
                      )}
                      {esGerencia && a.abierta && a.descontinuado && (
                        <>
                          <button className="btn btn-ghost" style={btn} onClick={() => abrirReemplazo(a)}>Autorizar reemplazo</button>
                          <button className="btn btn-ghost" style={btn}
                            onClick={() => cerrar(a, 'descartada', 'Cancelar ítem especial', 'Ej: el cliente acepta quitarlo de la venta...')}>Cancelar ítem</button>
                        </>
                      )}
                      {esGerencia && a.abierta && !a.descontinuado && (
                        <>
                          {a.estado !== 'solicitud_emitida' && <button className="btn btn-ghost" style={btn} onClick={() => solicitarCompra(a)}>Solicitar compra</button>}
                          <button className="btn btn-ghost" style={btn}
                            onClick={() => cerrar(a, 'resuelta', 'Cerrar alerta', 'Ej: compra recibida, se usará stock existente...')}>Cerrar</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>

      {/* CU-124: vincular stock ya recibido a la venta */}
      {dlgVincular && (
        <div style={overlayStyle}>
          <div style={boxStyle}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Vincular stock a la venta</div>
            <div style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>
              <strong>{dlgVincular.alerta.material}</strong> para <strong>{dlgVincular.alerta.venta}</strong>
              {dlgVincular.alerta.cliente ? ` (${dlgVincular.alerta.cliente})` : ''}: faltan {formatQty(dlgVincular.alerta.pendiente)} {dlgVincular.alerta.unidad || ''}.
              El lote elegido queda reservado para esta venta.
            </div>
            <div className="form-group">
              <label className="form-label">Lote con stock libre</label>
              <select className="form-control" value={dlgVincular.lote} onChange={e => setDlgVincular({ ...dlgVincular, lote: e.target.value, error: '' })}>
                {dlgVincular.lotes.map(l => (
                  <option key={`${l.lote_id}|${l.bodega_id}`} value={`${l.lote_id}|${l.bodega_id}`}>
                    {l.lote} · {l.bodega} · ingreso {ddmmaaaa(l.ingreso)} · libre {formatQty(l.libre)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Cantidad a vincular</label>
              <input className="form-control" type="number" min={0} step="any" value={dlgVincular.cantidad}
                onChange={e => setDlgVincular({ ...dlgVincular, cantidad: e.target.value, error: '' })} />
            </div>
            {dlgVincular.error && (
              <div style={{ padding: '8px 10px', background: '#F8D7DA', borderRadius: 6, color: '#842029', fontSize: 13, marginBottom: 12 }}>
                {dlgVincular.error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={cancelBtnStyle} onClick={() => setDlgVincular(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmarVincular}>Vincular</button>
            </div>
          </div>
        </div>
      )}

      {/* Exc 1: reemplazo de un insumo descontinuado */}
      {dlgReemplazo && (
        <div style={overlayStyle}>
          <div style={boxStyle}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Autorizar reemplazo</div>
            <div style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>
              <strong>{dlgReemplazo.alerta.material}</strong> está descontinuado. Se cerrará esta alerta y se creará una para el
              reemplazo con la misma venta ({dlgReemplazo.alerta.venta}) y cantidad ({formatQty(dlgReemplazo.alerta.requerido)}).
            </div>
            <div className="form-group">
              <label className="form-label">Material de reemplazo</label>
              <SelectorProducto opciones={dlgReemplazo.materiales} value={dlgReemplazo.sku} aria-label="Material de reemplazo"
                onChange={sku => setDlgReemplazo(d => ({ ...d, sku, error: '' }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Motivo (mínimo 10 caracteres)</label>
              <textarea className="form-control" rows={2} value={dlgReemplazo.motivo}
                placeholder="Ej: el fabricante lo descontinuó; el cliente aprobó el reemplazo"
                onChange={e => setDlgReemplazo({ ...dlgReemplazo, motivo: e.target.value, error: '' })} />
              <div className="form-hint" style={{ textAlign: 'right' }}>{dlgReemplazo.motivo.trim().length}/10 mínimo</div>
            </div>
            {dlgReemplazo.error && (
              <div style={{ padding: '8px 10px', background: '#F8D7DA', borderRadius: 6, color: '#842029', fontSize: 13, marginBottom: 12 }}>
                {dlgReemplazo.error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={cancelBtnStyle} onClick={() => setDlgReemplazo(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmarReemplazo}>Autorizar reemplazo</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
