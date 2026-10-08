import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API } from '../../services/api';
import { exportarCSV } from '../../utils/csvExport';
import { usePageTitle } from '../../contexts/TitleContext';
import { usePrompt } from '../../hooks/useDialog';
import PinturaSobrantes from './PinturaSobrantes';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import BotonExportar from '../../components/BotonExportar';
import { usePagination } from '../../hooks/usePagination';
import SelectorProducto from '../../components/SelectorProducto';

// OPUS-16: las dos pantallas de pinturas se unen aqui. "Sobrantes" era una pagina
// aparte (/pinturas/sobrantes, que ahora redirige) y pasa a ser la primera pestaña:
// es la pregunta que el usuario se hace primero — cuanta pintura queda.
const TABS = [
  ['sobrantes', 'Sobrantes'],
  ['registro',  'Registrar uso'],
  ['historial', 'Historial'],
  ['consumo',   'Consumo'],
];

const AGRUPACIONES = [
  ['material', 'Por pintura'],
  ['color', 'Por color'],
  ['area', 'Por área'],
  ['ot', 'Por orden de trabajo'],
];

// D65: mismos estados que el backend (ordenesTrabajoController.ESTADOS_OT_CERRADA)
const OT_CERRADA = ['cancelada', 'finalizada', 'completada', 'cerrada'];

const fmtFecha = (f) => (f ? new Date(f).toLocaleString('sv-SE').slice(0, 16) : '—');
const fmtGr = (g) => (g == null ? '—' : `${g} gr`);

/**
 * Pinturas — OPUS-11 (Req #3) + OPUS-16.
 * Se pesa el envase al retirarlo de bodega y al devolverlo: la diferencia es
 * lo realmente consumido. Un retiro sin devolución todavía no tiene consumo,
 * así que no suma a los totales (el backend lo deja en NULL a propósito).
 *
 * OPUS-16: ese consumo AHORA descuenta stock. Las pinturas se llevan en kilogramos,
 * así que los gramos medidos se descuentan dividiendo por 1000. Un retiro abierto
 * todavía no descuenta nada. Esta página unifica lo que antes eran dos pantallas
 * (sobrantes y seguimiento).
 */
export default function PinturaSeguimiento() {
  usePageTitle('Pinturas');
  const { alert, showAlert } = useAlert();
  const prompt = usePrompt();
  // R1: desde la OT ("Registrar retiro de pintura") llega ?ot=&area=: se abre el
  // registro con la OT y su área ya elegidas
  const [params] = useSearchParams();
  const otDesdeOrden = params.get('ot') || '';

  const [tab, setTab] = useState(otDesdeOrden ? 'registro' : 'sobrantes');
  const [catalogo, setCatalogo] = useState({ pinturas: [], areas: [] });
  const [ordenes, setOrdenes] = useState([]);

  // Formulario de registro
  const [sku, setSku] = useState('');
  const [pesoEntrada, setPesoEntrada] = useState('');
  const [pesoSalida, setPesoSalida] = useState('');
  const [otId, setOtId] = useState(otDesdeOrden);
  const [areaId, setAreaId] = useState(otDesdeOrden ? (params.get('area') || '') : '');
  /** D65: al elegir una OT, el área pasa a ser la suya. */
  const elegirOt = (id) => {
    setOtId(id);
    const ot = ordenes.find(o => String(o.id) === String(id));
    setAreaId(ot?.area_id ? String(ot.area_id) : '');
  };
  const [colorAplicado, setColorAplicado] = useState('');
  const [superficie, setSuperficie] = useState('');
  const [observacion, setObservacion] = useState('');
  const [guardando, setGuardando] = useState(false);
  // OPUS-16: de qué bodega sale el envase. Si el material está en más de una, el
  // backend rechaza el registro pidiendo elegirla.
  const [bodegas, setBodegas] = useState([]);
  const [bodegaId, setBodegaId] = useState('');

  // Envases abiertos (pendientes de devolución)
  const [abiertos, setAbiertos] = useState([]);
  const [devSeguimiento, setDevSeguimiento] = useState(null); // id en devolución
  const [devPeso, setDevPeso] = useState('');
  const [devSuperficie, setDevSuperficie] = useState('');

  // Historial
  const [datos, setDatos] = useState(null);
  const [fSku, setFSku] = useState('');
  const [fOt, setFOt] = useState('');
  const [fArea, setFArea] = useState('');
  const [fDesde, setFDesde] = useState('');
  const [fHasta, setFHasta] = useState('');
  const [fEstado, setFEstado] = useState('');

  // Reporte de consumo
  const [agrupar, setAgrupar] = useState('material');
  const [rDesde, setRDesde] = useState('');
  const [rHasta, setRHasta] = useState('');
  const [reporte, setReporte] = useState(null);

  useEffect(() => {
    API.seguimientoPinturas.catalogo()
      .then(c => setCatalogo(c || { pinturas: [], areas: [] }))
      .catch(e => showAlert('danger', 'Error cargando el catálogo de pinturas: ' + e.message));
    // D65: solo OT abiertas (una finalizada no admite retiros de pintura)
    API.ordenesTrabajo.listar()
      .then(o => setOrdenes((Array.isArray(o) ? o : []).filter(x => !OT_CERRADA.includes(String(x.estado).toLowerCase()))))
      .catch(e => console.warn('Error cargando OTs:', e.message));
  }, [showAlert]);

  const cargarAbiertos = useCallback(async () => {
    try {
      const d = await API.seguimientoPinturas.listar({ estado: 'abierto' });
      setAbiertos(d?.seguimientos || []);
    } catch (e) {
      console.warn('Error cargando envases abiertos:', e.message);
    }
  }, []);

  useEffect(() => { cargarAbiertos(); }, [cargarAbiertos]);

  const cargarHistorial = useCallback(async () => {
    try {
      const d = await API.seguimientoPinturas.listar({
        sku: fSku || null, orden_trabajo_id: fOt || null, area_trabajo_id: fArea || null,
        desde: fDesde || null, hasta: fHasta || null, estado: fEstado || null,
      });
      setDatos(d);
    } catch (err) {
      showAlert('danger', 'Error cargando el historial: ' + err.message);
      setDatos({ resumen: {}, seguimientos: [] });
    }
  }, [fSku, fOt, fArea, fDesde, fHasta, fEstado, showAlert]);

  useEffect(() => { if (tab === 'historial') cargarHistorial(); }, [tab, cargarHistorial]);

  const cargarReporte = useCallback(async () => {
    try {
      const d = await API.seguimientoPinturas.reporte({
        agrupar, desde: rDesde || null, hasta: rHasta || null,
      });
      setReporte(d);
    } catch (err) {
      showAlert('danger', 'Error generando el reporte: ' + err.message);
    }
  }, [agrupar, rDesde, rHasta, showAlert]);

  useEffect(() => { if (tab === 'consumo') cargarReporte(); }, [tab, cargarReporte]);

  // Catálogo de bodegas para el selector de origen (OPUS-16)
  useEffect(() => {
    API.bodegas.listar()
      .then(b => setBodegas(Array.isArray(b) ? b : (b?.bodegas || [])))
      .catch(() => {});
  }, []);

  const pinturaElegida = catalogo.pinturas.find(p => p.sku === sku);

  const limpiarFormulario = () => {
    setSku(''); setPesoEntrada(''); setPesoSalida(''); setOtId(''); setAreaId('');
    setColorAplicado(''); setSuperficie(''); setObservacion(''); setBodegaId('');
  };

  const registrar = async () => {
    const entrada = parseFloat(pesoEntrada);
    if (!sku) { showAlert('warning', 'Seleccione la pintura que se retira.'); return; }
    if (isNaN(entrada) || entrada <= 0) { showAlert('warning', 'El peso del envase al retirarlo debe ser mayor a 0.'); return; }
    if (!otId && !areaId) { showAlert('warning', 'Sin OT, indique el área que usa la pintura.'); return; }   // D65
    if (pesoSalida !== '' && parseFloat(pesoSalida) > entrada) {
      showAlert('warning', 'El peso de devolución no puede ser mayor que el de retiro.');
      return;
    }
    setGuardando(true);
    try {
      const resp = await API.seguimientoPinturas.registrar({
        sku,
        peso_entrada_gr: entrada,
        peso_salida_gr: pesoSalida === '' ? null : parseFloat(pesoSalida),
        orden_trabajo_id: otId || null,
        area_trabajo_id: areaId || null,
        color_aplicado: colorAplicado || null,
        superficie_m2: superficie === '' ? null : parseFloat(superficie),
        observacion: observacion || null,
        bodega_id: bodegaId || null,
      });
      showAlert(resp?.advertencia ? 'warning' : 'success',
        (resp?.message || 'Uso registrado') + (resp?.advertencia ? ' · ' + resp.advertencia : ''));
      limpiarFormulario();
      cargarAbiertos();
      if (tab === 'historial') cargarHistorial();
    } catch (err) {
      const multi = err.payload?.bodegas;
      showAlert('danger', multi?.length ? (
        <>
          {err.message}
          <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 12 }}>
            {multi.map(b => <li key={b.bodega_id}>Bodega #{b.bodega_id} — {b.disponible} disponible(s)</li>)}
          </ul>
        </>
      ) : 'Error: ' + err.message);
    } finally {
      setGuardando(false);
    }
  };

  const abrirDevolucion = (s) => {
    setDevSeguimiento(s.id);
    setDevPeso('');
    setDevSuperficie(s.superficie_m2 != null ? String(s.superficie_m2) : '');
  };

  const confirmarDevolucion = async (s) => {
    const peso = parseFloat(devPeso);
    if (isNaN(peso) || peso < 0) { showAlert('warning', 'Indique el peso del envase al devolverlo.'); return; }
    if (peso > s.peso_entrada_gr) {
      showAlert('warning', `El envase salió pesando ${s.peso_entrada_gr} gr; no puede volver pesando más.`);
      return;
    }
    try {
      const resp = await API.seguimientoPinturas.devolver(s.id, {
        peso_salida_gr: peso,
        superficie_m2: devSuperficie === '' ? null : parseFloat(devSuperficie),
      });
      setDevSeguimiento(null);
      showAlert(resp?.advertencia ? 'warning' : 'success',
        (resp?.message || 'Envase devuelto') + (resp?.advertencia ? ' · ' + resp.advertencia : ''));
      cargarAbiertos();
      if (tab === 'historial') cargarHistorial();
    } catch (err) {
      showAlert('danger', 'Error al registrar la devolución: ' + err.message);
    }
  };

  /* OPUS-16: anular devuelve al stock lo que este seguimiento hubiera descontado.
     No borra la fila: el registro sigue siendo historial, marcado como anulado. */
  const anular = async (s) => {
    const motivo = await prompt(
      `¿Anular el seguimiento #${s.id} de ${s.material}?` +
      (s.stock_descontado_kg > 0 ? ` Se devolverán ${s.stock_descontado_kg} kg al stock.` : ''),
      'Motivo de la anulación'
    );
    if (motivo === null) return;
    try {
      const resp = await API.seguimientoPinturas.anular(s.id, { motivo });
      showAlert(resp?.advertencia ? 'warning' : 'success',
        (resp?.message || 'Seguimiento anulado') + (resp?.advertencia ? ' · ' + resp.advertencia : ''));
      cargarAbiertos();
      cargarHistorial();
    } catch (err) {
      showAlert('danger', 'Error al anular: ' + err.message);
    }
  };

  const seguimientos = datos?.seguimientos || [];
  const resumen = datos?.resumen || {};
  const pag = usePagination(seguimientos, 20);

  // Un consumo muy por encima del promedio de esa pintura merece mirarse
  const promedioPorSku = {};
  seguimientos.filter(s => !s.abierto).forEach(s => {
    if (!promedioPorSku[s.sku]) promedioPorSku[s.sku] = { suma: 0, n: 0 };
    promedioPorSku[s.sku].suma += s.peso_consumido_gr || 0;
    promedioPorSku[s.sku].n += 1;
  });
  const esAnomalo = (s) => {
    const p = promedioPorSku[s.sku];
    if (s.abierto || !p || p.n < 3) return false;
    return s.peso_consumido_gr > (p.suma / p.n) * 1.5;
  };

  const exportarHistorial = () => {
    const num = (titulo) => ({ titulo, formato: 'numero' });
    const headers = ['ID', { titulo: 'Fecha y hora', formato: 'timestamp' }, 'SKU', 'Pintura', 'Color aplicado', 'OT', 'Área',
      num('Peso retiro (gr)'), num('Peso devolución (gr)'), num('Consumido (gr)'), num('Superficie (m2)'),
      num('Rendimiento (gr/m2)'), 'Estado', 'Usuario'];
    const rows = seguimientos.map(s => [
      s.id, s.fecha_uso || '', s.sku, s.material || '', s.color_aplicado || '',
      s.orden_trabajo_id ? '#' + s.orden_trabajo_id : '', s.area || '',
      s.peso_entrada_gr, s.peso_salida_gr ?? '', s.peso_consumido_gr ?? '',
      s.superficie_m2 ?? '', s.rendimiento_gr_m2 ?? '',
      s.abierto ? 'Sin devolver' : 'Cerrado', s.usuario || '',
    ]);
    try { exportarCSV('seguimiento-pinturas', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  const exportarReporte = () => {
    const num = (titulo) => ({ titulo, formato: 'numero' });
    const headers = ['Grupo', 'Usos', num('Consumido (gr)'), num('Promedio (gr)'), num('Máximo (gr)'),
                     num('Superficie (m2)'), num('Rendimiento (gr/m2)')];
    const rows = (reporte?.grupos || []).map(g => [
      g.etiqueta, g.usos, g.consumido_gr, g.promedio_gr, g.maximo_gr, g.superficie_m2 ?? '', g.rendimiento_gr_m2 ?? '',
    ]);
    try { exportarCSV('consumo-pinturas', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Pinturas</div>
          <div className="page-subtitle">Stock sobrante y consumo real por peso de envase</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/pinturas/sobrantes" className="btn btn-ghost">Pinturas sobrantes</Link>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)' }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={'btn btn-ghost tab-btn' + (tab === k ? ' active' : '')}
            style={{ borderRadius: 0, marginBottom: -2, borderBottom: tab === k ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/* ── Tab: Registrar uso ── */}
      {tab === 'sobrantes' && (
        <div className="tab-content" id="tab-sobrantes">
          <PinturaSobrantes embebido />
        </div>
      )}

      {tab === 'registro' && (
        <div className="tab-content" id="tab-registro">
          <div className="card" style={{ padding: 20, marginBottom: 20 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Retiro de pintura</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Pese el envase al sacarlo de bodega. Al devolverlo, registre el peso de vuelta y el sistema
              calcula cuánta pintura se usó. Si ya conoce los dos pesos, cárguelos juntos.
              <div style={{ marginTop: 4 }}>
                El consumo <strong>descuenta stock</strong>: las pinturas se llevan en kilogramos, así que
                1.000 gr consumidos descuentan 1 kg. Un retiro sin devolver todavía no descuenta nada.
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 200 }}>
                <label className="form-label">Pintura</label>
                <SelectorProducto id="reg-sku" value={sku} onChange={setSku}
                  opciones={catalogo.pinturas.map(x => ({ sku: x.sku, nombre: x.nombre, detalle: x.color || '' }))} />
                {pinturaElegida && (
                  <div style={{ fontSize: 11, color: pinturaElegida.stock > 0 ? 'var(--text-secondary)' : 'var(--danger)', marginTop: 4 }}>
                    Stock: {pinturaElegida.stock} {pinturaElegida.unidad}
                    {pinturaElegida.stock <= 0 && ' — sin stock en bodega'}
                  </div>
                )}
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 130 }}>
                <label className="form-label">Peso al retirar (gr)</label>
                <input className="form-control" type="number" id="reg-entrada" min={0.01} step="0.01"
                  value={pesoEntrada} onChange={e => setPesoEntrada(e.target.value)} />
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 130 }}>
                <label className="form-label">
                  Peso al devolver (gr)
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 11 }}> · opcional</span>
                </label>
                <input className="form-control" type="number" id="reg-salida" min={0} step="0.01"
                  value={pesoSalida} onChange={e => setPesoSalida(e.target.value)} placeholder="Si ya volvió" />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 150 }}>
                <label className="form-label">Orden de trabajo</label>
                <select className="form-control" id="reg-ot" value={otId} onChange={e => elegirOt(e.target.value)}>
                  <option value="">Sin OT</option>
                  {ordenes.map(o => (
                    <option key={o.id} value={o.id}>#{o.id}{o.proyecto_codigo ? ' — ' + o.proyecto_codigo : ''}{o.area ? ' · ' + o.area : ''}</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 150 }}>
                <label className="form-label">
                  Bodega de origen
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 11 }}> · opcional</span>
                </label>
                <select className="form-control" id="reg-bodega" value={bodegaId} onChange={e => setBodegaId(e.target.value)}>
                  <option value="">Automática</option>
                  {bodegas.map(b => <option key={b.id || b.bodega_id} value={b.id || b.bodega_id}>{b.nombre || b.bodega_nombre}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
                <label className="form-label">Área {!otId && <span className="required">*</span>}</label>
                {/* D65: con OT, el área es la de la OT; sin OT es obligatoria */}
                <select className="form-control" id="reg-area" value={areaId} onChange={e => setAreaId(e.target.value)} disabled={!!otId}>
                  <option value="">{otId ? 'La de la OT' : 'Seleccione...'}</option>
                  {catalogo.areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
                <label className="form-label">Color aplicado</label>
                <input className="form-control" id="reg-color" value={colorAplicado}
                  onChange={e => setColorAplicado(e.target.value)}
                  placeholder={pinturaElegida?.color || 'Color del catálogo'} />
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 120 }}>
                <label className="form-label">
                  Superficie (m²)
                  <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: 11 }}> · opcional</span>
                </label>
                <input className="form-control" type="number" id="reg-superficie" min={0.01} step="0.01"
                  value={superficie} onChange={e => setSuperficie(e.target.value)} />
              </div>
            </div>

            <div className="form-group" style={{ marginTop: 12, marginBottom: 12 }}>
              <label className="form-label">Observación</label>
              <input className="form-control" id="reg-observacion" value={observacion}
                onChange={e => setObservacion(e.target.value)} placeholder="Opcional" />
            </div>

            <button className="btn btn-primary" id="btn-registrar" onClick={registrar} disabled={guardando}>
              {guardando ? 'Guardando…' : 'Registrar'}
            </button>
            <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
              Sin el peso de devolución, el retiro queda abierto: no suma al consumo ni descuenta stock.
            </span>
          </div>

          {/* Envases sin devolver */}
          <div className="card">
            <div className="card-title">
              Envases sin devolver
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}> · {abiertos.length} pendiente(s)</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th><th>Fecha</th><th>Pintura</th><th>OT</th><th>Área</th>
                    <th style={{ textAlign: 'right' }}>Peso al retirar</th>
                    <th>Retirado por</th>
                    <th style={{ textAlign: 'center' }}>Devolución</th>
                  </tr>
                </thead>
                <tbody id="abiertos-body">
                  {abiertos.length === 0 && (
                    <EmptyRow colSpan={8} emptyMsg="No hay envases pendientes de devolución." />
                  )}
                  {abiertos.map(s => (
                    <tr key={s.id}>
                      <td><span className="td-mono" style={{ fontSize: 11 }}>{s.id}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>{fmtFecha(s.fecha_uso)}</td>
                      <td>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{s.material}</div>
                        <div style={{ fontSize: 11, color: '#aaa' }}>{s.sku}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {s.orden_trabajo_id ? <Link to={`/ordenes/${s.orden_trabajo_id}`}>#{s.orden_trabajo_id}</Link> : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.area || '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtGr(s.peso_entrada_gr)}</td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.usuario || '—'}</td>
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {devSeguimiento === s.id ? (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}>
                            <input className="form-control" type="number" min={0} step="0.01" autoFocus
                              style={{ width: 110, fontSize: 12 }} placeholder="Peso (gr)"
                              value={devPeso} onChange={e => setDevPeso(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') confirmarDevolucion(s); if (e.key === 'Escape') setDevSeguimiento(null); }} />
                            <input className="form-control" type="number" min={0.01} step="0.01"
                              style={{ width: 90, fontSize: 12 }} placeholder="m²"
                              value={devSuperficie} onChange={e => setDevSuperficie(e.target.value)} />
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => confirmarDevolucion(s)}>Guardar</button>
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => setDevSeguimiento(null)}>Cancelar</button>
                          </div>
                        ) : (
                          <button className="btn btn-secondary" style={{ padding: '2px 10px', fontSize: 11 }}
                            onClick={() => abrirDevolucion(s)}>Registrar devolución</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Historial ── */}
      {tab === 'historial' && (
        <div className="tab-content" id="tab-historial">
          <div className="kpi-grid" style={{ marginBottom: 20 }}>
            <div className="kpi-card">
              <div className="kpi-label">Registros</div>
              <div className="kpi-value">{resumen.total_registros ?? '—'}</div>
              <div className="kpi-sub">{resumen.abiertos ?? 0} sin devolver</div>
            </div>
            <div className="kpi-card kpi-danger">
              <div className="kpi-label">Consumo medido</div>
              <div className="kpi-value danger">{resumen.consumido_gr ?? 0} gr</div>
              <div className="kpi-sub">Solo retiros cerrados</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Stock descontado</div>
              <div className="kpi-value">{resumen.stock_descontado_kg ?? 0} kg</div>
              <div className="kpi-sub">Rebajado del inventario</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Superficie</div>
              <div className="kpi-value">{resumen.superficie_m2 ?? 0} m²</div>
              <div className="kpi-sub">Informada en los registros</div>
            </div>
            <div className="kpi-card kpi-success">
              <div className="kpi-label">Rendimiento</div>
              <div className="kpi-value" style={{ color: 'var(--success)' }}>
                {resumen.rendimiento_gr_m2 != null ? resumen.rendimiento_gr_m2 : '—'}
              </div>
              <div className="kpi-sub">gramos por m²</div>
            </div>
          </div>

          <div className="card card-sm" style={{ marginBottom: 16 }}>
            <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Pintura</label>
                <div style={{ minWidth: 240 }}><SelectorProducto id="filtro-sku" vacio="Todas" value={fSku} onChange={setFSku} opciones={catalogo.pinturas} /></div>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>OT</label>
                <select className="form-control" id="filtro-ot" style={{ width: 'auto' }} value={fOt} onChange={e => setFOt(e.target.value)}>
                  <option value="">Todas</option>
                  {ordenes.map(o => <option key={o.id} value={o.id}>#{o.id}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Área</label>
                <select className="form-control" id="filtro-area" style={{ width: 'auto' }} value={fArea} onChange={e => setFArea(e.target.value)}>
                  <option value="">Todas</option>
                  {catalogo.areas.map(a => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Estado</label>
                <select className="form-control" id="filtro-estado" style={{ width: 'auto' }} value={fEstado} onChange={e => setFEstado(e.target.value)}>
                  <option value="">Todos</option>
                  <option value="abierto">Sin devolver</option>
                  <option value="cerrado">Cerrados</option>
                  <option value="anulado">Anulados</option>
                  <option value="todos">Todos (incl. anulados)</option>
                </select>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Desde</label>
                <input className="form-control" type="date" id="filtro-desde" style={{ width: 'auto' }} value={fDesde} onChange={e => setFDesde(e.target.value)} />
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Hasta</label>
                <input className="form-control" type="date" id="filtro-hasta" style={{ width: 'auto' }} value={fHasta} onChange={e => setFHasta(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" id="btn-limpiar"
                  onClick={() => { setFSku(''); setFOt(''); setFArea(''); setFDesde(''); setFHasta(''); setFEstado(''); }}>
                  Limpiar filtros
                </button>
                <BotonExportar id="btn-exportar-historial" className="btn btn-secondary btn-sm" onClick={exportarHistorial}
                  filas={datos ? seguimientos.length : null} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>ID</th><th>Fecha</th><th>Pintura</th><th>Color</th><th>OT</th><th>Área</th>
                    <th style={{ textAlign: 'right' }}>Retiro</th>
                    <th style={{ textAlign: 'right' }}>Devolución</th>
                    <th style={{ textAlign: 'right' }}>Consumido</th>
                    <th style={{ textAlign: 'right' }}>Stock desc.</th>
                    <th style={{ textAlign: 'right' }}>gr/m²</th>
                    <th>Usuario</th>
                    <th style={{ textAlign: 'center' }}>Acción</th>
                  </tr>
                </thead>
                <tbody id="historial-body">
                  {!datos && <tr><td colSpan={13} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
                  {datos && seguimientos.length === 0 && (
                    <EmptyRow colSpan={13} emptyMsg={
                      <div className="empty-state">
                        <div className="empty-state-icon">🎨</div>
                        <p>No hay usos de pintura registrados con estos filtros.</p>
                      </div>
                    } />
                  )}
                  {datos && pag.items.map(s => (
                    <tr key={s.id} style={
                      s.estado === 'anulado'
                        ? { opacity: 0.55, textDecoration: 'line-through' }
                        : esAnomalo(s) ? { background: 'rgba(255,193,7,0.12)' } : undefined
                    }>
                      <td><span className="td-mono" style={{ fontSize: 11 }}>{s.id}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--gray)', whiteSpace: 'nowrap' }}>{fmtFecha(s.fecha_uso)}</td>
                      <td>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{s.material}</div>
                        <div style={{ fontSize: 11, color: '#aaa' }}>{s.sku}</div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.color_aplicado || s.color_catalogo || '—'}</td>
                      <td style={{ fontSize: 12 }}>
                        {s.orden_trabajo_id ? <Link to={`/ordenes/${s.orden_trabajo_id}`}>#{s.orden_trabajo_id}</Link> : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.area || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{fmtGr(s.peso_entrada_gr)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {s.abierto
                          ? <span className="badge badge-warning" style={{ fontSize: 10 }}>sin devolver</span>
                          : fmtGr(s.peso_salida_gr)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>
                        {fmtGr(s.peso_consumido_gr)}
                        {esAnomalo(s) && (
                          <span title="Muy por encima del promedio de esta pintura" style={{ marginLeft: 4 }}>⚠</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>
                        {s.stock_descontado_kg > 0 ? `${s.stock_descontado_kg} kg` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{s.rendimiento_gr_m2 ?? '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{s.usuario || '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {s.estado === 'anulado'
                          ? <span className="badge badge-gray" style={{ fontSize: 10 }}>anulado</span>
                          : (
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => anular(s)}
                              title={s.stock_descontado_kg > 0
                                ? `Devuelve ${s.stock_descontado_kg} kg al stock`
                                : 'Este registro no descontó stock'}>
                              Anular
                            </button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...pag} />
          </div>
        </div>
      )}

      {/* ── Tab: Consumo ── */}
      {tab === 'consumo' && (
        <div className="tab-content" id="tab-consumo">
          <div className="card card-sm" style={{ marginBottom: 16 }}>
            <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Agrupar</label>
                <select className="form-control" id="rep-agrupar" style={{ width: 'auto' }}
                  value={agrupar} onChange={e => setAgrupar(e.target.value)}>
                  {AGRUPACIONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Desde</label>
                <input className="form-control" type="date" id="rep-desde" style={{ width: 'auto' }} value={rDesde} onChange={e => setRDesde(e.target.value)} />
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>Hasta</label>
                <input className="form-control" type="date" id="rep-hasta" style={{ width: 'auto' }} value={rHasta} onChange={e => setRHasta(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { setRDesde(''); setRHasta(''); }}>Todo el período</button>
                <BotonExportar id="btn-exportar-reporte" className="btn btn-secondary btn-sm" onClick={exportarReporte}
                  filas={reporte ? (reporte.grupos?.length || 0) : null} />
              </div>
            </div>
          </div>

          {reporte?.resumen?.retiros_abiertos > 0 && (
            <div className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
              ⚠ {reporte.resumen.retiros_abiertos} envase(s) del período siguen sin devolver, así que su consumo
              todavía no está medido y no entra en estos totales.
            </div>
          )}

          <div className="card">
            <div className="card-title">
              Consumo {AGRUPACIONES.find(a => a[0] === agrupar)?.[1].toLowerCase()}
              {reporte?.resumen && (
                <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {' · '}{reporte.resumen.consumido_gr} gr en {reporte.resumen.usos} uso(s)
                  {reporte.resumen.rendimiento_gr_m2 != null && ` · ${reporte.resumen.rendimiento_gr_m2} gr/m²`}
                </span>
              )}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Grupo</th>
                    <th style={{ textAlign: 'right' }}>Usos</th>
                    <th style={{ textAlign: 'right' }}>Consumido</th>
                    <th style={{ textAlign: 'right' }}>Promedio</th>
                    <th style={{ textAlign: 'right' }}>Máximo</th>
                    <th style={{ textAlign: 'right' }}>Superficie</th>
                    <th style={{ textAlign: 'right' }}>gr/m²</th>
                  </tr>
                </thead>
                <tbody id="reporte-body">
                  {!reporte && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
                  {reporte && reporte.grupos.length === 0 && (
                    <EmptyRow colSpan={7} emptyMsg="No hay consumos medidos en este período." />
                  )}
                  {reporte && reporte.grupos.map(g => (
                    <tr key={g.clave}>
                      <td style={{ fontWeight: 500, fontSize: 13 }}>{g.etiqueta}</td>
                      <td style={{ textAlign: 'right' }}>{g.usos}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{g.consumido_gr} gr</td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{g.promedio_gr} gr</td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{g.maximo_gr} gr</td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{g.superficie_m2 != null ? g.superficie_m2 + ' m²' : '—'}</td>
                      <td style={{ textAlign: 'right', fontSize: 12 }}>{g.rendimiento_gr_m2 ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
