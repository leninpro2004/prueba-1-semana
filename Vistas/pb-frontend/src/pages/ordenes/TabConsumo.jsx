import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { formatQty } from '../../utils/format';
import { esProyectoDePrueba } from '../../utils/proyectos';
import SelectorProducto from '../../components/SelectorProducto';
import { AvisoCerrable } from '../../components/Alert';
import NombreCorto from '../../components/NombreCorto';   // F-17

/**
 * R1 (docs/incremento-3-4/decisiones.md): pestaña Consumo de la OT.
 *
 * Se carga la receta (la guardada en la OT, la de su especificación o una buscada)
 * con sus materiales para N puertas; se ajustan cantidades, se agregan o quitan
 * materiales, y "Guardar consumo" registra el real y descuenta stock. Volver a guardar
 * mueve el stock solo por la diferencia (lo hace el backend).
 *  - "Según receta" = estimado (lo comparan las Desviaciones, CU-103/104).
 *  - Las pinturas no se descuentan aquí: su real sale del Seguimiento de pinturas.
 * D54: en una OT cerrada, gerencia puede "Corregir consumo": solo el real (por la diferencia, con motivo) y agregar
 * un material; sin receta, estimados ni quitar. La OT sigue cerrada.
 * F-05: en una OT abierta, cambiar un real YA guardado (consumo extra o menor) pide el motivo en la fila, y quitar
 * un material con consumo lo pide en un diálogo. El primer registro no lo pide.
 * F-08 (D74): bloque "Medidas" de la puerta. Las líneas de la receta por fórmula se calculan con ellas;
 * sin medidas llegan sin cantidad ("falta medida") y no se guardan hasta cargarlas o escribir el real.
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
  const prompt = usePrompt();
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
  const [recargaPrecarga, setRecargaPrecarga] = useState(0);   // F-08: al guardar medidas se vuelve a precargar
  const editable = abierta || corrigiendo;

  useEffect(() => {
    API.recetas.listar().then(r => setRecetas(Array.isArray(r) ? r : [])).catch(() => {});
    API.materiales.listar({ estado: 'activo' }).then(m => setMateriales(m || [])).catch(() => {});
  }, []);

  // Bodega de retiro: preelegida si hay una sola activa
  const bodegasActivas = useMemo(() => (bodegas || []).filter(b => ['activo', 'activa'].includes(b.estado)), [bodegas]);
  // F-05: materiales con un consumo real ya guardado en la OT (según el backend)
  const conRealGuardado = useMemo(
    () => new Set((data?.materiales || []).filter(m => m.real != null).map(m => m.sku)), [data]);
  /** El real de la fila cambia lo ya guardado: consumo extra o menor, pide motivo. */
  const pideMotivo = (f) => abierta && !f.esPintura && conRealGuardado.has(f.sku)
    && CANTIDAD_OK.test(String(f.real).trim()) && Math.abs(num(f.real) - f.registrado) > 1e-9;
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
          estimado: m.cantidad_total, registrado: 0, stock: null,
          real: m.cantidad_total == null ? '' : String(m.cantidad_total), faltaMedida: m.falta_medida || null,
        })));
        setRecetaEnTabla({ id: String(p.producto.id), codigo: p.producto.codigo, nombre: p.producto.nombre, puertas: p.puertas });
      } else {
        setFilas([]);
        setRecetaEnTabla(null);
      }
    }).catch(err => { if (!cancelado) showAlert('danger', 'No se pudo cargar la receta: ' + err.message); });
    return () => { cancelado = true; };
  }, [data, otId, recetaGuardada, orden, showAlert, recargaPrecarga]);

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
        real: prev && prev.registrado > 0 ? String(prev.registrado) : m.cantidad_total == null ? '' : String(m.cantidad_total),
        faltaMedida: m.falta_medida || null,
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
  const cambiarMotivo = (sku, valor) => setFilas(fs => fs.map(f => (f.sku === sku ? { ...f, motivo: valor } : f)));
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
    const sinMotivo = filas.filter(f => pideMotivo(f) && !String(f.motivo || '').trim());
    if (sinMotivo.length) {
      showAlert('danger', `Indique el motivo del cambio de: ${sinMotivo.map(f => f.sku).join(', ')}. Ya tenían un consumo registrado.`);
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

    // F-05: quitar un material que tenía consumo devuelve stock y pide el motivo
    let motivoQuitar = '';
    const quitadosConConsumo = quitados.filter(q => parseFloat(q.real || 0) > 0 && !q.es_pintura);
    if (quitadosConConsumo.length) {
      const m = await prompt(
        `Indique el motivo para quitar de la OT ${quitadosConConsumo.map(q => q.sku).join(', ')} (lo registrado se devuelve a bodega):`,
        'Quitar material con consumo', 'Ej: no se usó en esta OT');
      if (m == null) return;
      if (!m.trim()) { showAlert('danger', 'Indique el motivo para quitar el material.'); return; }
      motivoQuitar = m.trim();
    }

    const body = {
      ...(recetaEnTabla && { receta_id: Number(recetaEnTabla.id), cantidad_puertas: Number(recetaEnTabla.puertas) }),
      reemplazar_receta: !!(recetaEnTabla && recetaGuardada && recetaGuardada !== String(recetaEnTabla.id)),
      bodega_id: bodega || null,
      ...(motivoQuitar && { motivo: motivoQuitar }),
      lineas: filas.map(f => ({
        sku: f.sku, estimado: f.estimado, real: f.esPintura ? null : num(f.real),
        ...(pideMotivo(f) && { motivo: String(f.motivo).trim() }),
      })),
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
      {/* F-24: OT de un proyecto de prueba (capacitación): el consumo sí mueve stock real */}
      {abierta && esProyectoDePrueba(orden?.proyecto_codigo) && (
        <AvisoCerrable className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
          ⚠ Esta OT es de un <strong>proyecto de prueba</strong> ({orden.proyecto_codigo}). Lo que guardes aquí descuenta
          stock real. Cuando termines de practicar, revierte el consumo antes de anular la OT.
        </AvisoCerrable>
      )}
      {data.resumen?.con_alerta_faltante > 0 && (
        <AvisoCerrable className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
          ⚠ {data.resumen.con_alerta_faltante} material(es) de esta OT tienen una alerta de faltante abierta.{' '}
          <Link to="/alertas/faltantes">Ver alertas de faltantes</Link>
        </AvisoCerrable>
      )}

      {/* F-08: medidas de la puerta (se remonta al cambiar las guardadas) */}
      <BloqueMedidas key={JSON.stringify(precarga?.orden?.medidas ?? null)} otId={otId} medidas={precarga?.orden?.medidas ?? null}
        derivadas={precarga?.orden?.derivadas ?? null} editable={abierta} showAlert={showAlert}
        onGuardadas={(msg) => {
          const conGuardados = (data.materiales || []).length > 0;
          showAlert('success', msg + (conGuardados ? ' Pulse "Cargar en la tabla" para recalcular los estimados con las nuevas medidas.' : ''));
          setRecargaPrecarga(n => n + 1);
        }} />

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
                      <div style={{ fontWeight: 500 }}><NombreCorto texto={f.nombre} /></div>
                      <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                        <code>{f.sku}</code>{f.unidad ? ` · ${f.unidad}` : ''}
                        {f.critico && <> <span className="badge badge-danger" style={{ fontSize: 10 }}>Crítico</span></>}
                        {f.inactivo && <> <span className="badge badge-gray" style={{ fontSize: 10 }}>Inactivo</span></>}
                        {f.estimado == null && !f.faltaMedida && <> <span className="badge badge-info" style={{ fontSize: 10 }}>agregado a mano</span></>}
                        {f.faltaMedida && <> <span className="badge badge-warning" style={{ fontSize: 10 }}>falta medida</span></>}
                      </div>
                      {f.faltaMedida && <div style={{ fontSize: 11, color: 'var(--warning)' }}>{f.faltaMedida}</div>}
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
                          {pideMotivo(f) && (
                            <input className="form-control" aria-label={`Motivo del cambio de ${f.sku}`} maxLength={255}
                              style={{ width: 200, marginLeft: 'auto', marginTop: 4, fontSize: 12,
                                borderColor: String(f.motivo || '').trim() ? undefined : 'var(--warning)' }}
                              placeholder="Motivo (ej.: se cortó mal)" value={f.motivo || ''}
                              onChange={e => cambiarMotivo(f.sku, e.target.value)} />
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
            <AvisoCerrable className="alert alert-warning" style={{ fontSize: 13, marginBottom: 12 }}>
              Corrección de una OT cerrada: ajuste el consumo real o agregue un material que se usó y no se registró (para
              quitarlo, deje su real en 0). El stock se mueve por la diferencia y la OT sigue cerrada. Las pinturas se
              corrigen desde el Seguimiento de pinturas.
            </AvisoCerrable>
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

/**
 * F-08 (D74): medidas de la puerta de la OT, en milímetros. Todas las puertas de la OT miden lo
 * mismo. Se guardan aparte del consumo (no mueven stock); al guardarlas se vuelve a precargar la receta.
 */
const CAMPOS_MEDIDAS = [
  { campo: 'vano_ancho_mm', etiqueta: 'Vano ancho (mm)' },
  { campo: 'vano_alto_mm', etiqueta: 'Vano alto (mm)' },
  { campo: 'perfil_marco_mm', etiqueta: 'Perfil del marco (mm)' },
  { campo: 'hojas', etiqueta: 'Hojas' },
];

function BloqueMedidas({ otId, medidas, derivadas, editable, showAlert, onGuardadas }) {
  const [form, setForm] = useState(() => ({
    vano_ancho_mm: medidas?.vano_ancho_mm != null ? String(medidas.vano_ancho_mm) : '',
    vano_alto_mm: medidas?.vano_alto_mm != null ? String(medidas.vano_alto_mm) : '',
    perfil_marco_mm: medidas?.perfil_marco_mm != null ? String(medidas.perfil_marco_mm) : '',
    hojas: medidas?.hojas != null ? String(medidas.hojas) : '1',
    mdf: medidas?.mdf === true,
  }));
  const [errores, setErrores] = useState({});
  const [guardando, setGuardando] = useState(false);

  const guardar = async (quitar = false) => {
    setGuardando(true);
    setErrores({});
    try {
      const r = await API.ordenesTrabajo.guardarMedidas(otId, quitar ? null : form);
      onGuardadas(r.message);
    } catch (err) {
      if (err.payload?.errores?.length) setErrores(Object.fromEntries(err.payload.errores.map(e => [e.campo, e.error])));
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }} id="consumo-medidas">
      <div className="section-label" style={{ marginBottom: 2 }}>Medidas de la puerta</div>
      <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 8 }}>
        {medidas
          ? `Vano ${formatQty(medidas.vano_ancho_mm)} × ${formatQty(medidas.vano_alto_mm)} mm · ${medidas.hojas} hoja(s) · ` +
            `perfil ${formatQty(medidas.perfil_marco_mm)} mm${medidas.mdf ? ' · con MDF' : ''}. `
          : 'Sin medidas. '}
        Los insumos de la receta que se calculan por medidas las usan; todas las puertas de la OT miden lo mismo.
      </div>
      {derivadas && (
        <div style={{ fontSize: 12, marginBottom: 8 }} id="medidas-derivadas">
          {[['Marco', 'marco'], ['Alojamiento', 'alojamiento'], ['Hoja', 'hoja'], ['Bastidor', 'bastidor']].map(([nombre, v]) => (
            <span key={v} style={{ marginRight: 16 }}>
              {nombre}: <strong>{formatQty(derivadas[`${v}_ancho`])} × {formatQty(derivadas[`${v}_alto`])}</strong> mm
            </span>
          ))}
          {derivadas.hojas > 1 && <span style={{ color: 'var(--gray)' }}>(hoja y bastidor: cada hoja)</span>}
        </div>
      )}
      {editable && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {CAMPOS_MEDIDAS.map(({ campo, etiqueta }) => (
            <div key={campo}>
              <label className="form-label" htmlFor={`medida-${campo}`} style={{ marginBottom: 4 }}>{etiqueta}</label>
              <input className="form-control" id={`medida-${campo}`} inputMode="decimal" style={{ width: 120, ...(errores[campo] && { borderColor: 'var(--danger)' }) }}
                value={form[campo]} title={errores[campo] || undefined}
                onChange={e => setForm(f => ({ ...f, [campo]: e.target.value }))} />
            </div>
          ))}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, paddingBottom: 8 }}>
            <input type="checkbox" id="medida-mdf" checked={form.mdf} onChange={e => setForm(f => ({ ...f, mdf: e.target.checked }))} />
            Con MDF
          </label>
          <button type="button" className="btn btn-secondary" id="btn-guardar-medidas" disabled={guardando} onClick={() => guardar(false)}>
            {guardando ? 'Guardando…' : 'Guardar medidas'}
          </button>
          {medidas && (
            <button type="button" className="btn btn-ghost" disabled={guardando} onClick={() => guardar(true)}>Quitar</button>
          )}
        </div>
      )}
      {Object.keys(errores).length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>{Object.values(errores).join(' · ')}</div>
      )}
    </div>
  );
}
