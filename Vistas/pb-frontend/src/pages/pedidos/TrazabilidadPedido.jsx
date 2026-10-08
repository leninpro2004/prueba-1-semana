import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { formatQty } from '../../utils/format';
import { estadoDespacho, fechaCorta, fechaHora } from './formatoInstalacion';

/**
 * CU-121: trazabilidad de los insumos de un pedido de instalación. Se busca por número de
 * venta o por SKU (el campo funciona con el lector de códigos: procesa al recibir Enter).
 * Cada insumo muestra su línea de tiempo: ingreso a bodega → bodega → vinculación →
 * preparación → retiro → carga → despacho; lo que el pedido aún no alcanzó queda "Pendiente".
 */

const MARCA = {
  completada: { icono: '✓', color: 'var(--success)', texto: null },
  parcial:    { icono: '◐', color: 'var(--warning)', texto: 'Parcial' },
  pendiente:  { icono: '○', color: 'var(--gray)',    texto: 'Pendiente' },
};

/** La fecha de ingreso es DATE ('YYYY-MM-DD'); las demás son instantes. */
const fechaEtapa = (e) => (!e.fecha ? null : e.clave === 'ingreso' ? fechaCorta(e.fecha) : fechaHora(e.fecha));

function LineaDeTiempo({ insumo }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 600 }}>{insumo.nombre}</div>
      <div style={{ fontSize: 11, color: 'var(--gray)', marginBottom: 10 }}>
        <code>{insumo.sku}</code> · {formatQty(insumo.requerida)}{insumo.unidad ? ` ${insumo.unidad}` : ''}
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {insumo.etapas.map((e, i) => {
          const m = MARCA[e.estado] || MARCA.pendiente;
          return (
            <li key={e.clave} style={{ display: 'flex', gap: 10, position: 'relative', paddingBottom: i < insumo.etapas.length - 1 ? 12 : 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${m.color}`, color: m.color,
                               display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700 }}>{m.icono}</span>
                {i < insumo.etapas.length - 1 && <span style={{ flex: 1, width: 2, background: 'var(--border, #ddd)', marginTop: 2 }} />}
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

export default function TrazabilidadPedido() {
  usePageTitle('Trazabilidad de pedidos');
  const { alert, showAlert } = useAlert();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [texto, setTexto] = useState(q);
  const [res, setRes] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [recarga, setRecarga] = useState(0);   // repetir la misma búsqueda vuelve a consultar

  useEffect(() => {
    if (!q) return;
    let cancelado = false;
    API.pedidosVenta.trazabilidad(q)
      .then(r => { if (!cancelado) setRes(r); })
      .catch(err => { if (!cancelado) { setRes(null); showAlert('warning', err.message); } })   // Exc 2
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [q, recarga, showAlert]);

  const buscar = (ev) => {
    ev.preventDefault();
    const v = texto.trim();
    if (!v) { showAlert('warning', 'Ingrese el número de venta o el SKU a consultar.'); return; }
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
          <div className="page-subtitle">Recorrido de los insumos de un pedido de instalación, desde el ingreso a bodega hasta el despacho (CU-121)</div>
        </div>
        <Link to="/instalacion" className="btn btn-ghost">← Pedidos de instalación</Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <form className="card" onSubmit={buscar} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <label className="form-label" htmlFor="traza-q" style={{ marginBottom: 4 }}>Número de venta o SKU</label>
          <input className="form-control" id="traza-q" autoFocus value={texto} onChange={ev => setTexto(ev.target.value)}
            placeholder="Ej: NV-PRUEBA-INV-01 o TUB-040" />
        </div>
        <button type="submit" className="btn btn-primary" disabled={cargando}>{cargando ? 'Buscando…' : 'Buscar'}</button>
      </form>

      {res?.sin_datos && <Alert type="info" message={res.mensaje} style={{ marginTop: 16 }} />}

      {res?.tipo === 'sku' && !res.sin_datos && (
        <div style={{ marginTop: 16, fontSize: 13, color: 'var(--gray)' }}>
          {res.material.nombre} (<code>{res.material.sku}</code>) aparece en {res.pedidos.length} pedido(s) de instalación.
        </div>
      )}

      {(res?.pedidos || []).map(p => {
        const e = estadoDespacho(p.venta.estado_despacho);
        return (
          <div key={p.venta.id} style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <Link to={`/instalacion/${p.venta.id}`} style={{ fontWeight: 600, fontSize: 15 }}>{p.venta.numero}</Link>
              <span style={{ fontSize: 13, color: 'var(--gray)' }}>{p.venta.cliente || '—'} · venta "{p.venta.estado_pedido}"</span>
              <span className={'badge ' + e.badge}>{e.texto}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {p.insumos.map(i => <LineaDeTiempo key={i.sku} insumo={i} />)}
            </div>
          </div>
        );
      })}
    </>
  );
}
