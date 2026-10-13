import PedidoProgramacion from '../pedidos/PedidoProgramacion';
import ReportesNav from '../../components/ReportesNav';

/**
 * reportes/programacion.html es idéntico a pedidos/programacion.html
 * (solo difiere la versión del layout.js cargado). Se reutiliza el mismo componente.
 * B-08: desde Reportes lleva las pestañas de navegación; /pedidos/programacion no.
 */
export default function ReporteProgramacion() {
  return <><ReportesNav /><PedidoProgramacion /></>;
}
