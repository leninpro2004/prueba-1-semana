import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { formatQty } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm, usePrompt } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import DuplicarReceta from './DuplicarReceta';
import SelectorProducto from '../../components/SelectorProducto';

/**
 * CU-102 (D37): crear, ver y editar una receta (plantilla de insumos de un tipo de puerta).
 *  - Exc 1: el producto debe existir y estar activo (y no ser herramienta).
 *  - Exc 3: la cantidad debe ser mayor que cero; el error se marca en el campo.
 *  - Exc 2: si ya existe, se edita o se DUPLICA como nueva versión conservando la anterior.
 *  - Edición: 24 h libre para gerencia y jop; después solo gerencia, con motivo.
 * La merma se ingresa en % y se guarda como fracción (20 % → 0,2).
 */

let siguienteClave = 1;
const filaVacia = () => ({ clave: siguienteClave++, sku: '', cantidad: '', mermaPct: '', areaId: '' });
const fechaHora = (v) => (v ? new Date(v).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function RecetaEditor() {
  const { id } = useParams();
  const esNueva = !id;
  usePageTitle(esNueva ? 'Nueva receta' : 'Receta');
  const { user } = useAuth();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const location = useLocation();
  const { alert, showAlert } = useAlert();
  const esGerencia = user?.rol === 'gerencia';
  const puedeEditarRol = ['gerencia', 'jop'].includes(user?.rol);

  const [producto, setProducto] = useState(null);   // cabecera guardada (null en una nueva)
  const [reemplazaA, setReemplazaA] = useState([]);
  const [nombre, setNombre] = useState('');
  const [codigo, setCodigo] = useState('');
  const [tipo, setTipo] = useState('');
  const [filas, setFilas] = useState(() => [filaVacia()]);
  const [originales, setOriginales] = useState({});  // sku -> { nombre, unidad, estado } de lo ya guardado
  const [materiales, setMateriales] = useState([]);  // catálogo de activos
  const [areas, setAreas] = useState([]);
  const [errores, setErrores] = useState({});        // `${indice}:${campo}` -> mensaje
  const [guardando, setGuardando] = useState(false);
  const [duplicando, setDuplicando] = useState(false);

  // Catálogos: materiales activos y áreas activas de producción o instalación (CU-120, D44)
  useEffect(() => {
    API.materiales.listar({ estado: 'activo' }).then(m => setMateriales(Array.isArray(m) ? m : [])).catch(() => setMateriales([]));
    API.reportes.listarAreas()
      .then(a => setAreas((a || []).filter(x => ['produccion', 'instalacion'].includes(x.clasificacion) && x.activo !== false)))
      .catch(() => setAreas([]));
  }, []);

  const [recarga, setRecarga] = useState(0);   // se incrementa para volver a consultar
  const cargar = () => setRecarga(n => n + 1);

  /** Vuelca la receta guardada en el formulario. */
  const aplicar = (r) => {
    setProducto(r.producto);
    setReemplazaA(r.reemplaza_a || []);
    setNombre(r.producto.nombre || '');
    setCodigo(r.producto.codigo || '');
    setTipo(r.producto.tipo || '');
    setOriginales(Object.fromEntries(r.materiales.map(m => [m.sku, { nombre: m.nombre, unidad: m.unidad, estado: m.estado_material,
      // Sesión 15: valores guardados, para dejar pasar un material inactivo que no se tocó
      cantidad: parseFloat(m.cantidad_base), merma: parseFloat(m.merma), areaId: m.area_id ? String(m.area_id) : '' }])));
    setFilas(r.materiales.length ? r.materiales.map(m => ({
      clave: siguienteClave++, sku: m.sku, cantidad: String(parseFloat(m.cantidad_base)),
      mermaPct: String(Math.round(parseFloat(m.merma) * 10000) / 100), areaId: m.area_id ? String(m.area_id) : '',
    })) : [filaVacia()]);
    setErrores({});
  };

  useEffect(() => {
    if (esNueva) return undefined;
    let cancelado = false;
    API.recetas.obtener(id)
      .then(r => { if (!cancelado) aplicar(r); })
      .catch(err => { if (!cancelado) showAlert('danger', 'No se pudo cargar la receta: ' + err.message); });
    return () => { cancelado = true; };
    // aplicar solo usa setters, que React mantiene estables
  }, [id, esNueva, recarga, showAlert]);

  // Mensaje que deja la duplicación al llegar a la receta nueva
  useEffect(() => {
    if (location.state?.mensaje) showAlert('success', location.state.mensaje);
  }, [location.state, showAlert]);

  const catalogo = useMemo(() => new Map(materiales.map(m => [m.sku, m])), [materiales]);

  // Qué se puede hacer con esta receta y por qué no
  const inactiva = producto && !producto.activo;
  const bloqueadaJop = producto && producto.activo && !producto.en_plazo && !esGerencia;
  const soloLectura = !puedeEditarRol || inactiva || bloqueadaJop;

  /** Cambia un campo de la fila y borra el error de ese campo (campoError = nombre en el backend). */
  const cambiar = (i, campo, valor, campoError = campo) => {
    setFilas(fs => fs.map((f, j) => (j === i ? { ...f, [campo]: valor } : f)));
    setErrores(e => { const n = { ...e }; delete n[`${i}:${campoError}`]; return n; });
  };
  const quitar = (i) => setFilas(fs => (fs.length > 1 ? fs.filter((_, j) => j !== i) : [filaVacia()]));

  /** Sesión 15: la fila de un material inactivo quedó igual que la guardada (se puede conservar, como en la OT). */
  const intacta = (f) => {
    const o = originales[f.sku.trim()];
    if (!o) return false;
    const c = parseFloat(String(f.cantidad).replace(',', '.'));
    const m = f.mermaPct === '' ? 0 : parseFloat(String(f.mermaPct).replace(',', '.')) / 100;
    return Math.abs(c - o.cantidad) < 1e-9 && Math.abs(m - o.merma) < 1e-6 && f.areaId === o.areaId;
  };

  /** Validación en la vista (el backend vuelve a validar todo). */
  const validar = () => {
    const e = {};
    const vistos = new Set();
    filas.forEach((f, i) => {
      const sku = f.sku.trim();
      if (!sku) { e[`${i}:sku`] = 'Elija un producto'; return; }
      if (!catalogo.has(sku) && !intacta(f)) e[`${i}:sku`] = originales[sku] ? 'Producto inactivo: puede quedar como estaba, pero no modificarse. Para cambiarlo, reemplácelo' : 'El SKU no existe o está inactivo';
      else if (vistos.has(sku)) e[`${i}:sku`] = 'Repetido en la receta';
      vistos.add(sku);
      const c = parseFloat(String(f.cantidad).replace(',', '.'));
      if (isNaN(c) || c <= 0) e[`${i}:cantidad_base`] = 'Debe ser mayor que cero';
      const m = f.mermaPct === '' ? 0 : parseFloat(String(f.mermaPct).replace(',', '.'));
      if (isNaN(m) || m < 0 || m >= 100) e[`${i}:merma`] = 'Entre 0 y 99 %';
    });
    return e;
  };

  const guardar = async () => {
    if (!nombre.trim()) { showAlert('danger', 'El nombre de la receta es obligatorio.'); return; }
    if (!codigo.trim()) { showAlert('danger', 'El código de la receta es obligatorio: identifica el tipo de puerta.'); return; }
    const e = validar();
    setErrores(e);
    if (Object.keys(e).length) { showAlert('danger', 'Revise los campos marcados en rojo: no se guardó nada.'); return; }

    const cuerpo = {
      nombre: nombre.trim(), codigo: codigo.trim(), tipo: tipo.trim() || null,
      materiales: filas.map(f => ({
        sku: f.sku.trim(),
        cantidad_base: parseFloat(String(f.cantidad).replace(',', '.')),
        merma: f.mermaPct === '' ? 0 : parseFloat(String(f.mermaPct).replace(',', '.')) / 100,
        area_id: f.areaId || null,
      })),
    };

    // Fuera de plazo, gerencia corrige con motivo (queda en auditoría)
    if (!esNueva && !producto.en_plazo) {
      const motivo = await prompt(
        'Esta receta tiene más de 24 horas: la corrección sobrescribe lo que pudo usarse en órdenes de trabajo. ' +
        'Si el proceso cambió, cancele y duplíquela como nueva versión. Si es una corrección, indique el motivo:',
        'Corregir receta fuera de plazo', 'Ej: la cantidad de ACR-001 era 2,5 y no 25');
      if (motivo == null) return;
      if (!motivo.trim()) { showAlert('danger', 'Indique el motivo de la corrección.'); return; }
      cuerpo.motivo = motivo.trim();
    }

    setGuardando(true);
    try {
      if (esNueva) {
        const resp = await API.recetas.crear(cuerpo);
        if (resp?.error) throw new Error(resp.error);   // 409: código repetido (apiFetch no lo lanza)
        navigate(`/recetas/${resp.id}`, { replace: true, state: { mensaje: resp.message } });
      } else {
        const resp = await API.recetas.actualizar(id, cuerpo);
        if (resp?.error) throw new Error(resp.error);   // 409: código repetido
        showAlert('success', resp.message);
        cargar();
      }
    } catch (err) {
      // Errores por fila del backend (Exc 1 y 3) sobre sus campos
      const porFila = err.payload?.errores;
      if (Array.isArray(porFila)) {
        setErrores(Object.fromEntries(porFila.filter(x => x.fila).map(x => [`${x.fila - 1}:${x.campo}`, x.error])));
      }
      showAlert('danger', err.message);
    } finally {
      setGuardando(false);
    }
  };

  const cambiarEstado = async () => {
    const activar = inactiva;
    const ok = await confirm(
      activar ? `¿Reactivar la receta "${producto.nombre}"?`
              : `¿Desactivar la receta "${producto.nombre}"? Dejará de ofrecerse en las órdenes de trabajo. No se borra.`,
      activar ? 'Reactivar receta' : 'Desactivar receta');
    if (!ok) return;
    try {
      const resp = await API.recetas.cambiarEstado(id, activar);
      showAlert('success', resp.message);
      cargar();
    } catch (err) { showAlert('danger', err.message); }
  };

  const err = (i, campo) => errores[`${i}:${campo}`];
  const estiloError = (i, campo) => (err(i, campo) ? { borderColor: 'var(--danger)' } : undefined);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">{esNueva ? 'Nueva receta' : producto?.nombre || 'Receta'}</div>
          <div className="page-subtitle">Insumos por puerta. La merma se suma a la cantidad al cargarla en la orden de trabajo.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/recetas" className="btn btn-ghost">← Recetas</Link>
          {!esNueva && puedeEditarRol && producto && (
            <>
              <button className="btn btn-secondary" onClick={() => setDuplicando(true)}>Duplicar</button>
              <button className="btn btn-ghost" onClick={cambiarEstado}>{inactiva ? 'Reactivar' : 'Desactivar'}</button>
            </>
          )}
        </div>
      </div>

      <Alert {...alert} />

      {/* Estado de la receta y regla de edición */}
      {producto && (
        <div className="card card-sm" style={{ marginBottom: 16, fontSize: 13, lineHeight: 1.7 }}>
          <div>
            {producto.activo ? <span className="badge badge-success">Activa</span> : <span className="badge badge-gray">Inactiva</span>}
            {' '}Creada el {fechaHora(producto.fecha_creacion)}.
            {producto.activo && (producto.en_plazo
              ? <> Edición libre hasta el {fechaHora(producto.edicion_libre_hasta)}.</>
              : <> Plazo de edición vencido: solo gerencia puede corregirla, indicando el motivo.</>)}
          </div>
          {producto.reemplazada_por_id && (
            <div>Reemplazada por <Link to={`/recetas/${producto.reemplazada_por_id}`}>{producto.reemplazada_por_nombre}</Link>.</div>
          )}
          {reemplazaA.length > 0 && (
            <div>Versión nueva de: {reemplazaA.map((r, i) => <span key={r.id}>{i > 0 && ', '}<Link to={`/recetas/${r.id}`}>{r.nombre}</Link></span>)}.</div>
          )}
          {bloqueadaJop && (
            <div style={{ color: 'var(--warning)', fontWeight: 600, marginTop: 4 }}>
              Pasaron más de 24 horas desde su creación: solo gerencia puede editarla. Si el proceso cambió, use "Duplicar" para crear una nueva versión.
            </div>
          )}
          {inactiva && <div style={{ color: 'var(--gray)', marginTop: 4 }}>Una receta inactiva no se edita: reactívela o duplíquela.</div>}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="form-group" style={{ flex: 2, minWidth: 220, marginBottom: 0 }}>
            <label className="form-label">Nombre (tipo de puerta) *</label>
            <input className="form-control" value={nombre} onChange={e => setNombre(e.target.value)} disabled={soloLectura} maxLength={200}
              placeholder="Ej: Puerta Especial blindaje ABC" />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
            <label className="form-label">Código *</label>
            <input className="form-control" value={codigo} onChange={e => setCodigo(e.target.value.toUpperCase())} disabled={soloLectura}
              maxLength={80} placeholder="Ej: PB-ABC" />
          </div>
          <div className="form-group" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
            <label className="form-label">Tipo</label>
            <input className="form-control" value={tipo} onChange={e => setTipo(e.target.value)} disabled={soloLectura} maxLength={150} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Insumos por puerta</div>
        <div style={{ fontSize: 12, color: 'var(--gray)', marginBottom: 12 }}>
          El <strong>área</strong> (obligatoria) indica dónde se consume el insumo: cada orden de trabajo carga solo los insumos de su área,
          y los del área <strong>Instalación</strong> se vinculan al pedido de instalación de la venta.
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Producto</th>
                <th style={{ width: 120 }}>Cantidad</th>
                <th style={{ width: 90 }}>Unidad</th>
                <th style={{ width: 100 }}>Merma %</th>
                <th style={{ width: 170 }}>Área</th>
                {!soloLectura && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                const mat = catalogo.get(f.sku.trim()) || originales[f.sku.trim()];
                const inactivo = originales[f.sku.trim()] && !catalogo.has(f.sku.trim());
                const conservado = inactivo && intacta(f);   // sesión 15: aviso, no error
                return (
                  <tr key={f.clave} style={inactivo ? { background: conservado ? '#FFF6E5' : '#FDECEA' } : undefined}>
                    <td>
                      {/* Sesión 15 (punto 22): mismo selector que el resto del sistema (antes un <datalist>) */}
                      <SelectorProducto opciones={materiales} value={f.sku} disabled={soloLectura} aria-label={`Producto de la fila ${i + 1}`}
                        onChange={sku => cambiar(i, 'sku', sku)} style={estiloError(i, 'sku')} />
                      <div style={{ fontSize: 11, color: inactivo ? (conservado ? 'var(--warning)' : 'var(--danger)') : 'var(--gray)', marginTop: 2 }}>
                        {inactivo
                          ? `${mat?.nombre || ''} — inactivo o dado de baja: ${conservado ? 'se conserva como estaba; para cambiarlo, reemplácelo' : 'no se puede modificar: déjelo como estaba o reemplácelo'}`
                          : ''}
                      </div>
                      {err(i, 'sku') && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err(i, 'sku')}</div>}
                    </td>
                    <td>
                      <input className="form-control" inputMode="decimal" value={f.cantidad} disabled={soloLectura}
                        onChange={e => cambiar(i, 'cantidad', e.target.value, 'cantidad_base')}
                        style={estiloError(i, 'cantidad_base')} />
                      {err(i, 'cantidad_base') && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err(i, 'cantidad_base')}</div>}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{mat?.unidad_medida || mat?.unidad || '—'}</td>
                    <td>
                      <input className="form-control" inputMode="decimal" value={f.mermaPct} disabled={soloLectura} placeholder="0"
                        onChange={e => cambiar(i, 'mermaPct', e.target.value, 'merma')}
                        style={estiloError(i, 'merma')} />
                      {err(i, 'merma') && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err(i, 'merma')}</div>}
                    </td>
                    <td>
                      <select className="form-control" value={f.areaId} disabled={soloLectura}
                        onChange={e => cambiar(i, 'areaId', e.target.value, 'area_id')} style={estiloError(i, 'area_id')}>
                        {/* R1: el área es obligatoria (un insumo sin área se descontaría en todas las OT de la puerta) */}
                        <option value="">Seleccione...</option>
                        {areas.map(a => <option key={a.id} value={String(a.id)}>{a.nombre}</option>)}
                      </select>
                      {err(i, 'area_id') && <div style={{ fontSize: 11, color: 'var(--danger)' }}>{err(i, 'area_id')}</div>}
                    </td>
                    {!soloLectura && (
                      <td><button className="btn btn-ghost btn-sm" title="Quitar insumo" onClick={() => quitar(i)}>✕</button></td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!soloLectura && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setFilas(fs => [...fs, filaVacia()])}>+ Agregar insumo</button>
            <button className="btn btn-primary" onClick={guardar} disabled={guardando}>
              {guardando ? 'Guardando…' : esNueva ? 'Crear receta' : producto?.en_plazo ? 'Guardar cambios' : 'Corregir (con motivo)'}
            </button>
          </div>
        )}
        {filas.some(f => f.cantidad) && (
          <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 10 }}>
            Cantidad con merma por puerta: {filas.filter(f => f.sku && f.cantidad).map(f => {
              const c = parseFloat(String(f.cantidad).replace(',', '.')) || 0;
              const m = parseFloat(String(f.mermaPct || 0).replace(',', '.')) || 0;
              return `${f.sku} ${formatQty(c * (1 + m / 100))}`;
            }).join(' · ')}
          </div>
        )}
      </div>

      {duplicando && producto && (
        <DuplicarReceta receta={producto} onCerrar={() => setDuplicando(false)}
          onDuplicada={(resp) => { setDuplicando(false); navigate(`/recetas/${resp.id}`, { state: { mensaje: resp.message } }); }} />
      )}
    </>
  );
}
