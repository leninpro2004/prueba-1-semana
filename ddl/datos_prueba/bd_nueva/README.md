# Datos de prueba — BD nueva (Módulo Inventario, Grupo 14)

Datos para ejecutar los casos de prueba de caja negra de los Incrementos 3 y 4
(`docs/pruebas/Incremento_3_Grupo_14_Caja_negra.docx` e `Incremento_4_...`). Son **DML** (solo `INSERT`) que se
cargan sobre una base de datos **recién creada**, después de los DDL y los catálogos.

- Las **fechas son relativas al día de carga** (`CURRENT_DATE - n`): la historia empieza unos 15 meses antes y lo
  operativo (pedidos, conteos, reservas) ocurrió en los últimos días. **Recarguen la BD antes de cada sesión de pruebas**:
  varios casos dependen de ventanas de tiempo (ventas de los últimos 60 días, consumo de 90 días, "hoy").
- El stock es **exactamente lo que dejan los movimientos** y lo reservado es la suma de las reservas activas
  (`99_verificar.sql` lo comprueba).
- Escriben filas mínimas en `finanzas` y `terreno` (clientes, proyectos, empleados, ventas `NV-PRUEBA-*`): es una
  excepción autorizada (D67). Todo se reconoce como prueba (correos `.test`, códigos `PRY-PRUEBA-*`).
- **No editar a mano** los archivos 01..06: los genera `generador/generar.js` (`node generador/generar.js`).

## Archivos

| Archivo | Contenido |
|---|---|
| `01_finanzas_terreno.sql` | Clientes, proyectos, 5 empleados (Ricardo Toro, inactivo) y especificaciones de puerta |
| `02_usuarios.sql` | Usuarios de prueba (uno por rol). Sirve también para la BD vacía |
| `03_maestros.sql` | 4 bodegas, 8 anaqueles, 7 proveedores, 25 materiales, códigos de barras, fichas de abastecimiento, 5 recetas y la regla de integración |
| `04_historia.sql` | ~3.200 movimientos (compras, consumos, traslados, mermas, despachos, Terreno), lotes, facturas, precios y el stock |
| `05_ventas_y_pedidos.sql` | 22 ventas `NV-PRUEBA-01..22`, pedidos de instalación en cada estado y reservas |
| `06_operacion.sql` | 10 órdenes de trabajo (con diferenciales), 4 conteos cíclicos y el historial de alertas |
| `07_volumen_cu76.sql` | **Opcional**: +10.215 movimientos de "Tornillo autoperforante" para el límite de 10.000 filas de CU-76 |
| `99_verificar.sql` | Solo lectura: controles de coherencia. Todas las consultas deben volver vacías |

## Cómo cargar

Los archivos son UTF-8 y todos (DDL, catálogos y datos) empiezan con `SET client_encoding = 'UTF8'`, así que `psql` en
Windows no daña los acentos. Si se usa una copia antigua de los DDL o de los catálogos sin esa línea, fijar antes
`$env:PGCLIENTENCODING = "UTF8"`.

PowerShell, desde la carpeta `codigo`:

```powershell
createdb -U postgres puertas_blindadas_prueba
foreach ($f in "ddl/ddl_inventario.sql","ddl/ddl_terreno.sql","ddl/ddl_finanzas.sql","ddl/catalogos_inventario.sql",
               "ddl/datos_prueba/bd_nueva/01_finanzas_terreno.sql","ddl/datos_prueba/bd_nueva/02_usuarios.sql",
               "ddl/datos_prueba/bd_nueva/03_maestros.sql","ddl/datos_prueba/bd_nueva/04_historia.sql",
               "ddl/datos_prueba/bd_nueva/05_ventas_y_pedidos.sql","ddl/datos_prueba/bd_nueva/06_operacion.sql") {
  psql -U postgres -d puertas_blindadas_prueba -v ON_ERROR_STOP=1 -q -f $f
}
psql -U postgres -d puertas_blindadas_prueba -f ddl/datos_prueba/bd_nueva/99_verificar.sql
```

- **pgAdmin**: crear la BD y abrir cada archivo en el Query Tool, en el mismo orden, y ejecutarlo.
- **Recargar**: `dropdb -U postgres puertas_blindadas_prueba` y repetir.
- **Usarla**: en `Controlador/pb-backend/.env`, `DB_NAME=puertas_blindadas_prueba`, y reiniciar el backend. Al arrancar,
  el backend crea solo las alertas de insumos especiales (CU-122).
- **BD vacía** (casos "sin datos"): `puertas_blindadas_vacia` con los 3 DDL, `catalogos_inventario.sql` y **solo**
  `02_usuarios.sql`.

## Usuarios

Todos con la contraseña **`Prueba2026!`**.

| Usuario | Rol | Para qué |
|---|---|---|
| `gerente.prueba` | gerencia | La mayoría de los casos |
| `gerente2.prueba` | gerencia | CU-42 Exc: bloqueo tras 3 intentos (así no se bloquea el otro) |
| `jop.prueba` | jop | CU-65 sin precios, CU-107 (tiene la regla de Terreno), "retirado por otro operador" |
| `tecnico.prueba` | técnico | Solo lectura (D62) |
| `admin.prueba` | administrador | Reglas de integración (CU-108) |
| `secretaria.prueba` | secretaria | Solo lectura (D62) |

## Qué hay

- **Bodegas**: Bodega Central (casi todo), Bodega Planta (pinturas, madera, 3 bisagras), Bodega Obra Norte (5
  productos de instalación) y **Bodega Sur, sin productos**.
- **Materiales destacados**:

| SKU | Material | Situación |
|---|---|---|
| ACE-C14 | Plancha acero galvanizado cal. 14 | 2 proveedores; stock 12, bajo el mínimo y con cobertura menor al plazo |
| ACE-C16 | Plancha acero galvanizado cal. 16 | Un solo proveedor |
| TUB-4040 | Tubo estructural 40x40x2 mm | Aceros del Pacífico sin plazo y Perfiles Nuevo Norte sin precio; lote `TUB-RECIENTE-01` entero |
| DIS-CORTE | Disco de corte metal 7 pulgadas | Cobertura menor al plazo |
| CER-MUL | Cerradura multipunto de seguridad | Crítico; poco stock libre (12 entre todas las bodegas); merma pendiente de aprobación |
| BIS-ACE | Bisagra de acero reforzada | 4 libres en Central y 3 en Planta (reparto entre bodegas) |
| MIR-PUE | Mirilla gran angular 200 grados | Sin presentación comercial registrada |
| LIJ-120 | Lija al agua grano 120 | **Sin proveedor** |
| ESP-POL | Espuma de poliuretano 750 ml | Su único proveedor está **inactivo** |
| ADH-EPO | Adhesivo epóxico bicomponente | Una sola compra, **sin consumo** y con un único precio |
| GUA-NIT | Guantes de nitrilo | **Stock 0**: se compraron y consumieron hace 20 a 40 días |
| MAT-INAC | Perfil de aluminio 30x30 (dado de baja) | **Inactivo** |
| CER-BIO | Cerradura biométrica importada | Insumo especial, stock 0, lo esperan 2 ventas |
| VID-BLI | Visor blindado importado | Insumo especial **descontinuado** |
| MAN-BRO | Manilla de bronce artesanal | Insumo especial que ninguna venta espera |
| PIN-CUS | Pintura verde oliva personalizada | Insumo especial **sin proveedor** |
| HER-TAL, HER-ESM | Taladro, esmeril | Herramientas |

- **Proveedores**: Aceros del Pacífico, Pinturas Andinas, Ferretería Industrial Sur, Maderas del Maule, Importadora
  Blindex, **Perfiles Nuevo Norte (sin compras ni precios)** y Distribuidora Cerrada (**inactivo**).
- **Recetas**: PB-STD-001 (estándar), PB-DBL-001 (doble hoja), PB-ESP-001 (con cerradura biométrica), PB-REP-001
  (**sin insumos de instalación**) y PB-STD-000 (versión anterior, desactivada).
- **Códigos de barras**: `2` + 11 dígitos en el orden de la tabla de materiales. Por ejemplo, ACE-C14 = `200000000001`,
  MIR-PUE = `200000000012`, MAT-INAC = `200000000023`.

## Qué dato usar en cada caso

Los casos que dependen de otro se marcan **(orden)**: hacerlos en el orden indicado.

### Incremento 3

| CU | Caso | Dato |
|---|---|---|
| 19 | 1 · 2 · 3 | Mirilla gran angular (sin presentación): guardar una; vacía; más de 150 caracteres |
| 19 | 4 | Plancha acero cal. 14 (ya tiene presentación): pide confirmar |
| 30 | 1 · 3 | Escanear `200000000001` (Plancha cal. 14) o escribir `ACE-C14` en el campo del escáner |
| 30 | 2 | Código `299999999999` |
| 30 | 4 | Código `200000000023` (Perfil de aluminio, inactivo) |
| 31 | 1 · 2 | Filtrar por tipo, fechas, bodega o producto; luego buscar `XYZ` |
| 31 | 3 | Sin filtros: unos 3.200 movimientos |
| 31 | 4 | Desde posterior a hasta |
| 37 | 1 · 5 | Contar la **Bodega Obra Norte** (5 productos); agregar Mirilla gran angular (no está en esa bodega: "no esperado") |
| 37 | 2 | Cantidad `-3` o `abc` |
| 37 | 3 | **Bodega Sur** |
| 37 | 4 | **(orden)** Después del caso 1, volver a contar la Obra Norte el mismo día |
| 42 | 1 · 2 | Revertir cualquier salida o entrada revertible con `gerente.prueba`; contraseña correcta / incorrecta |
| 42 | 3 | Con `gerente2.prueba`, 3 contraseñas incorrectas seguidas: queda bloqueado 15 minutos |
| 43 | 1 · 2 | Procesar el conteo **#3 (Obra Norte, confirmado)**: 2 fuera de tolerancia (Tarugos −8 %, Cerradura −25 %) y el Sellador sin contar |
| 43 | 3 | Procesar el conteo **#4 (Bodega Planta)**: todo dentro de tolerancia, queda "conforme" |
| 43 | 4 | **(orden)** Procesar otra vez el #3 |
| 44 | 1 | Entrada de **Tubo estructural**, lote `TUB-RECIENTE-01` (60 m, intacto) |
| 44 | 2 | Salida de **Sellador de silicona** "cantidad mal digitada" (ya "Anulado por Reversión") |
| 44 | 3 | La **primera** entrada de Plancha acero cal. 14 (su lote ya se consumió) |
| 44 | 4 | Una salida con documento "Traslado", o una de "Despacho" de la venta NV-PRUEBA-11 |
| 47 | 1 | "Evaluar cobertura": preventivas Plancha cal. 14 y Disco de corte |
| 47 | 2 | Lija al agua (sin proveedor) y Espuma de poliuretano (proveedor inactivo): "pendiente de configuración" |
| 47 | 3 | Adhesivo epóxico: "sin rotación" |
| 47 | 4 | Guantes de nitrilo: alerta crítica de quiebre |
| 48 | 1 · 3 | Panel de reposición después de evaluar; filtrar por categoría Madera (sin alertas) |
| 48 | 2 | **BD vacía** |
| 55 | 1 | Historial: unas 40 alertas del último año, resueltas por un usuario, por "Sistema" o "Sin registro" |
| 55 | 2 | **BD vacía** |
| 55 | 3 | Fechas futuras o rango invertido |
| 55 | 4 | Las activas (stock de la Plancha cal. 14 y los Guantes, conteo de Tarugos, retiro de NV-07) salen "Pendiente" |
| 57 | 1 · 3 · 4 | **(orden)** Después de CU-43 caso 1, generar las alertas del conteo #3: Tarugos **actualiza** la alerta activa del conteo #2, Cerradura sale **crítica** |
| 57 | 2 | Generar las alertas del conteo #4 (conforme) |
| 59 | 1 · 3 | Buscar `acero`, `PIN` o la categoría; luego `zzz` |
| 59 | 2 | **BD vacía** |
| 60 | 1 | Vincular Perfiles Nuevo Norte al Adhesivo epóxico con precio, plazo y mínimo |
| 60 | 2 | Precio o plazo `0` o negativo |
| 60 | 3 | Vincular Aceros del Pacífico a la Plancha cal. 14 (ya vinculado) |
| 61 | 1 · 3 | Aceros del Pacífico; luego un rango de un año sin datos (por ejemplo, 2024) |
| 61 | 2 | Perfiles Nuevo Norte |
| 62 | 1 | Ficha de Aceros del Pacífico: unas 40 entregas, cerca de la mitad con retraso |
| 62 | 2 | Perfiles Nuevo Norte: "Dato no disponible" |
| 62 | 3 | Entrada de compra con fecha de pedido posterior a la de recepción |
| 63 | 1 · 3 | Métricas de cumplimiento; luego un rango sin entregas (2024) |
| 63 | 2 | **BD vacía** |
| 64 | 1 | Aceros del Pacífico / Plancha cal. 14: precios de factura, "manual" y "cotización" |
| 64 | 2 | Perfiles Nuevo Norte |
| 64 | 3 | Ferretería Industrial Sur / Adhesivo epóxico (un solo precio) |
| 71 | 1 | Período de los últimos 90 días |
| 71 | 2 | Inicio posterior al fin |
| 71 | 3 | Últimos 60 días: Guantes de nitrilo con índice "N/A" (stock 0 al inicio y al final) |
| 71 | 4 | Todo 2024 (antes del primer movimiento) |
| 75 | 1 | El año en curso |
| 75 | 2 | Un año sin datos: dos años atrás |
| 75 | 3 | El año anterior: tiene meses sin información (antes del primer movimiento, unos 15 meses atrás) |
| 75 | 4 | El año siguiente |
| 102 | 1 | Crear una receta nueva con área en cada insumo |
| 102 | 2 | Agregar el Perfil de aluminio (inactivo) |
| 102 | 3 | Código `PB-STD-001` (ya existe; se puede duplicar como versión nueva) |
| 102 | 4 · 5 | Cantidad 0; un insumo sin área |
| 103 | 1 | **OT #6** (Corte, finalizada, con estimado y real) |
| 103 | 2 | **OT #7** (finalizada, sin consumo real): "N/A" |
| 103 | 3 | **OT #8**: la Pintura esmalte blanco tiene estimado 0, "Sin base de comparación" |
| 104 | 1 | Últimos 90 días: las OT #1 a #5 ya procesadas (más las que se procesen en CU-103) |
| 104 | 2 · 3 | Fechas invertidas; un período sin diferenciales (2024) |
| 107 | 1 | Como `jop.prueba`: salida desde Terreno de Sellador de silicona, Bodega Central |
| 107 | 2 | Como `gerente.prueba` desde Terreno, o como jop desde Finanzas (sin regla) |
| 107 | 3 · 4 | SKU `MAT-INAC` (inactivo) o `NOEXISTE`; campos vacíos o cantidad inválida |
| 107 | 5 | Salida de Guantes de nitrilo (stock 0) |
| 108 | 1 | Crear la regla Finanzas + gerencia |
| 108 | 2 | **BD vacía** |
| 108 | 3 | Crear Terreno + jop (ya existe) |
| 108 | 4 | Desactivar Terreno + jop: es la única y Terreno registró movimientos en los últimos 30 días |
| 122 | 1 · 3 | Alertas → Faltantes → Insumos especiales: Cerradura biométrica (NV-18 y NV-19) y Pintura verde oliva (NV-18, sin proveedor) |
| 122 | 2 | Visor blindado (NV-20, descontinuado): cancelar o elegir un reemplazo |
| 122 | 4 | "Revisar ventas" no duplica. Para ver que actualiza la cantidad, simular que Finanzas cambia la venta (ver al final) |
| 123 | 1 · 2 | Registrar un insumo especial nuevo; dejar campos vacíos |
| 123 | 3 | SKU `ACE-C14` |
| 124 | 2 | Entrada (compra, Importadora Blindex) de 2 Manillas de bronce: ninguna venta la espera |
| 124 | 3 · 4 | **(orden)** Entrada de 4 Cerraduras biométricas: esperan NV-19 (2) y NV-18 (3); repartir y dejar NV-18 parcial |
| 124 | 1 | **(orden)** Entrada de 1 Cerradura biométrica: vincularla a NV-18, que queda completa |
| 132 | 1 | Liberar la reserva de **NV-PRUEBA-22** (Electrodo de soldadura) con un motivo |
| 132 | 2 | Reserva de **NV-PRUEBA-17** (anulada) |
| 132 | 3 | Buscar la venta `NV-PRUEBA-99` |
| 132 | 4 | Cualquier reserva de **NV-PRUEBA-06** (pedido preparado) |

### Incremento 4

| CU | Caso | Dato |
|---|---|---|
| 65 | 1 | Plancha cal. 14: Aceros (menor costo) y Ferretería Sur (menor plazo) |
| 65 | 2 | Plancha cal. 16 (un proveedor) |
| 65 | 3 | Lija al agua (sin proveedores) |
| 65 | 4 | Tubo estructural: Aceros sin plazo, Perfiles Nuevo Norte sin precio |
| 65 | 5 | El caso 1 como `jop.prueba` |
| 76 | 1 · 4 | Exportar el historial de movimientos o el reporte histórico y abrirlo en Excel |
| 76 | 2 | Cargar `07_volumen_cu76.sql` y exportar los movimientos (más de 10.000) |
| 76 | 3 | Un reporte sin datos (por ejemplo, movimientos de 2024) |
| 119 | 1 | **NV-PRUEBA-04** (vinculada completa): marcar preparado |
| 119 | 2 | **NV-PRUEBA-02** (sin vincular) |
| 119 | 3 | **NV-PRUEBA-05**: le falta 1 Mirilla |
| 119 | 4 | **NV-PRUEBA-06** (ya preparado) |
| 120 | 1 · 5 | **(orden)** **NV-PRUEBA-01** (2 puertas estándar): se sugieren 7 insumos; las 6 bisagras salen 4 de Central y 2 de Planta |
| 120 | 2 | **NV-PRUEBA-02** (hoja de reposición, sin insumos de instalación) |
| 120 | 3 | **(orden)** **NV-PRUEBA-03** (10 puertas doble hoja): faltan Cerraduras y Bisagras, queda parcial |
| 120 | 4 | **NV-PRUEBA-04** (ya vinculada): modificarla |
| 121 | 1 | `NV-PRUEBA-11` (despachada: las 7 etapas) o el SKU `CER-MUL` |
| 121 | 2 | `NV-PRUEBA-02` (sin movimientos) |
| 121 | 3 | `NV-NOEXISTE` |
| 125 | 1 | **NV-PRUEBA-08** (preparado y retirado): responsable Pedro Salinas |
| 125 | 2 | **NV-PRUEBA-08** con Ricardo Toro (inactivo) |
| 125 | 3 | **NV-PRUEBA-09** (en carga con Pedro Salinas): sumar a Luis Carrasco |
| 125 | 4 | **NV-PRUEBA-06** (preparado, nada retirado) |
| 126 | 1 · 2 · 4 | **NV-PRUEBA-06**: retirar un insumo; reportar otro en ubicación incorrecta; retiro parcial de Tarugos (5 de 10) |
| 126 | 3 | **NV-PRUEBA-07**: la Cerradura multipunto ya la retiró `jop.prueba` (entrar como gerente) |
| 126 | 5 | **NV-PRUEBA-07**: retirar los 4 Tarugos que faltan; se cierran sus 2 alertas |
| 127 | 1 | **NV-PRUEBA-09** (en carga): confirmar la salida |
| 127 | 2 | **NV-PRUEBA-10** (preparado y retirado, sin carga) |
| 127 | 3 | **NV-PRUEBA-11** (ya en tránsito) |
| 127 | 4 | En el historial, revertir una salida "Despacho" de NV-PRUEBA-11 |
| 131 | 1 | **NV-PRUEBA-12** (Plancha cal. 16, Tabla pino, Pintura blanca) |
| 131 | 2 | **NV-PRUEBA-13** (Perfil de aluminio inactivo + Electrodo) |
| 131 | 3 | **NV-PRUEBA-14** (150 planchas cal. 14; hay 12) |
| 131 | 4 | **NV-PRUEBA-15** (pendiente) o **NV-PRUEBA-16** (ya reservada) |

### CU-122 caso 4: simular que Finanzas cambia una venta

Inventario no edita ventas. Para probar que la alerta se **actualiza** en vez de duplicarse:

```sql
UPDATE finanzas.item_nota_venta SET cantidad = 4
WHERE sku_material = 'CER-BIO'
  AND id_nota_venta = (SELECT id_nota_venta FROM finanzas.nota_venta WHERE numero_nota_venta = 'NV-PRUEBA-19');
```

Después, "Revisar ventas" en el panel: la alerta de NV-19 pasa a 4, sin una alerta nueva.
