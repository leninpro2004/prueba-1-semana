import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import { useAuth } from '../../hooks/useAuth';
import Alert from '../../components/Alert';

/**
 * CU-107: simulador de módulo externo. HERRAMIENTA DE PRUEBA, solo en desarrollo
 * (la ruta y el ítem del menú existen solo con import.meta.env.DEV): no llega al
 * build que se entrega al cliente.
 *
 * Emula la pantalla de Terreno o Finanzas: llama a POST /api/integracion/movimientos
 * con el token del usuario conectado, igual que lo harán esos módulos con el login
 * común, y muestra la respuesta como la vería el otro módulo. Para probar los
 * rechazos por rol, entrar con otro usuario.
 */

const MODULOS = [{ valor: 'terreno', nombre: 'Terreno' }, { valor: 'finanzas', nombre: 'Finanzas' }];
const TIPOS = [{ valor: 'salida', nombre: 'Salida' }, { valor: 'entrada', nombre: 'Entrada (devolución)' }];
const OTRO = '__otro__';
const FORM_INICIAL ={ modulo: 'terreno', tipo: 'salida', sku: '', bodega_id: '', cantidad: '', referencia: '', descripcion: '' };

const nuevaClave = () => (crypto.randomUUID ? crypto.randomUUID() : `sim-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const hora = () => new Date().toLocaleTimeString('es-CL');

/** Traduce la respuesta (o el error) de Inventario a lo que mostraría el otro módulo. */
function interpretar(resp, err) {
  if (err) {
    return { status: err.status || 0, tipo: 'danger', codigo: err.payload?.codigo, message: err.message, detalle: err.payload };
  }
  if (resp?.codigo) {  // los 409 llegan como datos
    return { status: 409, tipo: 'danger', codigo: resp.codigo, message: resp.error, detalle: resp };
  }
  if (resp?.repetido) return { status: 200, tipo: 'info', codigo: 'REPETIDO', message: resp.message, detalle: resp };
  return { status: 201, tipo: 'success', codigo: 'REGISTRADO', message: resp?.message, detalle: resp };
}

export default function SimuladorModulo() {
  usePageTitle('Simulador de módulo externo');
  const { user } = useAuth();
  const [materiales, setMateriales] = useState([]);
  const [bodegas, setBodegas] = useState([]);
  const [form, setForm] = useState(FORM_INICIAL);
  const [otroSku, setOtroSku] = useState(false);
  const [ultimo, setUltimo] = useState(null);       // último cuerpo enviado (para reenviarlo tal cual)
  const [respuesta, setRespuesta] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    Promise.all([API.materiales.listar(), API.bodegas.listar()])
      .then(([m, b]) => { setMateriales(m || []); setBodegas(b || []); })
      .catch(() => {});
  }, []);

  const cambiar = (campo) => (e) => setForm(f => ({ ...f, [campo]: e.target.value }));

  const enviar = async (body) => {
    setEnviando(true);
    let r;
    try {
      r = interpretar(await API.integracion.registrarMovimiento(body));
    } catch (err) {
      r = interpretar(null, err);
    } finally {
      setEnviando(false);
    }
    setUltimo(body);
    setRespuesta({ ...r, clave: body.clave_envio });
    setHistorial(h => [{ hora: hora(), body, ...r }, ...h].slice(0, 10));
  };

  // Cada envío nuevo lleva su propia clave; "Reenviar" repite la última (idempotencia)
  const enviarNuevo = () => enviar({ ...form, clave_envio: nuevaClave() });
  const reenviar = () => ultimo && enviar(ultimo);

  const moduloNombre = (v) => MODULOS.find(m => m.valor === v)?.nombre || v || '—';

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Simulador de módulo externo</div>
          <div className="page-subtitle">Envía movimientos a Inventario como lo harían Terreno o Finanzas (CU-107)</div>
        </div>
      </div>

      <Alert type="warning" message={
        `Herramienta de prueba, solo visible en desarrollo. Emula la pantalla de otro módulo: el movimiento es real ` +
        `y mueve el stock. Se envía con su sesión (${user?.username}, rol ${user?.rol}); para probar otro rol, entre con otro usuario.`
      } />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="card" id="sim-form">
          <div className="section-label">Pantalla de {moduloNombre(form.modulo)} (simulada)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="sim-modulo">Módulo de origen</label>
              <select className="form-control" id="sim-modulo" value={form.modulo} onChange={cambiar('modulo')}>
                {MODULOS.map(m => <option key={m.valor} value={m.valor}>{m.nombre}</option>)}
                <option value="produccion">Otro (no válido)</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sim-tipo">Tipo de movimiento</label>
              <select className="form-control" id="sim-tipo" value={form.tipo} onChange={cambiar('tipo')}>
                {TIPOS.map(t => <option key={t.valor} value={t.valor}>{t.nombre}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sim-sku">Producto</label>
              {/* Mismo formato que Registrar entrada. "Otro SKU" permite escribir uno que no existe (Exc 2) */}
              <select className="form-control" id="sim-sku" value={otroSku ? OTRO : form.sku}
                onChange={e => {
                  const v = e.target.value;
                  setOtroSku(v === OTRO);
                  setForm(f => ({ ...f, sku: v === OTRO ? '' : v }));
                }}>
                <option value="">Seleccionar producto...</option>
                {materiales.map(m => (
                  <option key={m.sku} value={m.sku}>{m.sku} — {m.nombre}{m.estado && m.estado !== 'activo' ? ` (${m.estado})` : ''}</option>
                ))}
                <option value={OTRO}>Otro SKU (escribir)...</option>
              </select>
              {otroSku && (
                <input className="form-control" id="sim-sku-otro" style={{ marginTop: 6 }} value={form.sku} onChange={cambiar('sku')}
                  placeholder="SKU a enviar" autoComplete="off" autoFocus />
              )}
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sim-bodega">Bodega</label>
              <select className="form-control" id="sim-bodega" value={form.bodega_id} onChange={cambiar('bodega_id')}>
                <option value="">Sin bodega</option>
                {bodegas.map(b => (
                  <option key={b.id} value={b.id}>{b.nombre}{['activo', 'activa'].includes(b.estado) ? '' : ` (${b.estado})`}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sim-cantidad">Cantidad</label>
              <input className="form-control" id="sim-cantidad" inputMode="decimal" value={form.cantidad} onChange={cambiar('cantidad')} />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="sim-referencia">Referencia de la operación</label>
              <input className="form-control" id="sim-referencia" value={form.referencia} onChange={cambiar('referencia')}
                placeholder={form.modulo === 'finanzas' ? 'Ej. NV-2026-015' : 'Ej. OBRA-2026-015'} />
            </div>
          </div>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label" htmlFor="sim-descripcion">Descripción (opcional)</label>
            <input className="form-control" id="sim-descripcion" value={form.descripcion} onChange={cambiar('descripcion')} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" id="btn-reenviar" onClick={reenviar} disabled={!ultimo || enviando}
              title="Repite el último envío con la misma clave: Inventario no debe registrarlo dos veces">
              Reenviar el mismo envío
            </button>
            <button type="button" className="btn btn-primary" id="btn-enviar" onClick={enviarNuevo} disabled={enviando}>
              {enviando ? 'Enviando...' : 'Enviar a Inventario'}
            </button>
          </div>
        </div>

        <div className="card" id="sim-respuesta">
          <div className="section-label">Respuesta de Inventario</div>
          {!respuesta ? (
            <p style={{ color: 'var(--gray)', fontSize: 13 }}>Todavía no se envía nada.</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
                <span className={`badge badge-${respuesta.tipo === 'danger' ? 'danger' : respuesta.tipo === 'info' ? 'info' : 'success'}`}>
                  {respuesta.status || 'sin conexión'}
                </span>
                {respuesta.codigo && <span className="td-mono" style={{ fontSize: 12 }}>{respuesta.codigo}</span>}
              </div>
              <Alert type={respuesta.tipo} message={respuesta.message} style={{ marginBottom: 8 }} />
              {respuesta.detalle?.campos?.length > 0 && (
                <ul style={{ fontSize: 13, margin: '0 0 8px', paddingLeft: 18 }}>
                  {respuesta.detalle.campos.map(c => <li key={c.campo}><strong>{c.campo}</strong>: {c.error}</li>)}
                </ul>
              )}
              <div style={{ fontSize: 12, color: 'var(--gray)' }}>
                {respuesta.detalle?.movimiento_id && <>Movimiento #{respuesta.detalle.movimiento_id} · </>}
                {respuesta.detalle?.stock_disponible !== undefined && <>Disponible en la bodega: {respuesta.detalle.stock_disponible} · </>}
                Clave de envío: <span className="td-mono">{respuesta.clave}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {historial.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-label">Últimos envíos</div>
          <div className="table-wrap">
            <table id="sim-historial">
              <thead><tr><th>Hora</th><th>Módulo</th><th>Tipo</th><th>SKU</th><th>Cantidad</th><th>Referencia</th><th>Resultado</th></tr></thead>
              <tbody>
                {historial.map((h, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{h.hora}</td>
                    <td>{moduloNombre(h.body.modulo)}</td>
                    <td>{h.body.tipo}</td>
                    <td className="td-mono" style={{ whiteSpace: 'nowrap' }}>{h.body.sku || '—'}</td>
                    <td>{h.body.cantidad || '—'}</td>
                    <td>{h.body.referencia || '—'}</td>
                    <td><span className={`badge badge-${h.tipo === 'danger' ? 'danger' : h.tipo === 'info' ? 'info' : 'success'}`}>{h.status} {h.codigo}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
