import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';

const EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const OK = 'var(--success)', BAD = 'var(--danger)';

/** Gestión de Usuario (crear / editar ?id=) — conversión 1:1 de usuarios/crear.html */
export default function UsuarioCrear() {
  usePageTitle('Gestión de Usuario');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get('id');
  const modoEditar = !!editId;
  const { alert, showAlert } = useAlert();

  const [subtitle, setSubtitle] = useState('Completa todos los campos obligatorios');
  const [id, setId] = useState('');
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [rol, setRol] = useState('');
  const [estado, setEstado] = useState('activo');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [hints, setHints] = useState({}); // campo → { msg, ok }
  const [saving, setSaving] = useState(false);
  const [previewBtn, setPreviewBtn] = useState('Vista previa');
  const previewRef = useRef(null);

  const setHint = (campo, msg, ok) => setHints(h => ({ ...h, [campo]: { msg, ok } }));

  // Cargar datos reales si es modo edición
  useEffect(() => {
    if (!modoEditar) return;
    let cancelado = false;
    (async () => {
      try {
        const usuarios = await API.usuarios.listar();
        if (cancelado) return;
        const u = (usuarios || []).find(x => String(x.id) === String(editId));
        if (u) {
          setSubtitle(`Modificando datos de: ${u.username || u.id}`);
          setId(u.username || String(u.id));
          setNombre(u.nombre_completo || '');
          setEmail(u.correo || '');
          setRol(u.rol || '');
          setEstado(u.estado || 'activo');
          if (u.rol) setHint('rol', '✓', true);
        } else {
          showAlert('danger', 'Usuario no encontrado.');
        }
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error cargando datos del usuario: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [modoEditar, editId, showAlert]);

  /* ── Validaciones en tiempo real ── */
  const validarCampo = (campo, valor) => {
    const val = (valor ?? '').trim();
    switch (campo) {
      case 'id':
        if (!val) return setHint('id', 'Campo obligatorio', false);
        if (val.length > 20) return setHint('id', 'Máximo 20 caracteres', false);
        if (!/^[a-zA-Z0-9_]+$/.test(val)) return setHint('id', 'Solo letras, números y guión bajo', false);
        return setHint('id', '✓ ID válido y disponible', true);
      case 'nombre':
        if (!val || val.length < 2) return setHint('nombre', 'Mínimo 2 caracteres', false);
        if (val.length > 100) return setHint('nombre', 'Máximo 100 caracteres', false);
        return setHint('nombre', '✓', true);
      case 'email':
        if (!val) return setHint('email', 'Campo obligatorio', false);
        if (!EMAIL_RE.test(val)) return setHint('email', 'Formato inválido (ej: nombre@dominio.cl)', false);
        return setHint('email', '✓ Email válido', true);
      case 'rol':
        if (!val) return setHint('rol', 'Debes seleccionar un rol', false);
        return setHint('rol', '✓', true);
      default:
    }
  };

  // Fortaleza de contraseña
  let score = 0;
  if (pass1.length >= 8) score++;
  if (/[A-Z]/.test(pass1)) score++;
  if (/[0-9]/.test(pass1)) score++;
  if (/[^a-zA-Z0-9]/.test(pass1)) score++;
  const colores = ['#dc3545', '#dc3545', '#ffc107', '#198754', '#198754'];
  const labels = ['', 'Muy débil', 'Débil', 'Aceptable', 'Fuerte'];

  const validarPass = (p1, p2) => {
    if (modoEditar) return;
    if (p1.length < 8) setHint('pass', 'Mínimo 8 caracteres', false); else setHint('pass', '✓', true);
    if (p2 && p1 !== p2) setHint('pass2', 'Las contraseñas no coinciden', false);
    else if (p2) setHint('pass2', '✓ Coinciden', true);
  };

  const esValido = (campo) => hints[campo]?.ok === true;
  const checks = [
    { label: 'ID único y válido', ok: esValido('id') },
    { label: 'Nombre completo', ok: nombre.trim().length >= 2 },
    { label: 'Email con formato válido', ok: esValido('email') },
    { label: 'Rol asignado', ok: !!rol },
  ];
  if (!modoEditar) {
    checks.push({ label: 'Contraseña (mín. 8 caracteres)', ok: pass1.length >= 8 });
    checks.push({ label: 'Contraseñas coinciden', ok: pass1 === pass2 && pass1.length > 0 });
  }

  // Preview
  const completo = id.trim() && nombre.trim() && email.trim() && rol;
  const initials = nombre.trim() ? nombre.trim().split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '--';

  const inputStyle = (campo) => {
    const h = hints[campo];
    if (!h || !h.msg) return undefined;
    return h.ok
      ? { borderColor: OK, boxShadow: '0 0 0 3px rgba(25,135,84,.12)' }
      : { borderColor: BAD, boxShadow: '0 0 0 3px rgba(220,53,69,.12)' };
  };
  const hint = (campo) => <div className="form-hint" id={'hint-' + campo} style={{ color: hints[campo]?.ok ? OK : BAD }}>{hints[campo]?.msg || ''}</div>;

  const mostrarPreview = () => {
    previewRef.current?.scrollIntoView({ behavior: 'smooth' });
    setPreviewBtn('✓ Vista previa');
    setTimeout(() => setPreviewBtn('Vista previa'), 1500);
  };

  const guardarUsuario = async () => {
    const username = id.trim();
    const nombreVal = nombre.trim();
    const emailVal = email.trim();
    validarCampo('id', id); validarCampo('nombre', nombre); validarCampo('email', email); validarCampo('rol', rol);

    if (!username && !modoEditar) { showAlert('danger', 'El ID de usuario es obligatorio.'); return; }
    if (!nombreVal) { showAlert('danger', 'El nombre es obligatorio.'); return; }
    if (!emailVal || !EMAIL_RE.test(emailVal)) { showAlert('danger', 'El email tiene un formato inválido.'); return; }
    if (!rol) { showAlert('danger', 'Debes asignar un rol al usuario.'); return; }
    if (!modoEditar) {
      if (!pass1 || pass1.length < 8) { showAlert('danger', 'La contraseña debe tener al menos 8 caracteres.'); return; }
      if (pass1 !== pass2) { showAlert('danger', 'Las contraseñas no coinciden.'); return; }
    }

    const partes = nombreVal.split(' ');
    const primerNombre = partes[0] || '';
    const primerApellido = partes.slice(1).join(' ') || '';

    setSaving(true);
    try {
      if (modoEditar) {
        await API.usuarios.editarPermisos(editId, { rol, estado });
        navigate(`/usuarios?actualizado=${encodeURIComponent(username)}`);
      } else {
        await API.usuarios.crear({ username, correo: emailVal, password: pass1, nombre: primerNombre, apellido: primerApellido, rol, estado: 'activo' });
        navigate(`/usuarios?creado=${encodeURIComponent(username)}`);
      }
    } catch (err) {
      showAlert('danger', err.message || 'Error al guardar el usuario.');
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title" id="page-title">{modoEditar ? 'Editar usuario' : 'Nuevo usuario'}</div>
          <div className="page-subtitle" id="page-subtitle">{subtitle}</div>
        </div>
        <Link to="/usuarios" className="btn btn-ghost">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
          Volver a usuarios
        </Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>

        {/* FORMULARIO PRINCIPAL */}
        <div className="card">
          <div className="section-label">Datos de cuenta</div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">ID de usuario <span style={{ color: 'var(--danger)' }}>*</span> <span style={{ fontWeight: 400, color: 'var(--gray)' }}>(1–20 caracteres alfanuméricos)</span></label>
              <input className="form-control" id="f-id" placeholder="ej: jgarcia" maxLength={20} autoComplete="off" value={id} readOnly={modoEditar}
                style={{ ...(modoEditar ? { background: 'var(--gray-light)', cursor: 'default' } : {}), ...inputStyle('id') }}
                onChange={e => { setId(e.target.value); validarCampo('id', e.target.value); }} />
              {hint('id')}
            </div>
            <div className="form-group">
              <label className="form-label">Nombre completo <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input className="form-control" id="f-nombre" placeholder="Juan García" maxLength={100} value={nombre} style={inputStyle('nombre')}
                onChange={e => { setNombre(e.target.value); validarCampo('nombre', e.target.value); }} />
              {hint('nombre')}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Email <span style={{ color: 'var(--danger)' }}>*</span> <span style={{ fontWeight: 400, color: 'var(--gray)' }}>(debe ser único en el sistema)</span></label>
            <input className="form-control" id="f-email" type="email" placeholder="usuario@puertasblindadas.cl" value={email} style={inputStyle('email')}
              onChange={e => { setEmail(e.target.value); validarCampo('email', e.target.value); }} />
            {hint('email')}
          </div>

          <div style={{ height: 1, background: 'var(--gray-mid)', margin: '20px 0' }}></div>

          <div className="section-label">Rol y permisos</div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Rol <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select className="form-control" id="f-rol" value={rol} style={inputStyle('rol')} onChange={e => { setRol(e.target.value); validarCampo('rol', e.target.value); }}>
                <option value="" disabled>Seleccionar rol...</option>
                <option value="gerencia">Gerencia</option>
                <option value="jop">JOP</option>
              </select>
              {hint('rol')}
            </div>
            {modoEditar && (
              <div className="form-group" id="grupo-estado">
                <label className="form-label">Estado</label>
                <select className="form-control" id="f-estado" value={estado} onChange={e => setEstado(e.target.value)}>
                  <option value="activo">Activo</option>
                  <option value="inactivo">Inactivo</option>
                </select>
              </div>
            )}
          </div>

          {rol && (
            <div id="rol-descripcion" style={{ marginBottom: 20 }}>
              {rol === 'gerencia' && (
                <div style={{ background: 'var(--orange-light)', borderRadius: 'var(--radius-md)', padding: '12px 16px', fontSize: 12 }}>
                  <strong style={{ color: 'var(--orange-dark)' }}>Gerencia</strong>
                  <p style={{ color: 'var(--orange-dark)', marginTop: 4, lineHeight: 1.6 }}>Acceso completo al sistema: gestión de productos, bodegas, movimientos, alertas, proveedores, pedidos, reportes con valores monetarios y gestión de usuarios.</p>
                </div>
              )}
              {rol === 'jop' && (
                <div style={{ background: '#cff4fc', borderRadius: 'var(--radius-md)', padding: '12px 16px', fontSize: 12 }}>
                  <strong style={{ color: '#055160' }}>JOP (Jefe de Operaciones)</strong>
                  <p style={{ color: '#055160', marginTop: 4, lineHeight: 1.6 }}>Acceso operativo: registro de entradas y salidas, consulta de stock, alertas y pedidos. <strong>No visualiza costos ni precios</strong> en ninguna vista del sistema.</p>
                </div>
              )}
            </div>
          )}

          <div style={{ height: 1, background: 'var(--gray-mid)', margin: '4px 0 20px' }}></div>

          {!modoEditar && (
            <div id="bloque-password">
              <div className="section-label">Contraseña inicial</div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Contraseña <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="form-control" id="f-pass" type="password" placeholder="Mínimo 8 caracteres" value={pass1} style={inputStyle('pass')}
                    onChange={e => { setPass1(e.target.value); validarPass(e.target.value, pass2); }} />
                  {hint('pass')}
                </div>
                <div className="form-group">
                  <label className="form-label">Confirmar contraseña <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input className="form-control" id="f-pass2" type="password" placeholder="Repite la contraseña" value={pass2} style={inputStyle('pass2')}
                    onChange={e => { setPass2(e.target.value); validarPass(pass1, e.target.value); }} />
                  {hint('pass2')}
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: 'var(--gray)', marginBottom: 4 }}>Fortaleza de contraseña</div>
                <div style={{ height: 4, background: 'var(--gray-mid)', borderRadius: 2, overflow: 'hidden' }}>
                  <div id="pass-strength-bar" style={{ height: '100%', width: (score * 25) + '%', background: colores[score] || '#aaa', transition: 'width 0.3s,background 0.3s', borderRadius: 2 }}></div>
                </div>
                <div id="pass-strength-label" style={{ fontSize: 11, color: 'var(--gray)', marginTop: 4 }}>{labels[score] || ''}</div>
              </div>
              <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                El usuario deberá cambiar su contraseña en el primer inicio de sesión. Se recomienda notificarle por email.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
            <Link to="/usuarios" className="btn btn-ghost">Cancelar</Link>
            <button className="btn btn-secondary" id="btn-preview" onClick={mostrarPreview}>{previewBtn}</button>
            <button className="btn btn-primary" onClick={guardarUsuario} disabled={saving}>
              {saving ? 'Guardando...' : modoEditar ? 'Guardar cambios' : (
                <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg> Crear usuario</>
              )}
            </button>
          </div>
        </div>

        {/* PANEL LATERAL */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" id="preview-card" ref={previewRef} style={{ opacity: completo ? 1 : 0.4, transition: 'opacity 0.3s' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Vista previa</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--orange-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: 'var(--orange-dark)', flexShrink: 0 }} id="preview-avatar">{initials}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }} id="preview-nombre">{nombre.trim() || 'Nombre completo'}</div>
                <div style={{ fontSize: 12, color: 'var(--orange)' }} id="preview-email">{email.trim() || 'email@dominio.cl'}</div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, color: 'var(--gray)', fontWeight: 600, textTransform: 'uppercase' }}>ID</div>
                <div className="td-mono" style={{ fontSize: 12 }} id="preview-id">{id.trim() || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--gray)', fontWeight: 600, textTransform: 'uppercase' }}>Rol</div>
                <span className={'badge ' + (rol === 'gerencia' ? 'badge-orange' : rol === 'jop' ? 'badge-info' : 'badge-gray')} id="preview-rol-badge">{rol || '—'}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Validaciones</div>
            <div id="validacion-list" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {checks.map(c => (
                <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <div style={{ width: 16, height: 16, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, background: c.ok ? 'var(--success)' : 'var(--gray-mid)', color: c.ok ? '#fff' : 'var(--gray)' }}>{c.ok ? '✓' : '○'}</div>
                  <span style={{ color: c.ok ? 'var(--success)' : 'var(--gray)' }}>{c.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ background: '#f9f9f9', borderStyle: 'dashed' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gray)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>Roles disponibles</div>
            <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.7 }}>
              <div><strong>Gerencia:</strong> acceso completo incluyendo costos y administración de usuarios.</div>
              <div style={{ marginTop: 6 }}><strong>JOP:</strong> acceso operativo sin visualización de datos monetarios (FR-59).</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
