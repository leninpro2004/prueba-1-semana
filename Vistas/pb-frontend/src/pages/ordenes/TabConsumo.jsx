import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useConfirm } from '../../hooks/useDialog';
import { formatQty } from '../../utils/format';
import SelectorProducto from '../../components/SelectorProducto';

/**
 * R1 (docs/sprint/decisiones.md): pestaña Consumo de la OT.
 *
 * Se carga la receta (la guardada en la OT, la de su especificación o una buscada)
 * con sus materiales para N puertas; se ajustan cantidades, se agregan o quitan
 * materiales, y "Guardar consumo" registra el real y descuenta stock. Volver a guardar
 * mueve el stock solo por la diferencia (lo hace el backend).
 *  - "Según receta" = estimado (lo comparan las Desviaciones, CU-103/104).
 *  - Las pinturas no se descuentan aquí: su real sale del Seguimiento de pinturas.
 * D54: en una OT cerrada, gerencia puede "Corregir consumo": solo el real (por la diferencia, con motivo) y agregar
 * un material; sin receta, estimados ni quitar. La OT sigue cerrada.
 */

const num = (v) => Number(String(v ?? '').trim().replace(',', '.'));
const CANTIDAD_OK = /^\d+([.,]\d{1,4})?$/;
const ORIGEN = {
  ot: 'guardada en esta OT',
  especificacion: 'según la especificación de la puerta',
  elegida: 'elegida a mano',
};

/** Fila de la tabla a partir de un material ya registrado en la OT. */
const filaDeOT = (m) => {
  const registrado = m.real != null ? parseFloat(m.real) : 0;
  const estimado = m.estimado != null ? parseFloat(m.estimado) : null;
  return {
    sku: m.sku, nombre: m.nombre, unidad: m.unidad, esPintura: m.es_pintura === true,
    critico: m.es_critico, inactivo: m.estado_material !== 'activo',
    estimado, registrado, stock: m.stock_disponible != null ? parseFloat(m.stock_disponible) : null,
    real: m.real != null ? String(registrado) : estimado != null ? String(estimado) : '',
    retirosAbiertos: m.pintura_retiros_abiertos || 0,
  };
};

export default function TabConsumo({ otId, data, bodegas, abierta, puedeCorregir = false, onGuardado, showAlert }) {
  const confirm = useConfirm();
  const orden = data?.orden;
  const recetaGuardada = orden?.receta_id != null ? String(orden.receta_id) : null;

  const [recetas, setRecetas] = useState([]);         // activas, para "Buscar otra"
  const [materiales, setMateriales] = useState([]);   // activos, para "Agregar material"
  const [precarga, setPrecarga] = useState(null);     // respuesta de recetas.porOrden
  const [recetaSel, setRecetaSel] = useState('');
  const [puertas, setPuertas] = useState('1');
  const [recetaEnTabla, setRecetaEnTabla] = useState(null);   // { id, codigo, nombre, puertas }
  const [filas, setFilas] = useState(null);
  const [bodegaId, setBodegaId] = useState('');
  const [nuevoSku, setNuevoSku] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [errores, setErrores] = useState(null);
  const [corrigiendo, setCorrigiendo] = useState(false);   // D54: OT cerrada en modo corrección
  const [motivo, setMotivo] = useState('');
  const editable = abierta || corrigiendo;

  useEffect(() => {
    API.recetas.listar().then(r => setRecetas(Array.isArray(r) ? r : [])).catch(() => {});
    API.materiales.listar({ estado: 'activo' }).then(m => setMateriales(m || [])).catch(() => {});
  }, []);

  // Bodega de retiro: preelegida si hay una sola activa
  const bodegasActivas = useMemo(() => (bodegas || []).filter(b => ['activo', 'activa'].includes(b.estado)), [bodegas]);
  const bodega = bodegaId || (bodegasActivas.length === 1 ? String(bodegasActivas[0].id) : '');

  /* Estado inicial: lo guardado en la OT; si la OT está vacía, la receta precargada
     (sin guardar: el usuario ajusta y confirma con "Guardar consumo"). */
  useEffect(() => {
    if (!data) return;
    let cancelado = false;
    API.recetas.porOrden(otId).then(p => {
      if (cancelado) return;
      setPrecarga(p);
      setPuertas(String(p.puertas || 1));
      setRecetaSel(p.producto?.id ? String(p.producto.id) : '');
      const guardadas = (data.materiales || []).map(filaDeOT);
      if (guardadas.length > 0) {
        setFilas(guardadas);
        setRecetaEnTabla(recetaGuardada
          ? { id: recetaGuardada, codigo: orden.receta_codigo, nombre: orden.receta_nombre, puertas: orden.cantidad_puertas }
          : null);
      } else if (!p.motivo_sin_receta) {
        setFilas(p.materiales.map(m => ({
          sku: m.sku, nombre: m.nombre, unidad: m.unidad, esPintura: m.es_pintura === true,
          critico: m.es_critico, inactivo: m.estado_material !== 'activo',
          estimado: m.cantidad_total, registrado: 0, stock: null, real: String(m.cantidad_total),
        })));
        setRecetaEnTabla({ id: String(p.producto.id), codigo: p.producto.codigo, nombre: p.producto.nombre, puertas: p.puertas });
      } else {
        setFilas([]);
        setRecetaEnTabla(null);
      }
    }).catch(err => { if (!cancelado) showAlert('danger', 'No se pudo cargar la receta: ' + err.message); });
    return () => { cancelado = true; };
  }, [data, otId, recetaGuardada, orden, showAlert]);

  /* "Cargar en la tabla": la receta elegida para N puertas. Reemplaza los estimados; el
     real ya registrado no se toca; los agregados a mano sin real se quitan (R1). */
  const cargarReceta = useCallback(async () => {
    if (!recetaSel) { showAlert('warning', 'Elija una receta.'); return; }
    if (!/^\d+$/.test(puertas) || +puertas < 1 || +puertas > 1000) {
      showAlert('warning', 'La cantidad de puertas debe ser un número entero entre 1 y 1000.');
      return;
    }
    let p;
    try {
      p = await API.recetas.porOrden(otId, { receta_id: recetaSel, puertas });
    } catch (err) { showAlert('danger', err.message); return; }
    if (p.motivo_sin_receta) { showAlert('warning', p.motivo_sin_receta); return; }

    const tieneAlgo = (filas || []).some(f => f.estimado != null || f.registrado > 0);
    if (tieneAlgo) {
      const ok = await confirm(
        `Se reemplazarán los estimados de esta OT por los de la receta ${p.producto.codigo} para ${p.puertas} puerta(s). ` +
        'El consumo real ya registrado no se modifica hasta que pulse "Guardar consumo".', 'Cargar receta');
      if (!ok) return;
    }
    const previas = new Map((filas || []).map(f => [f.sku, f]));
    const nuevas = p.materiales.map(m => {
      const prev = previas.get(m.sku);
      return {
        sku: m.sku, nombre: m.nombre, unidad: m.unidad, esPintura: m.es_pintura === true,
        critico: m.es_critico, inactivo: m.estado_material !== 'activo',
        estimado: m.cantidad_total, registrado: prev?.registrado ?? 0, stock: prev?.stock ?? null,
        real: prev && prev.registrado > 0 ? String(prev.registrado) : String(m.cantidad_total),
      };
    });
    const enReceta = new Set(nuevas.map(n => n.sku));
    // Lo que ya tiene consumo registrado y no está en la receta queda, sin estimado
    const conReal = (filas || []).filter(f => !enReceta.has(f.sku) && f.registrado > 0).map(f => ({ ...f, estimado: null }));
    setFilas([...nuevas, ...conReal]);
    setRecetaEnTabla({ id: String(p.producto.id), codigo: p.producto.codigo, nombre: p.producto.nombre, puertas: p.puertas });
    setErrores(null);
    showAlert('info', `Receta ${p.producto.codigo} cargada en la tabla para ${p.puertas} puerta(s). Ajuste y pulse "Guardar consumo". Todavía no se guardó nada.`);
  }, [recetaSel, puertas, otId, filas, confirm, showAlert]);

  const cambiarReal = (sku, valor) => setFilas(fs => fs.map(f => (f.sku === sku ? { ...f, real: valor } : f)));
  const quitar = (sku) => setFilas(fs => fs.filter(f => f.sku !== sku));

  const agregar = () => {
    const m = materiales.find(x => x.sku === nuevoSku);
    if (!m) return;
    setFilas(fs => [...fs, {
      sku: m.sku, nombre: m.nombre, unidad: m.unidad_medida || m.unidad, esPintura: false, critico: m.es_critico,
      inactivo: false, estimado: null, registrado: 0, stock: null, real: '',
    }]);
    setNuevoSku('');
  };

  const guardar = async () => {
    const malas = filas.filter(f => !f.esPintura && !CANTIDAD_OK.test(String(f.real).trim()));
    if (malas.length) {
      showAlert('danger', `Revise el consumo real de: ${malas.map(f => f.sku).join(', ')} (número mayor o igual a 0, hasta 4 decimales).`);
      return;
    }
    // Resumen de lo que va a pasar con el stock, antes de confirmar
    const enTabla = new Set(filas.map(f => f.sku));
    const descontar = [], devolver = [];
    for (const f of filas) {
      if (f.esPintura) continue;
      const delta = num(f.real) - f.registrado;
      if (delta > 1e-9) descontar.push(`${f.sku} ${formatQty(delta)}`);
      if (delta < -1e-9) devolver.push(`${f.sku} ${formatQty(-delta)}`);
    }
    const quitados = (data?.materiales || []).filter(m => !enTabla.has(m.sku));
    for (const q of quitados) if (parseFloat(q.real || 0) > 0 && !q.es_pintura) devolver.push(`${q.sku} ${formatQty(q.real)} (se quita)`);
    const partes = [
      descontar.length && `Se descontará de bodega: ${descontar.join(', ')}.`,
      devolver.length && `Se devolverá a bodega: ${devolver.join(', ')}.`,
      quitados.length && `Se quitan de la OT: ${quitados.map(q => q.sku).join(', ')}.`,
    ].filter(Boolean);
    if (!(await confirm(partes.length ? partes.join(' ') + ' ¿Guardar?' : 'No hay cambios de stock. ¿Guardar los estimados?', 'Guardar consumo'))) return;

    const body = {
      ...(recetaEnTabla && { receta_id: Number(recetaEnTabla.id), cantidad_puertas: Number(recetaEnTabla.puertas) }),
      reemplazar_receta: !!(recetaEnTabla && recetaGuardada && recetaGuardada !== String(recetaEnTabla.id)),
      bodega_id: bodega || null,
      lineas: filas.map(f => ({ sku: f.sku, estimado: f.estimado, real: f.esPintura ? null : num(f.real) })),
    };
    setGuardando(true);
    setErrores(null);
    try {
      let r = await API.ordenesTrabajo.guardarConsumo(otId, body);
      if (r?.codigo === 'RECETA_DISTINTA') {
        if (!(await confirm(r.error, 'Reemplazar receta'))) return;
        r = await API.ordenesTrabajo.guardarConsumo(otId, { ...body, reemplazar_receta: true });
      }
      if (r?.codigo) { showAlert('danger', r.error); return; }
      showAlert('success', r.message);
      onGuardado();
    } catch (err) {
      if (err.payload?.errores?.length) setErrores(err.payload.errores);
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  /* D54: la corrección parte de lo REGISTRADO (no de la receta precargada) */
  const empezarCorreccion = () => {
    setFilas((data?.materiales || []).map(m => ({ ...filaDeOT(m), real: String(m.real != null ? parseFloat(m.real) : 0) })));
    setErrores(null);
    setMotivo('');
    setCorrigiendo(true);
  };
  const cancelarCorreccion = () => {
    setFilas((data?.materiales || []).map(filaDeOT));
    setErrores(null);
    setCorrigiendo(false);
  };

  const guardarCorreccion = async () => {
    const malas = filas.filter(f => !f.esPintura && !CANTIDAD_OK.test(String(f.real).trim()));
    if (malas.length) {
      showAlert('danger', `Revise el consumo real de: ${malas.map(f => f.sku).join(', ')} (número mayor o igual a 0, hasta 4 decimales).`);
      return;
    }
    const cambian = filas.filter(f => !f.esPintura && Math.abs(num(f.real) - f.registrado) > 1e-9);
    if (!cambian.length) { showAlert('warning', 'No hay cambios: el consumo real es igual al registrado.'); return; }
    if (!motivo.trim()) { showAlert('danger', 'Indique el motivo de la corrección.'); return; }
    const descontar = cambian.filter(f => num(f.real) > f.registrado).map(f => `${f.sku} ${formatQty(num(f.real) - f.registrado)}`);
    const devolver = cambian.filter(f => num(f.real) < f.registrado).map(f => `${f.sku} ${formatQty(f.registrado - num(f.real))}`);
    const ok = await confirm(
      [descontar.length && `Se descontará de bodega: ${descontar.join(', ')}.`,
       devolver.length && `Se devolverá a bodega: ${devolver.join(', ')}.`].filter(Boolean).join(' ') +
      ' La OT sigue cerrada; si tenía diferenciales procesados, se recalculan. ¿Guardar la corrección?',
      'Corregir consumo de OT cerrada');
    if (!ok) return;
    setGuardando(true);
    setErrores(null);
    try {
      const r = await API.ordenesTrabajo.corregirConsumo(otId, {
        lineas: cambian.map(f => ({ sku: f.sku, real: num(f.real) })), motivo: motivo.trim(), bodega_id: bodega || null,
      });
      showAlert('success', r.message);
      setCorrigiendo(false);
      onGuardado();
    } catch (err) {
      if (err.payload?.errores?.length) setErrores(err.payload.errores);
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  if (!data || filas === null) {
    return <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--gray)' }}>Cargando…</div>;
  }

  const disponibles = materiales.filter(m => !filas.some(f => f.sku === m.sku));
  // Retiro de pintura para esta OT: abre el Seguimiento con la OT y su área ya elegidas
  const retiroPintura = `/pinturas/seguimiento?ot=${otId}${orden?.area_id ? `&area=${orden.area_id}` : ''}`;
  const errorDe = (sku) => errores?.find(e => e.sku === sku)?.error;

  return (
    <div className="tab-content" id="tab-consumo">
      {data.resumen?.con_alerta_faltante > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
          ⚠ {data.resumen.con_alerta_faltante} material(es) de esta OT tienen una alerta de faltante abierta.{' '}
          <Link to="/alertas/faltantes">Ver alertas de faltantes</Link>
        </div>
      )}

      {/* Receta */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }} id="consumo-receta">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div className="section-label" style={{ marginBottom: 2 }}>Receta · área {orden?.area || '—'}</div>
            {recetaEnTabla ? (
              <div style={{ fontSize: 14 }}>
                <strong>{recetaEnTabla.codigo}</strong> — {recetaEnTabla.nombre} · {recetaEnTabla.puertas} puerta(s)
                {recetaGuardada === String(recetaEnTabla.id)
                  ? <span style={{ fontSize: 12, color: 'var(--gray)' }}> · guardada en esta OT</span>
                  : <span className="badge badge-warning" style={{ marginLeft: 6 }}>sin guardar</span>}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--gray)' }}>
                Sin receta cargada.{precarga?.motivo_sin_receta ? ' ' + precarga.motivo_sin_receta : ''}
              </div>
            )}
            {precarga?.origen && !recetaGuardada && recetaEnTabla && (
              <div style={{ fontSize: 12, color: 'var(--gray)' }}>Receta precargada {ORIGEN[precarga.origen]}.</div>
            )}
          </div>
          {abierta && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label className="form-label" htmlFor="consumo-receta-sel" style={{ marginBottom: 4 }}>Receta</label>
                <select className="form-control" id="consumo-receta-sel" value={recetaSel} onChange={e => setRecetaSel(e.target.value)}>
                  <option value="">Buscar receta...</option>
                  {recetas.map(r => <option key={r.id} value={r.id}>{r.codigo} — {r.nombre}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="consumo-puertas" style={{ marginBottom: 4 }}>Puertas</label>
                <input className="form-control" id="consumo-puertas" inputMode="numeric" style={{ width: 80 }}
                  value={puertas} onChange={e => setPuertas(e.target.value.trim())} />
              </div>
              <button type="button" className="btn btn-secondary" id="btn-cargar-receta" onClick={cargarReceta}>Cargar en la tabla</button>
            </div>
          )}
        </div>
      </div>

      {/* Materiales */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table" id="tabla-consumo">
            <thead>
              <tr>
                <th>Material</th>
                <th style={{ textAlign: 'right' }}>Según receta</th>
                <th style={{ textAlign: 'right', width: 150 }}>Consumo real</th>
                <th style={{ textAlign: 'right' }}>Ya registrado</th>
                <th style={{ textAlign: 'right' }} title="Consumo real menos según receta">Diferencia</th>
                <th style={{ textAlign: 'right' }}>Stock disp.</th>
                {abierta && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {filas.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 28, color: 'var(--gray)' }}>
                  Esta OT no tiene materiales. Cargue una receta o agregue materiales a mano.
                </td></tr>
              )}
              {filas.map(f => {
                const real = f.esPintura ? f.registrado : num(f.real);
                const valido = f.esPintura || CANTIDAD_OK.test(String(f.real).trim());
                const delta = valido && !f.esPintura ? real - f.registrado : 0;
                // Una pintura sin pesajes todavía no tiene consumo: sin diferencia
                const dif = valido && f.estimado != null && !(f.esPintura && f.registrado === 0) ? real - f.estimado : null;
                const error = errorDe(f.sku);
                return (
                  <tr key={f.sku} style={f.inactivo ? { background: '#FDECEA' } : undefined}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{f.nombre}</div>
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                        <code>{f.sku}</code>{f.unidad ? ` · ${f.unidad}` : ''}
                        {f.critico && <> <span className="badge badge-danger" style={{ fontSize: 10 }}>Crítico</span></>}
                        {f.inactivo && <> <span className="badge badge-gray" style={{ fontSize: 10 }}>Inactivo</span></>}
                        {f.estimado == null && <> <span className="badge badge-info" style={{ fontSize: 10 }}>agregado a mano</span></>}
                      </div>
                      {error && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{f.estimado != null ? formatQty(f.estimado) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {f.esPintura ? (
                        <span style={{ fontSize: 12, color: 'var(--gray)' }} title="Las pinturas se descuentan al registrar su pesaje">
                          {f.registrado > 0 ? <strong style={{ color: 'initial' }}>{formatQty(f.registrado)}</strong> : '—'}
                          <div><Link to={retiroPintura}>Seguimiento de pinturas</Link></div>
                          {f.retirosAbiertos > 0 && <div style={{ color: 'var(--warning)' }}>{f.retirosAbiertos} envase(s) sin devolver</div>}
                        </span>
                      ) : editable ? (
                        <>
                          <input className="form-control" inputMode="decimal" aria-label={`Consumo real de ${f.sku}`}
                            style={{ width: 110, marginLeft: 'auto', textAlign: 'right', borderColor: valido ? undefined : 'var(--danger)' }}
                            value={f.real} onChange={e => cambiarReal(f.sku, e.target.value)} />
                          {Math.abs(delta) > 1e-9 && (
                            <div style={{ fontSize: 11, color: delta > 0 ? 'var(--danger)' : 'var(--success)' }}>
                              {delta > 0 ? `descuenta ${formatQty(delta)}` : `devuelve ${formatQty(-delta)}`}
                            </div>
                          )}
                        </>
                      ) : formatQty(real)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{f.registrado > 0 ? formatQty(f.registrado) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {dif != null && Math.abs(dif) > 1e-9
                        ? <span className={`badge badge-${dif > 0 ? 'danger' : 'success'}`}>{dif > 0 ? '+' : ''}{formatQty(dif)}</span>
                        : dif != null ? '0' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--gray)' }}>{f.stock != null ? formatQty(f.stock) : '—'}</td>
                    {abierta && (
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" title={f.registrado > 0 ? 'Quitar y devolver a bodega lo registrado' : 'Quitar de la OT'}
                          disabled={f.esPintura && f.registrado > 0} onClick={() => quitar(f.sku)}>✕</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {abierta && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label className="form-label" htmlFor="consumo-agregar" style={{ marginBottom: 4 }}>Agregar material</label>
                <div style={{ minWidth: 280 }}>
                  <SelectorProducto id="consumo-agregar" opciones={disponibles} value={nuevoSku} onChange={setNuevoSku} />
                </div>
              </div>
              <button type="button" className="btn btn-secondary" id="btn-agregar-material" onClick={agregar} disabled={!nuevoSku}>+ Agregar</button>
              <Link to={retiroPintura} className="btn btn-ghost" id="btn-retiro-pintura"
                title="Las pinturas se descuentan por pesaje en el Seguimiento de pinturas">Registrar retiro de pintura</Link>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label className="form-label" htmlFor="consumo-bodega" style={{ marginBottom: 4 }}>Bodega de retiro</label>
                <select className="form-control" id="consumo-bodega" value={bodega} onChange={e => setBodegaId(e.target.value)}>
                  <option value="">Automática (la única con stock)</option>
                  {bodegasActivas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
                </select>
              </div>
              <button type="button" className="btn btn-primary" id="btn-guardar-consumo" onClick={guardar} disabled={guardando || (filas.length === 0 && !(data.materiales || []).length)}>
                {guardando ? 'Guardando...' : 'Guardar consumo'}
              </button>
            </div>
          </div>
        )}

        {/* D54: OT cerrada, solo gerencia */}
        {!abierta && puedeCorregir && !corrigiendo && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" id="btn-corregir-consumo" onClick={empezarCorreccion}
              title="Corrige el consumo real registrado (por la diferencia, con motivo). La OT sigue cerrada.">
              Corregir consumo (OT cerrada)
            </button>
          </div>
        )}
        {!abierta && corrigiendo && (
          <div style={{ marginTop: 12 }} id="correccion-consumo">
            <div className="alert alert-warning" style={{ fontSize: 13, marginBottom: 12 }}>
              Corrección de una OT cerrada: ajuste el consumo real o agregue un material que se usó y no se registró (para
              quitarlo, deje su real en 0). El stock se mueve por la diferencia y la OT sigue cerrada. Las pinturas se
              corrigen desde el Seguimiento de pinturas.
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <label className="form-label" htmlFor="correccion-agregar" style={{ marginBottom: 4 }}>Agregar material</label>
                  <div style={{ minWidth: 280 }}>
                    <SelectorProducto id="correccion-agregar" opciones={disponibles} value={nuevoSku} onChange={setNuevoSku} />
                  </div>
                </div>
                <button type="button" className="btn btn-secondary" onClick={agregar} disabled={!nuevoSku}>+ Agregar</button>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <label className="form-label" htmlFor="correccion-bodega" style={{ marginBottom: 4 }}>Bodega de retiro</label>
                  <select className="form-control" id="correccion-bodega" value={bodega} onChange={e => setBodegaId(e.target.value)}>
                    <option value="">Automática (la única con stock)</option>
                    {bodegasActivas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label" htmlFor="correccion-motivo" style={{ marginBottom: 4 }}>Motivo (obligatorio)</label>
                  <input className="form-control" id="correccion-motivo" style={{ minWidth: 260 }} maxLength={255}
                    placeholder="Ej: se registró mal la cantidad usada" value={motivo} onChange={e => setMotivo(e.target.value)} />
                </div>
                <button type="button" className="btn btn-ghost" onClick={cancelarCorreccion} disabled={guardando}>Cancelar</button>
                <button type="button" className="btn btn-primary" id="btn-guardar-correccion" onClick={guardarCorreccion} disabled={guardando}>
                  {guardando ? 'Guardando...' : 'Guardar corrección'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
