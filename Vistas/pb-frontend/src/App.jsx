import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { DialogProvider } from './components/DialogProvider';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import ReservaLista from './pages/reservas/ReservaLista';
import ReservarVenta from './pages/reservas/ReservarVenta';
import ReporteValorizacion from './pages/reportes/ReporteValorizacion';
import PedidoSobrantes from './pages/pedidos/PedidoSobrantes';
import HerramientaLista from './pages/herramientas/HerramientaLista';
import PinturaSeguimiento from './pages/pinturas/PinturaSeguimiento';
import ProductoLista from './pages/productos/ProductoLista';
import ProductoCrear from './pages/productos/ProductoCrear';
import ProductoEditar from './pages/productos/ProductoEditar';
import ProductoDetalle from './pages/productos/ProductoDetalle';
import ProductoEtiquetas from './pages/productos/ProductoEtiquetas';
import BodegaLista from './pages/bodegas/BodegaLista';
import MovimientoEntrada from './pages/movimientos/MovimientoEntrada';
import MovimientoSalida from './pages/movimientos/MovimientoSalida';
import MovimientoHistorial from './pages/movimientos/MovimientoHistorial';
import ConteoLista from './pages/conteos/ConteoLista';
import ConteoCiclico from './pages/conteos/ConteoCiclico';
import ConteoDetalle from './pages/conteos/ConteoDetalle';
import ConteoDiferencias from './pages/conteos/ConteoDiferencias';
import Alertas from './pages/alertas/Alertas';
import Faltantes from './pages/alertas/Faltantes';
import PedidoChecklist from './pages/pedidos/PedidoChecklist';
import PedidoProgramacion from './pages/pedidos/PedidoProgramacion';
import OrdenLista from './pages/ordenes/OrdenLista';
import OrdenDetalle from './pages/ordenes/OrdenDetalle';
import OrdenCostos from './pages/ordenes/OrdenCostos';
import UsuarioLista from './pages/usuarios/UsuarioLista';
import UsuarioCrear from './pages/usuarios/UsuarioCrear';
import ProveedorLista from './pages/proveedores/ProveedorLista';
import ProveedorDetalle from './pages/proveedores/ProveedorDetalle';
import ProveedorMetricas from './pages/proveedores/ProveedorMetricas';
import ReporteMovimientos from './pages/reportes/ReporteMovimientos';
import ReporteMermas from './pages/reportes/ReporteMermas';
import ReporteConsumoArea from './pages/reportes/ReporteConsumoArea';
import ReporteProgramacion from './pages/reportes/ReporteProgramacion';
import ReporteRotacion from './pages/reportes/ReporteRotacion';
import ReporteHistorico from './pages/reportes/ReporteHistorico';
import ReporteDesviaciones from './pages/reportes/ReporteDesviaciones';
import RecetaLista from './pages/recetas/RecetaLista';
import RecetaEditor from './pages/recetas/RecetaEditor';
import ReglasIntegracion from './pages/integracion/ReglasIntegracion';
import SimuladorModulo from './pages/integracion/SimuladorModulo';
import PedidosInstalacion from './pages/pedidos/PedidosInstalacion';
import PedidoInstalacionDetalle from './pages/pedidos/PedidoInstalacionDetalle';
import TrazabilidadPedido from './pages/pedidos/TrazabilidadPedido';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DialogProvider>
          <Routes>
            <Route path="/login" element={<Login />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />

                <Route path="/productos"             element={<ProductoLista />} />
                <Route path="/productos/crear"       element={<ProductoCrear />} />
                <Route path="/productos/etiquetas"   element={<ProductoEtiquetas />} />
                <Route path="/productos/:sku"        element={<ProductoDetalle />} />
                <Route path="/productos/:sku/editar" element={<ProductoEditar />} />

                <Route path="/bodegas" element={<BodegaLista />} />

                <Route path="/movimientos/entrada"   element={<MovimientoEntrada />} />
                <Route path="/movimientos/salida"    element={<MovimientoSalida />} />
                <Route path="/movimientos/historial" element={<MovimientoHistorial />} />

                {/* CU-37: conteo cíclico (la ruta fija /nuevo antes de /:id) */}
                <Route path="/conteos"       element={<ConteoLista />} />
                <Route path="/conteos/nuevo" element={<ConteoCiclico />} />
                <Route path="/conteos/:id"   element={<ConteoDetalle />} />
                <Route path="/conteos/:id/diferencias" element={<ConteoDiferencias />} />

                <Route path="/alertas"           element={<Alertas />} />
                <Route path="/alertas/faltantes" element={<Faltantes />} />

                <Route path="/proveedores"     element={<ProveedorLista />} />
                <Route path="/proveedores/metricas" element={<ProveedorMetricas />} />
                <Route path="/proveedores/:id" element={<ProveedorDetalle />} />

                <Route path="/pedidos/checklist"    element={<PedidoChecklist />} />
                <Route path="/pedidos/programacion" element={<PedidoProgramacion />} />
                <Route path="/pedidos/sobrantes"    element={<PedidoSobrantes />} />
                {/* CU-120 → 119: pedidos de instalación (ventas de Finanzas y su despacho) */}
                <Route path="/instalacion"          element={<PedidosInstalacion />} />
                <Route path="/instalacion/trazabilidad" element={<TrazabilidadPedido />} />   {/* CU-121, antes de /:id */}
                <Route path="/instalacion/:id"      element={<PedidoInstalacionDetalle />} />

                <Route path="/ordenes"            element={<OrdenLista />} />
                <Route path="/ordenes/:id"        element={<OrdenDetalle />} />
                <Route path="/ordenes/:id/costos" element={<OrdenCostos />} />

                {/* CU-102 (D37): módulo de recetas (la ruta fija /nueva antes de /:id) */}
                <Route path="/recetas"       element={<RecetaLista />} />
                <Route path="/recetas/nueva" element={<RecetaEditor />} />
                <Route path="/recetas/:id"   element={<RecetaEditor key="editar" />} />

                <Route path="/reportes/movimientos"  element={<ReporteMovimientos />} />
                <Route path="/reportes/mermas"       element={<ReporteMermas />} />
                <Route path="/reportes/valorizacion" element={<ReporteValorizacion />} />
                <Route path="/reportes/consumo-area" element={<ReporteConsumoArea />} />
                <Route path="/reportes/programacion" element={<ReporteProgramacion />} />
                <Route path="/reportes/rotacion"     element={<ReporteRotacion />} />
                <Route path="/reportes/historico"    element={<ReporteHistorico />} />
                <Route path="/reportes/desviaciones" element={<ReporteDesviaciones />} />

                <Route path="/reservas"           element={<ReservaLista />} />
                <Route path="/reservas/venta"     element={<ReservarVenta />} />   {/* CU-131 */}
                {/* OPUS-16: las dos pantallas de pinturas se unieron; la vieja redirige */}
                <Route path="/pinturas/sobrantes" element={<Navigate to="/pinturas/seguimiento" replace />} />
                <Route path="/herramientas"         element={<HerramientaLista />} />
                <Route path="/pinturas/seguimiento" element={<PinturaSeguimiento />} />

                <Route path="/usuarios"       element={<UsuarioLista />} />
                <Route path="/usuarios/crear" element={<UsuarioCrear />} />

                {/* CU-108: reglas de integración entre módulos (gerencia y administrador) */}
                <Route path="/integracion" element={<ReglasIntegracion />} />
                {/* CU-107: simulador de Terreno/Finanzas. SOLO en desarrollo: no llega al build del cliente */}
                {import.meta.env.DEV && <Route path="/pruebas/modulo-externo" element={<SimuladorModulo />} />}
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </DialogProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
