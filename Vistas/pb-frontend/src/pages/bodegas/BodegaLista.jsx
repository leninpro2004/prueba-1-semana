import { useCallback, useEffect, useState } from 'react';
import { API } from '../../services/api';
import { formatQty } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';

// Opciones estáticas del modal "Asignar producto" (copiadas del HTML)
const PRODUCTOS_ASIGNAR = [
  ['MAT-ACE-001', 'MAT-ACE-001 — Acero inoxidable placa 2mm'],
  ['MAT-MAD-002', 'MAT-MAD-002 — Madera roble 2x7 metros'],
  ['INS-CER-003', 'INS-CER-003 — Cerradura seguridad triple'],
  ['HER-TAL-004', 'HER-TAL-004 — Taladro percutor 800W'],
  ['INS-TOR-005', 'INS-TOR-005 — Tornillo acero inox 5cm'],
];

/**
 * Bodegas — conversión 1:1 de bodegas/lista.html.
 * data-rol="gerencia" (ocultos si rol === 'jop'): Nueva bodega, Editar bodega,
 * + Asignar producto, + Crear anaquel, Eliminar anaquel.
 */
export default function BodegaLista() {
  usePageTitle('Bodegas');
  const { user } = useAuth();
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const verGerencia = user?.rol !== 'jop';
  const puedeEliminarBodega = user?.rol === 'gerencia' || user?.rol === 'administrador';

  const [bodegas, setBodegas] = useState(null);       // null = aún sin cargar
  const [bodegaActual, setBodegaActual] = useState(null);
  const [detalle, setDetalle] = useState(null);       // data de API.bodegas.obtener

  // Modales
  const [modalNueva, setModalNueva] = useState(false);
  const [nCodigo, setNCodigo] = useState('');
  const [nNombre, setNNombre] = useState('');
  const [nUbicacion, setNUbicacion] = useState('');
  const [nAlert, setNAlert] = useState('');
  const [nErr, setNErr] = useState({});

  const [modalAsignar, setModalAsignar] = useState(false);
  const [asignarProducto, setAsignarProducto] = useState('');
  const [asignarUbic, setAsignarUbic] = useState('');

  const [modalAnaquel, setModalAnaquel] = useState(false);
  const [anqDesc, setAnqDesc] = useState('');
  const [anqAlert, setAnqAlert] = useState('');

  // Editar anaquel (SONNET-4)
  const [editAnaquel, setEditAnaquel] = useState(null); // { id, descripcion }
  const [editAnaquelAlert, setEditAnaquelAlert] = useState('');
  const [eliminandoBodega, setEliminandoBodega] = useState(false);

  // Form editar bodega (CU-21)
  const [editOpen, setEditOpen] = useState(false);
  const [editNombre, setEditNombre] = useState('');
  const [editDir, setEditDir] = useState('');
  const [editEstado, setEditEstado] = useState('activo');
  const [editAlert, setEditAlert] = useState('');

  const cargarBodegas = useCallback(async () => {
    try {
      const data = await API.bodegas.listar();
      setBodegas(Array.isArray(data) ? data : []);
      return data;
    } catch (err) {
      showAlert('danger', 'Error cargando bodegas: ' + err.message);
    }
  }, [showAlert]);

  useEffect(() => { cargarBodegas(); }, [cargarBodegas]);

  const verDetalle = useCallback(async (id) => {
    setBodegaActual(id);
    try {
      const data = await API.bodegas.obtener(id);
      setDetalle(data);
    } catch (err) {
      showAlert('danger', 'Error cargando detalle: ' + err.message);
    }
  }, [showAlert]);

  const volverLista = () => { setDetalle(null); setBodegaActual(null); setEditOpen(false); };

  const abrirAsignar = () => { setModalAsignar(true); };

  const toggleEditBodega = () => {
    if (!editOpen) {
      const b = (bodegas || []).find(x => String(x.id) === String(bodegaActual));
      if (b) {
        setEditNombre(b.nombre || '');
        setEditDir(b.direccion || '');
        setEditEstado(b.estado || 'activo');
      }
      setEditOpen(true);
    } else {
      setEditOpen(false);
    }
  };

  const guardarEditBodega = async () => {
    const nombre = editNombre.trim();
    const direccion = editDir.trim();
    if (!nombre) { setEditAlert('El nombre no puede quedar vacío.'); return; }
    try {
      const resp = await API.bodegas.actualizar(bodegaActual, { nombre, direccion, estado: editEstado });
      if (resp?.error) { setEditAlert(resp.error); return; }
      setEditOpen(false);
      showAlert('success', resp?.message);
      await cargarBodegas();
      verDetalle(bodegaActual);
    } catch (err) { setEditAlert('Error: ' + err.message); }
  };

  const guardarBodega = async () => {
    const codigo = nCodigo.trim();
    const nombre = nNombre.trim();
    const ubicacion = nUbicacion.trim();
    if (!codigo) { setNErr({ codigo: true }); setNAlert('El código de la bodega es obligatorio.'); return; }
    if (!nombre) { setNErr({ nombre: true }); setNAlert('El nombre es obligatorio.'); return; }
    setNErr({});
    try {
      await API.bodegas.crear({ codigo, nombre, direccion: ubicacion || null });
      setModalNueva(false);
      setNCodigo(''); setNNombre(''); setNUbicacion(''); setNAlert('');
      cargarBodegas();
      showAlert('success', <>Bodega <strong>{nombre}</strong> registrada correctamente.</>);
    } catch (err) {
      setNAlert(err.message);
    }
  };

  const confirmarAsignar = () => {
    setModalAsignar(false);
    showAlert('info', 'Para asignar stock a una bodega, registra una entrada de movimiento desde la vista de Movimientos.');
  };

  // CU-25: Crear anaquel
  const crearAnaquel = async () => {
    const descripcion = anqDesc.trim();
    if (!descripcion) { setAnqAlert('La descripción del anaquel es requerida.'); return; }
    if (descripcion.length > 255) { setAnqAlert('La descripción es demasiado extensa. Máximo 255 caracteres.'); return; }
    if (!bodegaActual) { setAnqAlert('No se ha seleccionado una bodega válida.'); return; }
    try {
      const resp = await API.bodegas.crearAnaquel(bodegaActual, { descripcion });
      if (resp?.error) { setAnqAlert(resp.error); return; }
      setModalAnaquel(false);
      setAnqDesc('');
      setAnqAlert('');
      showAlert('success', resp?.message);
      verDetalle(bodegaActual);
    } catch (err) { setAnqAlert('Error: ' + err.message); }
  };

  const eliminarAnaquel = async (anaquelId, desc) => {
    if (!(await confirm('¿Eliminar el anaquel "' + desc + '"? Esta acción no se puede deshacer.', 'Eliminar anaquel'))) return;
    try {
      const resp = await API.bodegas.eliminarAnaquel(bodegaActual, anaquelId);
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      verDetalle(bodegaActual);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  // SONNET-4: Editar anaquel
  const abrirEditarAnaquel = (a) => { setEditAnaquel({ id: a.id, descripcion: a.descripcion }); setEditAnaquelAlert(''); };

  const guardarEditarAnaquel = async () => {
    const descripcion = editAnaquel.descripcion.trim();
    if (!descripcion) { setEditAnaquelAlert('La descripción del anaquel es requerida.'); return; }
    if (descripcion.length > 255) { setEditAnaquelAlert('La descripción es demasiado extensa. Máximo 255 caracteres.'); return; }
    try {
      const resp = await API.bodegas.editarAnaquel(bodegaActual, editAnaquel.id, { descripcion });
      if (resp?.error) { setEditAnaquelAlert(resp.error); return; }
      setEditAnaquel(null);
      showAlert('success', resp?.message);
      verDetalle(bodegaActual);
    } catch (err) { setEditAnaquelAlert('Error: ' + err.message); }
  };

  // SONNET-4: Eliminar bodega
  const eliminarBodegaActual = async () => {
    if (!(await confirm('¿Eliminar la bodega "' + bodegaNombreActual + '"? Esta acción no se puede deshacer y requiere que no tenga stock asignado.', 'Eliminar bodega'))) return;
    setEliminandoBodega(true);
    try {
      const resp = await API.bodegas.eliminar(bodegaActual);
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      volverLista();
      cargarBodegas();
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    } finally {
      setEliminandoBodega(false);
    }
  };

  const anqLen = anqDesc.length;
  const anqColor = anqLen > 255 ? 'var(--danger)' : anqLen >= 230 ? 'var(--warning)' : 'var(--gray)';
  const bodegaNombreActual = (bodegas || []).find(x => String(x.id) === String(bodegaActual))?.nombre || `Bodega ${bodegaActual}`;
  const anaqueles = detalle?.anaqueles || [];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Bodegas</div>
          <div className="page-subtitle">Gestión de almacenes físicos y stock por ubicación</div>
        </div>
        {verGerencia && (
          <button className="btn btn-primary" onClick={() => setModalNueva(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Nueva bodega
          </button>
        )}
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Grid de cards */}
      {!detalle && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 16, marginBottom: 24 }} id="bodegas-grid">
          {bodegas !== null && bodegas.length === 0 && (
            <div className="empty-state"><div className="empty-state-icon">🏭</div><p>No hay bodegas registradas.</p></div>
          )}
          {(bodegas || []).map(b => (
            <div key={b.id} className="card" style={{ cursor: 'pointer', transition: 'border-color .15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#fe8f01'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#e0e0e0'; }}
              onClick={() => verDetalle(b.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div style={{ width: 44, height: 44, background: 'var(--orange-light)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fe8f01" strokeWidth="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                </div>
                <span className={`badge ${b.estado === 'activo' ? 'badge-success' : 'badge-gray'}`}>{b.estado}</span>
              </div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{b.nombre}</div>
              <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 14 }}>{b.direccion || 'Sin dirección'}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
                <span style={{ fontSize: 12, color: 'var(--gray)' }}>SKUs: <b style={{ color: '#000' }}>{b.total_skus || 0}</b></span>
                <span style={{ fontSize: 12, color: 'var(--orange)', fontWeight: 500 }}>Ver detalle →</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detalle de bodega (FR-16) */}
      {detalle && (
        <div id="detalle-bodega">
          <button className="btn btn-ghost" style={{ marginBottom: 16 }} onClick={volverLista}>← Volver a bodegas</button>
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }} id="det-nombre">{detalle.nombre}</div>
                <div style={{ fontSize: 12, color: 'var(--gray)' }} id="det-meta">ID: {detalle.id} · {detalle.direccion || 'Sin dirección'}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="badge badge-orange" id="det-productos">{detalle.materiales?.length || 0} materiales</span>
                {verGerencia && <button className="btn btn-ghost btn-sm" onClick={toggleEditBodega}>Editar bodega</button>}
                {verGerencia && <button className="btn btn-secondary btn-sm" onClick={abrirAsignar}>+ Asignar producto</button>}
                {puedeEliminarBodega && (
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={eliminandoBodega} onClick={eliminarBodegaActual}>
                    {eliminandoBodega ? 'Eliminando...' : 'Eliminar bodega'}
                  </button>
                )}
              </div>
            </div>

            {/* Form editar bodega (CU-21) */}
            {editOpen && (
              <div id="edit-bodega-form" style={{ marginBottom: 16, padding: 16, background: 'var(--bg-alt)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div id="edit-bodega-alert">{editAlert && <div className="alert alert-danger">{editAlert}</div>}</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
                    <label className="form-label">Nombre</label>
                    <input className="form-control" id="edit-bod-nombre" value={editNombre} onChange={e => setEditNombre(e.target.value)} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
                    <label className="form-label">Dirección</label>
                    <input className="form-control" id="edit-bod-dir" value={editDir} onChange={e => setEditDir(e.target.value)} />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, minWidth: 140 }}>
                    <label className="form-label">Estado</label>
                    <select className="form-control" id="edit-bod-estado" value={editEstado} onChange={e => setEditEstado(e.target.value)}>
                      <option value="activo">Activo</option>
                      <option value="inactiva">Inactiva</option>
                    </select>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={guardarEditBodega}>Guardar</button>
                  <button className="btn btn-ghost btn-sm" onClick={toggleEditBodega}>Cancelar</button>
                </div>
              </div>
            )}
            <div className="section-label">Productos en esta bodega</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>SKU</th><th>Nombre</th><th>Unidad</th><th>Stock físico</th><th>Reservado para OT</th></tr>
                </thead>
                <tbody id="tbody-bodega">
                  {(!detalle.materiales || detalle.materiales.length === 0) && (
                    <tr><td colSpan={5}><div className="empty-state"><p>Sin existencias registradas en esta bodega.</p></div></td></tr>
                  )}
                  {(detalle.materiales || []).map(i => {
                    const color = parseFloat(i.cantidad_fisica || 0) <= parseFloat(i.stock_critico || 0) ? 'var(--danger)'
                                : parseFloat(i.cantidad_fisica || 0) <= parseFloat(i.stock_minimo || 0)  ? 'var(--warning)'
                                : 'inherit';
                    return (
                      <tr key={i.sku}>
                        <td><span className="td-mono">{i.sku}</span></td>
                        <td style={{ fontWeight: 500, fontSize: 13 }}>{i.nombre}</td>
                        <td style={{ color: 'var(--gray)', fontSize: 13 }}>{i.unidad_medida || '—'}</td>
                        <td style={{ fontWeight: 600, color }}>{formatQty(i.cantidad_fisica)}</td>
                        <td style={{ color: 'var(--gray)', fontSize: 13 }}>{formatQty(i.cantidad_reservada)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Anaqueles (CU-25) */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #f0f0f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="section-label" style={{ marginBottom: 0 }}>Anaqueles</div>
                {verGerencia && <button className="btn btn-secondary btn-sm" onClick={() => setModalAnaquel(true)}>+ Crear anaquel</button>}
              </div>
              <div id="anaqueles-list" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {anaqueles.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 16, color: 'var(--gray)', fontSize: 13 }}>Sin anaqueles registrados en esta bodega.</div>
                )}
                {anaqueles.map(a => {
                  // OPUS-5: productos ubicados en este anaquel
                  const productos = a.productos || [];
                  return (
                    <div key={a.id} style={{ padding: '10px 14px', background: 'var(--bg-alt)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{a.descripcion}</div>
                          <div style={{ fontSize: 11, color: 'var(--gray)' }}>
                            ID: {a.id} · {productos.length === 0 ? 'sin productos asignados' : `${productos.length} producto(s)`}
                          </div>
                        </div>
                        {verGerencia && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn btn-ghost btn-sm btn-icon" title="Editar anaquel" onClick={() => abrirEditarAnaquel(a)}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)', fontSize: 11 }} onClick={() => eliminarAnaquel(a.id, a.descripcion)}>Eliminar</button>
                          </div>
                        )}
                      </div>
                      {productos.length > 0 && (
                        <ul style={{ margin: '8px 0 0 0', padding: '8px 0 0 18px', fontSize: 12, borderTop: '1px dashed var(--border)' }}>
                          {productos.map(pr => (
                            <li key={pr.sku}>
                              <code>{pr.sku}</code> — {pr.nombre}: <strong>{formatQty(pr.cantidad)}</strong> {pr.unidad || ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* OPUS-5: stock de la bodega todavia sin anaquel asignado */}
              {detalle?.sin_anaquel?.materiales > 0 && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: '#FFF3CD', borderRadius: 6, fontSize: 12, color: '#856404' }}>
                  {detalle.sin_anaquel.materiales} material(es) de esta bodega ({formatQty(detalle.sin_anaquel.cantidad)} unidades) todavía no tienen anaquel asignado.
                  Se les asigna al registrar una entrada eligiendo el anaquel de destino.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal nueva bodega (FR-13) */}
      {modalNueva && (
        <div className="modal-backdrop show" id="modal-nueva" onClick={e => { if (e.target === e.currentTarget) setModalNueva(false); }}>
          <div className="modal">
            <div className="modal-header">
              <div><div className="modal-title">Nueva Bodega</div><div className="modal-subtitle">Registrar almacén físico</div></div>
              <button className="modal-close" onClick={() => setModalNueva(false)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div id="modal-nueva-alert">{nAlert && <div className="alert alert-danger">{nAlert}</div>}</div>
              <div className="form-group">
                <label className="form-label" htmlFor="n-codigo">Código único <span className="required">*</span></label>
                <input className="form-control" id="n-codigo" placeholder="BOD-004" value={nCodigo} onChange={e => setNCodigo(e.target.value)}
                  style={nErr.codigo ? { borderColor: 'var(--danger)' } : undefined} />
                <div className="form-hint">Alfanumérico, irrepetible. Ej: BOD-001, CDS-01</div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="n-nombre">Nombre <span className="required">*</span></label>
                <input className="form-control" id="n-nombre" placeholder="Bodega Central" value={nNombre} onChange={e => setNNombre(e.target.value)}
                  style={nErr.nombre ? { borderColor: 'var(--danger)' } : undefined} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="n-ubicacion">Ubicación física</label>
                <input className="form-control" id="n-ubicacion" placeholder="Planta principal, Sede Norte..." value={nUbicacion} onChange={e => setNUbicacion(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModalNueva(false)}>Cancelar</button>
              <button className="btn btn-primary" id="btn-guardar-bodega" onClick={guardarBodega}>Registrar bodega</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal asignar producto (FR-14) */}
      {modalAsignar && (
        <div className="modal-backdrop show" id="modal-asignar" onClick={e => { if (e.target === e.currentTarget) setModalAsignar(false); }}>
          <div className="modal">
            <div className="modal-header">
              <div><div className="modal-title">Asignar producto</div><div className="modal-subtitle" id="asignar-subtitle">{bodegaNombreActual}</div></div>
              <button className="modal-close" onClick={() => setModalAsignar(false)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div id="modal-asignar-alert"></div>
              <div className="form-group">
                <label className="form-label">Producto <span className="required">*</span></label>
                <select className="form-control" id="asignar-producto" value={asignarProducto} onChange={e => setAsignarProducto(e.target.value)}>
                  <option value="">Seleccionar por SKU...</option>
                  {PRODUCTOS_ASIGNAR.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="asignar-ubicacion">Ubicación interna</label>
                <input className="form-control" id="asignar-ubicacion" placeholder="Anaquel A1, Rack B2..." value={asignarUbic} onChange={e => setAsignarUbic(e.target.value)} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModalAsignar(false)}>Cancelar</button>
              <button className="btn btn-primary" id="btn-confirmar-asignar" onClick={confirmarAsignar}>Asignar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal crear anaquel (CU-25) */}
      {modalAnaquel && (
        <div className="modal-backdrop show" id="modal-anaquel" onClick={e => { if (e.target === e.currentTarget) setModalAnaquel(false); }}>
          <div className="modal">
            <div className="modal-header">
              <div><div className="modal-title">Crear Anaquel</div><div className="modal-subtitle" id="anaquel-subtitle">Subdivisión interna de bodega</div></div>
              <button className="modal-close" onClick={() => setModalAnaquel(false)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div id="modal-anaquel-alert">{anqAlert && <div className="alert alert-danger">{anqAlert}</div>}</div>
              <div className="form-group">
                <label className="form-label" htmlFor="anq-desc">Descripción / Identificador <span className="required">*</span></label>
                <input className="form-control" id="anq-desc" placeholder="Ej: A-01 Estante superior izquierdo" value={anqDesc} onChange={e => setAnqDesc(e.target.value)} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                  <div className="form-hint" style={{ margin: 0 }}>Máximo 255 caracteres. Debe ser único dentro de la bodega.</div>
                  <div id="anq-desc-counter" style={{ fontSize: 11, color: anqColor }}>{anqLen} / 255</div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModalAnaquel(false)}>Cancelar</button>
              <button className="btn btn-primary" id="btn-crear-anaquel" onClick={crearAnaquel}>Crear anaquel</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar anaquel (SONNET-4) */}
      {editAnaquel && (
        <div className="modal-backdrop show" id="modal-editar-anaquel" onClick={e => { if (e.target === e.currentTarget) setEditAnaquel(null); }}>
          <div className="modal">
            <div className="modal-header">
              <div><div className="modal-title">Editar Anaquel</div><div className="modal-subtitle">ID: {editAnaquel.id}</div></div>
              <button className="modal-close" onClick={() => setEditAnaquel(null)}>&#x2715;</button>
            </div>
            <div className="modal-body">
              <div id="modal-editar-anaquel-alert">{editAnaquelAlert && <div className="alert alert-danger">{editAnaquelAlert}</div>}</div>
              <div className="form-group">
                <label className="form-label" htmlFor="edit-anq-desc">Descripción / Identificador <span className="required">*</span></label>
                <input className="form-control" id="edit-anq-desc" placeholder="Ej: A-01 Estante superior izquierdo"
                  value={editAnaquel.descripcion} onChange={e => setEditAnaquel({ ...editAnaquel, descripcion: e.target.value })} />
                <div className="form-hint">Máximo 255 caracteres. Debe ser único dentro de la bodega.</div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setEditAnaquel(null)}>Cancelar</button>
              <button className="btn btn-primary" id="btn-guardar-anaquel" onClick={guardarEditarAnaquel}>Guardar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
