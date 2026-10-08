import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { formatMoney, formatQty } from '../../utils/format';

/**
 * CU-103: diferenciales de consumo de una OT finalizada.
 * Desviación = real − estimado; % = ÷ estimado × 100. Sin estimado → "Sin base de
 * comparación" (Exc 2). Planificados sin consumo registrado se listan aparte: no son
 * ahorro. El impacto en CLP solo llega a quien puede ver montos (el backend lo quita a jop).
 */

const TIPOS = {
  sobre_gasto:    { etiqueta: 'Sobre gasto',    badge: 'badge-danger' },
  ahorro:         { etiqueta: 'Ahorro',         badge: 'badge-success' },
  sin_desviacion: { etiqueta: 'Sin desviación', badge: 'badge-gray' },
  sin_base:       { etiqueta: 'Sin base de comparación', badge: 'badge-warning' },
};

const pct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toLocaleString('es-CL', { maximumFractionDigits: 2 }) + '%');
const conSigno = (v) => (v > 0 ? '+' : '') + formatQty(v);

export default function TabDesviaciones({ otId, estado, puedeProcesar }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [procesando, setProcesando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    if (!puedeProcesar) return undefined;
    let cancelado = false;
    API.ordenesTrabajo.diferenciales(otId)
      .then(d => { if (!cancelado) setDatos(d); })
      .catch(e => { if (!cancelado) setError(e.message); });
    return () => { cancelado = true; };
  }, [otId, puedeProcesar, recarga]);

  const procesar = async () => {
    setProcesando(true);
    setError(''); setMensaje('');
    try {
      const r = await API.ordenesTrabajo.procesarDiferenciales(otId);
      setDatos(r);
      setMensaje(r.message);
    } catch (e) {
      setError(e.message);
      setRecarga(n => n + 1);
    } finally {
      setProcesando(false);
    }
  };

  if (!puedeProcesar) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--gray)' }}>
        Esta pestaña es para quien gestiona la producción (gerencia y jefatura de operaciones).
      </div>
    );
  }

  const finalizada = estado === 'finalizada';
  const r = datos?.resumen;
  const verMontos = r && 'impacto_neto_clp' in r;

  return (
    <div className="tab-content" id="tab-desviaciones">
      <div className="card card-sm" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13 }}>
          {!finalizada
            ? <>Los diferenciales se procesan cuando la orden de trabajo está <strong>finalizada</strong> (hoy: {estado || '—'}). Use "Finalizar OT" arriba.</>
            : datos?.procesado
              ? <>Procesado el {new Date(datos.procesado.fecha).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })}{datos.procesado.usuario ? ` por ${datos.procesado.usuario}` : ''}.</>
              : 'Esta orden de trabajo todavía no tiene diferenciales procesados.'}
        </div>
        {finalizada && (
          <button className="btn btn-primary btn-sm" onClick={procesar} disabled={procesando} id="btn-procesar-dif">
            {procesando ? 'Procesando…' : datos?.procesado ? 'Reprocesar diferenciales' : 'Procesar diferenciales'}
          </button>
        )}
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}
      {mensaje && <div className="alert alert-success" style={{ marginBottom: 16 }}>{mensaje}</div>}

      {r && r.items > 0 && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi-card kpi-danger"><div className="kpi-label">Sobre gasto</div><div className="kpi-value danger">{r.sobre_gasto}</div>
            <div className="kpi-sub">{verMontos ? formatMoney(r.impacto_sobre_gasto_clp) + ' (incluye sin base)' : 'ítem(s)'}</div></div>
          <div className="kpi-card kpi-success"><div className="kpi-label">Ahorro</div><div className="kpi-value" style={{ color: 'var(--success)' }}>{r.ahorro}</div>
            <div className="kpi-sub">{verMontos ? formatMoney(r.impacto_ahorro_clp) : 'ítem(s)'}</div></div>
          <div className="kpi-card"><div className="kpi-label">Sin desviación</div><div className="kpi-value">{r.sin_desviacion}</div><div className="kpi-sub">ítem(s)</div></div>
          <div className="kpi-card kpi-warning"><div className="kpi-label">Sin base</div><div className="kpi-value warning">{r.sin_base}</div><div className="kpi-sub">No estaban planificados</div></div>
          {verMontos && <div className="kpi-card"><div className="kpi-label">Impacto neto</div><div className="kpi-value" style={{ fontSize: 20 }}>{formatMoney(r.impacto_neto_clp)}</div><div className="kpi-sub">Positivo = gasto de más</div></div>}
        </div>
      )}

      {datos?.items?.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th style={{ textAlign: 'right' }}>Estimado</th><th style={{ textAlign: 'right' }}>Real</th>
                  <th style={{ textAlign: 'right' }}>Desviación</th><th style={{ textAlign: 'right' }}>%</th><th>Tipo</th>
                  {verMontos && <th style={{ textAlign: 'right' }}>Impacto</th>}
                </tr>
              </thead>
              <tbody>
                {datos.items.map(i => (
                  <tr key={i.sku}>
                    <td><div style={{ fontWeight: 500, fontSize: 13 }}>{i.nombre}</div><div style={{ fontSize: 11, color: '#aaa' }}>{i.sku} · {i.unidad || ''}</div></td>
                    <td style={{ textAlign: 'right' }}>{i.tipo === 'sin_base' ? '—' : formatQty(i.estimado)}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(i.real)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{conSigno(i.desviacion_abs)}</td>
                    <td style={{ textAlign: 'right' }}>{pct(i.desviacion_pct)}</td>
                    <td><span className={'badge ' + TIPOS[i.tipo].badge}>{TIPOS[i.tipo].etiqueta}</span></td>
                    {verMontos && <td style={{ textAlign: 'right' }}>{i.impacto_clp == null ? <span style={{ color: 'var(--gray)' }}>Sin precio</span> : formatMoney(i.impacto_clp)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {datos?.sin_consumo_registrado?.length > 0 && (
        <div className="alert alert-warning" style={{ fontSize: 13 }}>
          <strong>Planificados sin consumo registrado</strong> (no se cuentan como ahorro):{' '}
          {datos.sin_consumo_registrado.map(s => `${s.sku} (estimado ${formatQty(s.estimado)})`).join(', ')}.
          Si sí se consumieron, registre el consumo real y reprocese.
        </div>
      )}
    </div>
  );
}
