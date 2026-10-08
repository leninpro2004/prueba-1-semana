import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { API_BASE } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import '../assets/css/login.css';

const ErrorIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

/**
 * Login — conversión 1:1 de login.html (página standalone, sin layout).
 * Incluye modal de recuperación de contraseña en 2 pasos (CU-77 / CU-83).
 */
export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [params] = useSearchParams();

  const [userVal, setUserVal] = useState('');
  const [passVal, setPassVal] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fondo oscuro solo en esta página
  useEffect(() => {
    document.title = 'Iniciar sesión — Puertas Blindadas';
    document.body.classList.add('login-page');
    return () => document.body.classList.remove('login-page');
  }, []);

  // Timeout redirect message (CU-88) / cuenta desactivada (OPUS-8)
  useEffect(() => {
    const reason = params.get('reason');
    if (reason === 'timeout') {
      setError('Su sesión fue cerrada por inactividad. Inicie sesión nuevamente.');
    } else if (reason === 'cuenta_desactivada') {
      setError('Su cuenta ha sido desactivada por un administrador. Contacte a Gerencia.');
    }
  }, [params]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const u = userVal.trim();
    if (!u || !passVal) { setError('Ingresa tu usuario y contraseña.'); return; }

    setSubmitting(true);
    try {
      const res = await fetch(API_BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: passVal }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Usuario o contraseña incorrectos.');
        setSubmitting(false);
        return;
      }

      /* Login exitoso: guardar sesión con token y redirigir */
      login(data, passVal);
      navigate('/');
    } catch {
      setError('No se pudo conectar al servidor. Verifica que el backend esté corriendo.');
      setSubmitting(false);
    }
  };

  /* ── Modal recuperar contraseña (CU-77) ── */
  const [forgotOpen, setForgotOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [forgotAlert, setForgotAlert] = useState(null); // { type, content }
  const [forgotUser, setForgotUser] = useState('');
  const [forgotToken, setForgotToken] = useState('');
  const [forgotNewPass, setForgotNewPass] = useState('');

  const resetForgot = () => {
    // CU-83: Reiniciar modal al paso 1 cada vez que se abre
    setStep(1);
    setForgotAlert(null);
    setForgotUser('');
    setForgotToken('');
    setForgotNewPass('');
  };

  const openForgot = () => { resetForgot(); setForgotOpen(true); };
  const closeForgot = () => setForgotOpen(false);

  // Paso 1: solicitar token
  const solicitar = async () => {
    const username = forgotUser.trim();
    if (!username) { setForgotAlert({ type: 'danger', content: 'Ingresa tu nombre de usuario.' }); return; }
    try {
      const resp = await fetch(API_BASE + '/auth/solicitar-recuperacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await resp.json();

      // CU-83 CP4: Manejar rate-limit (429)
      if (resp.status === 429) {
        setForgotAlert({ type: 'danger', content: data.error || 'Demasiadas solicitudes. Intente en 15 minutos.' });
        return;
      }
      if (!resp.ok) {
        setForgotAlert({ type: 'danger', content: data.error || 'Error al procesar la solicitud.' });
        return;
      }
      // CU-83 CP2: Si no hay token, el usuario/correo no existe en el sistema
      if (!data.token_recuperacion) {
        setForgotAlert({ type: 'danger', content: `No se encontró una cuenta asociada a "${username}". Verifica el dato ingresado.` });
        return;
      }

      setForgotAlert({
        type: 'success',
        content: (
          <>
            {data.message || 'Solicitud procesada.'}
            {data.expira_en && (<><br /><small style={{ color: '#666' }}>El enlace de recuperación expira en <b>{data.expira_en}</b>.</small></>)}
            <br /><br /><b>Token (solo desarrollo):</b><br />
            <code style={{ wordBreak: 'break-all', fontSize: 11 }}>{data.token_recuperacion}</code>
          </>
        ),
      });
      setStep(2);
    } catch {
      setForgotAlert({ type: 'danger', content: 'Error de conexión.' });
    }
  };

  // Paso 2: consumir token y establecer nueva contraseña
  const restablecer = async () => {
    const token = forgotToken.trim();
    const pass = forgotNewPass;
    if (!token || !pass) { setForgotAlert({ type: 'danger', content: 'Ingresa el token y la nueva contraseña.' }); return; }
    if (pass.length < 8) { setForgotAlert({ type: 'danger', content: 'La contraseña debe tener al menos 8 caracteres.' }); return; }
    try {
      const resp = await fetch(API_BASE + '/auth/resetear-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password_nueva: pass }),
      });
      const data = await resp.json();
      if (data.error) {
        // CU-83 Exc 2: Si el token expiró y se regeneró automáticamente, mostrar el nuevo
        if (data.token_regenerado) {
          setForgotToken(data.token_regenerado);
          setForgotNewPass('');
          setForgotAlert({
            type: 'warning',
            content: (
              <>
                {data.error}
                {data.expira_en && (<><br /><small style={{ color: '#666' }}>El nuevo enlace expira en <b>{data.expira_en}</b>.</small></>)}
                <br /><br /><b>Nuevo token (solo desarrollo):</b><br />
                <code style={{ wordBreak: 'break-all', fontSize: 11 }}>{data.token_regenerado}</code>
              </>
            ),
          });
          return;
        }
        // Token inválido (no expirado) — volver al paso 1
        setForgotAlert({
          type: 'danger',
          content: (
            <>
              {data.error}<br />
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} id="btn-nuevo-token" onClick={resetForgot}>
                Solicitar nuevo enlace
              </button>
            </>
          ),
        });
        return;
      }
      setForgotAlert({ type: 'success', content: data.message });
      setTimeout(() => setForgotOpen(false), 2500);
    } catch {
      setForgotAlert({ type: 'danger', content: 'Error de conexión.' });
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">

        <div className="login-logo">PB</div>
        <div className="login-title">Iniciar sesión</div>
        <div className="login-sub">Puertas Blindadas · Sistema de Inventario</div>

        <div id="alert-container">
          {error && (
            <div className="alert alert-danger" style={{ marginBottom: 16 }}>
              <ErrorIcon />
              {error}
            </div>
          )}
        </div>

        <form id="login-form" noValidate onSubmit={onSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="input-user">
              Usuario o email <span className="required">*</span>
            </label>
            <input
              className="form-control"
              id="input-user"
              type="text"
              placeholder="ej: jgarcia"
              autoComplete="username"
              required
              value={userVal}
              onChange={e => { setUserVal(e.target.value); setError(''); }}
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="input-pass">
              Contraseña <span className="required">*</span>
            </label>
            <input
              className="form-control"
              id="input-pass"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              required
              value={passVal}
              onChange={e => { setPassVal(e.target.value); setError(''); }}
            />
          </div>

          <a className="forgot-link" id="forgot-link" onClick={openForgot}>¿Olvidaste tu contraseña?</a>

          <button className="btn btn-primary login-submit" type="submit" id="btn-submit" disabled={submitting}>
            {submitting ? 'Verificando...' : 'Ingresar'}
          </button>
        </form>

        <p className="login-demo">
          Usa tu usuario y contraseña de PostgreSQL
        </p>

      </div>

      {/* Modal recuperar contraseña (CU-77) */}
      <div
        className={'modal-backdrop' + (forgotOpen ? ' show' : '')}
        id="modal-forgot"
        onClick={e => { if (e.target === e.currentTarget) closeForgot(); }}
      >
        <div className="modal">
          <div className="modal-header">
            <div>
              <div className="modal-title">Recuperar contraseña</div>
              <div className="modal-subtitle">Ingresa tu correo electrónico o nombre de usuario para generar un enlace de recuperación</div>
            </div>
            <button className="modal-close" onClick={closeForgot}>&#x2715;</button>
          </div>
          <div className="modal-body">
            <div id="forgot-alert">
              {forgotAlert && <div className={`alert alert-${forgotAlert.type}`}>{forgotAlert.content}</div>}
            </div>
            {/* Paso 1: solicitar */}
            {step === 1 && (
              <div id="forgot-step1">
                <div className="form-group">
                  <label className="form-label" htmlFor="forgot-user">
                    Correo electrónico o nombre de usuario <span className="required">*</span>
                  </label>
                  <input className="form-control" id="forgot-user" type="text"
                    placeholder="ej: usuario@puertasblindadas.cl o jgarcia"
                    value={forgotUser} onChange={e => setForgotUser(e.target.value)} />
                </div>
              </div>
            )}
            {/* Paso 2: ingresar token + nueva contraseña */}
            {step === 2 && (
              <div id="forgot-step2">
                <div className="form-group">
                  <label className="form-label" htmlFor="forgot-token">Token de recuperación</label>
                  <input className="form-control" id="forgot-token" type="text" placeholder="Pegar token recibido"
                    value={forgotToken} onChange={e => setForgotToken(e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="forgot-newpass">Nueva contraseña</label>
                  <input className="form-control" id="forgot-newpass" type="password" placeholder="Mínimo 8 caracteres"
                    value={forgotNewPass} onChange={e => setForgotNewPass(e.target.value)} />
                </div>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={closeForgot}>Cancelar</button>
            {step === 1 && (
              <button className="btn btn-primary" id="btn-forgot-send" onClick={solicitar}>Solicitar recuperación</button>
            )}
            {step === 2 && (
              <button className="btn btn-primary" id="btn-forgot-reset" onClick={restablecer}>Restablecer contraseña</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
