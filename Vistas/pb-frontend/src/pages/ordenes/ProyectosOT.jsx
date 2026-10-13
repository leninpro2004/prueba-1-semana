import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert, AvisoCerrable } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { etiqueta, fechaLocal } from '../../utils/format';
import { esProyectoDePrueba } from '../../utils/proyectos';
import NuevaOT from './NuevaOT';
import NuevoProyecto from './NuevoProyecto';
import { useConfirm } from '../../hooks/useDialog';

/**
 * F-24: proyectos de Terreno con sus OT, para crear una OT desde el proyecto ("Nueva OT" lo deja
 * elegido). Lista todos; los de prueba (capacitación y marcha blanca) llevan su etiqueta.
 * F-29 (D83): gerencia crea proyectos aquí mientras Terreno no lo haga (temporal).
 */
export default function ProyectosOT() {
  usePageTitle('Proyectos');
  const { user } = useAuth();
  const puedeCrear = ['gerencia', 'administrador', 'jop'].includes(user?.rol);
  const puedeCrearProyecto = user?.rol === 'gerencia';   // F-29
  const confirm = useConfirm();
  const [nuevoProyecto, setNuevoProyecto] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const { alert, showAlert } = useAlert();
  const [proyectos, setProyectos] = useState(null);
  const [buscar, setBuscar] = useState('');
  const [soloPrueba, setSoloPrueba] = useState(false);
  const [nuevaPara, setNuevaPara] = useState(null);   // id del proyecto con el formulario abierto

  useEffect(() => {
    let vigente = true;
    API.ordenesTrabajo.proyectos()
      .then(p => { if (vigente) setProyectos(Array.isArray(p) ? p : []); })
      .catch(err => { if (vigente) showAlert('danger', 'Error cargando los proyectos: ' + err.message); });
    return () => { vigente = false; };
  }, [showAlert, recarga]);

  const proyectoCreado = async (p) => {
    setNuevoProyecto(false);
    setRecarga(n => n + 1);
    showAlert('success', `Proyecto ${p.codigo} creado.`);
    if (puedeCrear && await confirm(`Proyecto ${p.codigo} creado. ¿Crear su primera orden de trabajo ahora?`, 'Nuevo proyecto')) {
      setNuevaPara(p.id);
    }
  };

  const hayPrueba = (proyectos || []).some(p => esProyectoDePrueba(p.codigo));
  const filtrados = useMemo(() => {
    if (!proyectos) return null;
    const q = buscar.trim().toLowerCase();
    return proyectos.filter(p =>
      (!soloPrueba || esProyectoDePrueba(p.codigo)) &&
      (!q || `${p.codigo} ${p.nombre}`.toLowerCase().includes(q)));
  }, [proyectos, buscar, soloPrueba]);
  const pag = usePagination(filtrados, 20);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Proyectos</div>
          <div className="page-subtitle">Proyectos de Terreno y sus órdenes de trabajo</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-secondary" to="/ordenes">← Órdenes de trabajo</Link>
          {puedeCrearProyecto && (
            <button className="btn btn-primary" onClick={() => setNuevoProyecto(true)}>+ Nuevo proyecto</button>
          )}
        </div>
      </div>
      {nuevaPara != null && <NuevaOT proyectoInicial={nuevaPara} onCerrar={() => setNuevaPara(null)} />}
      {nuevoProyecto && <NuevoProyecto onCerrar={() => setNuevoProyecto(false)} onCreado={proyectoCreado} />}

      <div id="alert-container"><Alert {...alert} /></div>

      {hayPrueba && (
        <AvisoCerrable className="alert alert-info" style={{ marginBottom: 16 }}>
          Los proyectos marcados <strong>prueba</strong> sirven para practicar. Crear una OT no mueve stock, pero lo que
          se guarde en su pestaña Consumo sí descuenta stock real: reviértelo antes de anular la OT.
        </AvisoCerrable>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="form-control" style={{ maxWidth: 320 }} placeholder="Buscar por código o nombre"
            value={buscar} onChange={e => setBuscar(e.target.value)} />
          {hayPrueba && (
            <label className="form-check">
              <input type="checkbox" checked={soloPrueba} onChange={e => setSoloPrueba(e.target.checked)} />
              Solo proyectos de prueba
            </label>
          )}
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Proyecto</th><th>Instalación</th><th>Estado</th>
                <th style={{ textAlign: 'right' }}>OT abiertas</th>
                <th style={{ textAlign: 'right' }}>Terminadas</th>
                <th style={{ textAlign: 'right' }}>Anuladas</th>
                {puedeCrear && <th></th>}
              </tr>
            </thead>
            <tbody>
              {proyectos === null && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--gray)' }}>Cargando…</td></tr>
              )}
              {filtrados && filtrados.length === 0 && (
                <EmptyRow colSpan={7} emptyMsg={proyectos.length === 0
                  ? (puedeCrearProyecto ? 'No hay proyectos. Cree uno con "+ Nuevo proyecto".' : 'No hay proyectos. Gerencia puede crearlos desde esta pantalla.')
                  : 'Ningún proyecto coincide con la búsqueda.'} />
              )}
              {pag.items.map(p => (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>
                      <span className="td-mono">{p.codigo}</span>
                      {esProyectoDePrueba(p.codigo) && <span className="badge badge-warning" style={{ marginLeft: 6 }}>prueba</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--gray)' }}>{p.nombre}</div>
                  </td>
                  <td style={{ fontSize: 13 }}>{fechaLocal(p.fecha_instalacion)}</td>
                  <td style={{ fontSize: 13 }}>{etiqueta(p.estado_operacional)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{p.ot_abiertas}</td>
                  <td style={{ textAlign: 'right', color: 'var(--gray)' }}>{p.ot_terminadas}</td>
                  <td style={{ textAlign: 'right', color: 'var(--gray)' }}>{p.ot_anuladas}</td>
                  {puedeCrear && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => setNuevaPara(p.id)}>+ Nueva OT</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>
    </>
  );
}
