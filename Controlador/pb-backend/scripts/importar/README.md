# Importador de la carga inicial (F-03)

Carga productos, bodegas, proveedores, precios y el stock inicial desde una planilla Excel. El stock entra como
**movimientos de entrada con motivo `carga_inicial`** (D78), así que el histórico, el FIFO y los reportes funcionan desde
el primer día.

## Archivos

| Archivo | Para qué |
|---|---|
| `plantilla.xlsx` | La planilla que llena el cliente. Se regenera con `npm run plantilla` (no editar a mano). Va versionada (D85): si cambia `columnas.js`, se regenera y se commitea junto |
| `columnas.js` | Columnas de cada hoja. Las usan la plantilla y el importador: si se cambia una columna, se cambia aquí |
| `importador.js` | Lectura, validación y carga. Lo usan el comando y `tests/importar.test.js` |
| `importar.js` | El comando |

## Uso

Desde `Controlador/pb-backend`:

```
npm run importar -- <archivo.xlsx> --usuario <usuario>                  # simula (no escribe nada)
npm run importar -- <archivo.xlsx> --usuario <usuario> --aplicar        # carga
```

- `--usuario`: quien queda como autor de los movimientos (debe existir y estar activo; en la nube, Sahira).
- `--fecha AAAA-MM-DD`: fecha de la carga (por defecto, hoy en hora de Chile). Los lotes y movimientos quedan con esa fecha.
- `--reporte <ruta.csv>`: dónde escribir el reporte (por defecto `reporte-importacion.csv` junto al Excel).

**La base es la del `.env`** (`DB_NAME`, `DB_HOST`…): el comando la muestra al empezar. Para otra base sin tocar el
`.env`, defina la variable antes (`DB_NAME=puertas_blindadas_carga npm run importar -- ...` en Git Bash, o
`$env:DB_NAME="..."` en PowerShell).

## Cómo funciona

1. **Simular siempre primero.** La simulación valida todas las filas, ejecuta la carga completa dentro de una transacción
   y la revierte. Detecta también lo que solo la base sabe (largos, restricciones).
2. **El reporte** (CSV con `;`, se abre en Excel) lista cada error y aviso con su hoja, fila y campo, y los SKU y
   códigos de barras que se crearon o se crearían.
3. **Con un solo error no se carga nada.** Se corrige la planilla y se vuelve a simular.
4. **Se puede repetir sin duplicar**: un producto, bodega o proveedor que ya existe (mismo nombre, sin importar
   mayúsculas ni tildes) se reutiliza; si es un producto, se omite con su cantidad y queda un aviso.

## Reglas de la planilla

- **SKU y código de barras los genera el sistema**: `[CAT]-[NOMBRE]-NNN` (por ejemplo `HER-CERRAD-001`) y el código
  interno de 12 dígitos con prefijo 2.
- **Un producto en dos bodegas** = dos filas con el mismo nombre. El mismo producto dos veces en la misma bodega es
  error (hay que sumar las cantidades en una fila).
- **Clasificación**: categoría y subcategoría van juntas; nivel vacío = "General". Las que no existen se crean.
  Categoría general y funcional deben existir en el catálogo.
- **Unidad**: una del catálogo (`unidad`, `metro`, `kilogramo`, `litro`, `plancha`); también `m`, `kg`, `un`, `lt`.
- **Precios** solo en la hoja `precios`, siempre con su proveedor (así se valorizan). Un producto sin precio queda sin
  valorizar.
- Columnas que la plantilla no conoce (por ejemplo "revisar" u "origen") se ignoran.

## En la nube

Se corre desde un equipo con el `.env` apuntando a la RDS (con `DB_SSL=true`) o desde la EC2. `exceljs` es dependencia
normal, así que también está con `npm ci --omit=dev`. Orden (D79): 3 DDL → `catalogos_inventario.sql` → usuarios
reales (F-01) → simular → `--aplicar`.
