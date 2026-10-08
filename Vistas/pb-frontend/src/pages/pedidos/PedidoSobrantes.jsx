import PinturaSobrantes from '../pinturas/PinturaSobrantes';

/**
 * pedidos/sobrantes.html es idéntico a pinturas/sobrantes.html salvo que
 * renderiza todas las filas sin pbPaginar. Se reutiliza el mismo componente.
 */
export default function PedidoSobrantes() {
  return <PinturaSobrantes paginar={false} />;
}
