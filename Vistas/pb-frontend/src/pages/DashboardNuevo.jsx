import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { usePageTitle } from '../contexts/TitleContext';
import { fechaLocal, formatQty, hoyLocal } from '../utils/format';
import { ocultaMontos } from '../utils/user';
import PageHeader from '../components/PageHeader';
import Seccion, { SeccionVacia } from '../components/Seccion';
import { KpiCard, KpiGrid } from '../components/KpiCard';
import { BarrasHorizontales, LineaTemporal } from '../components/Charts';

const prioCls = { urgente: 'badge-danger', alta: 'badge-warning', media: 'badge-gray' };
const prioDot = { urgente: 'dot-urgente',  alta: 'dot-alta',      media: 'dot-media' };
const tipoCls = (t = '') => t.toLowerCase().includes('entrada') ? 'badge-success'
                          : t.toLowerCase().includes('salida')  ? 'badge-danger' : 'badge-gray';

/** Montos abreviados para los ejes (igual que en Consumo por área). */
const montoEje = (v) => {
  const n = Math.round(v);
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + n;
};

/** Primer día del mes local, `atras` meses hacia atrás, como 'AAAA-MM-DD'. */
const inicioDeMes = (atras = 0) => {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - atras, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`;
};

const Icono = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{children}</svg>
);

/**
 * F-25a' (D82, N-14): Dashboard con la composición de los lineamientos y del Dashboard M7 de Finanzas:
 * encabezado, tarjetas KPI, un gráfico a lo ancho y secciones en dos columnas. Se ve con "Vista: Nueva".
 * Los gráficos de consumo van en CLP y solo para quien ve montos (D50): sumar cantidades de distintas
 * unidades no tiene sentido.
 */
export default function DashboardNuevo() {
  usePageTitle('Dashboard');
  const { user } = useAuth();
  const navigate = useNavigate();
  const verMontos = !ocultaMontos(user);
  const verRiesgo = user?.rol !== 'jop';

  const [kpis, setKpis] = useState({ urgentes: null, bajo: null, productos: null, movs: null, riesgo: null });
  const [activas, setActivas] = useState(null);      // null = cargando
  const [totalActivas, setTotalActivas] = useState(null);
  const [ultimos, setUltimos] = useState(null);
  const [gMes, setGMes] = useState(null);
  const [gArea, setGArea] = useState(null);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      const [alertas, productos, movimientos] = await Promise.all([
        API.alertas.listar().catch(() => []),
        API.materiales.listar().catch(() => []),
        API.movimientos.listar({ desde: hoyLocal() }).catch(() => []),
      ]);
      if (cancelado) return;

      const vigentes = (Array.isArray(alertas) ? alertas : []).filter(a => a.estado === 'activa');
      setKpis(k => ({
        ...k,
        urgentes:  vigentes.filter(a => a.prioridad === 'urgente').length,
        bajo:      vigentes.filter(a => a.prioridad !== 'urgente').length,
        productos: Array.isArray(productos) ? productos.filter(p => p.estado === 'activo').length : 0,
        movs:      Array.isArray(movimientos) ? movimientos.length : 0,
      }));
      setActivas(vigentes.slice(0, 5));
      setTotalActivas(vigentes.length);
      setUltimos(Array.isArray(movimientos) ? movimientos.slice(0, 5) : []);

      if (verRiesgo) {
        const pedidos = await API.pedidos.listar().catch(() => []);
        if (cancelado) return;
        const enRiesgo = Array.isArray(pedidos) ? pedidos.filter(p => parseInt(p.materiales_faltantes || 0) > 0).length : 0;
        setKpis(k => ({ ...k, riesgo: enRiesgo }));
      }

      if (verMontos) {
        const [mes, area] = await Promise.all([
          API.reportes.consumoAreaGrafico({ desde: inicioDeMes(5), hasta: hoyLocal(), agrupar: 'mes' }).catch(() => null),
          API.reportes.consumoAreaGrafico({ desde: inicioDeMes(0), hasta: hoyLocal(), agrupar: 'area' }).catch(() => null),
        ]);
        if (cancelado) return;
        setGMes(mes || { labels: [], datasets: [] });
        setGArea(area || { areas: [] });
      }
    }

    // Igual que el Dashboard actual: primero se generan las alertas
    API.alertas.generar().catch(() => {}).finally(() => { if (!cancelado) cargar(); });
    return () => { cancelado = true; };
  }, [verMontos, verRiesgo]);

  const fecha = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  const nombreMes = new Date().toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });

  return (
    <>
      <PageHeader
        contexto="Inventario"
        titulo="Panel de inventario"
        descripcion={`Bienvenido, ${user?.nombre || user?.username || ''} · ${fecha}`}
      />

      <div className="contenido-max vista-apilada">
        <KpiGrid>
          <KpiCard
            titulo="Alertas urgentes" valor={kpis.urgentes} periodo="Ahora" tono="peligro" ruta="/alertas"
            descripcion="Productos en stock crítico que requieren atención inmediata."
            icono={<Icono><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></Icono>}
          />
          <KpiCard
            titulo="Stock bajo mínimo" valor={kpis.bajo} periodo="Ahora" ruta="/alertas"
            descripcion="Alertas activas de prioridad alta o media."
            icono={<Icono><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></Icono>}
          />
          <KpiCard
            titulo="Movimientos de hoy" valor={kpis.movs} periodo={fecha} ruta="/movimientos/historial"
            descripcion="Entradas, salidas y traslados registrados hoy."
            icono={<Icono><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></Icono>}
          />
          {verRiesgo ? (
            <KpiCard
              titulo="OT en riesgo" valor={kpis.riesgo} periodo="Ahora" tono="peligro" ruta="/pedidos/checklist"
              descripcion="Órdenes de trabajo sin stock suficiente para sus materiales."
              icono={<Icono><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></Icono>}
            />
          ) : (
            <KpiCard
              titulo="Productos activos" valor={kpis.productos} periodo="En catálogo" ruta="/productos"
              icono={<Icono><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></Icono>}
            />
          )}
        </KpiGrid>

        {verMontos && (
          <Seccion
            titulo="Consumo de materiales · últimos 6 meses"
            descripcion="Costo de los materiales consumidos por las órdenes de trabajo, por área, en pesos."
            ruta="/reportes/consumo-area"
          >
            {gMes === null && <SeccionVacia>Cargando…</SeccionVacia>}
            {gMes !== null && gMes.labels.length === 0 && <SeccionVacia>Sin consumos registrados en el período.</SeccionVacia>}
            {gMes !== null && gMes.labels.length > 0 && <LineaTemporal labels={gMes.labels} series={gMes.datasets} formato={montoEje} />}
          </Seccion>
        )}

        <div className="secciones-grid">
          <Seccion
            titulo={`Alertas activas${totalActivas ? ` (${totalActivas})` : ''}`}
            descripcion="Las más recientes. Haz clic en una para ver su detalle."
            ruta="/alertas" textoRuta="Ver todas"
          >
            {activas === null && <SeccionVacia>Cargando…</SeccionVacia>}
            {activas !== null && activas.length === 0 && <SeccionVacia>Sin alertas activas.</SeccionVacia>}
            {activas !== null && activas.map(a => (
              <div key={a.id} className="seccion-fila seccion-fila-clic" onClick={() => navigate(`/alertas?detalle=${a.id}`)}>
                <div className={`priority-dot ${prioDot[a.prioridad] || 'dot-media'}`} />
                <div className="seccion-fila-texto">
                  <div className="seccion-fila-nombre">{a.producto || a.sku}</div>
                  <div className="seccion-fila-sub">{a.tipo || '—'} · Stock actual: {formatQty(a.stock_actual)}</div>
                </div>
                <span className={`badge ${prioCls[a.prioridad] || 'badge-gray'}`}>{a.prioridad || 'media'}</span>
              </div>
            ))}
          </Seccion>

          <Seccion
            titulo="Últimos movimientos"
            descripcion="Los cinco más recientes de hoy."
            ruta="/movimientos/historial" textoRuta="Ver historial"
          >
            {ultimos === null && <SeccionVacia>Cargando…</SeccionVacia>}
            {ultimos !== null && ultimos.length === 0 && <SeccionVacia>Sin movimientos hoy.</SeccionVacia>}
            {ultimos !== null && ultimos.map((m, i) => (
              <div key={m.id ?? i} className="seccion-fila">
                <div className="seccion-fila-texto">
                  <div className="seccion-fila-nombre">{m.material_nombre || m.sku}</div>
                  <div className="seccion-fila-sub">{fechaLocal(m.fecha_hora)} · {m.bodega || '—'}</div>
                </div>
                <span className={`badge ${tipoCls(m.tipo)}`}>{m.tipo || '—'}</span>
                <span className="seccion-fila-cantidad">{formatQty(m.cantidad)}</span>
              </div>
            ))}
          </Seccion>
        </div>

        {verMontos && (
          <Seccion
            titulo={`Consumo por área · ${nombreMes}`}
            descripcion="Costo consumido en el mes por cada área de trabajo."
            ruta="/reportes/consumo-area"
          >
            {gArea === null && <SeccionVacia>Cargando…</SeccionVacia>}
            {gArea !== null && gArea.areas.length === 0 && <SeccionVacia>Sin consumos registrados este mes.</SeccionVacia>}
            {gArea !== null && gArea.areas.length > 0 && (
              <BarrasHorizontales formato={montoEje} datos={gArea.areas.map(a => ({ label: a.area, valor: a.costo }))} />
            )}
          </Seccion>
        )}
      </div>
    </>
  );
}
