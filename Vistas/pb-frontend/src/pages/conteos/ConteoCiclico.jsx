import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import EscanerCodigo from '../../components/EscanerCodigo';

/**
 * CU-37: ejecutar un conteo cíclico por bodega.
 *
 * - Conteo CIEGO (D9): la pantalla nunca recibe ni muestra el stock teórico.
 * - Sin borrador en la BD (opción A): el conteo se registra de una vez al confirmar.
 *   Mientras tanto el avance se guarda en ESTE navegador (clave usuario + bodega),
 *   para no perderlo si se recarga la página. Se borra al confirmar o al descartarlo.
 * - Flujo con lector: escanear → escribir la cantidad → Enter vuelve al escáner.
 */

const esActiva = (b) => ['activo', 'activa'].includes(b.estado);
// Exc 1: vacío (sin contar) o número >= 0 con hasta 4 decimales; se acepta coma
const CANTIDAD_OK = /^\d+([.,]\d{1,4})?$/;
const cantidadValida = (v) => v === '' || CANTIDAD_OK.test(v.trim());

const claveBorrador = (userId, bodegaId) => `pb_conteo_avance_${userId}_${bodegaId}`;
function leerBorrador(clave) {
  try { return JSON.parse(localStorage.getItem(clave) || 'null'); } catch { return null; }
}
function guardarBorrador(clave, datos) {
  try { localStorage.setItem(clave, JSON.stringify(datos)); } catch { /* sin almacenamiento: se sigue sin respaldo */ }
}
function borrarBorrador(clave) {
  try { localStorage.removeItem(clave); } catch { /* nada que borrar */ }
}

// Se llama desde efectos o manejadores, cuando el campo ya está en el DOM
const enfocar = (id) => {
  const el = document.getElementById(id);
  if (el) { el.focus(); el.select?.(); }
};

export default function ConteoCiclico() {
  usePageTitle('Conteo cíclico');
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();

  const [bodegas, setBodegas] = useState(null);
  const [bodegaId, setBodegaId] = useState('');
  const [prep, setPrep] = useState(null);        // { bodega, productos, conteo_hoy }
  const [cargando, setCargando] = useState(false);
  const [lineas, setLineas] = useState([]);      // [{ sku, nombre, unidad_medida, estado, cantidad, observacion, no_esperado }]
  const [otroConteo, setOtroConteo] = useState(false); // Exc 3: el usuario eligió crear otro
  const [justificacion, setJustificacion] = useState('');
  const [recuperado, setRecuperado] = useState(null);  // fecha del avance recuperado
  const [errores, setErrores] = useState({});    // { sku: true }
  const [guardando, setGuardando] = useState(false);

  const clave = user && bodegaId ? claveBorrador(user.id, bodegaId) : null;

  useEffect(() => {
    API.bodegas.listar()
      .then(b => setBodegas((b || []).filter(esActiva)))
      .catch(err => showAlert('danger', 'Error cargando bodegas: ' + err.message));
  }, [showAlert]);

  // Al elegir la bodega: productos (sin teórico), conteo de hoy y avance guardado
  const elegirBodega = async (id) => {
    setBodegaId(id);
    setPrep(null); setLineas([]); setErrores({}); setOtroConteo(false); setJustificacion(''); setRecuperado(null);
    if (!id) return;
    setCargando(true);
    try {
      const d = await API.conteos.preparar(id);
      const base = (d.productos || []).map(p => ({ ...p, cantidad: '', observacion: '', no_esperado: false }));
      const guardado = leerBorrador(claveBorrador(user.id, id));
      if (guardado?.lineas?.length) {
        // Se mezcla con la lista actual: si llegó un producto nuevo a la bodega, aparece vacío
        const previo = new Map(guardado.lineas.map(l => [l.sku.toUpperCase(), l]));
        const lista = base.map(p => {
          const l = previo.get(p.sku.toUpperCase());
          return l ? { ...p, cantidad: l.cantidad || '', observacion: l.observacion || '' } : p;
        });
        const enLista = new Set(base.map(p => p.sku.toUpperCase()));
        for (const l of guardado.lineas) {
          if (l.no_esperado && !enLista.has(l.sku.toUpperCase())) lista.push({ ...l, no_esperado: true });
        }
        setLineas(lista);
        setJustificacion(guardado.justificacion || '');
        setOtroConteo(Boolean(guardado.otroConteo));
        setRecuperado(guardado.guardado);
      } else {
        setLineas(base);
      }
      setPrep(d);
    } catch (err) {
      // Exc 2: bodega sin productos (400) u otro error
      showAlert(err.status === 400 ? 'warning' : 'danger', err.message);
    } finally {
      setCargando(false);
    }
  };

  // Foco pendiente: el campo a enfocar puede no existir hasta el próximo render
  // (la tabla al cargar la bodega, la fila de un producto no esperado recién agregado)
  const [foco, setFoco] = useState(null); // { id }
  useEffect(() => { if (foco) enfocar(foco.id); }, [foco]);

  // Con la bodega cargada, el cursor queda en el escáner
  useEffect(() => {
    if (prep) enfocar('escaner-codigo');
  }, [prep]);

  // Respaldo del avance en el navegador, en cada cambio
  useEffect(() => {
    if (!clave || !prep) return;
    const hayAvance = lineas.some(l => l.cantidad !== '' || l.observacion !== '' || l.no_esperado) || justificacion;
    if (hayAvance) {
      guardarBorrador(clave, {
        lineas: lineas.map(({ sku, nombre, unidad_medida, estado, cantidad, observacion, no_esperado }) =>
          ({ sku, nombre, unidad_medida, estado, cantidad, observacion, no_esperado })),
        justificacion, otroConteo, guardado: new Date().toLocaleString('es-CL'),
      });
    } else {
      borrarBorrador(clave);
    }
  }, [clave, prep, lineas, justificacion, otroConteo]);

  const descartarAvance = async () => {
    if (!(await confirm('Se borrarán las cantidades ingresadas en este navegador para esta bodega. ¿Continuar?', 'Descartar avance'))) return;
    borrarBorrador(clave);
    setRecuperado(null);
    setLineas(ls => ls.filter(l => !l.no_esperado).map(l => ({ ...l, cantidad: '', observacion: '' })));
    setJustificacion(''); setOtroConteo(false); setErrores({});
  };

  const cambiar = (sku, campo, valor) => {
    setLineas(ls => ls.map(l => (l.sku === sku ? { ...l, [campo]: valor } : l)));
    if (campo === 'cantidad') setErrores(e => ({ ...e, [sku]: !cantidadValida(valor) }));
  };

  // Escaneo: si el producto está en la lista se salta a su cantidad; si no, entra como no esperado (Exc 4)
  const onProducto = (p) => {
    const existente = lineas.find(l => l.sku.toUpperCase() === p.sku.toUpperCase());
    if (!existente) {
      setLineas(ls => [...ls, {
        sku: p.sku, nombre: p.nombre, unidad_medida: p.unidad_medida, estado: p.estado,
        codigo_barras: p.codigo_barras, cantidad: '', observacion: '', no_esperado: true,
      }]);
      showAlert('warning', <>El producto <strong>{p.sku}</strong> no está registrado en esta bodega. Se agregó como <strong>no esperado</strong>: si lo encontró aquí, ingrese la cantidad.</>);
    }
    setFoco({ id: 'cant-' + (existente?.sku || p.sku) });
  };

  const quitar = (sku) => setLineas(ls => ls.filter(l => l.sku !== sku));

  // Después de escribir la cantidad, Enter vuelve al escáner (así un segundo escaneo no cae en la cantidad)
  const onCantidadKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); enfocar('escaner-codigo'); }
  };

  const contados = lineas.filter(l => l.cantidad.trim() !== '').length;
  const sinContar = lineas.filter(l => !l.no_esperado && l.cantidad.trim() === '').length;
  const noEsperados = lineas.filter(l => l.no_esperado && l.cantidad.trim() !== '').length;
  const duplicado = prep?.conteo_hoy && !otroConteo;

  const confirmar = async () => {
    const invalidos = lineas.filter(l => !cantidadValida(l.cantidad));
    if (invalidos.length) {
      setErrores(Object.fromEntries(invalidos.map(l => [l.sku, true])));
      showAlert('danger', `La cantidad de ${invalidos[0].sku} debe ser un número igual o mayor a cero (hasta 4 decimales). Corríjala antes de confirmar.`);
      enfocar('cant-' + invalidos[0].sku);
      return;
    }
    if (contados === 0) { showAlert('danger', 'Ingrese la cantidad contada de al menos un producto.'); return; }
    if (prep.conteo_hoy && !justificacion.trim()) {
      showAlert('danger', 'Indique por qué se hace un segundo conteo de esta bodega hoy.');
      enfocar('justificacion');
      return;
    }

    const ok = await confirm(
      <>
        Se registrará el conteo de <strong>{prep.bodega.nombre}</strong>:
        <ul style={{ margin: '8px 0 8px 18px' }}>
          <li>{contados} producto(s) contados{noEsperados > 0 && <>, de ellos {noEsperados} no esperado(s)</>}</li>
          {sinContar > 0 && <li>{sinContar} producto(s) sin contar: quedarán informados en la comparación</li>}
        </ul>
        El stock teórico se toma en este momento. Una vez confirmado, el conteo no se puede modificar.
      </>,
      'Confirmar conteo'
    );
    if (!ok) return;

    setGuardando(true);
    try {
      const resp = await API.conteos.crear({
        bodega_id: parseInt(bodegaId),
        justificacion: prep.conteo_hoy ? justificacion.trim() : undefined,
        lineas: lineas
          .filter(l => !(l.no_esperado && l.cantidad.trim() === ''))
          .map(l => ({ sku: l.sku, cantidad: l.cantidad.trim(), observacion: l.observacion.trim() })),
      });
      if (resp?.conteo_existente) {
        // Exc 3 detectada al confirmar (otro usuario confirmó mientras se contaba)
        setPrep(p => ({ ...p, conteo_hoy: resp.conteo_existente }));
        setOtroConteo(false);
        showAlert('warning', resp.error);
        return;
      }
      borrarBorrador(clave);
      navigate(`/conteos/${resp.id}`, { state: { mensaje: `Conteo #${resp.id} registrado correctamente.` } });
    } catch (err) {
      if (err.payload?.sku) {
        setErrores({ [err.payload.sku]: true });
        enfocar('cant-' + err.payload.sku);
      }
      showAlert('danger', err.message || 'No se pudo registrar el conteo.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Nuevo conteo cíclico</div>
          <div className="page-subtitle">Conteo físico por bodega, sin ver el stock del sistema (CU-37)</div>
        </div>
        <Link to="/conteos" className="btn btn-secondary">← Volver a conteos</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="bodega">Bodega a contar <span className="required">*</span></label>
            <select className="form-control" id="bodega" value={bodegaId} onChange={e => elegirBodega(e.target.value)} disabled={guardando}>
              {bodegas === null
                ? <option value="">Cargando bodegas...</option>
                : <><option value="">Seleccionar bodega...</option>{bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}</>}
            </select>
          </div>
          <div style={{ fontSize: 13, color: 'var(--gray)', paddingBottom: 9 }}>
            {cargando ? 'Cargando productos...' : prep && <>Responsable: <strong>{user?.username}</strong></>}
          </div>
        </div>
      </div>

      {prep && duplicado && (
        // Exc 3: ya hay un conteo de esta bodega hoy
        <div className="card" style={{ marginBottom: 16 }}>
          <Alert type="warning" message={<>Ya existe un conteo de <strong>{prep.bodega.nombre}</strong> registrado hoy
            ({new Date(prep.conteo_hoy.fecha_hora).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}
            {prep.conteo_hoy.usuario && <>, por {prep.conteo_hoy.usuario}</>}).</>} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to={`/conteos/${prep.conteo_hoy.id}`} className="btn btn-secondary">Ver conteo existente</Link>
            <button type="button" className="btn btn-primary" onClick={() => { setOtroConteo(true); setFoco({ id: 'justificacion' }); }}>
              Crear otro conteo
            </button>
          </div>
        </div>
      )}

      {prep && !duplicado && (
        <>
          {prep.conteo_hoy && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" htmlFor="justificacion">
                  Justificación del segundo conteo de hoy <span className="required">*</span>
                </label>
                <textarea className="form-control" id="justificacion" rows={2} maxLength={500}
                  placeholder="Ej: recuento solicitado por diferencias grandes en el conteo de la mañana"
                  value={justificacion} onChange={e => setJustificacion(e.target.value)} />
              </div>
            </div>
          )}

          {recuperado && (
            <Alert type="info" message={<>Se recuperó el avance guardado en este navegador ({recuperado}).{' '}
              <a href="#" onClick={e => { e.preventDefault(); descartarAvance(); }} style={{ color: 'var(--orange)' }}>Descartar avance</a></>} />
          )}

          <EscanerCodigo onProducto={onProducto} autoFocus={false} permitirInactivos />

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div className="section-label" style={{ marginBottom: 0 }}>Productos de {prep.bodega.nombre}</div>
              <div style={{ fontSize: 13, color: 'var(--gray)' }} id="progreso">
                {contados} de {lineas.length} contados{noEsperados > 0 && <> · {noEsperados} no esperado(s)</>}
              </div>
            </div>
            <div className="table-wrap">
              <table id="tabla-conteo">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Producto</th>
                    <th style={{ width: 150 }}>Cantidad contada</th>
                    <th>Unidad</th>
                    <th>Observación</th>
                    <th style={{ width: 70 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lineas.map(l => (
                    <tr key={l.sku}>
                      <td className="td-mono">{l.sku}</td>
                      <td>
                        {l.nombre}
                        {l.no_esperado && <span className="badge badge-warning" style={{ marginLeft: 6 }}>No esperado</span>}
                        {l.estado && l.estado !== 'activo' && <span className="badge badge-gray" style={{ marginLeft: 6 }}>Inactivo</span>}
                      </td>
                      <td>
                        <input className="form-control" id={'cant-' + l.sku} inputMode="decimal" autoComplete="off"
                          placeholder="Sin contar" value={l.cantidad}
                          onChange={e => cambiar(l.sku, 'cantidad', e.target.value)} onKeyDown={onCantidadKey}
                          style={errores[l.sku] ? { borderColor: 'var(--danger)' } : undefined}
                          aria-invalid={errores[l.sku] ? 'true' : undefined} />
                      </td>
                      <td style={{ color: 'var(--gray)', fontSize: 13 }}>{l.unidad_medida || '—'}</td>
                      <td>
                        <input className="form-control" id={'obs-' + l.sku} maxLength={500} placeholder="Opcional"
                          value={l.observacion} onChange={e => cambiar(l.sku, 'observacion', e.target.value)} />
                      </td>
                      <td>
                        {l.no_esperado && (
                          <button type="button" className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => quitar(l.sku)}>
                            Quitar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-hint" style={{ marginTop: 8 }}>
              Deje vacía la cantidad de lo que no alcanzó a contar. Se aceptan decimales (ej: 12,5 kg). Después de escribir la cantidad, Enter vuelve al escáner.
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Link to="/conteos" className="btn btn-secondary">Cancelar</Link>
            <button type="button" className="btn btn-primary" id="btn-confirmar" onClick={confirmar} disabled={guardando}>
              {guardando ? 'Registrando...' : 'Confirmar conteo'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
