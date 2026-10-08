import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';

/** Programación Semanal de Instalaciones — conversión 1:1 de pedidos/programacion.html */
export default function PedidoProgramacion() {
  usePageTitle('Programación Semanal');
  const { alert, showAlert } = useAlert();

  // OPUS-7: rango configurable (la unidad base es la semana lunes-domingo)
  const [rango, setRango] = useState('1s');
  const [semanaInicio, setSemanaInicio] = useState('');
  const [periodo, setPeriodo] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [editEmpleado, setEditEmpleado] = useState(null); // id de OT en edicion
  const [resumen, setResumen] = useState(null);
  const [programacion, setProgramacion] = useState(null); // null = Cargando…; 'sin' = mensaje del backend
  const [menuOpen, setMenuOpen] = useState(false);
  const [falt, setFalt] = useState(null); // null | { loading, otId } | { error } | { otId, cancelada } | { otId, materiales }

  const params = { rango, ...(semanaInicio && { semana_inicio: semanaInicio }) };

  const cargar = useCallback(async () => {
    try {
      const data = await API.reportes.programacionSemanal({ rango, ...(semanaInicio && { semana_inicio: semanaInicio }) });
      setPeriodo(data?.periodo || null);
      if (data?.mensaje) {
        showAlert('info', data.mensaje);
        setResumen(null);
        setProgramacion('sin');
        return;
      }
      setResumen(data.resumen);
      setProgramacion(data.programacion || []);
    } catch (err) {
      showAlert('danger', 'Error: ' + err.message);
    }
  }, [rango, semanaInicio, showAlert]);

  useEffect(() => { cargar(); }, [cargar]);

  // Lista de usuarios activos para el selector de empleado tentativo
  useEffect(() => {
    API.usuarios.listar()
      .then(u => setUsuarios((u || []).filter(x => ['activo', 'activa'].includes(x.estado))))
      .catch(() => setUsuarios([]));
  }, []);

  // OPUS-7: empleado tentativo editable inline desde la programacion
  const guardarEmpleado = async (otId, empleadoId) => {
    try {
      const resp = await API.ordenesTrabajo.asignarEmpleadoTentativo(otId, empleadoId || null);
      setEditEmpleado(null);
      showAlert('success', resp?.message || 'Empleado tentativo actualizado');
      cargar();
    } catch (err) {
      showAlert('danger', 'Error al asignar el empleado tentativo: ' + err.message);
    }
  };

  // Cerrar menú exportar al hacer clic fuera
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  // CU-133: Ver detalle de faltantes por OT
  const verFaltantes = async (otId) => {
    setFalt({ loading: true, otId });
    try {
      const data = await API.ordenesTrabajo.consumos(otId);
      if (data?.error) { setFalt({ error: data.error }); return; }
      if (data?.orden && data.orden.estado === 'cancelada') { setFalt({ otId, cancelada: true }); return; }
      setFalt({ otId, materiales: data?.materiales || [] });
    } catch (err) {
      setFalt({ error: 'Error: ' + err.message });
    }
  };

  // CU-134: Exportar CSV / PDF
  const exportar = async (fn, nombre, tipo) => {
    setMenuOpen(false);
    try {
      const resp = await fn();
      if (!resp.ok) {
        const err = await resp.json();
        showAlert('warning', (err.error || 'Error al exportar') + ' Se recomienda reintentar la exportación.');
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
      showAlert('success', `Archivo ${tipo} exportado correctamente`);
    } catch (err) {
      showAlert('warning', 'Error al exportar: ' + err.message + '. Se recomienda reintentar la exportación.');
    }
  };

  const todoCompleto = falt?.materiales?.every(m => {
    const est = parseFloat(m.estimado || 0);
    const real = parseFloat(m.real || 0);
    return real >= est && m.real != null;
  });

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Programación de Instalaciones</div>
          <div className="page-subtitle">
            {periodo
              ? `${periodo.etiqueta} — ${periodo.desde} al ${periodo.hasta}`
              : 'Órdenes de trabajo programadas'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Link to="/reportes/movimientos" className="btn btn-ghost">← Reportes</Link>
          <button className="btn btn-primary" id="btn-refresh" onClick={cargar}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
            Actualizar
          </button>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button className="btn btn-secondary" id="btn-exportar" onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Exportar ▾
            </button>
            {menuOpen && (
              <div id="export-menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.1)', zIndex: 10, minWidth: 160, overflow: 'hidden' }}>
                <button className="btn btn-ghost" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '10px 16px', fontSize: 13 }} onClick={() => exportar(() => API.reportes.exportarProgramacion(params), `programacion_${periodo?.desde || ''}_${periodo?.hasta || ''}.csv`, 'CSV')}>📄 Exportar como CSV</button>
                <button className="btn btn-ghost" style={{ width: '100%', textAlign: 'left', borderRadius: 0, padding: '10px 16px', fontSize: 13, borderTop: '1px solid var(--border)' }} onClick={() => exportar(() => API.reportes.exportarProgramacionPDF(params), `programacion_${periodo?.desde || ''}_${periodo?.hasta || ''}.pdf`, 'PDF')}>📕 Exportar como PDF</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* OPUS-7: selector de rango. La semana siempre arranca en lunes (el backend
          lleva la fecha elegida al lunes de esa semana). */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 190 }}>
            <label className="form-label">Rango</label>
            <select className="form-control" id="filter-rango" value={rango} onChange={e => setRango(e.target.value)}>
              <option value="1s">1 semana (lunes a domingo)</option>
              <option value="2s">2 semanas</option>
              <option value="1m">1 mes</option>
              <option value="3m">3 meses</option>
              <option value="1a">1 año</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, minWidth: 180 }}>
            <label className="form-label">Semana de inicio</label>
            <input className="form-control" id="filter-semana" type="date" value={semanaInicio}
              onChange={e => setSemanaInicio(e.target.value)} />
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              Se ajusta al lunes de esa semana. Vacío = semana actual.
            </div>
          </div>
          {semanaInicio && (
            <button className="btn btn-ghost" onClick={() => setSemanaInicio('')}>Volver a la semana actual</button>
          )}
        </div>
      </div>

      {/* Resumen */}
      {resumen && (
        <div id="kpis" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Total OTs</div><div style={{ fontSize: 24, fontWeight: 700 }} id="kpi-total">{resumen.total_ots}</div></div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Con faltantes</div><div style={{ fontSize: 24, fontWeight: 700, color: 'var(--danger)' }} id="kpi-faltantes">{resumen.con_faltantes}</div></div>
            <div className="card" style={{ textAlign: 'center', padding: 16 }}><div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Sin faltantes</div><div style={{ fontSize: 24, fontWeight: 700, color: 'var(--success)' }} id="kpi-ok">{resumen.sin_faltantes}</div></div>
          </div>
        </div>
      )}

      {/* Tabla */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr><th>OT</th><th>Fecha instalación</th><th>Proyecto</th><th>Área</th><th>Responsable</th><th>Empleado tentativo</th><th>Estado</th><th style={{ textAlign: 'center' }}>Materiales</th><th style={{ textAlign: 'center' }}>Faltantes</th></tr>
            </thead>
            <tbody id="tabla-body">
              {programacion === null && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando…</td></tr>}
              {programacion === 'sin' && <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32 }}>Sin instalaciones programadas</td></tr>}
              {Array.isArray(programacion) && programacion.map(p => {
                const f = parseInt(p.materiales_con_faltante || 0);
                return (
                  <tr key={p.id}>
                    <td><Link to={`/ordenes/${p.id}`}>#{p.id}</Link></td>
                    <td>{new Date(p.fecha).toLocaleDateString('sv-SE')}</td>
                    <td>{p.proyecto_codigo || ''} {p.proyecto_nombre || '—'}</td>
                    <td>{p.area || '—'}</td>
                    <td>{p.responsable || '—'}</td>
                    {/* OPUS-7: empleado tentativo editable inline */}
                    <td>
                      {editEmpleado === p.id ? (
                        <select className="form-control" style={{ padding: '2px 6px', fontSize: 12, minWidth: 140 }}
                          autoFocus
                          defaultValue={p.empleado_tentativo_id || ''}
                          onChange={e => guardarEmpleado(p.id, e.target.value)}
                          onBlur={() => setEditEmpleado(null)}>
                          <option value="">— Sin asignar (usa el responsable) —</option>
                          {usuarios.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
                        </select>
                      ) : (
                        <span style={{ cursor: 'pointer' }} title="Clic para cambiar el empleado tentativo"
                          onClick={() => setEditEmpleado(p.id)}>
                          {p.empleado_tentativo || '—'}
                          {p.empleado_tentativo_heredado && p.empleado_tentativo && (
                            <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}> (responsable)</span>
                          )}
                          {' '}<span style={{ color: 'var(--primary)', fontSize: 11 }}>✎</span>
                        </span>
                      )}
                    </td>
                    <td><span className={`badge ${p.estado === 'cancelada' ? 'badge-danger' : p.estado === 'reprogramada' ? 'badge-warning' : ''}`}>{p.estado}</span></td>
                    <td style={{ textAlign: 'center' }}>{p.total_materiales}</td>
                    <td style={{ textAlign: 'center' }}>
                      {f > 0
                        ? <span className="badge badge-danger" style={{ cursor: 'pointer' }} onClick={() => verFaltantes(p.id)}>{f} — ver detalle</span>
                        : <span className="badge badge-success">0</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal detalle faltantes por OT (CU-133) */}
      {falt && (
        <div className="modal-overlay" id="modal-faltantes" style={{ display: 'flex' }}>
          <div className="modal" style={{ maxWidth: 650 }}>
            <div className="modal-header">
              <div className="modal-title">Detalle de faltantes</div>
              <button className="modal-close" onClick={() => setFalt(null)}>×</button>
            </div>
            <div className="modal-body" id="faltantes-body">
              {falt.loading && 'Cargando…'}
              {falt.error}
              {falt.cancelada && (
                <div style={{ padding: 16, textAlign: 'center' }}>
                  <div style={{ color: 'var(--warning)', fontWeight: 600, marginBottom: 8 }}>⚠ Esta orden de trabajo ha sido cancelada</div>
                  <div style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 12 }}>Se recomienda regenerar el reporte de programación para excluir OTs canceladas.</div>
                  <button className="btn btn-primary" onClick={() => { setFalt(null); cargar(); }}>🔄 Regenerar reporte</button>
                </div>
              )}
              {falt.materiales && falt.materiales.length === 0 && <div style={{ color: 'var(--gray)', textAlign: 'center', padding: 16 }}>No hay materiales asignados a esta OT.</div>}
              {falt.materiales && falt.materiales.length > 0 && (
                <>
                  {todoCompleto && <div style={{ padding: '10px 14px', background: '#d1e7dd', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#198754', fontWeight: 600 }}>✅ Todos los materiales están completos. No hay faltantes para esta OT.</div>}
                  <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--gray)' }}>OT #{falt.otId} — {falt.materiales.length} material(es) asignados</div>
                  <table className="table" style={{ fontSize: 13 }}>
                    <thead><tr><th>SKU</th><th>Material</th><th>Unidad</th><th style={{ textAlign: 'right' }}>Estimado</th><th style={{ textAlign: 'right' }}>Consumido</th><th>Estado</th></tr></thead>
                    <tbody>
                      {falt.materiales.map(m => {
                        const est = parseFloat(m.estimado || 0);
                        const real = parseFloat(m.real || 0);
                        const pendiente = est - real;
                        const sinConsumo = m.real == null;
                        const b = sinConsumo ? <span className="badge badge-warning">Pendiente</span>
                          : pendiente > 0 ? <span className="badge badge-danger">Falta {pendiente.toFixed(1)}</span>
                          : <span className="badge badge-success">Completo</span>;
                        return (
                          <tr key={m.sku}>
                            <td><code>{m.sku}</code></td>
                            <td>{m.nombre}{m.es_critico && <> <span className="badge badge-danger" style={{ fontSize: 10 }}>Crítico</span></>}</td>
                            <td>{m.unidad || '—'}</td>
                            <td style={{ textAlign: 'right' }}>{m.estimado != null ? est : '—'}</td>
                            <td style={{ textAlign: 'right' }}>{m.real != null ? real : '—'}</td>
                            <td>{b}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
