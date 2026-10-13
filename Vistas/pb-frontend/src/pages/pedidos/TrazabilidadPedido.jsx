import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { formatQty } from '../../utils/format';
import { estadoDespacho, fechaCorta, fechaHora, medidasTexto } from './formatoInstalacion';

/**
 * CU-121: trazabilidad de los insumos de un pedido de instalación. Se busca por número de
 * venta, por SKU o por cliente (el campo funciona con el lector de códigos: procesa al recibir Enter).
 * F-12: una fila por pedido con su etapa y su avance; doble clic → lo pedido (con medidas) y la
 * línea de tiempo del pedido completo: ingreso a bodega → bodega → vinculación → preparación → retiro →
 * carga → despacho, cada etapa con cuántos insumos la cumplen; lo que el pedido aún no alcanzó queda
 * "Pendiente". El detalle por insumo queda plegado, una fila por insumo.
 */

const MARCA = {
  completada: { icono: '✓', color: 'var(--success)', texto: null },
  parcial:    { icono: '◐', color: 'var(--warning)', texto: 'Parcial' },
  pendiente:  { icono: '○', color: 'var(--gray)',    texto: 'Pendiente' },
};

/** La fecha de ingreso es DATE ('YYYY-MM-DD'); las demás son instantes. */
const fechaEtapa = (e) => (!e.fecha ? null : e.clave === 'ingreso' ? fechaCorta(e.fecha) : fechaHora(e.fecha));

/** Ícono de una etapa (✓ ◐ ○). */
function Marca({ estado, size = 22, title }) {
  const m = MARCA[estado] || MARCA.pendiente;
  return (
    <span title={title} style={{ width: size, height: size, borderRadius: '50%', border: `2px solid ${m.color}`, color: m.color, flexShrink: 0,
                                 display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size / 2, fontWeight: 700 }}>{m.icono}</span>
  );
}

/** F-12: la línea de tiempo del pedido completo (cada etapa dice cuántos insumos la cumplen). */
function LineaDeTiempo({ etapas }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Recorrido del pedido</div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {etapas.map((e, i) => {
          const m = MARCA[e.estado] || MARCA.pendiente;
          return (
            <li key={e.clave} style={{ display: 'flex', gap: 10, position: 'relative', paddingBottom: i < etapas.length - 1 ? 12 : 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <Marca estado={e.estado} />
                {i < etapas.length - 1 && <span style={{ flex: 1, width: 2, background: 'var(--border, #ddd)', marginTop: 2 }} />}
              </div>
              <div style={{ fontSize: 13, color: e.estado === 'pendiente' ? 'var(--gray)' : undefined }}>
                <div style={{ fontWeight: 500 }}>
                  {e.titulo}
                  {m.texto && <span className={'badge ' + (e.estado === 'parcial' ? 'badge-warning' : 'badge-gray')} style={{ marginLeft: 6, fontSize: 10 }}>{m.texto}</span>}
                </div>
                {fechaEtapa(e) && <div style={{ fontSize: 12 }}>{fechaEtapa(e)}</div>}
                {e.detalle && <div style={{ fontSize: 12, color: 'var(--gray)' }}>{e.detalle}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Etapa actual de un insumo: su primera etapa no completada. */
const etapaDelInsumo = (i) => i.etapas.find(e => e.estado !== 'completada');
const textoEtapa = (e) => [e.titulo, fechaEtapa(e), e.detalle].filter(Boolean).join(' · ');

/** F-12: el detalle por insumo, compacto: una fila por insumo con sus 7 etapas en íconos (el detalle al pasar el mouse). */
function DetallePorInsumo({ insumos }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Insumo</th><th style={{ textAlign: 'right' }}>Cantidad</th><th>Etapa actual</th><th>Recorrido</th></tr>
        </thead>
        <tbody>
          {insumos.map(i => {
            const actual = etapaDelInsumo(i);
            return (
              <tr key={i.sku}>
                <td>{i.nombre}<div style={{ fontSize: 11, color: 'var(--gray)' }}><code>{i.sku}</code></div></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{formatQty(i.requerida)}{i.unidad ? ` ${i.unidad}` : ''}</td>
                <td>
                  {actual ? actual.titulo : <span className="badge badge-success">Completo</span>}
                  {actual?.estado === 'parcial' && <span className="badge badge-warning" style={{ marginLeft: 6, fontSize: 10 }}>Parcial</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {i.etapas.map(e => <Marca key={e.clave} estado={e.estado} size={18} title={textoEtapa(e)} />)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** F-12: el resumen de lo que se pidió (puertas, medidas, receta), arriba de la línea de tiempo. */
function LoPedido({ items }) {
  if (!items?.length) return null;
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="section-label">Lo pedido</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th style={{ textAlign: 'right' }}>Cantidad</th><th>Descripción</th><th>Medidas (alto × ancho × espesor)</th><th>Receta</th><th /></tr>
          </thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id}>
                <td style={{ textAlign: 'right' }}>{formatQty(i.cantidad)}</td>
                <td>
                  {i.descripcion}
                  {i.observacion && <div style={{ fontSize: 12, color: 'var(--gray)' }}>{i.observacion}</div>}
                </td>
                <td>{medidasTexto(i)}</td>
                <td>{i.receta ? <code>{i.receta}</code> : i.sku ? <span style={{ color: 'var(--gray)' }}>material suelto</span> : '—'}</td>
                <td>{i.requiere_instalacion && <span className="badge badge-info" style={{ fontSize: 10 }}>instalación</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Barra de avance del pedido: etapas completadas sobre el total. */
function Avance({ resumen }) {
  if (!resumen) return <span style={{ color: 'var(--gray)' }}>—</span>;
  const p = resumen.porcentaje;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 130 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--border)' }}>
        <div style={{ width: `${p}%`, height: '100%', borderRadius: 3, background: p === 100 ? 'var(--success)' : 'var(--primary)' }} />
      </div>
      <span style={{ fontSize: 12, minWidth: 36, textAlign: 'right' }}>{p} %</span>
    </div>
  );
}

/** Etapa del pedido = la del insumo menos avanzado. Sin lotes reservados, ese insumo sigue en "Ingreso a bodega". */
function Etapa({ resumen }) {
  if (!resumen) return <span style={{ color: 'var(--gray)' }}>Sin insumos vinculados</span>;
  if (resumen.etapa === 'despachado') return <span className="badge badge-success">Despachado</span>;
  return (
    <>
      {resumen.etapa_titulo}
      {resumen.etapa_estado === 'parcial' && <span className="badge badge-warning" style={{ marginLeft: 6, fontSize: 10 }}>Parcial</span>}
      {resumen.etapa === 'ingreso' && <div style={{ fontSize: 11, color: 'var(--gray)' }}>falta stock de algún insumo</div>}
    </>
  );
}

const COLUMNAS = 7;

export default function TrazabilidadPedido() {
  usePageTitle('Trazabilidad de pedidos');
  const { alert, showAlert } = useAlert();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [texto, setTexto] = useState(q);
  const [res, setRes] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [recarga, setRecarga] = useState(0);   // repetir la misma búsqueda vuelve a consultar
  const [abiertos, setAbiertos] = useState(() => new Set());   // ids de venta desplegados
  const [insumosAbiertos, setInsumosAbiertos] = useState(() => new Set());   // ids de venta con el detalle por insumo a la vista

  const conmutar = (set) => (id) => set(prev => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id); else s.add(id);
    return s;
  });
  const alternar = conmutar(setAbiertos);
  const alternarInsumos = conmutar(setInsumosAbiertos);

  useEffect(() => {
    if (!q) return;
    let cancelado = false;
    API.pedidosVenta.trazabilidad(q)
      .then(r => {
        if (cancelado) return;
        setRes(r);
        // Un solo pedido: se abre directo
        setAbiertos(new Set(r?.pedidos?.length === 1 ? [r.pedidos[0].venta.id] : []));
        // Por SKU cada pedido trae solo ese insumo: su detalle viene a la vista
        setInsumosAbiertos(new Set(r?.tipo === 'sku' ? r.pedidos.map(p => p.venta.id) : []));
      })
      .catch(err => { if (!cancelado) { setRes(null); showAlert('warning', err.message); } })   // Exc 2
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [q, recarga, showAlert]);

  const buscar = (ev) => {
    ev.preventDefault();
    const v = texto.trim();
    if (!v) { showAlert('warning', 'Ingrese el número de venta, el SKU o el cliente a consultar.'); return; }
    setRes(null);
    setCargando(true);
    setParams({ q: v });
    setRecarga(n => n + 1);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Trazabilidad de pedidos</div>
          <div className="page-subtitle">Recorrido de los insumos de un pedido de instalación, desde el ingreso a bodega hasta el despacho</div>
        </div>
        <Link to="/instalacion" className="btn btn-ghost">← Pedidos de instalación</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <form className="card" onSubmit={buscar} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <label className="form-label" htmlFor="traza-q" style={{ marginBottom: 4 }}>Número de venta, SKU o cliente</label>
          <input className="form-control" id="traza-q" autoFocus value={texto} onChange={ev => setTexto(ev.target.value)}
            placeholder="Ej: NV-PRUEBA-INV-01, TUB-040 o Constructora Los Andes" />
        </div>
        <button type="submit" className="btn btn-primary" disabled={cargando}>{cargando ? 'Buscando…' : 'Buscar'}</button>
      </form>

      {res?.mensaje && <Alert type="info" message={res.mensaje} style={{ marginTop: 16 }} />}

      {res && !res.sin_datos && (
        <div style={{ marginTop: 16, fontSize: 13, color: 'var(--gray)' }}>
          {res.tipo === 'sku'
            ? <>{res.material.nombre} (<code>{res.material.sku}</code>) aparece en {res.pedidos.length} pedido(s) de instalación.</>
            : res.tipo === 'busqueda' && <>{res.pedidos.length} pedido(s) para "{res.consulta}".</>}
          {' '}Doble clic en una fila para ver lo pedido y su recorrido.
        </div>
      )}

      {res?.pedidos?.length > 0 && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="table-wrap">
            <table id="tabla-trazabilidad">
              <thead>
                <tr><th>Venta</th><th>Cliente</th><th>Despacho</th><th>Etapa actual</th><th>Avance</th><th>Insumos</th><th /></tr>
              </thead>
              <tbody>
                {res.pedidos.map(p => {
                  const e = estadoDespacho(p.venta.estado_despacho);
                  const abierto = abiertos.has(p.venta.id);
                  return (
                    <Fragment key={p.venta.id}>
                      <tr onDoubleClick={() => alternar(p.venta.id)} style={{ cursor: 'pointer' }} title="Doble clic para ver el detalle">
                        <td className="td-mono"><Link to={`/instalacion/${p.venta.id}`}>{p.venta.numero}</Link></td>
                        <td>
                          {p.venta.cliente || '—'}
                          <div style={{ fontSize: 11, color: 'var(--gray)' }}>venta "{p.venta.estado_pedido}"</div>
                        </td>
                        <td><span className={'badge ' + e.badge}>{e.texto}</span></td>
                        <td><Etapa resumen={p.resumen} /></td>
                        <td><Avance resumen={p.resumen} /></td>
                        <td>{p.resumen ? `${p.resumen.insumos_completos} de ${p.resumen.insumos} completos` : '—'}</td>
                        <td>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => alternar(p.venta.id)}>
                            {abierto ? 'Ocultar' : 'Ver'}
                          </button>
                        </td>
                      </tr>
                      {abierto && (
                        <tr>
                          <td colSpan={COLUMNAS} style={{ background: 'var(--gray-light)', padding: 12 }}>
                            <LoPedido items={p.items} />
                            {p.resumen ? (
                              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                                <div style={{ flex: '0 1 340px', minWidth: 260 }}><LineaDeTiempo etapas={p.resumen.etapas} /></div>
                                <div className="card" style={{ flex: '1 1 420px', padding: 14 }}>
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => alternarInsumos(p.venta.id)}>
                                    {insumosAbiertos.has(p.venta.id) ? '▾ Ocultar' : '▸ Ver'} detalle por insumo ({p.insumos.length})
                                  </button>
                                  {insumosAbiertos.has(p.venta.id) && <div style={{ marginTop: 8 }}><DetallePorInsumo insumos={p.insumos} /></div>}
                                </div>
                              </div>
                            ) : (
                              <div style={{ fontSize: 13, color: 'var(--gray)' }}>
                                Esta venta todavía no tiene insumos vinculados. <Link to={`/instalacion/${p.venta.id}`}>Ir al pedido</Link>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
