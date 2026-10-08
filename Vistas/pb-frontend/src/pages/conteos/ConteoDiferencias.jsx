import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { useConfirm } from '../../hooks/useDialog';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { fechaHora } from './formato';
import AlertasConteo from './AlertasConteo';

/**
 * CU-43: diferencias entre el conteo y el stock teórico guardado al confirmarlo.
 * Solo gerencia (el backend responde 403 al resto). Registrar las diferencias no ajusta el stock.
 * D53: ya procesado, gerencia aprueba el ajuste de los productos que elija (por defecto, los que están fuera de
 * tolerancia): el stock se mueve por la diferencia, con motivo y la referencia al conteo. Se revierte con CU-44.
 */

/** Líneas que todavía se pueden ajustar: con diferencia y sin un ajuste vigente. */
const ajustable = (l) => Math.abs(l.diferencia) > 1e-9 && !l.ajustado;

const cant = (v) => (v == null ? '—' : Number(v).toLocaleString('es-CL', { maximumFractionDigits: 4 }));
const conSigno = (v, sufijo = '') => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toLocaleString('es-CL', { maximumFractionDigits: 4 }) + sufijo);

const CLASIF = {
  faltante:       { label: 'Faltante',       cls: 'badge-danger' },
  sobrante:       { label: 'Sobrante',       cls: 'badge-warning' },
  sin_diferencia: { label: 'Sin diferencia', cls: 'badge-success' },
};
const RESULTADO = {
  conforme:        'Conforme: no se detectaron discrepancias significativas',
  con_diferencias: 'Con diferencias fuera de tolerancia',
};

function Cifra({ valor, etiqueta, color }) {
  return (
    <div className="card card-sm" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: valor > 0 ? color : 'var(--gray)' }}>{valor}</div>
      <div style={{ fontSize: 12, color: 'var(--gray)' }}>{etiqueta}</div>
    </div>
  );
}

export default function ConteoDiferencias() {
  const { id } = useParams();
  usePageTitle('Diferencias del conteo #' + id);
  const confirm = useConfirm();
  const { alert, showAlert } = useAlert();
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  const [procesando, setProcesando] = useState(false);
  const [version, setVersion] = useState(0); // se incrementa para recargar tras registrar
  const [seleccion, setSeleccion] = useState(new Set());   // D53: SKU a ajustar
  const [motivo, setMotivo] = useState('');

  useEffect(() => {
    let cancelado = false;
    API.conteos.diferencias(id)
      .then(d => {
        if (cancelado) return;
        setDatos(d);
        // D53: por defecto, los que están fuera de tolerancia y todavía no se ajustaron
        setSeleccion(new Set(d.procesado ? d.lineas.filter(l => l.supera_tolerancia && ajustable(l)).map(l => l.sku) : []));
      })
      .catch(err => { if (!cancelado) setError(err.message); });
    return () => { cancelado = true; };
  }, [id, version]);

  const alternar = (sku) => setSeleccion(s => {
    const n = new Set(s);
    if (n.has(sku)) n.delete(sku); else n.add(sku);
    return n;
  });

  const aprobarAjuste = async () => {
    const lineas = datos.lineas.filter(l => seleccion.has(l.sku));
    if (!lineas.length) { showAlert('warning', 'Seleccione al menos un producto para ajustar.'); return; }
    if (!motivo.trim()) { showAlert('danger', 'Indique el motivo del ajuste.'); return; }
    const ok = await confirm(
      <>
        Se ajustará el stock de <strong>{datos.conteo.bodega}</strong> por la diferencia del conteo:
        <ul style={{ margin: '8px 0', paddingLeft: 18 }}>
          {lineas.map(l => <li key={l.sku}>{l.nombre}: {l.diferencia < 0 ? 'salida' : 'entrada'} de {cant(Math.abs(l.diferencia))}</li>)}
        </ul>
        Queda en el historial con la referencia al conteo y se puede revertir. ¿Aprobar el ajuste?
      </>,
      'Aprobar ajuste de stock'
    );
    if (!ok) return;
    setProcesando(true);
    try {
      const resp = await API.conteos.ajustar(id, { skus: lineas.map(l => l.sku), motivo: motivo.trim() });
      showAlert(resp?.error ? 'danger' : 'success', resp?.error || resp?.message);
      setMotivo('');
      setVersion(v => v + 1);
    } catch (err) {
      // 400: el backend detalla las líneas que no se pueden ajustar (no se ajustó ninguna)
      const detalle = err.payload?.errores?.length > 1 ? ' ' + err.payload.errores.map(e => `${e.sku}: ${e.error}`).join(' ') : '';
      showAlert('danger', err.message + detalle);
    } finally {
      setProcesando(false);
    }
  };

  const registrar = async () => {
    const conforme = datos.resultado_previsto === 'conforme';
    const ok = await confirm(
      <>
        {conforme
          ? <>Todas las diferencias están dentro de la tolerancia. El conteo quedará registrado como <strong>conforme</strong>.</>
          : <>Se registrarán las diferencias: <strong>{datos.resumen.fuera_tolerancia}</strong> producto(s) fuera de tolerancia.</>}
        <br /><br />
        El stock no se modifica. Una vez registradas, las diferencias no se pueden cambiar.
      </>,
      'Registrar diferencias'
    );
    if (!ok) return;
    setProcesando(true);
    try {
      const resp = await API.conteos.procesar(id);
      // 409 (Exc 3): otro usuario lo procesó mientras se revisaba
      showAlert(resp?.procesado ? 'warning' : 'success', resp?.error || resp?.message);
      setVersion(v => v + 1);
    } catch (err) {
      showAlert('danger', err.message || 'No se pudieron registrar las diferencias.');
    } finally {
      setProcesando(false);
    }
  };

  const c = datos?.conteo;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Diferencias del conteo #{id}</div>
          <div className="page-subtitle">{c ? `${c.bodega} · contado el ${fechaHora(c.fecha_hora)} por ${c.usuario || '—'}` : 'Comparación contra el stock del sistema (CU-43)'}</div>
        </div>
        <Link to={`/conteos/${id}`} className="btn btn-secondary">← Volver al conteo</Link>
      </div>

      <div id="alert-container">
        <Alert {...alert} />
        {error && <Alert type="danger" message={error} />}
      </div>

      {datos && (
        <>
          {datos.procesado ? (
            <>
              <Alert type={c.resultado === 'conforme' ? 'success' : 'warning'} message={<>
                Procesado el {fechaHora(c.fecha_procesamiento)} por {c.procesado_por || '—'}. Resultado: <strong>{RESULTADO[c.resultado]}</strong>.
              </>} />
              {/* CU-57: siguiente paso, generar las alertas */}
              <AlertasConteo conteo={c} onGeneradas={() => setVersion(v => v + 1)} />
            </>
          ) : (
            <Alert type="info" message={<>
              Vista previa: todavía no se ha registrado nada. La comparación es contra el stock que había al confirmar el conteo,
              no contra el actual. Resultado previsto: <strong>{RESULTADO[datos.resultado_previsto]}</strong>.
            </>} />
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
            <Cifra valor={datos.resumen.faltantes} etiqueta="Faltantes" color="var(--danger)" />
            <Cifra valor={datos.resumen.sobrantes} etiqueta="Sobrantes" color="var(--warning)" />
            <Cifra valor={datos.resumen.sin_diferencia} etiqueta="Sin diferencia" color="var(--success)" />
            <Cifra valor={datos.resumen.fuera_tolerancia} etiqueta="Fuera de tolerancia" color="var(--danger)" />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-label">Productos contados</div>
            <div className="table-wrap">
              <table id="tabla-diferencias">
                <thead>
                  <tr>
                    <th>SKU</th><th>Producto</th><th>Teórico</th><th>Contado</th>
                    <th>Diferencia</th><th>%</th><th>Clasificación</th><th>Tolerancia</th><th></th>
                    {datos.procesado && <th>Ajuste</th>}
                  </tr>
                </thead>
                <tbody>
                  {datos.lineas.length === 0 ? (
                    <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--gray)' }}>No hay productos contados.</td></tr>
                  ) : datos.lineas.map(l => (
                    <tr key={l.sku} style={l.supera_tolerancia ? { background: 'rgba(220, 53, 69, 0.05)' } : undefined}>
                      <td className="td-mono">{l.sku}</td>
                      <td>
                        {l.nombre}
                        {l.es_critico && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Crítico</span>}
                        {l.no_esperado && <span className="badge badge-warning" style={{ marginLeft: 6 }}>No esperado</span>}
                        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{l.unidad_medida || ''}</div>
                      </td>
                      <td>{cant(l.stock_teorico)}</td>
                      <td>{cant(l.cantidad_contada)}</td>
                      <td style={{ fontWeight: 600, color: l.diferencia < 0 ? 'var(--danger)' : l.diferencia > 0 ? 'var(--warning)' : undefined }}>
                        {conSigno(l.diferencia)}
                      </td>
                      <td>{l.diferencia_pct == null ? <span title="Sin stock teórico: el porcentaje no se puede calcular">—</span> : conSigno(l.diferencia_pct, ' %')}</td>
                      <td><span className={'badge ' + CLASIF[l.clasificacion].cls}>{CLASIF[l.clasificacion].label}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--gray)' }}>{l.tolerancia_pct != null ? `± ${cant(l.tolerancia_pct)} %` : '—'}</td>
                      <td>{l.supera_tolerancia
                        ? <span className="badge badge-danger">Fuera de tolerancia</span>
                        : <span style={{ fontSize: 12, color: 'var(--gray)' }}>Dentro</span>}</td>
                      {datos.procesado && (
                        <td>
                          {l.ajustado ? <span className="badge badge-success">Ajustado</span>
                            : ajustable(l) ? (
                              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                                <input type="checkbox" checked={seleccion.has(l.sku)} onChange={() => alternar(l.sku)}
                                  aria-label={`Ajustar ${l.sku}`} disabled={procesando} />
                                Ajustar
                              </label>
                            ) : <span style={{ fontSize: 12, color: 'var(--gray)' }}>—</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-hint" style={{ marginTop: 8 }}>
              Diferencia = contado − teórico. La tolerancia depende de si el producto es crítico; Gerencia la configura en Conteo cíclico → Tolerancias.
              Un producto sin stock teórico (no esperado) siempre queda fuera de tolerancia.
            </div>
          </div>

          {/* D53: gerencia aprueba el ajuste del stock por la diferencia */}
          {datos.procesado && datos.lineas.some(ajustable) && (
            <div className="card" id="ajuste-conteo" style={{ marginBottom: 16 }}>
              <div className="section-label">Ajustar el stock</div>
              <div style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 10 }}>
                Los productos marcados se ajustan por su diferencia (un faltante descuenta lo libre de la bodega; un sobrante entra
                al lote más antiguo). No cuenta como consumo, queda en el historial con la referencia al conteo y se puede revertir.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="form-control" id="motivo-ajuste" style={{ maxWidth: 420 }} maxLength={255}
                  placeholder="Motivo del ajuste (obligatorio)" value={motivo} onChange={e => setMotivo(e.target.value)} />
                <button type="button" className="btn btn-primary" id="btn-aprobar-ajuste" onClick={aprobarAjuste}
                  disabled={procesando || seleccion.size === 0}>
                  {procesando ? 'Ajustando...' : `Aprobar ajuste (${seleccion.size})`}
                </button>
              </div>
            </div>
          )}

          {datos.sin_contar.length > 0 && (
            // Exc 1: productos sin cantidad, excluidos de la comparación
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="section-label">Sin contar: excluidos de la comparación ({datos.sin_contar.length})</div>
              <div style={{ fontSize: 13, color: 'var(--gray)' }}>
                {datos.sin_contar.map(s => `${s.sku} — ${s.nombre}`).join(' · ')}
              </div>
            </div>
          )}

          {!datos.procesado && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Link to={`/conteos/${id}`} className="btn btn-secondary">Cancelar</Link>
              <button type="button" className="btn btn-primary" id="btn-registrar-diferencias" onClick={registrar} disabled={procesando}>
                {procesando ? 'Registrando...' : 'Registrar diferencias'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
