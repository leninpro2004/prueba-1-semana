import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import { fechaLocal, fechaHoraLocal, datetimeLocal } from '../../utils/format';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { useConfirm } from '../../hooks/useDialog';
import { overlayStyle, boxStyle, titleStyle, cancelBtnStyle, okBtnStyle } from '../../components/ConfirmDialog';

const esActivo = (e) => ['activo', 'activa'].includes(e);
// Fecha LOCAL (con toISOString(), de noche el "hasta" era mañana y el backend lo rechazaba por futuro)
const isoDay = (d) => fechaLocal(d);
const IconX = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;

/**
 * Gestión de Usuarios — conversión 1:1 de usuarios/lista.html.
 * (El HTML no contiene data-rol: toda la sección "Administración" ya se oculta a JOP en el sidebar.)
 * ?creado= / ?actualizado= muestran la alerta de éxito al volver de crear.html.
 */
export default function UsuarioLista() {
  usePageTitle('Gestión de Usuarios');
  const { alert, showAlert } = useAlert();
  const confirm = useConfirm();
  const [params] = useSearchParams();

  const [tab, setTab] = useState('usuarios');
  const [q, setQ] = useState('');
  const [rol, setRol] = useState('');
  const [estado, setEstado] = useState('');
  const [usuarios, setUsuarios] = useState([]);
  const [usuariosAud, setUsuariosAud] = useState([]);

  // Auditoría (FR-60)
  const hoy = new Date();
  const hace30 = new Date(hoy); hace30.setDate(hoy.getDate() - 30);
  const [audDesde, setAudDesde] = useState(isoDay(hace30));
  const [audHasta, setAudHasta] = useState(isoDay(hoy));
  const [audUsuario, setAudUsuario] = useState('');
  const [audAccion, setAudAccion] = useState('');
  const [acciones, setAcciones] = useState([]);
  const [auditoria, setAuditoria] = useState([]);
  const [audError, setAudError] = useState('');

  // Modal editar permisos (FR-61)
  const [edit, setEdit] = useState(null); // { id, nombre, rol, estado, origRol, origEstado, detalle, alerta }
  // Modal recuperar contraseña (FR-56)
  const [pass, setPass] = useState(null); // { id, nombre, temp, generando }
  // Diálogo programar activación/desactivación (CU-92/93)
  const [prog, setProg] = useState(null); // { id, nombre, esActivo, valor, min }

  const alertaInicial = useRef(false);
  useEffect(() => {
    if (alertaInicial.current) return;
    alertaInicial.current = true;
    if (params.get('creado')) showAlert('success', <>Usuario <strong>{params.get('creado')}</strong> creado correctamente.</>);
    if (params.get('actualizado')) showAlert('success', <>Usuario <strong>{params.get('actualizado')}</strong> actualizado correctamente.</>);
  }, [params, showAlert]);

  const filtrarUsuarios = useCallback(async () => {
    try {
      const data = await API.usuarios.listar({ buscar: q || null, rol: rol || null, estado: estado || null });
      setUsuarios(Array.isArray(data) ? data : []);
    } catch (err) {
      showAlert('danger', 'Error cargando usuarios: ' + err.message);
    }
  }, [q, rol, estado, showAlert]);

  useEffect(() => { filtrarUsuarios(); }, [filtrarUsuarios]);
  useEffect(() => { API.usuarios.listar().then(u => setUsuariosAud(u || [])).catch(() => {}); }, []);
  useEffect(() => { API.auditoria.acciones().then(a => setAcciones(Array.isArray(a) ? a : [])).catch(() => {}); }, []);

  const pagU = usePagination(usuarios, 20);
  const pagA = usePagination(auditoria, 20);

  const cargarAuditoria = useCallback(async () => {
    // CU-88 CP3/CP4: validaciones de fechas
    if (audDesde && audHasta && audDesde > audHasta) { setAudError('La fecha de inicio no puede ser posterior a la fecha de fin.'); return; }
    const h = isoDay(new Date());
    if ((audDesde && audDesde > h) || (audHasta && audHasta > h)) { setAudError('No se pueden buscar registros con fechas futuras.'); return; }
    setAudError('');
    try {
      const data = await API.usuarios.auditoria({ desde: audDesde, hasta: audHasta, usuario_id: audUsuario || undefined, accion: audAccion || undefined });
      setAuditoria(Array.isArray(data) ? data : []);
    } catch (err) {
      showAlert('danger', 'Error cargando auditoría: ' + err.message);
    }
  }, [audDesde, audHasta, audUsuario, audAccion, showAlert]);

  // Los selects de usuario y accion re-filtran automáticamente cuando la pestaña de auditoría está activa
  useEffect(() => {
    if (tab === 'auditoria') cargarAuditoria();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audUsuario, audAccion]);

  // CU-88 / SONNET-6: resetea los 4 filtros combinables (desde, hasta, usuario, accion)
  const limpiarFiltrosAuditoria = async () => {
    const d = isoDay(hace30), h = isoDay(hoy);
    setAudDesde(d); setAudHasta(h); setAudUsuario(''); setAudAccion(''); setAudError('');
    try {
      const data = await API.usuarios.auditoria({ desde: d, hasta: h, usuario_id: undefined, accion: undefined });
      setAuditoria(Array.isArray(data) ? data : []);
    } catch (err) {
      showAlert('danger', 'Error cargando auditoría: ' + err.message);
    }
  };

  const switchTab = (t) => {
    setTab(t);
    if (t === 'auditoria') {
      if (!audDesde || !audHasta) { setAudHasta(isoDay(hoy)); setAudDesde(isoDay(hace30)); }
      cargarAuditoria().catch(err => console.error('Error auto-cargando auditoría:', err));
    }
  };

  /* ── Editar permisos ── */
  const abrirEditarPermisos = (u) => {
    const estadoNorm = esActivo(u.estado?.toLowerCase()) ? 'activa' : 'inactivo';
    setEdit({ id: u.id, nombre: u.nombre_completo || u.username || '', rol: u.rol, estado: estadoNorm, origRol: u.rol, origEstado: estadoNorm, detalle: '', alerta: null });
  };

  const guardarCambios = async () => {
    if (edit.rol === edit.origRol && edit.estado === edit.origEstado) {
      setEdit({ ...edit, alerta: { type: 'warning', msg: 'No se detectaron cambios. Modifique al menos un campo antes de guardar.' } });
      return;
    }
    if (!edit.rol) { setEdit({ ...edit, alerta: { type: 'danger', msg: 'Debes asignar un rol al usuario.' } }); return; }
    try {
      await API.usuarios.editarPermisos(edit.id, { rol: edit.rol, estado: edit.estado });
      setEdit(null);
      filtrarUsuarios();
      showAlert('success', 'Permisos actualizados. Cambio registrado en auditoría.');
    } catch (err) {
      setEdit({ ...edit, alerta: { type: 'danger', msg: err.message } });
    }
  };

  /* ── Recuperar contraseña (CU-83/84) ── */
  const abrirRecuperarPass = (u) => setPass({ id: u.id, nombre: u.nombre_completo || u.username || '' || ('Usuario #' + u.id), temp: null, generando: false });

  const generarPassTemporal = async () => {
    setPass(p => ({ ...p, generando: true }));
    try {
      const data = await API.usuarios.recuperarPassword(pass.id);
      if (data?.error) { showAlert('danger', data.error); setPass(null); return; }
      setPass(p => ({ ...p, temp: data?.password_temporal || '—', generando: false }));
    } catch (err) {
      setPass(null);
      showAlert('danger', 'Error: ' + err.message);
    }
  };

  /* ── Programar activación/desactivación ── */
  const abrirProgramar = (u) => {
    const ahora = new Date(); ahora.setMinutes(ahora.getMinutes() + 1);
    setProg({ id: u.id, nombre: u.nombre_completo || u.username || '', esActivo: esActivo(u.estado), valor: '', min: datetimeLocal(ahora) });
  };

  const confirmarProgramar = () => {
    if (!prog.valor) { showAlert('danger', 'Debe seleccionar una fecha y hora.'); return; }
    const fechaObj = new Date(prog.valor);
    if (fechaObj <= new Date()) { showAlert('danger', 'La fecha programada debe ser posterior a la actual.'); return; }
    const { id, esActivo: act } = prog;
    setProg(null);
    const apiCall = act
      ? API.usuarios.programarDesactivacion(id, { fecha: fechaObj.toISOString() })
      : API.usuarios.programarActivacion(id, { fecha: fechaObj.toISOString() });
    apiCall.then(resp => {
      if (resp?.error) { showAlert('danger', resp.error); return; }
      showAlert('success', resp?.message);
      filtrarUsuarios();   // OPUS-8: refrescar para mostrar el badge de la programación
    }).catch(err => showAlert('danger', 'Error: ' + err.message));
  };

  // OPUS-8: cancelar una programación pendiente
  const cancelarProgramacion = async (u, tipo) => {
    const texto = tipo === 'desactivacion' ? 'desactivación' : 'activación';
    if (!(await confirm(`¿Cancelar la ${texto} programada de ${u.username}?`, 'Cancelar programación'))) return;
    try {
      const resp = await API.usuarios.cancelarProgramacion(u.id, tipo);
      showAlert('success', resp?.message || 'Programación cancelada');
      filtrarUsuarios();
    } catch (err) {
      showAlert('danger', 'Error al cancelar la programación: ' + err.message);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Gestión de Usuarios</div>
          <div className="page-subtitle">Control de cuentas, roles y permisos de acceso</div>
        </div>
        <Link to="/usuarios/crear" className="btn btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nuevo usuario
        </Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Tabs (FR-60) */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <div className={'tab' + (tab === 'usuarios' ? ' active' : '')} id="tab-usuarios" onClick={() => switchTab('usuarios')}>👤 Usuarios</div>
        <div className={'tab' + (tab === 'auditoria' ? ' active' : '')} id="tab-auditoria" onClick={() => switchTab('auditoria')}>🔍 Auditoría de acciones</div>
      </div>

      {/* TAB USUARIOS */}
      {tab === 'usuarios' && (
        <div id="panel-usuarios">
          <div className="card">
            <div className="filter-row">
              <div className="search-bar" style={{ flex: 1 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15" style={{ color: 'var(--gray)' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input id="search-input" placeholder="Buscar por ID, nombre o email..." value={q} onChange={e => setQ(e.target.value)} />
              </div>
              <select className="form-control" id="filter-rol" style={{ width: 140 }} value={rol} onChange={e => setRol(e.target.value)}>
                <option value="">Todos los roles</option>
                <option value="gerencia">Gerencia</option>
                <option value="jop">JOP</option>
              </select>
              <select className="form-control" id="filter-estado" style={{ width: 140 }} value={estado} onChange={e => setEstado(e.target.value)}>
                <option value="">Todos los estados</option>
                <option value="activa">Activos</option>
                <option value="inactivo">Inactivos</option>
              </select>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>ID</th><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th>Creado</th><th>Acciones</th></tr>
                </thead>
                <tbody id="tbody-usuarios">
                  {usuarios.length === 0 && <EmptyRow colSpan={7} emptyMsg={<div className="empty-state"><div className="empty-state-icon">👤</div><p>No se encontraron usuarios.</p></div>} />}
                  {pagU.items.map(u => {
                    const nombre = u.nombre_completo || u.username || '';
                    const initials = nombre.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || '??';
                    return (
                      <tr key={u.id}>
                        <td><span className="td-mono">{u.username}</span></td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--orange-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--orange-dark)', flexShrink: 0 }}>{initials}</div>
                            <div><div style={{ fontWeight: 500, fontSize: 13 }}>{nombre}</div></div>
                          </div>
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--orange)' }}>{u.correo || '—'}</td>
                        <td><span className={`badge ${u.rol === 'gerencia' ? 'badge-orange' : 'badge-info'}`}>{u.rol}</span></td>
                        <td>
                          <span className={`badge ${esActivo(u.estado) ? 'badge-success' : 'badge-gray'}`}>{esActivo(u.estado) ? 'activa' : 'inactiva'}</span>
                          {/* OPUS-8: programación pendiente, con opción de cancelarla */}
                          {u.desactivacion_programada && (
                            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                              ⏻ Desactivación: {new Date(u.desactivacion_programada).toLocaleString('es-CL')}
                              {' '}
                              <button className="btn btn-ghost" style={{ padding: '0 4px', fontSize: 11 }}
                                onClick={() => cancelarProgramacion(u, 'desactivacion')}>cancelar</button>
                            </div>
                          )}
                          {u.activacion_programada && (
                            <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 4 }}>
                              ⏻ Activación: {new Date(u.activacion_programada).toLocaleString('es-CL')}
                              {' '}
                              <button className="btn btn-ghost" style={{ padding: '0 4px', fontSize: 11 }}
                                onClick={() => cancelarProgramacion(u, 'activacion')}>cancelar</button>
                            </div>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--gray)' }}>{fechaLocal(u.creado)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <Link to={`/usuarios/crear?id=${u.id}`} className="btn btn-ghost btn-sm" title="Editar datos"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></Link>
                            <button className="btn btn-ghost btn-sm btn-editar-permisos" title="Editar rol y estado" onClick={() => abrirEditarPermisos(u)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M4.93 4.93a10 10 0 000 14.14"/></svg></button>
                            <button className="btn btn-ghost btn-sm btn-recuperar-pass" title="Recuperar contraseña" onClick={() => abrirRecuperarPass(u)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg></button>
                            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} title="Programar desactivación/activación" onClick={() => abrirProgramar(u)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination {...pagU} />
          </div>
        </div>
      )}

      {/* TAB AUDITORÍA (FR-60) */}
      {tab === 'auditoria' && (
        <div id="panel-auditoria">
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Filtrar auditoría</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
                <label className="form-label">Desde</label>
                <input className="form-control" type="date" id="aud-desde" value={audDesde} onChange={e => setAudDesde(e.target.value)} />
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
                <label className="form-label">Hasta</label>
                <input className="form-control" type="date" id="aud-hasta" value={audHasta} onChange={e => setAudHasta(e.target.value)} />
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
                <label className="form-label">Usuario</label>
                <select className="form-control" id="aud-usuario" value={audUsuario} onChange={e => setAudUsuario(e.target.value)}>
                  <option value="">Todos los usuarios</option>
                  {usuariosAud.map(u => <option key={u.id} value={u.id}>{u.username || u.nombre_completo || u.id}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
                <label className="form-label">Tipo de acción</label>
                <select className="form-control" id="aud-accion" value={audAccion} onChange={e => setAudAccion(e.target.value)}>
                  <option value="">Todas las acciones</option>
                  {acciones.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={cargarAuditoria}>Filtrar</button>
              <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end' }} onClick={limpiarFiltrosAuditoria}>Limpiar filtros</button>
            </div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Timestamp</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead>
                <tbody id="tbody-auditoria">
                  {audError && <tr><td colSpan={4}><div className="empty-state"><p style={{ color: 'var(--danger)' }}>{audError}</p></div></td></tr>}
                  {!audError && auditoria.length === 0 && <EmptyRow colSpan={4} emptyMsg={<div className="empty-state"><p>Sin registros de auditoría en el periodo.</p></div>} />}
                  {!audError && pagA.items.map((a, i) => (
                    <tr key={a.id ?? i}>
                      <td><span className="td-mono" style={{ fontSize: 11 }}>{fechaHoraLocal(a.timestamp, true)}</span></td>
                      <td style={{ fontSize: 13, fontWeight: 500 }}>{a.usuario || '—'}</td>
                      <td><span className="badge badge-gray">{a.accion || '—'}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{a.detalle || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!audError && <Pagination {...pagA} />}
            <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 12 }}>Los registros de auditoría son inmutables y no pueden ser modificados ni eliminados (FR-60).</p>
          </div>
        </div>
      )}

      {/* MODAL EDITAR ROL/ESTADO (FR-61) */}
      {edit && (
        <div className="modal-overlay" id="modal-editar" style={{ display: 'flex' }}>
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Editar permisos de usuario</div>
                <div className="modal-subtitle" id="modal-subtitle">Editando permisos de: {edit.nombre}</div>
              </div>
              <button className="modal-close" onClick={() => setEdit(null)}><IconX /></button>
            </div>
            <div className="modal-body">
              <div id="alert-modal">{edit.alerta && <div className={`alert alert-${edit.alerta.type}`} style={{ fontSize: 12 }}>{edit.alerta.msg}</div>}</div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Rol <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <select className="form-control" id="edit-rol" value={edit.rol} onChange={e => setEdit({ ...edit, rol: e.target.value })}>
                    <option value="gerencia">Gerencia</option>
                    <option value="jop">JOP</option>
                  </select>
                  <p style={{ fontSize: 11, color: 'var(--gray)', marginTop: 4 }}>Gerencia: acceso completo · JOP: sin visualización de costos</p>
                </div>
                <div className="form-group">
                  <label className="form-label">Estado <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <select className="form-control" id="edit-estado" value={edit.estado} onChange={e => setEdit({ ...edit, estado: e.target.value })}>
                    <option value="activa">Activo</option>
                    <option value="inactivo">Inactivo</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Detalle del cambio <span style={{ color: 'var(--gray)', fontWeight: 400 }}>(máx. 500 caracteres)</span></label>
                <textarea className="form-control" id="edit-detalle" rows={2} maxLength={500} placeholder="Ej: Cambio de rol por reorganización de equipo..."
                  value={edit.detalle} onChange={e => setEdit({ ...edit, detalle: e.target.value })} />
                <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 2 }} id="edit-detalle-count">{edit.detalle.length}/500</div>
              </div>
              <div className="alert alert-info" style={{ fontSize: 12 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Este cambio se registrará automáticamente en auditoría con fecha, hora e identificador de quien lo realizó (FR-61).
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={guardarCambios}>Guardar cambios</button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL RECUPERAR CONTRASEÑA (FR-56) */}
      {pass && (
        <div className="modal-overlay" id="modal-pass" style={{ display: 'flex' }}>
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="modal-title">Recuperación de contraseña</div>
                <div className="modal-subtitle" id="pass-subtitle">Restablecer contraseña de: {pass.nombre}</div>
              </div>
              <button className="modal-close" onClick={() => setPass(null)}><IconX /></button>
            </div>
            <div className="modal-body">
              <div className="alert alert-warning" style={{ fontSize: 12, marginBottom: 16 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Se generará una contraseña temporal alfanumérica. Debe comunicarla personalmente al usuario. Al iniciar sesión con la clave temporal, el sistema exigirá cambiarla.
              </div>
              <div className="form-group">
                <label className="form-label">Usuario</label>
                <input className="form-control" id="pass-nombre" readOnly value={pass.nombre} style={{ background: 'var(--gray-light)' }} />
              </div>
              {pass.temp && (
                <div id="pass-result" style={{ marginTop: 12, padding: 12, background: '#E8F5E9', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, color: '#2E7D32', fontWeight: 600, marginBottom: 4 }}>Contraseña temporal generada:</div>
                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 2 }} id="pass-temp">{pass.temp}</div>
                  <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>Copie esta clave y entréguela al usuario de forma segura.</div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              {pass.temp ? (
                <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => setPass(null)}>Aceptar</button>
              ) : (
                <>
                  <button className="btn btn-ghost" onClick={() => setPass(null)}>Cerrar</button>
                  <button className="btn btn-primary" id="btn-generar-temp" disabled={pass.generando} onClick={generarPassTemporal}>
                    {pass.generando ? 'Generando...' : 'Generar contraseña temporal'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Diálogo programar activación/desactivación (CU-92/93) */}
      {prog && (
        <div id="pb-dialog-overlay" style={overlayStyle}>
          <div style={boxStyle}>
            <div style={titleStyle}>Programar {prog.esActivo ? 'desactivación' : 'activación'}</div>
            <div style={{ fontSize: 14, color: '#555', lineHeight: 1.5, marginBottom: 12 }}>Seleccione la fecha y hora para la {prog.esActivo ? 'desactivación' : 'activación'} de "{prog.nombre}":</div>
            <input id="pb-dlg-datetime" type="datetime-local" min={prog.min} autoFocus value={prog.valor} onChange={e => setProg({ ...prog, valor: e.target.value })}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button id="pb-dlg-cancel" style={cancelBtnStyle} onClick={() => setProg(null)}>Cancelar</button>
              <button id="pb-dlg-ok" style={okBtnStyle} onClick={confirmarProgramar}>Programar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
