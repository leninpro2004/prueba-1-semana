import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { useAuth } from '../../hooks/useAuth';
import Alert, { useAlert } from '../../components/Alert';
import { formatQty } from '../../utils/format';
import { estadoDespacho, fechaCorta, fechaHora, ventaCancelada } from './formatoInstalacion';
import RetiroInsumos from './RetiroInsumos';
import CargaTransporte from './CargaTransporte';
import SalidaTransporte from './SalidaTransporte';
import SelectorProducto from '../../components/SelectorProducto';

/**
 * CU-120: vincular insumos de instalación a una venta (D44).
 * Se sugieren los insumos del área Instalación de las recetas de sus puertas (Exc 1: si no
 * hay, se cargan a mano); se ajustan cantidades y "Vincular" reserva por FIFO. Cada insumo
 * se reserva de SU bodega principal (D45), preelegida: la que alcanza para cubrirlo o, si
 * ninguna alcanza sola, la de más stock; lo que falte se completa desde las demás bodegas
 * (D58). Sin stock suficiente en ninguna la vinculación queda parcial (Exc 2).
 * Si ya está vinculada se muestra y se modifica (Exc 3): el backend ajusta por la diferencia.
 * D51 (solo gerencia): un pedido "preparado" o "en carga" vuelve a "vinculado" (con motivo, sin nada retirado), y el
 * de una venta cancelada se cancela liberando todas sus reservas.
 */

const CANTIDAD_OK = /^\d+([.,]\d{1,4})?$/;
const num = (v) => Number(String(v ?? '').trim().replace(',', '.'));
const clave = (sku, bodega) => `${sku}|${bodega}`;

/** Bodega sugerida para un insumo: la que alcanza (la de más stock entre ellas) o la de más stock. */
function bodegaSugerida(sku, cantidad, bodegas, stock) {
  const opciones = bodegas.map(b => ({ id: String(b.id), disp: stock.get(clave(sku, String(b.id))) || 0 }))
    .filter(o => o.disp > 0)
    .sort((a, b) => b.disp - a.disp);
  if (!opciones.length) return '';
  return (opciones.find(o => o.disp >= cantidad) || opciones[0]).id;
}

export default function PedidoInstalacionDetalle() {
  usePageTitle('Pedido de instalación');
  const { id } = useParams();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();

  const [d, setD] = useState(null);
  const [filas, setFilas] = useState([]);
  const [bodegas, setBodegas] = useState(null);
  const [stock, setStock] = useState(new Map());      // `${sku}|${bodega}` -> disponible
  const [materiales, setMateriales] = useState([]);
  const [nuevoSku, setNuevoSku] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState(null);
  const [recarga, setRecarga] = useState(0);         // se incrementa para volver a consultar
  const cargar = useCallback(() => setRecarga(n => n + 1), []);

  useEffect(() => {
    API.bodegas.listar().then(b => setBodegas((b || []).filter(x => ['activo', 'activa'].includes(x.estado)))).catch(() => setBodegas([]));
    API.materiales.listar({ estado: 'activo' }).then(m => setMateriales(m || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (bodegas === null) return;
    let cancelado = false;
    API.pedidosVenta.obtener(id).then(r => {
      if (cancelado) return;
      const st = new Map(r.stock.map(s => [clave(s.sku, String(s.bodega_id)), s.disponible]));
      const sug = new Map(r.sugerencia.map(s => [s.sku, s]));
      setD(r);
      setStock(st);
      setFilas(r.detalle.length
        ? r.detalle.map(x => ({ sku: x.sku, nombre: x.nombre, unidad: x.unidad, sugerido: sug.get(x.sku)?.cantidad ?? null,
                                cantidad: String(x.requerida), origen: x.origen, reservado: x.reservado, lotes: x.lotes || [],
                                bodega: String(x.bodega_id), bodegaGuardada: String(x.bodega_id) }))
        : r.sugerencia.map(s => ({ sku: s.sku, nombre: s.nombre, unidad: s.unidad, sugerido: s.cantidad,
                                   cantidad: String(s.cantidad), origen: 'receta', reservado: 0, lotes: [],
                                   bodega: bodegaSugerida(s.sku, s.cantidad, bodegas, st), bodegaGuardada: null })));
      setErrores(null);
    }).catch(err => { if (!cancelado) showAlert('danger', 'Error cargando el pedido: ' + err.message); });
    return () => { cancelado = true; };
  }, [id, recarga, bodegas, showAlert]);

  if (!d || bodegas === null) {
    return <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--gray)' }}>Cargando…<Alert {...alert} /></div>;
  }

  const { venta, editable } = d;
  const e = estadoDespacho(venta.estado_despacho);
  // CU-119: el checklist de preparación = insumos vinculados reservados completos
  const completos = d.detalle.filter(x => x.reservado >= x.requerida - 1e-9).length;
  const preparado = [...d.historial].reverse().find(h => h.estado === 'preparado');
  const puedePreparar = venta.estado_despacho === 'vinculado' && venta.vinculable;
  // CU-127: despachado, las reservas ya se liberaron (el stock salió): no hay faltantes que mostrar. D51: cancelado, igual
  const despachado = ['en_transito', 'cancelado'].includes(venta.estado_despacho);
  // D51 (solo gerencia)
  const esGerencia = user?.rol === 'gerencia';
  const cancelada = ventaCancelada(venta.estado_pedido);
  const enCurso = ['preparado', 'en_carga'].includes(venta.estado_despacho);
  const hayRetirado = d.detalle.some(x => x.retirada > 0);

  /** Respuestas 409 que llegan como datos: se informan y se recarga. */
  const resultado = (r, tipo = 'success') => {
    showAlert(r?.error ? 'danger' : tipo, r?.error || r?.message);
    cargar();
  };

  const deshacer = async () => {
    const motivo = await prompt(
      `El pedido ${venta.numero} volverá a "Vinculado": se podrá modificar la vinculación o liberar sus reservas, y habrá ` +
      'que volver a prepararlo, retirarlo y cargarlo. Las reservas no cambian. Indique el motivo:',
      'Volver a vinculado', 'Ej: el cliente cambió la fecha de instalación');
    if (motivo === null) return;
    if (!motivo.trim()) { showAlert('danger', 'Indique el motivo para volver el pedido a "Vinculado".'); return; }
    setGuardando(true);
    try {
      resultado(await API.pedidosVenta.deshacerPreparado(id, motivo.trim()));
    } catch (err) {
      showAlert('danger', err.message);   // 400: material retirado sin devolver
    } finally {
      setGuardando(false);
    }
  };

  const cancelarPedido = async () => {
    const motivo = await prompt(
      `La venta ${venta.numero} está cancelada. Se liberarán TODAS sus reservas (las de este pedido y las de materiales ` +
      'sueltos) y el pedido quedará "Cancelado". No se puede deshacer. Motivo (opcional):',
      'Cancelar pedido', 'Venta cancelada');
    if (motivo === null) return;
    setGuardando(true);
    try {
      resultado(await API.pedidosVenta.cancelar(id, motivo.trim()));
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  const marcarPreparado = async () => {
    if (!(await confirm(
      `Se marcará el pedido ${venta.numero} como "Preparado para despacho". Sus insumos quedan bloqueados para la salida: ` +
      'ya no se podrá modificar la vinculación ni liberar sus reservas. ¿Continuar?', 'Preparado para despacho'))) return;
    setGuardando(true);
    try {
      const r = await API.pedidosVenta.preparar(id);
      // Exc 3: ya estaba preparado
      if (r?.codigo === 'YA_PREPARADO') {
        showAlert('info', `${r.error} Preparado el ${fechaHora(r.fecha_preparado)} por ${r.preparado_por || '—'}.`);
      } else {
        showAlert('success', r.message);
      }
      cargar();
    } catch (err) {
      showAlert('danger', err.message);   // Exc 1 y 2: el backend detalla los faltantes
    } finally {
      setGuardando(false);
    }
  };
  const disponibles = materiales.filter(m => !filas.some(f => f.sku === m.sku));
  const errorDe = (sku) => errores?.find(x => x.sku === sku)?.error;
  const nombreBodega = (bid) => bodegas.find(b => String(b.id) === String(bid))?.nombre || `bodega #${bid}`;

  /** Lo que el insumo puede tener reservado en una bodega: lo libre + lo que ya reservó ahí. */
  const enBodega = (f, bid) => (stock.get(clave(f.sku, String(bid))) || 0)
    + f.lotes.filter(l => String(l.bodega_id) === String(bid)).reduce((s, l) => s + l.cantidad, 0);
  /** D58: lo que alcanza sumando todas las bodegas activas. */
  const alcanza = (f) => (f.bodega ? bodegas.reduce((s, b) => s + enBodega(f, b.id), 0) : null);
  /** D58: reparto previsto de `cant`: la principal primero y el resto desde las de más stock. */
  const reparto = (f, cant) => {
    const orden = [String(f.bodega), ...bodegas.map(b => String(b.id)).filter(id => id !== String(f.bodega))
      .sort((a, b) => enBodega(f, b) - enBodega(f, a))];
    const partes = [];
    let resta = cant;
    for (const bid of orden) {
      if (resta <= 1e-9) break;
      const x = Math.min(resta, enBodega(f, bid));
      if (x > 1e-9) { partes.push({ nombre: nombreBodega(bid), cantidad: x }); resta -= x; }
    }
    return partes;
  };
  const textoReparto = (partes) => partes.map(p => `${formatQty(p.cantidad)} en ${p.nombre}`).join(' + ');
  /** Opciones de bodega: las que tienen stock del insumo (o todas, si ninguna tiene). */
  const opcionesBodega = (f) => {
    const conStock = bodegas.filter(b => enBodega(f, b.id) > 1e-9 || String(b.id) === String(f.bodega));
    return conStock.some(b => enBodega(f, b.id) > 1e-9) ? conStock : bodegas;
  };

  const cambiar = (sku, campo, valor) => setFilas(fs => fs.map(x => (x.sku === sku ? { ...x, [campo]: valor } : x)));

  const agregar = async () => {
    const m = materiales.find(x => x.sku === nuevoSku);
    if (!m) return;
    setNuevoSku('');
    // El stock por bodega del insumo agregado no vino en la carga: se consulta
    let st = stock;
    try {
      const det = await API.materiales.obtener(m.sku);
      st = new Map(stock);
      for (const s of det?.stock_por_bodega || []) {
        st.set(clave(m.sku, String(s.bodega_id)), parseFloat(s.cantidad_fisica || 0) - parseFloat(s.cantidad_reservada || 0));
      }
      setStock(st);
    } catch { /* sin stock conocido: se elige la bodega a mano */ }
    setFilas(fs => [...fs, { sku: m.sku, nombre: m.nombre, unidad: m.unidad_medida || m.unidad, sugerido: null,
                             cantidad: '', origen: 'manual', reservado: 0, lotes: [],
                             bodega: bodegaSugerida(m.sku, 0, bodegas, st), bodegaGuardada: null }]);
  };

  const vincular = async () => {
    if (filas.length === 0) { showAlert('warning', 'Agregue al menos un insumo.'); return; }
    const malas = filas.filter(f => !CANTIDAD_OK.test(String(f.cantidad).trim()) || num(f.cantidad) <= 0);
    if (malas.length) { showAlert('danger', `Revise la cantidad de: ${malas.map(f => f.sku).join(', ')} (mayor que 0, hasta 4 decimales).`); return; }
    const sinBodega = filas.filter(f => !f.bodega);
    if (sinBodega.length) { showAlert('danger', `Elija la bodega de: ${sinBodega.map(f => f.sku).join(', ')}.`); return; }

    const porBodega = {};
    for (const f of filas) (porBodega[nombreBodega(f.bodega)] ||= []).push(f.sku);
    // D58: los que la principal no cubre se completan desde otras bodegas
    const repartidos = filas.map(f => ({ f, partes: reparto(f, num(f.cantidad)) })).filter(x => x.partes.length > 1);
    const faltan = filas.filter(f => num(f.cantidad) > alcanza(f) + 1e-9);
    const ok = await confirm(
      'Se reservará por orden de llegada (FIFO): ' +
      Object.entries(porBodega).map(([b, skus]) => `${skus.join(', ')} en ${b}`).join('; ') + '.' +
      (repartidos.length ? ` Se completan desde otras bodegas: ${repartidos.map(x => `${x.f.sku} (${textoReparto(x.partes)})`).join('; ')}.` : '') +
      (faltan.length ? ` ${faltan.map(f => `${f.sku} (faltan ${formatQty(num(f.cantidad) - alcanza(f))})`).join(', ')} no alcanza(n) ni sumando todas las bodegas: la vinculación quedará parcial.` : '') +
      ' ¿Continuar?',
      venta.preparacion_id ? 'Guardar cambios' : 'Vincular insumos');
    if (!ok) return;

    setGuardando(true);
    try {
      const r = await API.pedidosVenta.vincular(id, {
        lineas: filas.map(f => ({ sku: f.sku, cantidad: num(f.cantidad), origen: f.origen, bodega_id: Number(f.bodega) })),
      });
      if (r?.codigo) { showAlert('danger', r.error); return; }
      showAlert(r.parcial ? 'warning' : 'success', r.message);
      cargar();
    } catch (err) {
      if (err.payload?.errores?.length) setErrores(err.payload.errores);
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Pedido de instalación · {venta.numero}</div>
          <div className="page-subtitle">
            {venta.cliente || '—'} · venta "{venta.estado_pedido}" · entrega {fechaCorta(venta.fecha_max_entrega)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {venta.preparacion_id && (
            <Link to={`/instalacion/trazabilidad?q=${encodeURIComponent(venta.numero)}`} className="btn btn-secondary">Ver trazabilidad</Link>
          )}
          <Link to="/instalacion" className="btn btn-ghost">← Pedidos de instalación</Link>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>
      {d.aviso && <Alert type="warning" message={d.aviso} />}
      {/* D51: qué hacer con el pedido de una venta cancelada */}
      {cancelada && ['vinculado', 'preparado', 'en_carga'].includes(venta.estado_despacho) && (
        <Alert type="danger" message={venta.estado_despacho === 'vinculado'
          ? 'La venta fue cancelada: sus reservas siguen apartando stock. Gerencia puede cancelar el pedido para liberarlas.'
          : 'La venta fue cancelada: devuelva a bodega lo retirado y vuelva el pedido a "Vinculado"; después gerencia puede cancelarlo y liberar sus reservas.'} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="section-label">Despacho</div>
          <div style={{ margin: '6px 0' }}><span className={'badge ' + e.badge}>{e.texto}</span></div>
          {venta.preparacion_id ? (
            <div style={{ fontSize: 13, color: 'var(--gray)' }}>
              Vinculado el {fechaHora(venta.fecha_vinculacion)} por {venta.vinculado_por || '—'}
              {preparado && <div>Preparado para despacho el {fechaHora(preparado.fecha)} por {preparado.usuario || '—'}</div>}
              {d.historial.length > 2 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {d.historial.map((h, i) => (
                    <li key={i}>
                      {h.estado === 'vinculado' && i > 0 ? 'Vuelto a vinculado' : estadoDespacho(h.estado).texto}: {fechaHora(h.fecha)} · {h.usuario || '—'}
                    </li>
                  ))}
                </ul>
              )}
              {/* CU-119: checklist de preparación */}
              {d.detalle.length > 0 && !despachado && (
                <div style={{ marginTop: 8, color: completos === d.detalle.length ? 'var(--success)' : 'var(--danger)' }} id="checklist-preparacion">
                  Checklist de preparación: {completos} de {d.detalle.length} insumo(s) reservado(s) completo(s)
                </div>
              )}
              {puedePreparar && (
                <button type="button" className="btn btn-primary" id="btn-preparado" style={{ marginTop: 10 }}
                  onClick={marcarPreparado} disabled={guardando}
                  title={completos < d.detalle.length ? 'Hay insumos con faltante: resuélvalos antes de marcar el pedido' : undefined}>
                  Marcar como preparado para despacho
                </button>
              )}
              {/* D51: solo gerencia */}
              {esGerencia && (enCurso || (cancelada && venta.estado_despacho === 'vinculado')) && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {enCurso && (
                    <button type="button" className="btn btn-secondary" id="btn-deshacer" onClick={deshacer} disabled={guardando || hayRetirado}
                      title={hayRetirado ? 'Primero devuelva a bodega lo retirado (en el retiro de insumos)' : undefined}>
                      Volver a vinculado
                    </button>
                  )}
                  {cancelada && venta.estado_despacho === 'vinculado' && (
                    <button type="button" className="btn btn-danger" id="btn-cancelar-pedido" onClick={cancelarPedido} disabled={guardando}>
                      Liberar reservas y cancelar el pedido
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : <div style={{ fontSize: 13, color: 'var(--gray)' }}>Todavía no se vinculan insumos.</div>}
        </div>
        <div className="card">
          <div className="section-label">Ítems de la venta</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {d.items.map(i => (
              <li key={i.id}>
                {formatQty(i.cantidad)} × {i.descripcion}
                {i.receta && <> · <code>{i.receta}</code></>}
                {i.requiere_instalacion && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 10 }}>instalación</span>}
                {i.sku && <span style={{ color: 'var(--gray)' }}> · material suelto (reservas de venta, CU-131)</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card" id="insumos-instalacion">
        <div className="section-label" style={{ marginBottom: 2 }}>Insumos de instalación</div>
        <div style={{ fontSize: 12, color: 'var(--gray)' }}>
          Sugeridos desde el área Instalación de las recetas de las puertas que requieren instalación (cantidad × (1 + merma) × puertas).
          Cada insumo se reserva primero de la bodega de su fila (viene elegida la que alcanza para cubrirlo);
          si no alcanza, el resto se completa desde las demás bodegas.
        </div>

        {d.motivo_sin_plantilla && filas.length === 0 && (
          <Alert type="info" message={d.motivo_sin_plantilla} style={{ marginTop: 12, marginBottom: 0 }} />
        )}

        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table id="tabla-insumos-instalacion">
            <thead>
              <tr>
                <th>Insumo</th>
                <th style={{ textAlign: 'right' }}>Sugerido</th>
                <th style={{ textAlign: 'right', width: 130 }}>A reservar</th>
                <th style={{ width: 180 }}>Bodega</th>
                <th style={{ textAlign: 'right' }}>Alcanza</th>
                <th style={{ textAlign: 'right' }}>Reservado</th>
                <th style={{ textAlign: 'right' }}>Faltante</th>
                {editable && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {filas.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--gray)', padding: 20 }}>Sin insumos. Agréguelos abajo.</td></tr>
              )}
              {filas.map(f => {
                const cant = num(f.cantidad);
                const valido = CANTIDAD_OK.test(String(f.cantidad).trim()) && cant > 0;
                const max = alcanza(f);
                const faltante = despachado ? 0
                  : !editable ? Math.max(0, cant - f.reservado)
                  : valido && max != null ? Math.max(0, cant - max) : null;
                // D58: en edición, el reparto previsto; guardado, dónde quedó reservado
                const partes = editable
                  ? (valido ? reparto(f, cant) : [])
                  : Object.values(f.lotes.reduce((acc, l) => {
                      (acc[l.bodega_id] ||= { nombre: l.bodega, cantidad: 0 }).cantidad += l.cantidad;
                      return acc;
                    }, {}));
                return (
                  <tr key={f.sku}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{f.nombre}</div>
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                        <code>{f.sku}</code>{f.unidad ? ` · ${f.unidad}` : ''}
                        {f.origen === 'manual' && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 10 }}>agregado a mano</span>}
                        {f.lotes.length > 0 && ` · lotes: ${f.lotes.map(l => `${l.lote} (${formatQty(l.cantidad)})` +
                          (new Set(f.lotes.map(x => x.bodega_id)).size > 1 ? ` en ${l.bodega}` : '')).join(', ')}`}
                      </div>
                      {errorDe(f.sku) && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{errorDe(f.sku)}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{f.sugerido != null ? formatQty(f.sugerido) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {editable ? (
                        <input className="form-control" inputMode="decimal" aria-label={`Cantidad de ${f.sku}`}
                          style={{ width: 100, marginLeft: 'auto', textAlign: 'right', borderColor: valido || f.cantidad === '' ? undefined : 'var(--danger)' }}
                          value={f.cantidad} onChange={ev => cambiar(f.sku, 'cantidad', ev.target.value)} />
                      ) : formatQty(cant)}
                    </td>
                    <td>
                      {editable ? (
                        <select className="form-control" aria-label={`Bodega de ${f.sku}`} value={f.bodega} style={{ minWidth: 190 }}
                          onChange={ev => cambiar(f.sku, 'bodega', ev.target.value)}>
                          <option value="">Seleccione...</option>
                          {opcionesBodega(f).map(b => (
                            <option key={b.id} value={b.id}>{b.nombre} — {formatQty(enBodega(f, b.id))} disp.</option>
                          ))}
                        </select>
                      ) : nombreBodega(f.bodega)}
                      {partes.length > 1 && (
                        <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                          {editable ? 'Se completa: ' : 'Reservado: '}{textoReparto(partes)}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--gray)' }}>{max != null ? formatQty(max) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {despachado ? (venta.estado_despacho === 'cancelado'
                          ? <span className="badge badge-gray" style={{ fontSize: 10 }}>liberado</span>
                          : <span className="badge badge-orange" style={{ fontSize: 10 }}>despachado</span>)
                        : f.reservado > 0 ? formatQty(f.reservado) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {faltante == null ? '—' : faltante > 1e-9
                        ? <span className="badge badge-danger">{formatQty(faltante)}</span>
                        : <span className="badge badge-success">0</span>}
                    </td>
                    {editable && (
                      <td><button type="button" className="btn btn-ghost btn-sm" title="Quitar del pedido (libera lo reservado)"
                        onClick={() => setFilas(fs => fs.filter(x => x.sku !== f.sku))}>✕</button></td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {editable && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label className="form-label" htmlFor="inst-agregar" style={{ marginBottom: 4 }}>Agregar insumo</label>
                <div style={{ minWidth: 280 }}>
                  <SelectorProducto id="inst-agregar" opciones={disponibles} value={nuevoSku} onChange={setNuevoSku} />
                </div>
              </div>
              <button type="button" className="btn btn-secondary" onClick={agregar} disabled={!nuevoSku}>+ Agregar</button>
            </div>
            <button type="button" className="btn btn-primary" id="btn-vincular" onClick={vincular} disabled={guardando}>
              {guardando ? 'Guardando...' : venta.preparacion_id ? 'Guardar cambios' : 'Vincular insumos'}
            </button>
          </div>
        )}
      </div>

      {/* CU-126: desde "preparado" (después queda en solo lectura) */}
      {['preparado', 'en_carga', 'en_transito'].includes(venta.estado_despacho) && d.detalle.length > 0 && (
        <RetiroInsumos ventaId={id} venta={venta} detalle={d.detalle} onCambio={cargar} showAlert={showAlert} />
      )}
      {/* CU-125 */}
      {['preparado', 'en_carga', 'en_transito'].includes(venta.estado_despacho) && d.detalle.length > 0 && (
        <CargaTransporte ventaId={id} venta={venta} detalle={d.detalle} responsables={d.responsables_carga || []}
          onCambio={cargar} showAlert={showAlert} />
      )}
      {/* CU-127 */}
      {['en_carga', 'en_transito'].includes(venta.estado_despacho) && (
        <SalidaTransporte ventaId={id} venta={venta} detalle={d.detalle} responsables={d.responsables_carga || []}
          despacho={d.despacho} onCambio={cargar} showAlert={showAlert} />
      )}
    </>
  );
}
