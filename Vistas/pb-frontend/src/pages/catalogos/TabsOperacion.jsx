import { useCallback, useEffect, useState } from 'react';
import { API } from '../../services/api';
import { useConfirm } from '../../hooks/useDialog';
import { etiqueta } from '../../utils/format';
import Alert, { useAlert, AvisoCerrable } from '../../components/Alert';

/**
 * F-04: pestañas Áreas, Unidades y Motivos de la pantalla Catálogos (solo gerencia).
 * Los nombres son datos del cliente; el sistema reconoce las áreas por su clasificación y
 * algunos motivos por su nombre (los "del sistema", que no se renombran).
 */

const CLASIF_AREA = {
  produccion:  { texto: 'Producción',  ayuda: 'sus insumos van en las recetas y se consumen en las OT' },
  instalacion: { texto: 'Instalación', ayuda: 'los insumos que viajan a obra (pedidos de instalación)' },
  logistica:   { texto: 'Logística',   ayuda: 'no entra en las recetas' },
};

const ayudaStyle = { fontSize: 13, color: 'var(--gray)', marginBottom: 16, lineHeight: 1.6 };
const usoStyle = { fontSize: 12, color: 'var(--gray)' };

/** Carga con `cargar` y expone `ejecutar`: el 409 llega como respuesta (no lanza) y se trata como error. */
function useCatalogo(cargar) {
  const { alert, showAlert } = useAlert();
  const [datos, setDatos] = useState(null);

  const recargar = useCallback(async () => {
    try {
      setDatos(await cargar());
    } catch (err) {
      showAlert('danger', 'Error cargando el catálogo: ' + err.message);
    }
  }, [cargar, showAlert]);

  useEffect(() => {
    let cancelado = false;
    cargar()
      .then(d => { if (!cancelado) setDatos(d); })
      .catch(err => { if (!cancelado) showAlert('danger', 'Error cargando el catálogo: ' + err.message); });
    return () => { cancelado = true; };
  }, [cargar, showAlert]);

  const ejecutar = async (llamada, mensajeOk) => {
    try {
      const r = await llamada();
      if (r?.error) throw new Error(r.error);
      showAlert('success', mensajeOk);
      await recargar();
      return true;
    } catch (err) {
      showAlert('danger', err.message);
      return false;
    }
  };

  return { datos, alert, showAlert, ejecutar, recargar };
}

/** Nombre con "Renombrar" en línea. Sin onGuardar, solo muestra el texto. */
function NombreEditable({ nombre, mostrar, onGuardar, max = 150 }) {
  const [editando, setEditando] = useState(null);
  const guardar = async () => {
    const valor = editando.trim();
    if (!valor || valor === nombre) { setEditando(null); return; }
    if (await onGuardar(valor)) setEditando(null);
  };
  if (editando != null) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="form-control" style={{ flex: 1, padding: '4px 8px', fontSize: 13 }} autoFocus maxLength={max}
          value={editando} onChange={e => setEditando(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') guardar(); if (e.key === 'Escape') setEditando(null); }} />
        <button className="btn btn-primary btn-sm" onClick={guardar}>Guardar</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditando(null)}>Cancelar</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{mostrar ?? nombre}</span>
      {onGuardar && <button className="btn btn-ghost btn-sm" onClick={() => setEditando(nombre)}>Renombrar</button>}
    </div>
  );
}

/* ══════════════════════════════ Áreas ══════════════════════════════ */

const cargarAreas = () => API.catalogos.areas();

export function TabAreas() {
  const confirm = useConfirm();
  const { datos, alert, showAlert, ejecutar } = useCatalogo(cargarAreas);
  const [nuevo, setNuevo] = useState({ nombre: '', clasificacion: 'produccion' });

  if (!datos) return <div id="alert-container"><Alert {...alert} /></div>;

  const crear = async () => {
    const nombre = nuevo.nombre.trim();
    if (!nombre) { showAlert('danger', 'Escribe el nombre del área.'); return; }
    if (await ejecutar(() => API.catalogos.crearArea({ nombre, clasificacion: nuevo.clasificacion }), `Se creó el área "${nombre}".`)) {
      setNuevo({ nombre: '', clasificacion: 'produccion' });
    }
  };

  const cambiarClasificacion = async (a, clasificacion) => {
    if (!await confirm(`¿Cambiar "${a.nombre}" a ${CLASIF_AREA[clasificacion].texto}? Desde ahora ${CLASIF_AREA[clasificacion].ayuda}.`, 'Cambiar clasificación')) return;
    await ejecutar(() => API.catalogos.actualizarArea(a.id, { clasificacion }), `"${a.nombre}" ahora es de ${CLASIF_AREA[clasificacion].texto}.`);
  };

  const cambiarEstado = async (a) => {
    if (a.activo) {
      const uso = [];
      if (a.ots_abiertas) uso.push(`${a.ots_abiertas} OT abierta${a.ots_abiertas === 1 ? '' : 's'}`);
      if (a.lineas_receta) uso.push(`${a.lineas_receta} línea${a.lineas_receta === 1 ? '' : 's'} de receta`);
      const msg = `¿Desactivar "${a.nombre}"?` + (uso.length ? ` Tiene ${uso.join(' y ')}.` : '') +
        ' Sus OT conservan el área, pero no se podrá elegir para OT nuevas y sus líneas de receta no se cargarán en ellas.';
      if (!await confirm(msg, 'Desactivar área')) return;
    }
    await ejecutar(() => API.catalogos.actualizarArea(a.id, { activo: !a.activo }),
      `"${a.nombre}" quedó ${a.activo ? 'inactiva' : 'activa'}.`);
  };

  return (
    <>
      <div id="alert-container"><Alert {...alert} /></div>
      <p style={ayudaStyle}>
        Cada OT es de un área. El sistema reconoce el área por su <strong>clasificación</strong>, no por el nombre, así que
        renombrar es seguro. <strong>Producción</strong>: {CLASIF_AREA.produccion.ayuda}. <strong>Instalación</strong>:{' '}
        {CLASIF_AREA.instalacion.ayuda}. <strong>Logística</strong>: {CLASIF_AREA.logistica.ayuda}. Las áreas no se borran: se desactivan.
      </p>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Área</th><th>Clasificación</th><th>Uso</th><th>Estado</th></tr></thead>
            <tbody>
              {datos.areas.map(a => (
                <tr key={a.id}>
                  <td style={{ minWidth: 220 }}>
                    <NombreEditable nombre={a.nombre}
                      onGuardar={n => ejecutar(() => API.catalogos.actualizarArea(a.id, { nombre: n }), `"${a.nombre}" ahora se llama "${n}".`)} />
                  </td>
                  <td>
                    <select className="form-control" style={{ padding: '4px 8px', fontSize: 13 }} value={a.clasificacion ?? ''}
                      onChange={e => cambiarClasificacion(a, e.target.value)}>
                      {!a.clasificacion && <option value="">—</option>}
                      {datos.clasificaciones.map(c => <option key={c} value={c}>{CLASIF_AREA[c]?.texto ?? etiqueta(c)}</option>)}
                    </select>
                  </td>
                  <td style={usoStyle}>
                    {a.ots} OT{a.ots_abiertas ? ` (${a.ots_abiertas} abierta${a.ots_abiertas === 1 ? '' : 's'})` : ''} · {a.lineas_receta} línea{a.lineas_receta === 1 ? '' : 's'} de receta
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className={`badge ${a.activo ? 'badge-success' : 'badge-gray'}`}>{a.activo ? 'Activa' : 'Inactiva'}</span>{' '}
                    <button className="btn btn-ghost btn-sm" onClick={() => cambiarEstado(a)}>{a.activo ? 'Desactivar' : 'Activar'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input className="form-control" style={{ flex: '1 1 220px' }} placeholder="Nueva área" maxLength={150} value={nuevo.nombre}
            onChange={e => setNuevo({ ...nuevo, nombre: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') crear(); }} />
          <select className="form-control" style={{ flex: '0 1 180px' }} value={nuevo.clasificacion}
            onChange={e => setNuevo({ ...nuevo, clasificacion: e.target.value })}>
            {datos.clasificaciones.map(c => <option key={c} value={c}>{CLASIF_AREA[c]?.texto ?? etiqueta(c)}</option>)}
          </select>
          <button className="btn btn-secondary btn-sm" disabled={!nuevo.nombre.trim()} onClick={crear}>Agregar</button>
        </div>
      </div>
    </>
  );
}

/* ═════════════════════════════ Unidades ═════════════════════════════ */

const cargarUnidades = () => API.catalogos.unidades();

export function TabUnidades() {
  const confirm = useConfirm();
  const { datos, alert, ejecutar } = useCatalogo(cargarUnidades);
  const [nuevo, setNuevo] = useState('');

  if (!datos) return <div id="alert-container"><Alert {...alert} /></div>;

  const crear = async () => {
    const nombre = nuevo.trim();
    if (nombre && await ejecutar(() => API.catalogos.crearUnidad({ nombre }), `Se creó la unidad "${nombre}".`)) setNuevo('');
  };
  const borrar = async (u) => {
    if (!await confirm(`¿Borrar la unidad "${u.nombre}"? Ningún producto la usa.`, 'Borrar unidad')) return;
    await ejecutar(() => API.catalogos.eliminarUnidad(u.id), `Se borró "${u.nombre}".`);
  };

  return (
    <>
      <div id="alert-container"><Alert {...alert} /></div>
      <p style={ayudaStyle}>
        La unidad en que se cuenta cada producto. Se pueden renombrar; solo se borran las que ningún producto usa.
        El importador reconoce las abreviaturas (m, kg, un, lt) de metro, kilogramo, unidad y litro: si se renombran,
        en la planilla hay que escribir el nombre nuevo.
      </p>
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Unidad</th><th>Productos</th><th></th></tr></thead>
            <tbody>
              {datos.map(u => (
                <tr key={u.id}>
                  <td><NombreEditable nombre={u.nombre} max={100}
                    onGuardar={n => ejecutar(() => API.catalogos.actualizarUnidad(u.id, { nombre: n }), `"${u.nombre}" ahora se llama "${n}".`)} /></td>
                  <td style={usoStyle}>{u.usos === 0 ? 'sin uso' : u.usos}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-ghost btn-sm" style={{ color: u.usos ? undefined : 'var(--danger)' }} disabled={u.usos > 0}
                      title={u.usos ? 'En uso: cambia la unidad de esos productos o renómbrala' : undefined} onClick={() => borrar(u)}>Borrar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input className="form-control" style={{ flex: 1 }} placeholder="Nueva unidad" maxLength={100} value={nuevo}
            onChange={e => setNuevo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') crear(); }} />
          <button className="btn btn-secondary btn-sm" disabled={!nuevo.trim()} onClick={crear}>Agregar</button>
        </div>
      </div>
    </>
  );
}

/* ═════════════════════════════ Motivos ══════════════════════════════ */

const cargarMotivos = () => API.catalogos.motivos();

export function TabMotivos() {
  const confirm = useConfirm();
  const { datos, alert, showAlert, ejecutar, recargar } = useCatalogo(cargarMotivos);
  const [nuevo, setNuevo] = useState({ nombre: '', clasificacion_id: '' });
  const [restaurarEn, setRestaurarEn] = useState({});   // clave → clasificacion_id elegida
  const [borrando, setBorrando] = useState(null);       // motivo del sistema que se borra (pide contraseña)

  if (!datos) return <div id="alert-container"><Alert {...alert} /></div>;

  const deSalida = datos.clasificaciones.filter(c => !c.es_traslado);

  const crear = async () => {
    const nombre = nuevo.nombre.trim();
    if (!nombre) return;
    if (!nuevo.clasificacion_id) { showAlert('danger', 'Elige la categoría del motivo.'); return; }
    if (await ejecutar(() => API.catalogos.crearMotivo({ nombre, clasificacion_id: Number(nuevo.clasificacion_id) }), `Se creó el motivo "${nombre}".`)) {
      setNuevo({ nombre: '', clasificacion_id: '' });
    }
  };

  const borrarPropio = async (m) => {
    if (!await confirm(`¿Borrar el motivo "${m.nombre}"? Ningún movimiento lo usa.`, 'Borrar motivo')) return;
    await ejecutar(() => API.catalogos.eliminarMotivo(m.id), `Se borró "${m.nombre}".`);
  };

  const restaurar = (f) => {
    const elegida = f.clave in restaurarEn ? restaurarEn[f.clave] : (f.clasificacion_id ?? '');
    return ejecutar(() => API.catalogos.restaurarMotivo({ clave: f.clave, clasificacion_id: elegida === '' ? null : Number(elegida) }),
      `Se restauró "${etiqueta(f.clave)}".`);
  };

  return (
    <>
      <div id="alert-container"><Alert {...alert} /></div>
      <p style={ayudaStyle}>
        El motivo de cada salida. Su <strong>categoría</strong> decide cómo se trata: las de merma o pérdida piden evidencia
        y aprobación, y las de consumo cuentan en los reportes de consumo. Los motivos <strong>del sistema</strong> los usa
        el propio sistema por su nombre: no se renombran, y borrarlos pide tu contraseña.
      </p>

      {datos.faltantes.length > 0 && (
        <AvisoCerrable className="alert alert-warning" style={{ display: 'block' }}>
          <strong>Faltan motivos del sistema.</strong> Sin ellos no funciona lo que se indica. Restáuralos con su categoría:
          {datos.faltantes.map(f => (
            <div key={f.clave} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 260px' }}><strong>{etiqueta(f.clave)}</strong> — {f.funcion}</span>
              <select className="form-control" style={{ flex: '0 1 200px', padding: '4px 8px', fontSize: 13 }}
                value={f.clave in restaurarEn ? restaurarEn[f.clave] : (f.clasificacion_id ?? '')}
                onChange={e => setRestaurarEn({ ...restaurarEn, [f.clave]: e.target.value })}>
                <option value="">Sin categoría (entrada)</option>
                {datos.clasificaciones.map(c => <option key={c.id} value={c.id}>{etiqueta(c.nombre)}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" onClick={() => restaurar(f)}>Restaurar</button>
            </div>
          ))}
        </AvisoCerrable>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Motivo</th><th>Categoría</th><th>Movimientos</th><th></th></tr></thead>
            <tbody>
              {datos.motivos.map(m => (
                <tr key={m.id}>
                  <td style={{ minWidth: 240 }}>
                    {m.clave ? (
                      <div>
                        {etiqueta(m.nombre)} <span className="badge badge-gray" title={`Lo usa: ${m.funcion}`}>del sistema</span>
                        <div style={usoStyle}>{m.funcion}</div>
                      </div>
                    ) : (
                      <NombreEditable nombre={m.nombre}
                        onGuardar={n => ejecutar(() => API.catalogos.actualizarMotivo(m.id, { nombre: n }), `"${m.nombre}" ahora se llama "${n}".`)} />
                    )}
                  </td>
                  <td>
                    {m.clave || m.clasificacion_id == null ? (
                      <span style={usoStyle}>{m.clasificacion ? etiqueta(m.clasificacion) : 'Entrada'}</span>
                    ) : (
                      <select className="form-control" style={{ padding: '4px 8px', fontSize: 13 }} value={m.clasificacion_id}
                        onChange={e => ejecutar(() => API.catalogos.actualizarMotivo(m.id, { clasificacion_id: Number(e.target.value) }),
                          `"${m.nombre}" cambió de categoría.`)}>
                        {deSalida.map(c => <option key={c.id} value={c.id}>{etiqueta(c.nombre)}</option>)}
                      </select>
                    )}
                  </td>
                  <td style={usoStyle}>{m.usos === 0 ? 'sin uso' : m.usos}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-ghost btn-sm" style={{ color: m.usos ? undefined : 'var(--danger)' }} disabled={m.usos > 0}
                      title={m.usos ? 'Tiene movimientos: no se puede borrar' : undefined}
                      onClick={() => (m.clave ? setBorrando(m) : borrarPropio(m))}>
                      {m.clave ? 'Borrar…' : 'Borrar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input className="form-control" style={{ flex: '1 1 220px' }} placeholder="Nuevo motivo de salida" maxLength={150} value={nuevo.nombre}
            onChange={e => setNuevo({ ...nuevo, nombre: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') crear(); }} />
          <select className="form-control" style={{ flex: '0 1 200px' }} value={nuevo.clasificacion_id}
            onChange={e => setNuevo({ ...nuevo, clasificacion_id: e.target.value })}>
            <option value="">Categoría…</option>
            {deSalida.map(c => <option key={c.id} value={c.id}>{etiqueta(c.nombre)}</option>)}
          </select>
          <button className="btn btn-secondary btn-sm" disabled={!nuevo.nombre.trim()} onClick={crear}>Agregar</button>
        </div>
      </div>

      {borrando && (
        <BorrarMotivoSistema motivo={borrando} onCerrar={() => setBorrando(null)}
          onBorrado={async () => { setBorrando(null); showAlert('success', `Se borró "${etiqueta(borrando.nombre)}". Puedes restaurarlo desde esta pestaña.`); await recargar(); }} />
      )}
    </>
  );
}

/** Aviso antes de borrar un motivo del sistema. La firma de gerencia la pide apiFetch (F-11). */
function BorrarMotivoSistema({ motivo, onCerrar, onBorrado }) {
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    if (enviando) return;
    setEnviando(true);
    setError('');
    try {
      const b = await API.catalogos.eliminarMotivo(motivo.id);
      if (!b) return;                       // 401: apiFetch ya llevó al login
      if (b.error) { setError(b.error); return; }   // 409: tiene movimientos
      await onBorrado();
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="modal-backdrop show" onClick={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <form className="modal" onSubmit={enviar}>
        <div className="modal-header">
          <div><div className="modal-title">Borrar "{etiqueta(motivo.nombre)}"</div>
            <div className="modal-subtitle">Motivo del sistema</div></div>
          <button type="button" className="modal-close" onClick={onCerrar}>&#x2715;</button>
        </div>
        <div className="modal-body">
          <AvisoCerrable className="alert alert-warning" style={{ display: 'block' }}>
            Sin este motivo deja de funcionar <strong>{motivo.funcion}</strong>. Puedes restaurarlo después desde esta misma pestaña.
          </AvisoCerrable>
          {error && (
            <AvisoCerrable className="alert alert-warning" style={{ marginTop: 12, marginBottom: 0 }}>{error}</AvisoCerrable>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onCerrar}>Cancelar</button>
          <button type="submit" className="btn btn-danger" disabled={enviando} autoFocus>
            {enviando ? 'Borrando…' : 'Borrar motivo'}
          </button>
        </div>
      </form>
    </div>
  );
}
