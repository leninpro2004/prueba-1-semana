import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { AvisoCerrable } from '../../components/Alert';

/**
 * F-06 (D70, D71): formulario "Nueva OT". Una OT por área; el proyecto se elige directo o
 * sale de la venta (la OT guarda el proyecto de Terreno de esa venta). La receta es opcional:
 * si se elige, la pestaña Consumo la precarga para N puertas (R1). Al crear, va al detalle.
 */
export default function NuevaOT({ onCerrar, proyectoInicial = '' }) {   // F-24: abrir con un proyecto ya elegido
  const navigate = useNavigate();
  const { user } = useAuth();
  const [opciones, setOpciones] = useState(null);
  const [recetas, setRecetas] = useState([]);
  const [error, setError] = useState(null);
  const [guardando, setGuardando] = useState(false);

  const [areaId, setAreaId] = useState('');
  const [origen, setOrigen] = useState('proyecto');   // 'proyecto' | 'venta' | 'ninguno'
  const [proyectoId, setProyectoId] = useState(String(proyectoInicial ?? ''));
  const [ventaId, setVentaId] = useState('');
  const [recetaId, setRecetaId] = useState('');
  const [puertas, setPuertas] = useState('1');
  const [responsableId, setResponsableId] = useState(String(user?.id ?? ''));

  useEffect(() => {
    let vigente = true;
    Promise.all([API.ordenesTrabajo.opcionesNueva(), API.recetas.listar()])
      .then(([o, r]) => { if (vigente) { setOpciones(o); setRecetas(Array.isArray(r) ? r : []); } })
      .catch(err => { if (vigente) setError('No se pudieron cargar las opciones: ' + err.message); });
    return () => { vigente = false; };
  }, []);

  const crear = async () => {
    if (!areaId) { setError('Elija el área de la OT.'); return; }
    if (origen === 'proyecto' && !proyectoId) { setError('Elija el proyecto, o marque "Sin proyecto".'); return; }
    if (origen === 'venta' && !ventaId) { setError('Elija la venta.'); return; }
    if (recetaId && !/^\d+$/.test(puertas)) { setError('La cantidad de puertas debe ser un número entero.'); return; }
    setGuardando(true);
    setError(null);
    try {
      const r = await API.ordenesTrabajo.crear({
        area_id: Number(areaId),
        ...(origen === 'proyecto' && { proyecto_id: Number(proyectoId) }),
        ...(origen === 'venta' && { nota_venta_id: Number(ventaId) }),
        ...(recetaId && { receta_id: Number(recetaId), cantidad_puertas: Number(puertas) }),
        responsable_id: Number(responsableId),
      });
      navigate(`/ordenes/${r.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setGuardando(false);
    }
  };

  const ventasConProyecto = (opciones?.ventas || []).filter(v => v.proyecto_id != null);
  const ventasSinProyecto = (opciones?.ventas || []).length - ventasConProyecto.length;

  return (
    <div className="modal-backdrop show" id="modal-nueva-ot" onClick={e => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Nueva orden de trabajo</div>
            <div className="modal-subtitle">Una OT por área. La receta se puede cargar ahora o después, en la pestaña Consumo.</div>
          </div>
          <button className="modal-close" onClick={onCerrar}>&#x2715;</button>
        </div>
        <div className="modal-body">
          {error && <AvisoCerrable className="alert alert-danger">{error}</AvisoCerrable>}
          {!opciones && !error && <div style={{ color: 'var(--gray)' }}>Cargando…</div>}
          {opciones && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="not-area">Área <span className="required">*</span></label>
                <select className="form-control" id="not-area" value={areaId} onChange={e => setAreaId(e.target.value)}>
                  <option value="">Elija el área…</option>
                  {opciones.areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Para</label>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 14 }}>
                  {[['proyecto', 'Un proyecto'], ['venta', 'Una venta'], ['ninguno', 'Sin proyecto']].map(([v, t]) => (
                    <label key={v} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="radio" name="not-origen" value={v} checked={origen === v} onChange={() => setOrigen(v)} /> {t}
                    </label>
                  ))}
                </div>
              </div>
              {origen === 'proyecto' && (
                <div className="form-group">
                  <select className="form-control" id="not-proyecto" aria-label="Proyecto" value={proyectoId} onChange={e => setProyectoId(e.target.value)}>
                    <option value="">Elija el proyecto…</option>
                    {opciones.proyectos.map(p => <option key={p.id} value={p.id}>{p.codigo} — {p.nombre}</option>)}
                  </select>
                </div>
              )}
              {origen === 'venta' && (
                <div className="form-group">
                  <select className="form-control" id="not-venta" aria-label="Venta" value={ventaId} onChange={e => setVentaId(e.target.value)}>
                    <option value="">Elija la venta (aprobada o en proceso)…</option>
                    {ventasConProyecto.map(v => <option key={v.id} value={v.id}>{v.numero}</option>)}
                  </select>
                  {ventasSinProyecto > 0 && (
                    <div className="form-hint">
                      {ventasSinProyecto} venta(s) no aparecen porque no tienen un proyecto de Terreno: la OT se liga al proyecto de la venta.
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div className="form-group" style={{ flex: 2, minWidth: 200 }}>
                  <label className="form-label" htmlFor="not-receta">Receta</label>
                  <select className="form-control" id="not-receta" value={recetaId} onChange={e => setRecetaId(e.target.value)}>
                    <option value="">Sin receta por ahora</option>
                    {recetas.filter(r => r.activo).map(r => <option key={r.id} value={r.id}>{r.codigo} — {r.nombre}</option>)}
                  </select>
                </div>
                {recetaId && (
                  <div className="form-group" style={{ flex: 1, minWidth: 90 }}>
                    <label className="form-label" htmlFor="not-puertas">Puertas</label>
                    <input className="form-control" id="not-puertas" inputMode="numeric" value={puertas}
                      onChange={e => setPuertas(e.target.value.trim())} />
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="not-responsable">Responsable</label>
                <select className="form-control" id="not-responsable" value={responsableId} onChange={e => setResponsableId(e.target.value)}>
                  {opciones.usuarios.map(u => <option key={u.id} value={u.id}>{u.nombre ? `${u.nombre} (${u.username})` : u.username}</option>)}
                </select>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onCerrar} disabled={guardando}>Cancelar</button>
          <button className="btn btn-primary" id="btn-crear-ot" onClick={crear} disabled={guardando || !opciones}>
            {guardando ? 'Creando…' : 'Crear OT'}
          </button>
        </div>
      </div>
    </div>
  );
}
