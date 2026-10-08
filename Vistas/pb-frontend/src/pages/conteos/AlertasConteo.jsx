import { useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import Alert from '../../components/Alert';

/**
 * CU-57: generar las alertas de un conteo procesado con diferencias.
 * Se usa en el detalle del conteo (gerencia y jop) y en la vista de diferencias.
 * conteo = { id, estado, resultado, alertas_generadas }
 */
export default function AlertasConteo({ conteo, onGeneradas }) {
  const [generando, setGenerando] = useState(false);
  const [aviso, setAviso] = useState(null);

  if (!conteo || conteo.estado !== 'procesado') return null;

  const generar = async () => {
    setGenerando(true);
    try {
      const resp = await API.conteos.generarAlertas(conteo.id);
      // 409 (ya generadas) llega como datos con error
      setAviso({ type: resp?.error ? 'warning' : 'success', message: resp?.error || resp?.message });
      onGeneradas?.();
    } catch (err) {
      setAviso({ type: 'danger', message: err.message || 'No se pudieron generar las alertas.' });
    } finally {
      setGenerando(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }} id="alertas-conteo">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="section-label" style={{ marginBottom: 2 }}>Alertas por diferencia (CU-57)</div>
          <div style={{ fontSize: 13, color: 'var(--gray)' }}>
            {conteo.resultado === 'conforme'
              ? 'El conteo es conforme: no hay diferencias fuera de tolerancia que alertar.'
              : conteo.alertas_generadas > 0
                ? <>Se generaron {conteo.alertas_generadas} alerta(s) desde este conteo.</>
                : 'Las diferencias fuera de tolerancia todavía no tienen alertas. Las críticas se avisan de inmediato a Gerencia.'}
          </div>
        </div>
        {conteo.resultado === 'con_diferencias' && (conteo.alertas_generadas > 0
          ? <Link to="/alertas" className="btn btn-secondary">Ver alertas</Link>
          : (
            <button type="button" className="btn btn-primary" id="btn-generar-alertas" onClick={generar} disabled={generando}>
              {generando ? 'Generando...' : 'Generar alertas'}
            </button>
          ))}
      </div>
      {aviso && <Alert {...aviso} style={{ marginTop: 12, marginBottom: 0 }} />}
    </div>
  );
}
