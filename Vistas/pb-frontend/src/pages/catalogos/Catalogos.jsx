import { useCallback, useEffect, useMemo, useState } from 'react';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert, AvisoCerrable } from '../../components/Alert';
import { TabAreas, TabUnidades, TabMotivos } from './TabsOperacion';

/**
 * Catálogos (solo gerencia): las listas que usa el sistema, editables sin pedirle SQL al equipo.
 * B-14: pestaña Clasificación. F-04: Áreas, Unidades y Motivos (TabsOperacion.jsx).
 */
const PESTANAS = [
  ['clasificacion', 'Clasificación de productos'],
  ['areas', 'Áreas de trabajo'],
  ['unidades', 'Unidades de medida'],
  ['motivos', 'Motivos de salida'],
];

export default function Catalogos() {
  usePageTitle('Catálogos');
  const { user } = useAuth();
  const [tab, setTab] = useState('clasificacion');

  if (user && user.rol !== 'gerencia') {
    return <div className="empty-state"><div className="empty-state-icon">🔒</div><p>Esta sección es solo para gerencia.</p></div>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Catálogos</div>
          <div className="page-subtitle">Listas que usa el sistema: se crean, renombran y ordenan desde aquí</div>
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 20 }}>
        {PESTANAS.map(([clave, titulo]) => (
          <div key={clave} className={'tab' + (tab === clave ? ' active' : '')} onClick={() => setTab(clave)}>{titulo}</div>
        ))}
      </div>
      {tab === 'clasificacion' && <TabClasificacion />}
      {tab === 'areas' && <TabAreas />}
      {tab === 'unidades' && <TabUnidades />}
      {tab === 'motivos' && <TabMotivos />}
    </>
  );
}

const usosTexto = (n) => (n === 0 ? 'sin uso' : `${n} producto${n === 1 ? '' : 's'}`);

function TabClasificacion() {
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const [datos, setDatos] = useState(null);
  const [selCat, setSelCat] = useState(null);
  const [selSub, setSelSub] = useState(null);
  const [fusion, setFusion] = useState(null);   // { tipo, item, opciones, destino }

  const cargar = useCallback(async () => {
    try {
      setDatos(await API.materiales.clasificacion());
    } catch (err) {
      showAlert('danger', 'Error cargando la clasificación: ' + err.message);
    }
  }, [showAlert]);

  useEffect(() => {
    let cancelado = false;
    API.materiales.clasificacion()
      .then(d => { if (!cancelado) setDatos(d); })
      .catch(err => { if (!cancelado) showAlert('danger', 'Error cargando la clasificación: ' + err.message); });
    return () => { cancelado = true; };
  }, [showAlert]);

  /** Llama a la API; el 409 llega como respuesta (no lanza): se trata igual que un error. */
  const ejecutar = async (llamada, mensajeOk) => {
    try {
      const r = await llamada();
      if (r?.error) throw new Error(r.error);
      showAlert('success', mensajeOk);
      await cargar();
      return true;
    } catch (err) {
      showAlert('danger', err.message);
      return false;
    }
  };

  const clas = datos?.clasificacion;
  const cat = clas?.categorias.find(c => String(c.id) === String(selCat)) || null;
  const sub = clas?.subcategorias.find(s => String(s.id) === String(selSub) && String(s.categoria_id) === String(cat?.id)) || null;
  const subs = cat ? clas.subcategorias.filter(s => String(s.categoria_id) === String(cat.id)) : [];
  const niveles = sub ? clas.niveles.filter(n => String(n.subcategoria_id) === String(sub.id)) : [];

  // Destinos posibles al fusionar un nivel: cualquier otro nivel, con su ruta completa
  const rutasNivel = useMemo(() => {
    if (!clas) return [];
    const catDe = new Map(clas.categorias.map(c => [String(c.id), c.nombre]));
    const subDe = new Map(clas.subcategorias.map(s => [String(s.id), s]));
    return clas.niveles.map(n => {
      const s = subDe.get(String(n.subcategoria_id));
      return { id: n.id, etiqueta: `${catDe.get(String(s?.categoria_id)) ?? '?'} › ${s?.nombre ?? '?'} › ${n.nombre}` };
    }).sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'));
  }, [clas]);

  const crear = (tipo, nombre, padreId) =>
    ejecutar(() => API.materiales.crearClasificacion(tipo, { nombre, padre_id: padreId }),
      tipo === 'subcategoria' ? `Se creó "${nombre}" con el nivel "General".` : `Se creó "${nombre}".`);

  const renombrar = (tipo, item, nombre) =>
    ejecutar(() => API.materiales.actualizarClasificacion(tipo, item.id, { nombre }), `"${item.nombre}" ahora se llama "${nombre}".`);

  const borrar = async (tipo, item, opciones) => {
    if (item.usos > 0) {
      setFusion({ tipo, item, opciones: opciones.filter(o => String(o.id) !== String(item.id)), destino: '' });
      return;
    }
    const rama = tipo === 'categoria' ? ' También se borran sus subcategorías y niveles.'
      : tipo === 'subcategoria' ? ' También se borran sus niveles.' : '';
    if (!await confirm(`¿Borrar "${item.nombre}"? Ningún producto lo usa.${rama}`, 'Borrar')) return;
    await ejecutar(() => API.materiales.eliminarClasificacion(tipo, item.id), `Se borró "${item.nombre}".`);
  };

  const fusionar = async () => {
    const destino = fusion.opciones.find(o => String(o.id) === String(fusion.destino));
    if (!destino) { showAlert('danger', 'Elige a dónde pasan los productos.'); return; }
    const ok = await ejecutar(
      () => API.materiales.eliminarClasificacion(fusion.tipo, fusion.item.id, destino.id),
      `${usosTexto(fusion.item.usos)} pasaron a "${destino.etiqueta}" y "${fusion.item.nombre}" se borró.`
    );
    if (ok) setFusion(null);
  };

  if (!datos) return <div id="alert-container"><Alert {...alert} /></div>;

  const opcionesDe = (lista) => lista.map(x => ({ id: x.id, etiqueta: x.nombre }));

  return (
    <>
      <div id="alert-container"><Alert {...alert} /></div>
      <p style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 16, lineHeight: 1.6 }}>
        Cada producto lleva tres clasificaciones independientes. Lo que ningún producto usa se puede borrar; lo que está en
        uso se renombra o se <strong>fusiona</strong> con otro (sus productos pasan al otro y el original se borra).
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }}>
        <Lista
          titulo="Categoría general" ayuda="La que se ve en la lista de productos, su filtro y los saldos valorizados."
          items={datos.generales}
          onCrear={n => crear('general', n)}
          onRenombrar={(it, n) => renombrar('general', it, n)}
          onBorrar={it => borrar('general', it, opcionesDe(datos.generales))}
          fusionable
        />
        <Lista
          titulo="Categoría funcional" ayuda="Qué papel cumple el producto (por ejemplo insumo o herramienta)."
          items={datos.funcionales}
          onCrear={n => crear('funcional', n)}
          onRenombrar={(it, n) => renombrar('funcional', it, n)}
          onBorrar={it => borrar('funcional', it, opcionesDe(datos.funcionales))}
          fusionable
        />
      </div>

      <div className="card">
        <div className="card-title">Clasificación específica</div>
        <p style={{ fontSize: 12, color: 'var(--gray)', marginTop: -8, marginBottom: 12 }}>
          Árbol categoría → subcategoría → nivel. El producto guarda el nivel. Elige una categoría para ver sus
          subcategorías, y una subcategoría para ver sus niveles.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
          <Lista
            sinTarjeta titulo="Categorías" items={clas.categorias}
            seleccionado={cat?.id} onSeleccionar={it => { setSelCat(it.id); setSelSub(null); }}
            onCrear={n => crear('categoria', n)}
            onRenombrar={(it, n) => renombrar('categoria', it, n)}
            onBorrar={it => borrar('categoria', it, [])}
          />
          <Lista
            sinTarjeta titulo={cat ? `Subcategorías de ${cat.nombre}` : 'Subcategorías'} items={subs}
            vacio={cat ? 'Sin subcategorías.' : 'Elige una categoría.'}
            seleccionado={sub?.id} onSeleccionar={it => setSelSub(it.id)}
            onCrear={cat ? n => crear('subcategoria', n, cat.id) : null}
            onRenombrar={(it, n) => renombrar('subcategoria', it, n)}
            onBorrar={it => borrar('subcategoria', it, [])}
            extra={it => (
              <label className="form-check" style={{ fontSize: 11, color: 'var(--gray)' }} title="En Crear producto muestra el aviso de colores personalizados">
                <input type="checkbox" checked={it.es_color_custom === true}
                  onChange={e => ejecutar(() => API.materiales.actualizarClasificacion('subcategoria', it.id, { es_color_custom: e.target.checked }),
                    `"${it.nombre}" ${e.target.checked ? 'admite' : 'ya no admite'} colores personalizados.`)} />
                colores personalizados
              </label>
            )}
          />
          <Lista
            sinTarjeta titulo={sub ? `Niveles de ${sub.nombre}` : 'Niveles'} items={niveles}
            vacio={sub ? 'Sin niveles: los productos no podrán usar esta subcategoría.' : 'Elige una subcategoría.'}
            onCrear={sub ? n => crear('nivel', n, sub.id) : null}
            onRenombrar={(it, n) => renombrar('nivel', it, n)}
            onBorrar={it => borrar('nivel', it, rutasNivel)}
            fusionable
          />
        </div>
      </div>

      {fusion && (
        <div className="modal-backdrop show" onClick={e => { if (e.target === e.currentTarget) setFusion(null); }}>
          <div className="modal">
            <div className="modal-header">
              <div><div className="modal-title">Fusionar "{fusion.item.nombre}"</div>
                <div className="modal-subtitle">La usan {usosTexto(fusion.item.usos)}</div></div>
              <button className="modal-close" onClick={() => setFusion(null)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
                Sus productos pasan al destino que elijas y "{fusion.item.nombre}" se borra. Sirve para juntar duplicados
                o quitar una categoría que ya no se usa.
              </p>
              {fusion.opciones.length === 0 ? (
                <AvisoCerrable className="alert alert-warning">No hay otro destino. Crea primero el que va a recibir los productos.</AvisoCerrable>
              ) : (
                <div className="form-group">
                  <label className="form-label" htmlFor="fusion-destino">Pasar los productos a</label>
                  <select className="form-control" id="fusion-destino" value={fusion.destino}
                    onChange={e => setFusion(f => ({ ...f, destino: e.target.value }))}>
                    <option value="">Elige…</option>
                    {fusion.opciones.map(o => <option key={o.id} value={o.id}>{o.etiqueta}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setFusion(null)}>Cancelar</button>
              <button className="btn btn-primary" disabled={!fusion.destino} onClick={fusionar}>Fusionar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Una lista editable: agregar, renombrar en línea y borrar (o fusionar si está en uso y se puede).
 * Sin onCrear no se muestra el campo para agregar (falta elegir el padre).
 */
function Lista({ titulo, ayuda, items, vacio = 'Sin elementos.', seleccionado, onSeleccionar, onCrear, onRenombrar, onBorrar,
                 fusionable = false, extra, sinTarjeta = false }) {
  const [nuevo, setNuevo] = useState('');
  const [editando, setEditando] = useState(null);   // { id, nombre }

  const agregar = async () => {
    const nombre = nuevo.trim();
    if (!nombre) return;
    if (await onCrear(nombre)) setNuevo('');
  };
  const guardar = async (it) => {
    const nombre = editando.nombre.trim();
    if (!nombre || nombre === it.nombre) { setEditando(null); return; }
    if (await onRenombrar(it, nombre)) setEditando(null);
  };

  const cuerpo = (
    <>
      <div className={sinTarjeta ? '' : 'card-title'} style={sinTarjeta ? { fontSize: 13, fontWeight: 600, marginBottom: 6 } : undefined}>{titulo}</div>
      {ayuda && <p style={{ fontSize: 12, color: 'var(--gray)', marginTop: -8, marginBottom: 10 }}>{ayuda}</p>}
      <div style={{ border: '1px solid var(--gray-mid)', borderRadius: 'var(--radius-md)', maxHeight: 340, overflowY: 'auto' }}>
        {items.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--gray)' }}>{vacio}</div>}
        {items.map(it => {
          const activo = seleccionado != null && String(seleccionado) === String(it.id);
          const enEdicion = editando && String(editando.id) === String(it.id);
          const bloqueado = it.usos > 0 && !fusionable;
          return (
            <div key={it.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--gray-light)',
                       background: activo ? 'var(--orange-light)' : undefined, cursor: onSeleccionar && !enEdicion ? 'pointer' : undefined }}
              onClick={() => { if (onSeleccionar && !enEdicion) onSeleccionar(it); }}>
              {enEdicion ? (
                <>
                  <input className="form-control" style={{ flex: 1, padding: '4px 8px', fontSize: 13 }} autoFocus maxLength={150}
                    value={editando.nombre} onClick={e => e.stopPropagation()}
                    onChange={e => setEditando({ ...editando, nombre: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') guardar(it); if (e.key === 'Escape') setEditando(null); }} />
                  <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); guardar(it); }}>Guardar</button>
                  <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); setEditando(null); }}>Cancelar</button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: activo ? 600 : 400, overflowWrap: 'anywhere' }}>{it.nombre}</div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, color: 'var(--gray)' }}>{usosTexto(it.usos)}</span>
                      {extra && <span onClick={e => e.stopPropagation()}>{extra(it)}</span>}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" title="Cambiar el nombre"
                    onClick={e => { e.stopPropagation(); setEditando({ id: it.id, nombre: it.nombre }); }}>Renombrar</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: bloqueado ? undefined : 'var(--danger)' }} disabled={bloqueado}
                    title={bloqueado ? 'En uso: fusiona sus niveles con otros para pasarles los productos' : undefined}
                    onClick={e => { e.stopPropagation(); onBorrar(it); }}>
                    {it.usos > 0 && fusionable ? 'Fusionar…' : 'Borrar'}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {onCrear && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input className="form-control" style={{ flex: 1 }} placeholder="Nuevo nombre" maxLength={150} value={nuevo}
            onChange={e => setNuevo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') agregar(); }} />
          <button className="btn btn-secondary btn-sm" disabled={!nuevo.trim()} onClick={agregar}>Agregar</button>
        </div>
      )}
    </>
  );

  return sinTarjeta ? <div>{cuerpo}</div> : <div className="card">{cuerpo}</div>;
}
