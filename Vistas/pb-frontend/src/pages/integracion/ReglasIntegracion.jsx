import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import { useConfirm } from '../../hooks/useDialog';
import Alert, { useAlert } from '../../components/Alert';
import { fechaHora } from '../conteos/formato';

/**
 * CU-108: qué roles pueden registrar movimientos de inventario desde otros
 * módulos (Terreno, Finanzas). Gerencia y administrador. Las reglas viven en
 * perfil_permiso (V1); CU-107 las valida en cada movimiento que llega.
 */

const TIPO = { entrada: 'Entradas', salida: 'Salidas' };
const AYUDA_TIPO = { entrada: 'suman stock', salida: 'restan stock' };
const FORM_VACIO = { modulo: '', perfil_id: '', tipos: [] };

const listaTipos = (tipos) => tipos.map(t => TIPO[t]?.toLowerCase() || t).join(' y ');
const nombrePerfil = (p) => p.usuarios > 0 ? p.nombre : `${p.nombre} (sin usuarios con este rol)`;

export default function ReglasIntegracion() {
  usePageTitle('Integración entre módulos');
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const [datos, setDatos] = useState(null);     // { reglas, modulos, perfiles, tipos }
  const [form, setForm] = useState(null);       // null = cerrado; { ...FORM_VACIO, editando }
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    let cancelado = false;
    API.integracion.reglas()
      .then(d => { if (!cancelado) setDatos(d); })
      .catch(err => { if (!cancelado) showAlert('danger', 'Error cargando las reglas: ' + err.message); });
    return () => { cancelado = true; };
  }, [showAlert]);

  const perfilDe = (id) => datos?.perfiles.find(p => p.id === Number(id));
  const aplicar = (resp) => {
    setDatos(d => ({ ...d, reglas: resp.reglas }));
    setForm(null);
    showAlert('success', resp.message);
  };

  const abrirNueva = () => setForm({ ...FORM_VACIO, editando: false });
  const abrirEdicion = (r) => setForm({ modulo: r.modulo, perfil_id: String(r.perfil_id), tipos: r.tipos, editando: true });
  const alternarTipo = (t) => setForm(f => ({
    ...f, tipos: f.tipos.includes(t) ? f.tipos.filter(x => x !== t) : [...f.tipos, t],
  }));

  const guardar = async () => {
    if (!form.modulo) { showAlert('danger', 'Seleccione el módulo de origen.'); return; }
    if (!form.perfil_id) { showAlert('danger', 'Seleccione el rol.'); return; }
    if (form.tipos.length === 0) { showAlert('danger', 'Seleccione al menos un tipo de movimiento.'); return; }
    const body = { modulo: form.modulo, perfil_id: Number(form.perfil_id), tipos: form.tipos };
    setGuardando(true);
    try {
      if (form.editando) {
        aplicar(await API.integracion.actualizarRegla(body));
        return;
      }
      let resp = await API.integracion.crearRegla(body);
      // Exc 2: ya hay una regla activa para ese módulo y rol → actualizarla en vez de duplicarla
      if (resp?.codigo === 'REGLA_EXISTENTE') {
        const v = resp.regla;
        const ok = await confirm(
          `Ya existe una regla activa para ${v.modulo_nombre} y el rol ${v.perfil}, que permite ${listaTipos(v.tipos)}. ` +
          `¿Reemplazarla para que permita ${listaTipos(datos.tipos.filter(t => form.tipos.includes(t)))}?`,
          'Regla existente'
        );
        if (!ok) return;
        resp = await API.integracion.crearRegla({ ...body, actualizar: true });
      }
      if (resp?.codigo) { showAlert('danger', resp.error); return; }
      aplicar(resp);
    } catch (err) {
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  /**
   * Desactivar o eliminar, con la Exc 3 (última regla activa de un módulo con
   * operaciones en curso): el backend responde 409 y se reenvía con confirmar.
   */
  const quitar = async (r, { llamar, pregunta, titulo, verbo }) => {
    if (!(await confirm(pregunta, titulo))) return;
    const body = { modulo: r.modulo, perfil_id: r.perfil_id };
    try {
      let resp = await llamar(body);
      if (resp?.codigo === 'OPERACIONES_EN_CURSO') {
        const o = resp.operaciones;
        const seguro = await confirm(
          `${resp.error} (Último movimiento: ${fechaHora(o.ultimo)}) ¿${verbo} de todas formas?`,
          'Operaciones en curso'
        );
        if (!seguro) return;
        resp = await llamar({ ...body, confirmar: true });
      }
      if (resp?.codigo) { showAlert('danger', resp.error); return; }
      aplicar(resp);
    } catch (err) {
      showAlert('danger', err.message);
    }
  };

  const desactivar = (r) => quitar(r, {
    llamar: (b) => API.integracion.actualizarRegla({ ...b, tipos: [] }),
    pregunta: `${r.modulo_nombre} ya no podrá registrar movimientos de inventario con el rol ${r.perfil}. ¿Desactivar la regla?`,
    titulo: 'Desactivar regla',
    verbo: 'Desactivar',
  });

  // Módulo y rol no se editan: si se eligieron mal, la regla se elimina y se crea otra
  const eliminar = (r) => quitar(r, {
    llamar: (b) => API.integracion.eliminarRegla(b),
    pregunta: `Se eliminará la regla ${r.modulo_nombre} · ${r.perfil}` +
              (r.activa ? `, y ${r.modulo_nombre} ya no podrá registrar movimientos con ese rol` : '') +
              '. Úselo para corregir una regla creada por error; el registro queda en la auditoría. ¿Eliminar?',
    titulo: 'Eliminar regla',
    verbo: 'Eliminar',
  });

  const reglas = datos?.reglas || [];
  const modulosSinReglas = (datos?.modulos || []).filter(m => !reglas.some(r => r.modulo === m.valor && r.activa));

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Integración entre módulos</div>
          <div className="page-subtitle">Roles que pueden registrar movimientos de inventario desde Terreno y Finanzas (CU-108)</div>
        </div>
        {datos && !form && (
          <button type="button" className="btn btn-primary" id="btn-nueva-regla" onClick={abrirNueva}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Nueva regla
          </button>
        )}
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {form && datos && (
        <div className="card" style={{ marginBottom: 16 }} id="form-regla">
          <div className="section-label">{form.editando ? 'Modificar regla' : 'Nueva regla'}</div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
            <div className="form-group" style={{ minWidth: 200 }}>
              <label className="form-label" htmlFor="regla-modulo">Módulo de origen</label>
              <select className="form-control" id="regla-modulo" value={form.modulo} disabled={form.editando}
                onChange={e => setForm(f => ({ ...f, modulo: e.target.value }))}>
                <option value="">Seleccione...</option>
                {datos.modulos.map(m => <option key={m.valor} value={m.valor}>{m.nombre}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ minWidth: 260 }}>
              <label className="form-label" htmlFor="regla-perfil">Rol</label>
              <select className="form-control" id="regla-perfil" value={form.perfil_id} disabled={form.editando}
                onChange={e => setForm(f => ({ ...f, perfil_id: e.target.value }))}>
                <option value="">Seleccione...</option>
                {datos.perfiles.map(p => <option key={p.id} value={p.id}>{nombrePerfil(p)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Tipos de movimiento permitidos</div>
              {datos.tipos.map(t => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, marginTop: 4 }}>
                  <input type="checkbox" id={`regla-tipo-${t}`} checked={form.tipos.includes(t)} onChange={() => alternarTipo(t)} />
                  {TIPO[t] || t} <span style={{ color: 'var(--gray)', fontSize: 12 }}>({AYUDA_TIPO[t] || t})</span>
                </label>
              ))}
            </div>
          </div>
          {form.perfil_id && perfilDe(form.perfil_id)?.usuarios === 0 && (
            <Alert type="warning" message="Ningún usuario activo tiene este rol: la regla se guarda, pero no habilitará a nadie mientras no existan usuarios con él." style={{ marginTop: 8, marginBottom: 0 }} />
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)} disabled={guardando}>Cancelar</button>
            <button type="button" className="btn btn-primary" id="btn-guardar-regla" onClick={guardar} disabled={guardando}>
              {guardando ? 'Guardando...' : 'Guardar regla'}
            </button>
          </div>
        </div>
      )}

      {datos && reglas.length > 0 && modulosSinReglas.length > 0 && (
        <Alert type="warning" message={`${modulosSinReglas.map(m => m.nombre).join(' y ')} no ${modulosSinReglas.length > 1 ? 'tienen' : 'tiene'} reglas activas: no podrá${modulosSinReglas.length > 1 ? 'n' : ''} registrar movimientos de inventario.`} />
      )}

      <div className="card">
        <div className="table-wrap">
          <table id="tabla-reglas">
            <thead>
              <tr><th>Módulo de origen</th><th>Rol</th><th>Tipos permitidos</th><th>Estado</th><th></th></tr>
            </thead>
            <tbody>
              {datos === null ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--gray)' }}>{alert?.message ? '—' : 'Cargando reglas...'}</td></tr>
              ) : reglas.length === 0 ? (
                // Exc 1: sin reglas
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--gray)' }} id="reglas-vacias">
                  No hay reglas configuradas. Mientras no exista al menos una, Terreno y Finanzas no podrán registrar movimientos de inventario.
                </td></tr>
              ) : reglas.map(r => {
                const perfil = perfilDe(r.perfil_id);
                return (
                  <tr key={`${r.modulo}-${r.perfil_id}`}>
                    <td>{r.modulo_nombre}</td>
                    <td>{perfil ? nombrePerfil(perfil) : r.perfil}</td>
                    <td>{r.activa ? r.tipos.map(t => TIPO[t] || t).join(', ') : '—'}</td>
                    <td>
                      <span className={'badge ' + (r.activa ? 'badge-success' : 'badge-gray')}>{r.activa ? 'Activa' : 'Inactiva'}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.activa ? (
                        <>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => abrirEdicion(r)}>Editar</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => desactivar(r)}>Desactivar</button>
                        </>
                      ) : (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => abrirEdicion(r)}>Activar</button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                        onClick={() => eliminar(r)}>Eliminar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
