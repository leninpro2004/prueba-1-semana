import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { hoyLocal } from '../../utils/format';
import { AvisoCerrable } from '../../components/Alert';

const CLIENTE_VACIO = { rut: '', razon_social: '', contacto: '', correo: '', telefono: '', es_empresa: true };

/**
 * F-29 (D83): formulario "Nuevo proyecto" (solo gerencia). Temporal: mientras Terreno no cree proyectos,
 * Inventario los crea en terreno.proyecto, con un cliente existente o uno nuevo. onCreado(proyecto).
 */
export default function NuevoProyecto({ onCerrar, onCreado }) {
  const [opciones, setOpciones] = useState(null);
  const [error, setError] = useState(null);
  const [guardando, setGuardando] = useState(false);

  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [fecha, setFecha] = useState('');
  const [modoCliente, setModoCliente] = useState('existente');   // 'existente' | 'nuevo'
  const [rutCliente, setRutCliente] = useState('');
  const [cliente, setCliente] = useState(CLIENTE_VACIO);

  useEffect(() => {
    let vigente = true;
    API.ordenesTrabajo.opcionesNuevoProyecto()
      .then(o => {
        if (!vigente) return;
        setOpciones(o);
        setCodigo(o.codigo_sugerido || '');
        if (!o.clientes?.length) setModoCliente('nuevo');
      })
      .catch(err => { if (vigente) setError('No se pudieron cargar las opciones: ' + err.message); });
    return () => { vigente = false; };
  }, []);

  const cambiarCliente = (campo, valor) => setCliente(c => ({ ...c, [campo]: valor }));

  const crear = async () => {
    if (!codigo.trim()) { setError('Indique el código del proyecto.'); return; }
    if (nombre.trim().length < 3) { setError('El nombre debe tener al menos 3 caracteres.'); return; }
    if (!fecha) { setError('Indique la fecha de instalación.'); return; }
    if (modoCliente === 'existente' && !rutCliente) { setError('Elija el cliente, o cree uno nuevo.'); return; }
    if (modoCliente === 'nuevo' && ['rut', 'razon_social', 'contacto', 'correo', 'telefono'].some(k => !cliente[k].trim())) {
      setError('Complete todos los datos del cliente nuevo.'); return;
    }
    setGuardando(true);
    setError(null);
    try {
      const r = await API.ordenesTrabajo.crearProyecto({
        codigo: codigo.trim(), nombre: nombre.trim(), fecha_instalacion: fecha,
        ...(modoCliente === 'existente' ? { rut_cliente: rutCliente } : { cliente_nuevo: cliente }),
      });
      // El 409 llega como respuesta (no lanza): código o cliente repetido
      if (r?.error) {
        setError(r.error + (r.codigo_sugerido ? ` Código libre sugerido: ${r.codigo_sugerido}.` : ''));
        if (r.codigo_sugerido) setCodigo(r.codigo_sugerido);
        return;
      }
      onCreado(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="modal-backdrop show" id="modal-nuevo-proyecto" onClick={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Nuevo proyecto</div>
            <div className="modal-subtitle">Mientras Terreno no cree proyectos, se crean aquí para poder abrir sus OT.</div>
          </div>
          <button className="modal-close" onClick={onCerrar}>&#x2715;</button>
        </div>
        <div className="modal-body">
          {error && <AvisoCerrable className="alert alert-danger">{error}</AvisoCerrable>}
          {!opciones && !error && <div style={{ color: 'var(--gray)' }}>Cargando…</div>}
          {opciones && (
            <>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div className="form-group" style={{ flex: 1, minWidth: 150 }}>
                  <label className="form-label" htmlFor="np-codigo">Código <span className="required">*</span></label>
                  <input className="form-control" id="np-codigo" maxLength={30} value={codigo} onChange={e => setCodigo(e.target.value)} />
                </div>
                <div className="form-group" style={{ flex: 1, minWidth: 150 }}>
                  <label className="form-label" htmlFor="np-fecha">Fecha de instalación <span className="required">*</span></label>
                  <input className="form-control" id="np-fecha" type="date" min={hoyLocal()} value={fecha} onChange={e => setFecha(e.target.value)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="np-nombre">Nombre <span className="required">*</span></label>
                <input className="form-control" id="np-nombre" maxLength={150} placeholder="ej: Edificio Los Andes - Torre A"
                  value={nombre} onChange={e => setNombre(e.target.value)} />
              </div>

              <div className="form-group">
                <label className="form-label">Cliente <span className="required">*</span></label>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14 }}>
                  {[['existente', 'Un cliente registrado'], ['nuevo', 'Cliente nuevo']].map(([v, t]) => (
                    <label key={v} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="radio" name="np-modo" value={v} checked={modoCliente === v} onChange={() => setModoCliente(v)}
                        disabled={v === 'existente' && !opciones.clientes.length} /> {t}
                    </label>
                  ))}
                </div>
              </div>
              {modoCliente === 'existente' ? (
                <div className="form-group">
                  <select className="form-control" id="np-cliente" aria-label="Cliente" value={rutCliente} onChange={e => setRutCliente(e.target.value)}>
                    <option value="">Elija el cliente…</option>
                    {opciones.clientes.map(c => <option key={c.rut} value={c.rut}>{c.razon_social} — {c.rut}</option>)}
                  </select>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
                      <label className="form-label" htmlFor="np-rut">RUT</label>
                      <input className="form-control" id="np-rut" placeholder="12345678-5" value={cliente.rut} onChange={e => cambiarCliente('rut', e.target.value)} />
                    </div>
                    <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
                      <label className="form-label" htmlFor="np-tipo">Tipo</label>
                      <select className="form-control" id="np-tipo" value={cliente.es_empresa ? 'empresa' : 'persona'}
                        onChange={e => cambiarCliente('es_empresa', e.target.value === 'empresa')}>
                        <option value="empresa">Empresa</option>
                        <option value="persona">Persona</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="np-razon">{cliente.es_empresa ? 'Razón social' : 'Nombre completo'}</label>
                    <input className="form-control" id="np-razon" value={cliente.razon_social} onChange={e => cambiarCliente('razon_social', e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
                      <label className="form-label" htmlFor="np-contacto">Contacto</label>
                      <input className="form-control" id="np-contacto" value={cliente.contacto} onChange={e => cambiarCliente('contacto', e.target.value)} />
                    </div>
                    <div className="form-group" style={{ flex: 1, minWidth: 140 }}>
                      <label className="form-label" htmlFor="np-telefono">Teléfono</label>
                      <input className="form-control" id="np-telefono" value={cliente.telefono} onChange={e => cambiarCliente('telefono', e.target.value)} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="np-correo">Correo</label>
                    <input className="form-control" id="np-correo" type="email" value={cliente.correo} onChange={e => cambiarCliente('correo', e.target.value)} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCerrar}>Cancelar</button>
          <button className="btn btn-primary" disabled={!opciones || guardando} onClick={crear}>
            {guardando ? 'Creando…' : 'Crear proyecto'}
          </button>
        </div>
      </div>
    </div>
  );
}
