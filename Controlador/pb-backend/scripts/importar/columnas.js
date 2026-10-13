/**
 * F-03: columnas de cada hoja de la plantilla. Las usan el importador (para leer) y
 * generarPlantilla.js (para escribir), así nunca divergen. Sin dependencias: generar
 * la plantilla no abre conexión a la BD.
 */
const COLUMNAS = {
  productos: [
    { clave: 'nombre',              titulo: 'nombre',              obligatoria: true, ancho: 40 },
    { clave: 'descripcion',         titulo: 'descripción',         ancho: 30 },
    { clave: 'presentacion',        titulo: 'presentación',        ancho: 20 },
    { clave: 'unidad',              titulo: 'unidad',              obligatoria: true, ancho: 12 },
    { clave: 'categoria',           titulo: 'categoría',           obligatoria: true, ancho: 16 },
    { clave: 'subcategoria',        titulo: 'subcategoría',        obligatoria: true, ancho: 18 },
    { clave: 'nivel',               titulo: 'nivel',               ancho: 14 },
    { clave: 'categoria_funcional', titulo: 'categoría funcional', obligatoria: true, ancho: 18 },
    { clave: 'categoria_general',   titulo: 'categoría general',   obligatoria: true, ancho: 18 },
    { clave: 'critico',             titulo: 'crítico S/N',         ancho: 11, siNo: true },
    { clave: 'especial',            titulo: 'especial S/N',        ancho: 11, siNo: true },
    { clave: 'herramienta',         titulo: 'herramienta S/N',     ancho: 14, siNo: true },
    { clave: 'stock_minimo',        titulo: 'stock mínimo',        ancho: 12 },
    { clave: 'bodega',              titulo: 'bodega',              ancho: 18 },
    { clave: 'anaquel',             titulo: 'anaquel',             ancho: 14 },
    { clave: 'cantidad',            titulo: 'cantidad',            ancho: 10 },
  ],
  bodegas: [
    { clave: 'bodega',    titulo: 'bodega',    obligatoria: true, ancho: 24 },
    { clave: 'anaquel',   titulo: 'anaquel',   ancho: 18 },
    { clave: 'direccion', titulo: 'dirección', ancho: 36 },
  ],
  proveedores: [
    { clave: 'razon_social', titulo: 'razón social', obligatoria: true, ancho: 32 },
    { clave: 'rut',          titulo: 'RUT',          ancho: 14 },
    { clave: 'rubro',        titulo: 'rubro',        ancho: 18 },
    { clave: 'tipo',         titulo: 'tipo',         ancho: 16 },
    { clave: 'pais',         titulo: 'país',         ancho: 12 },
    { clave: 'contacto',     titulo: 'contacto',     ancho: 22 },
    { clave: 'correo',       titulo: 'correo',       ancho: 26 },
    { clave: 'telefono',     titulo: 'teléfono',     ancho: 16 },
  ],
  precios: [
    { clave: 'producto',          titulo: 'producto',             obligatoria: true, ancho: 40 },
    { clave: 'proveedor',         titulo: 'proveedor',            obligatoria: true, ancho: 32 },
    { clave: 'precio',            titulo: 'precio',               obligatoria: true, ancho: 12 },
    { clave: 'tiempo_reposicion', titulo: 'tiempo de reposición', ancho: 18 },
    { clave: 'compra_minima',     titulo: 'compra mínima',        ancho: 14 },
    { clave: 'principal',         titulo: 'principal S/N',        ancho: 12, siNo: true },
  ],
};

module.exports = { COLUMNAS };
