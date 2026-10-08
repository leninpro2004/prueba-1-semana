import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { useConfirm } from '../../hooks/useDialog';
import Alert from '../../components/Alert';
import { fechaHora } from './formato';

/**
 * D10 (sesión 4): tolerancias del conteo cíclico, editables por Gerencia.
 * Se aplican a los conteos que se procesen desde el cambio; los ya procesados
 * conservan la tolerancia con la que se evaluaron.
 */

const TIPOS = [
  { tipo: 'critico',    nombre: 'Productos críticos' },
  { tipo: 'no_critico', nombre: 'Productos no críticos' },
];
const PCT_OK = /^\d+([.,]\d{1,2})?$/;
const num = (v) => Number(String(v).trim().replace(',', '.'));

export default function ToleranciasConteo() {
  const confirm = useConfirm();
  const [vigentes, setVigentes] = useState(null);
  const [form, setForm] = useState({});
  const [aviso, setAviso] = useState(null);   // { type, message }
  const [guardando, setGuardando] = useState(false);
  const [abierta, setAbierta] = useState(false);

  const cargarForm = (t) => setForm(Object.fromEntries(TIPOS.map(({ tipo }) => [tipo, {
    tolerancia_pct: String(t[tipo].tolerancia_pct).replace('.', ','),
    umbral_critico_pct: String(t[tipo].umbral_critico_pct).replace('.', ','),
  }])));

  useEffect(() => {
    let cancelado = false;
    API.conteos.tolerancias()
      .then(t => { if (!cancelado) { setVigentes(t); cargarForm(t); } })
      .catch(err => { if (!cancelado) setAviso({ type: 'danger', message: 'Error cargando tolerancias: ' + err.message }); });
    return () => { cancelado = true; };
  }, []);

  const cambiar = (tipo, campo, valor) => setForm(f => ({ ...f, [tipo]: { ...f[tipo], [campo]: valor } }));

  const validar = () => {
    for (const { tipo, nombre } of TIPOS) {
      const { tolerancia_pct: t, umbral_critico_pct: u } = form[tipo];
      if (!PCT_OK.test(String(t).trim())) return `La tolerancia de ${nombre.toLowerCase()} debe ser un porcentaje igual o mayor a 0 (hasta 2 decimales).`;
      if (!PCT_OK.test(String(u).trim()) || num(u) <= num(t)) return `El umbral crítico de ${nombre.toLowerCase()} debe ser mayor que su tolerancia.`;
      if (num(u) > 1000) return `El umbral crítico de ${nombre.toLowerCase()} no puede superar 1000 %.`;
    }
    return null;
  };

  const guardar = async () => {
    const error = validar();
    if (error) { setAviso({ type: 'danger', message: error }); return; }
    const ok = await confirm(
      'Las nuevas tolerancias se aplicarán a los conteos que se procesen desde ahora. Los conteos ya procesados conservan las suyas. ¿Guardar?',
      'Cambiar tolerancias'
    );
    if (!ok) return;
    setGuardando(true);
    try {
      const body = Object.fromEntries(TIPOS.map(({ tipo }) => [tipo, {
        tolerancia_pct: num(form[tipo].tolerancia_pct),
        umbral_critico_pct: num(form[tipo].umbral_critico_pct),
      }]));
      const resp = await API.conteos.actualizarTolerancias(body);
      setVigentes(resp.tolerancias);
      cargarForm(resp.tolerancias);
      setAviso({ type: 'success', message: resp.message });
    } catch (err) {
      setAviso({ type: 'danger', message: err.message });
    } finally {
      setGuardando(false);
    }
  };

  if (!vigentes && !aviso) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }} id="tolerancias-conteo">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="section-label" style={{ marginBottom: 2 }}>Tolerancias de conteo</div>
          {vigentes && (
            <div style={{ fontSize: 13, color: 'var(--gray)' }}>
              Críticos: {vigentes.critico.tolerancia_pct} % / {vigentes.critico.umbral_critico_pct} % ·
              No críticos: {vigentes.no_critico.tolerancia_pct} % / {vigentes.no_critico.umbral_critico_pct} %
              <span style={{ fontSize: 11 }}> (tolerancia / umbral crítico)</span>
            </div>
          )}
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setAbierta(a => !a)} aria-expanded={abierta}>
          {abierta ? 'Cerrar' : 'Configurar'}
        </button>
      </div>

      {aviso && <Alert {...aviso} style={{ marginTop: 12, marginBottom: 0 }} />}

      {abierta && vigentes && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--gray)', margin: '0 0 12px' }}>
            <strong>Tolerancia:</strong> hasta este porcentaje la diferencia se considera normal; se registra, pero no genera alerta.
            <br /><strong>Umbral crítico:</strong> sobre este porcentaje la alerta es crítica y se avisa de inmediato a Gerencia.
            Entre ambos, la alerta es de prioridad alta.
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tipo de producto</th><th>Tolerancia (%)</th><th>Umbral crítico (%)</th><th>Última modificación</th></tr></thead>
              <tbody>
                {TIPOS.map(({ tipo, nombre }) => (
                  <tr key={tipo}>
                    <td>{nombre}</td>
                    <td>
                      <input className="form-control" id={`tol-${tipo}`} inputMode="decimal" style={{ maxWidth: 110 }}
                        value={form[tipo]?.tolerancia_pct ?? ''} onChange={e => cambiar(tipo, 'tolerancia_pct', e.target.value)} />
                    </td>
                    <td>
                      <input className="form-control" id={`umb-${tipo}`} inputMode="decimal" style={{ maxWidth: 110 }}
                        value={form[tipo]?.umbral_critico_pct ?? ''} onChange={e => cambiar(tipo, 'umbral_critico_pct', e.target.value)} />
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>
                      {!vigentes[tipo].configurado ? 'Valores por defecto, sin configurar'
                        : vigentes[tipo].usuario ? `${fechaHora(vigentes[tipo].fecha_modificacion)} por ${vigentes[tipo].usuario}`
                        : 'Valores iniciales'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="btn btn-primary" id="btn-guardar-tolerancias" onClick={guardar} disabled={guardando}>
              {guardando ? 'Guardando...' : 'Guardar tolerancias'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
