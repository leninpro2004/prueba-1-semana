#!/usr/bin/env node
'use strict';
/**
 * Generador de los DATOS DE PRUEBA para una BD NUEVA — Módulo Inventario (Grupo 14).
 *
 *   node ddl/datos_prueba/bd_nueva/generador/generar.js
 *
 * Escribe 01..06 en ddl/datos_prueba/bd_nueva/ (DML estático, sin lógica). No se conecta
 * a la BD ni tiene dependencias.
 *
 * Cómo funciona: SIMULA en orden cronológico lo que haría el backend (compras, consumos
 * por FIFO, traslados con el mismo lote, reservas por lote, despachos, reversiones,
 * conteos) con las mismas reglas de src/db/stock.js y de los controllers. Así el stock
 * de inventario_bodega es exactamente lo que dejan los movimientos, y lo reservado es
 * exactamente la suma de las reservas activas. Nada se escribe "a mano" en el stock.
 *
 * Las fechas quedan RELATIVAS al día de carga (CURRENT_DATE - n): las ventanas de 60 y
 * 90 días, los "últimos 30 días" y el conteo de hoy calzan siempre. Por eso conviene
 * recargar la BD antes de una sesión de pruebas.
 *
 * El azar es determinista (PRNG con semilla fija): dos corridas dan los mismos archivos.
 */
const fs = require('fs');
const path = require('path');

const DESTINO = path.resolve(__dirname, '..');

/* ══════════════════════════════════════════════════════════════════════
   Utilidades
   ══════════════════════════════════════════════════════════════════════ */

/** PRNG mulberry32: determinista. */
function prng(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (x) => Math.round(x * 10000) / 10000;
const raw = (s) => ({ raw: s });

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object' && 'raw' in v) return v.raw;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Número inválido: ${v}`);
    return String(r4(v));
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Un instante: días atrás (d) + minutos del día. */
function T(d, hora = '10:00') {
  const [h, m] = hora.split(':').map(Number);
  return { d, min: h * 60 + m };
}
const claveT = (t) => -t.d * 1440 + t.min;
const hhmm = (t) => `${String(Math.floor(t.min / 60)).padStart(2, '0')}:${String(t.min % 60).padStart(2, '0')}`;
/** timestamp relativo al día de carga */
const ts = (t) => raw(`CURRENT_DATE - ${t.d} + TIME '${hhmm(t)}'`);
/** date relativa: d > 0 en el pasado, d < 0 en el futuro */
const fecha = (d) => raw(d === 0 ? 'CURRENT_DATE' : d > 0 ? `CURRENT_DATE - ${d}` : `CURRENT_DATE + ${-d}`);

/** Dígito verificador de un RUT chileno. */
function dv(n) {
  let s = 0, m = 2;
  for (const c of String(n).split('').reverse()) { s += Number(c) * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (s % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}
const rut = (n) => `${n}-${dv(n)}`;

/** INSERT con varias filas (en bloques). `identidad`: la tabla tiene columna IDENTITY. */
function insert(tabla, cols, filas, { identidad = true } = {}) {
  if (!filas.length) return `-- ${tabla}: sin filas\n`;
  let out = '';
  for (let i = 0; i < filas.length; i += 400) {
    const bloque = filas.slice(i, i + 400);
    out += `INSERT INTO ${tabla} (${cols.join(', ')})\n` + (identidad ? 'OVERRIDING SYSTEM VALUE\n' : '') +
      'VALUES\n  ' + bloque.map(f => `(${f.map(lit).join(', ')})`).join(',\n  ') + ';\n';
  }
  return out;
}
const setval = (tabla, col) =>
  `SELECT setval(pg_get_serial_sequence('${tabla}', '${col}'), (SELECT MAX(${col}) FROM ${tabla}));\n`;

/* ══════════════════════════════════════════════════════════════════════
   Catálogos (los ids de ddl/catalogos_inventario.sql)
   ══════════════════════════════════════════════════════════════════════ */

const ENTRADA = 1, SALIDA = 2;
const MOT = { compra: 1, consumo: 2, merma: 3, reverso: 6, devolucion: 7, despacho: 8, traslado: 9 };
const AREA = { corte: 1, pintura: 2, armado: 3, bodega: 4, instalacion: 5 };
const TIPO_ALERTA = { critico: 2, reposicion: 5, bajoMinimo: 6, diferencia: 8, diferenciaCritica: 9, ubicacion: 10, faltanteRetiro: 11 };
const TOLERANCIA = { critico: { tol: 1, umbral: 5 }, no_critico: { tol: 5, umbral: 20 } };

/* ══════════════════════════════════════════════════════════════════════
   Datos maestros
   ══════════════════════════════════════════════════════════════════════ */

// Contraseña de todos los usuarios de prueba: ver README.md. Hash bcrypt (costo 12).
const HASH = '$2b$12$9vuDVQ..HFVaDPm9mBQ3q.DAM2NsZdFuvbcoTVXlG7pK.WKzlIdyK';

const U = { gerente: 1, jop: 2, tecnico: 3, admin: 4, secretaria: 5, gerente2: 6 };
const USUARIOS = [
  // id, username, nombre, apellido, rol, perfil
  [1, 'gerente.prueba',    'Gabriela', 'Rojas',   'gerencia',      1],
  [2, 'jop.prueba',        'Javier',   'Muñoz',   'jop',           2],
  [3, 'tecnico.prueba',    'Tomás',    'Soto',    'tecnico',       6],
  [4, 'admin.prueba',      'Andrea',   'Fuentes', 'administrador', 4],
  [5, 'secretaria.prueba', 'Sofía',    'Pérez',   'secretaria',    5],
  [6, 'gerente2.prueba',   'Gonzalo',  'Vera',    'gerencia',      1],
];

const BODEGAS = [
  // id, nombre, dirección, código
  [1, 'Bodega Central',    'Av. Los Industriales 1450, Quilicura', 'BC'],
  [2, 'Bodega Planta',     'Camino Lo Echevers 820, Quilicura',    'BP'],
  [3, 'Bodega Obra Norte', 'Av. Recoleta 3300, Recoleta (obra)',   'BON'],
  [4, 'Bodega Sur',        'Av. Lo Espejo 2100, San Bernardo',     'BS'],
];
const NOMBRE_BODEGA = Object.fromEntries(BODEGAS.map(b => [b[0], b[1]]));

const ANAQUELES = [
  [1, 'Central A - Aceros y perfiles', 1],
  [2, 'Central B - Cerraduras y herrajes', 1],
  [3, 'Central C - Fijaciones y sellos', 1],
  [4, 'Central D - Consumibles y herramientas', 1],
  [5, 'Planta P1 - Pinturas', 2],
  [6, 'Planta P2 - Maderas y herrajes', 2],
  [7, 'Obra Norte O1 - Contenedor', 3],
  [8, 'Sur S1 - Rack principal', 4],
];
const NOMBRE_ANAQUEL = Object.fromEntries(ANAQUELES.map(a => [a[0], a[1]]));

const PROVEEDORES = [
  // id, razón social, país, tipo, rubro, contacto (nombre, apellido), estado, rut, teléfono, correo, prefijo factura
  [1, 'Aceros del Pacífico S.A.',     'Chile', 'distribuidor', 'Aceros y perfiles',                ['Carolina', 'Méndez'],  'activo',   96543210, '+56 2 2345 6789', 'ventas@acerosdelpacifico.test', 'ACP'],
  [2, 'Pinturas Andinas Ltda.',       'Chile', 'fabricante',   'Pinturas y recubrimientos',        ['Rodrigo', 'Lagos'],    'activo',   77321654, '+56 2 2456 7890', 'pedidos@pinturasandinas.test',  'PAN'],
  [3, 'Ferretería Industrial Sur SpA','Chile', 'distribuidor', 'Ferretería, fijaciones y herrajes', ['Paula', 'Contreras'],  'activo',   76987321, '+56 2 2567 8901', 'contacto@ferreteriasur.test',   'FIS'],
  [4, 'Maderas del Maule Ltda.',      'Chile', 'productor',    'Maderas',                          ['Hernán', 'Tapia'],     'activo',   78456123, '+56 71 234 5678', 'ventas@maderasdelmaule.test',   'MDM'],
  [5, 'Importadora Blindex Ltda.',    'Chile', 'importador',   'Cerraduras y accesorios importados', ['Valentina', 'Ibáñez'], 'activo',   76123987, '+56 2 2678 9012', 'importaciones@blindex.test',    'IBX'],
  [6, 'Perfiles Nuevo Norte SpA',     'Chile', 'distribuidor', 'Aceros y perfiles',                ['Ignacio', 'Araya'],    'activo',   77888999, '+56 55 234 5678', 'contacto@nuevonorte.test',      'PNN'],
  [7, 'Distribuidora Cerrada Ltda.',  'Chile', 'distribuidor', 'Sellos y adhesivos',               ['Mónica', 'Vidal'],     'inactivo', 76555444, '+56 2 2789 0123', 'ventas@distcerrada.test',       'DCL'],
];

/*
 * Materiales. Unidades: 1 plancha, 2 litro, 3 metro, 4 unidad, 5 kilogramo.
 * Categoría general: 1 Materia Prima, 2 Material Crítico. Funcional: 1 Herramienta,
 * 2 Insumo, 3 Materia Prima. Nivel específico: 1 Calibre 14, 2 Calibre 16, 3 40x40mm,
 * 4 Esmalte, 5 Anticorrosiva, 6 Esmalte custom, 7 Tabla 1x6.
 */
const MATERIALES = [
  { sku: 'ACE-C14',  nombre: 'Plancha acero galvanizado cal. 14', unidad: 1, gen: 2, fun: 3, nivel: 1, critico: true,  min: 20, crit: 8,  max: 120, pres: 'Plancha 1220 x 2440 mm, paquete de 10 unidades', desc: 'Acero para hojas y marcos de puerta blindada' },
  { sku: 'ACE-C16',  nombre: 'Plancha acero galvanizado cal. 16', unidad: 1, gen: 1, fun: 3, nivel: 2, min: 10, crit: 4,  max: 60, pres: 'Plancha 1220 x 2440 mm, paquete de 10 unidades' },
  { sku: 'TUB-4040', nombre: 'Tubo estructural 40x40x2 mm',       unidad: 3, gen: 1, fun: 3, nivel: 3, min: 60, crit: 20, max: 400, pres: 'Tira de 6 metros' },
  { sku: 'PIN-BLA',  nombre: 'Pintura esmalte blanco',            unidad: 5, gen: 1, fun: 2, nivel: 4, min: 15, crit: 5,  max: 80, pres: 'Tineta de 20 kg', noCustom: 'blanco' },
  { sku: 'PIN-GRS',  nombre: 'Pintura anticorrosiva gris RAL-7016', unidad: 5, gen: 1, fun: 2, nivel: 5, min: 15, crit: 5, max: 90, pres: 'Tineta de 20 kg', noCustom: 'gris RAL-7016' },
  { sku: 'PIN-CUS',  nombre: 'Pintura verde oliva personalizada', unidad: 5, gen: 1, fun: 2, nivel: 6, rotativo: false, custom: 'verde oliva', desc: 'Color a pedido del cliente: se compra por venta' },
  { sku: 'MAD-PIN',  nombre: 'Tabla pino radiata 1x6',            unidad: 3, gen: 1, fun: 3, nivel: 7, min: 50, crit: 20, max: 400 },
  { sku: 'ELE-SOLD', nombre: 'Electrodo soldadura E6011 3/32',    unidad: 5, gen: 1, fun: 2, min: 5, crit: 2, max: 40, pres: 'Caja de 5 kg' },
  { sku: 'DIS-CORTE',nombre: 'Disco de corte metal 7 pulgadas',   unidad: 4, gen: 1, fun: 2, min: 10, crit: 5, max: 100, pres: 'Caja de 25 unidades' },
  { sku: 'CER-MUL',  nombre: 'Cerradura multipunto de seguridad', unidad: 4, gen: 2, fun: 2, critico: true, min: 5, crit: 2, max: 40, pres: 'Caja individual con 3 llaves' },
  { sku: 'BIS-ACE',  nombre: 'Bisagra de acero reforzada 4 pulgadas', unidad: 4, gen: 1, fun: 2, min: 6, crit: 3, max: 120 },
  { sku: 'MIR-PUE',  nombre: 'Mirilla gran angular 200 grados',   unidad: 4, gen: 1, fun: 2, min: 4, crit: 2, max: 40 },
  { sku: 'TAR-ANC',  nombre: 'Tarugo de anclaje 10 mm',           unidad: 4, gen: 1, fun: 2, min: 100, crit: 40, max: 1200, pres: 'Bolsa de 100 unidades' },
  { sku: 'ESP-POL',  nombre: 'Espuma de poliuretano 750 ml',      unidad: 4, gen: 1, fun: 2, min: 8, crit: 3, max: 60 },
  { sku: 'SIL-TRA',  nombre: 'Sellador de silicona transparente 280 ml', unidad: 4, gen: 1, fun: 2, min: 10, crit: 4, max: 80, pres: 'Caja de 12 cartuchos' },
  { sku: 'BUR-GOM',  nombre: 'Burlete de goma EPDM',              unidad: 3, gen: 1, fun: 2, min: 40, crit: 15, max: 400, pres: 'Rollo de 50 metros' },
  { sku: 'CER-BIO',  nombre: 'Cerradura biométrica importada',    unidad: 4, gen: 2, fun: 2, critico: true, rotativo: false, desc: 'Se importa por venta' },
  { sku: 'VID-BLI',  nombre: 'Visor blindado importado',          unidad: 4, gen: 1, fun: 2, rotativo: false, descontinuado: true, desc: 'El fabricante dejó de producirlo' },
  { sku: 'MAN-BRO',  nombre: 'Manilla de bronce artesanal',       unidad: 4, gen: 1, fun: 2, rotativo: false },
  { sku: 'ADH-EPO',  nombre: 'Adhesivo epóxico bicomponente',     unidad: 4, gen: 1, fun: 2 },
  { sku: 'LIJ-120',  nombre: 'Lija al agua grano 120',            unidad: 4, gen: 1, fun: 2, min: 20, crit: 8, max: 200 },
  { sku: 'GUA-NIT',  nombre: 'Guantes de nitrilo (par)',          unidad: 4, gen: 1, fun: 2, min: 50, crit: 20, max: 300 },
  { sku: 'MAT-INAC', nombre: 'Perfil de aluminio 30x30 (dado de baja)', unidad: 3, gen: 1, fun: 3, estado: 'inactivo', desc: 'Ya no se usa en las puertas' },
  { sku: 'HER-TAL',  nombre: 'Taladro percutor 800 W',            unidad: 4, fun: 1, herramienta: true, valor: 89990, adq: 300 },
  { sku: 'HER-ESM',  nombre: 'Esmeril angular 4 1/2 pulgadas',    unidad: 4, fun: 1, herramienta: true, valor: 54990, adq: 280 },
];
const MAT = Object.fromEntries(MATERIALES.map(m => [m.sku, m]));

/*
 * Ficha de abastecimiento (material_proveedor): sku, proveedor, plazo (días hábiles),
 * precio referencial (null = el último del historial), principal, cantidad mínima.
 */
const MAT_PROV = [
  ['ACE-C14', 1, 5, null, true, 10], ['ACE-C14', 3, 3, null, false, 5],   // CU-65: dos proveedores
  ['ACE-C16', 1, 5, null, true, 10],                                       // CU-65: uno solo
  ['TUB-4040', 1, null, null, true, 30], ['TUB-4040', 6, 7, null, false, null], // CU-65: datos incompletos
  ['PIN-BLA', 2, 4, null, true, 4], ['PIN-GRS', 2, 4, null, true, 4],
  ['MAD-PIN', 4, 6, null, true, 50],
  ['ELE-SOLD', 3, 3, null, true, 5], ['DIS-CORTE', 3, 4, null, true, 25],
  ['CER-MUL', 3, 5, null, true, 5], ['CER-MUL', 5, 15, 45500, false, 10],
  ['BIS-ACE', 3, 3, null, true, 20], ['MIR-PUE', 3, 4, null, true, 5], ['TAR-ANC', 3, 2, null, true, 100],
  ['ESP-POL', 7, 3, null, true, 12],                                       // su único proveedor está inactivo
  ['SIL-TRA', 3, 3, null, true, 12], ['BUR-GOM', 3, 5, null, true, 50],
  ['CER-BIO', 5, 20, null, true, 1], ['VID-BLI', 5, 25, 98000, true, 1], ['MAN-BRO', 5, 15, 35000, true, 1],
  ['ADH-EPO', 3, 3, null, true, null], ['GUA-NIT', 3, 2, null, true, 50],
  ['HER-TAL', 3, 5, null, true, null], ['HER-ESM', 3, 5, null, true, null],
  // LIJ-120 y PIN-CUS sin proveedor a propósito (CU-65 Exc 2, CU-47 Exc 1, CU-122 Exc 2)
];
const plazoDe = (sku, prov) => MAT_PROV.find(x => x[0] === sku && x[1] === prov)?.[2] ?? null;
const principalDe = (sku) => MAT_PROV.filter(x => x[0] === sku && x[4]).sort((a, b) => a[1] - b[1])[0]?.[1] ?? null;

/* Recetas (producto_terminado + material_producto_terminado). */
const RECETAS = [
  { id: 1, codigo: 'PB-STD-001', nombre: 'Puerta blindada estándar 90x200', tipo: 'simple', items: [
    ['ACE-C14', AREA.corte, 2, 0.1], ['TUB-4040', AREA.corte, 6, 0.05],
    ['ELE-SOLD', AREA.armado, 0.5, 0.1], ['DIS-CORTE', AREA.armado, 1, 0],
    ['PIN-GRS', AREA.pintura, 1.2, 0.1], ['PIN-BLA', AREA.pintura, 1, 0.1],
    ['CER-MUL', AREA.instalacion, 1, 0], ['BIS-ACE', AREA.instalacion, 3, 0], ['MIR-PUE', AREA.instalacion, 1, 0],
    ['TAR-ANC', AREA.instalacion, 8, 0.25], ['ESP-POL', AREA.instalacion, 1, 0], ['SIL-TRA', AREA.instalacion, 1, 0],
    ['BUR-GOM', AREA.instalacion, 5.5, 0.1]] },
  { id: 2, codigo: 'PB-DBL-001', nombre: 'Puerta blindada doble hoja 160x210', tipo: 'doble', items: [
    ['ACE-C14', AREA.corte, 4, 0.1], ['TUB-4040', AREA.corte, 10, 0.05],
    ['ELE-SOLD', AREA.armado, 0.9, 0.1], ['DIS-CORTE', AREA.armado, 2, 0],
    ['PIN-GRS', AREA.pintura, 2.2, 0.1], ['PIN-BLA', AREA.pintura, 1.8, 0.1],
    ['CER-MUL', AREA.instalacion, 2, 0], ['BIS-ACE', AREA.instalacion, 6, 0], ['MIR-PUE', AREA.instalacion, 1, 0],
    ['TAR-ANC', AREA.instalacion, 12, 0.25], ['ESP-POL', AREA.instalacion, 2, 0], ['SIL-TRA', AREA.instalacion, 2, 0],
    ['BUR-GOM', AREA.instalacion, 9, 0.1]] },
  { id: 3, codigo: 'PB-ESP-001', nombre: 'Puerta blindada con cerradura biométrica', tipo: 'simple', items: [
    ['ACE-C14', AREA.corte, 2, 0.1], ['TUB-4040', AREA.corte, 6, 0.05],
    ['PIN-CUS', AREA.pintura, 1.5, 0.1],
    ['CER-BIO', AREA.instalacion, 1, 0], ['BIS-ACE', AREA.instalacion, 3, 0], ['TAR-ANC', AREA.instalacion, 8, 0.25],
    ['SIL-TRA', AREA.instalacion, 1, 0]] },
  { id: 4, codigo: 'PB-REP-001', nombre: 'Hoja de reposición (sin insumos de instalación)', tipo: 'simple', items: [
    ['ACE-C14', AREA.corte, 2, 0.1], ['PIN-GRS', AREA.pintura, 1.2, 0.1]] },
  // Versión anterior de la estándar: desactivada y reemplazada por PB-STD-001 (CU-102)
  { id: 5, codigo: 'PB-STD-000', nombre: 'Puerta blindada estándar 90x200 (versión anterior)', tipo: 'simple', activo: false, reemplazo: 1, items: [
    ['ACE-C14', AREA.corte, 2.2, 0.1], ['TUB-4040', AREA.corte, 6, 0.1],
    ['PIN-GRS', AREA.pintura, 1.4, 0.1],
    ['CER-MUL', AREA.instalacion, 1, 0], ['BIS-ACE', AREA.instalacion, 3, 0], ['TAR-ANC', AREA.instalacion, 8, 0.25]] },
];
const RECETA = Object.fromEntries(RECETAS.map(r => [r.id, r]));

/* Otros schemas (finanzas y terreno): filas mínimas, marcadas como prueba. */
const CLIENTES = [
  // id, rut (número), razón social, tipo (1 empresa, 2 persona), contacto, teléfono, correo
  [1, 76111111, 'Constructora Los Andes SpA',   1, 'Marcelo Olivares', '+56 9 8111 1111', 'compras@losandes.test'],
  [2, 76222222, 'Inmobiliaria Costa Sur Ltda.', 1, 'Daniela Paredes',  '+56 9 8222 2222', 'proyectos@costasur.test'],
  [3, 12345678, 'Roberto Figueroa Soto',        2, 'Roberto Figueroa', '+56 9 8333 3333', 'rfigueroa@correo.test'],
  [4, 76333333, 'Hotel Mirador del Lago S.A.',  1, 'Claudia Riquelme', '+56 9 8444 4444', 'mantencion@miradorlago.test'],
];
const PROYECTOS = [
  // id, código, nombre, cliente, ingreso (días atrás), instalación (días; negativo = futuro)
  [1, 'PRY-PRUEBA-01', 'Edificio Los Andes - Torre A',   1, 120, -30],
  [2, 'PRY-PRUEBA-02', 'Condominio Costa Sur - Etapa 2', 2, 90,  -45],
  [3, 'PRY-PRUEBA-03', 'Casa Figueroa',                  3, 60,  -20],
  [4, 'PRY-PRUEBA-04', 'Hotel Mirador - Remodelación',   4, 30,  -60],
];
const EMPLEADOS = [
  // rut (número), nombre, apellido, cargo, estado
  [15111222, 'Pedro',   'Salinas',  1, 'activo'],
  [16222333, 'Luis',    'Carrasco', 2, 'activo'],
  [17333444, 'Marcela', 'Díaz',     3, 'activo'],
  [18444555, 'Diego',   'Morales',  4, 'activo'],
  [14555666, 'Ricardo', 'Toro',     1, 'inactivo'],   // CU-125 Exc 1
];
const EMP = Object.fromEntries(EMPLEADOS.map(e => [e[1], rut(e[0])]));

/* ══════════════════════════════════════════════════════════════════════
   Estado de la simulación
   ══════════════════════════════════════════════════════════════════════ */

const ids = {};
const nuevo = (k) => (ids[k] = (ids[k] || 0) + 1);

const st = {
  lotes: [], lfp: [], facturas: [], hpm: [], movs: [], ib: new Map(), reservas: [],
  ventas: [], items: [], preps: [], dets: [], estados: [], reauth: [],
  ots: [], mots: [], difc: [], conteos: [], detConteo: [], difInv: [], alertas: [], hist: [],
};
const secFactura = {};

const kIb = (sku, lote, bod) => `${sku}|${lote}|${bod}`;
const loteDe = (id) => st.lotes[id - 1];

function fila(sku, lote, bod, anaquel = null) {
  const k = kIb(sku, lote, bod);
  let f = st.ib.get(k);
  if (!f) { f = { sku, lote, bod, fis: 0, res: 0, anaquel }; st.ib.set(k, f); }
  else if (anaquel && !f.anaquel) f.anaquel = anaquel;
  return f;
}
/** Filas de stock de un SKU (en una bodega o en todas) en orden FIFO: lote más antiguo primero. */
function fifo(sku, bod = null) {
  return [...st.ib.values()]
    .filter(f => f.sku === sku && (bod == null || f.bod === bod))
    .sort((a, b) => loteDe(b.lote).ingreso - loteDe(a.lote).ingreso || a.lote - b.lote || a.bod - b.bod);
}
const libreEn = (sku, bod = null) => r4(fifo(sku, bod).reduce((s, f) => s + f.fis - f.res, 0));

function mov(t, o) {
  const m = { id: nuevo('mov'), t, estado: 'completado', modulo: 'inventario', lote: null, factura: null, ot: null,
              proyecto: null, motivo: null, desc: null, evidencia: null, revertido: null, ref: null, clave: null, ...o };
  if (!(m.cantidad > 0)) throw new Error(`Movimiento sin cantidad: ${JSON.stringify(o)}`);
  st.movs.push(m);
  return m;
}

/** Descuenta por FIFO lo DISPONIBLE (físico − reservado) de una bodega. Igual que descontarFifo. */
function descontar(sku, bod, cant) {
  const filas = fifo(sku, bod).filter(f => f.fis > f.res + 1e-9);
  const disp = r4(filas.reduce((s, f) => s + f.fis - f.res, 0));
  if (cant > disp + 1e-9) throw new Error(`Stock insuficiente de ${sku} en bodega ${bod}: disponible ${disp}, se pide ${cant}`);
  let resto = cant;
  const usados = [];
  for (const f of filas) {
    if (resto <= 1e-9) break;
    const x = r4(Math.min(resto, f.fis - f.res));
    f.fis = r4(f.fis - x);
    usados.push({ lote: f.lote, cant: x });
    resto = r4(resto - x);
  }
  return usados;
}

function nuevoLote({ d, prov = null, numero = null }) {
  const l = { id: nuevo('lote'), numero, ingreso: d, recepcion: d, prov, factura: null };
  st.lotes.push(l);
  return l;
}
/** 'LOTE-YYYYMMDD-id' como lo arma el backend, o el número que se informó. */
const numeroLoteSql = (l) => (l.numero ? lit(l.numero) : `'LOTE-' || to_char(CURRENT_DATE - ${l.ingreso}, 'YYYYMMDD') || '-${l.id}'`);

/** Compra (registrarEntrada tipo compra): lote, fecha de pedido, factura, movimiento, stock e historial de precio. */
function compra(t, { sku, bod, cant, prov, precio, lead, anaquel = null, usuario = U.gerente, numeroLote = null }) {
  const lote = nuevoLote({ d: t.d, prov, numero: numeroLote });
  st.lfp.push({ id: nuevo('lfp'), pedido: t.d + lead, precio, lote: lote.id });
  const pre = PROVEEDORES.find(p => p[0] === prov)[10];
  secFactura[prov] = (secFactura[prov] || 10230 + prov * 1000) + 1;
  const fac = { id: nuevo('fac'), numero: `F-${pre}-${String(secFactura[prov]).padStart(6, '0')}`, fecha: t.d, prov };
  st.facturas.push(fac);
  lote.factura = fac.id;
  const m = mov(t, { tipo: ENTRADA, motivo: MOT.compra, sku, bod, lote: lote.id, factura: fac.id, usuario, cantidad: cant });
  const f = fila(sku, lote.id, bod, anaquel);
  f.fis = r4(f.fis + cant);
  st.hpm.push({ id: nuevo('hpm'), sku, prov, precio, desde: t.d, fuente: 'factura', factura: fac.id, usuario, t });
  return m;
}

/** Salida (registrarSalida / consumo de OT). El movimiento de salida manual no guarda lote; el de OT guarda el principal. */
function salida(t, { sku, bod, cant, motivo = MOT.consumo, ot = null, proyecto = null, usuario = U.jop, desc = null,
                     evidencia = null, estado = 'completado', conLote = false, modulo = 'inventario', ref = null, clave = null }) {
  const usados = descontar(sku, bod, cant);
  return mov(t, { tipo: SALIDA, motivo, sku, bod, lote: conLote ? usados[0].lote : null, ot, proyecto, usuario,
                  desc, evidencia, estado, modulo, ref, clave, cantidad: cant });
}

/** Traslado (D60): salida + entrada del MISMO lote por cada lote movido, con la referencia TRASLADO-<id>. */
function traslado(t, { sku, de, a, cant, usuario = U.jop, anaquel = null }) {
  const usados = descontar(sku, de, cant);
  const texto = `Traslado de ${NOMBRE_BODEGA[de]} a ${NOMBRE_BODEGA[a]}`;
  let primero = null;
  for (const u of usados) {
    const f = fila(sku, u.lote, a, anaquel);
    f.fis = r4(f.fis + u.cant);
    const s = mov(t, { tipo: SALIDA, motivo: MOT.traslado, sku, bod: de, lote: u.lote, usuario, desc: texto, cantidad: u.cant });
    primero = primero || s.id;
    s.ref = `TRASLADO-${primero}`;
    mov(t, { tipo: ENTRADA, motivo: MOT.traslado, sku, bod: a, lote: u.lote, usuario, desc: texto, cantidad: u.cant, ref: `TRASLADO-${primero}` });
  }
}

/** CU-44 sobre una SALIDA: vuelve al lote de la salida o al más antiguo de la bodega; inverso + original 'revertido'. */
function revertirSalida(t, m, usuario = U.gerente) {
  st.reauth.push({ id: nuevo('reauth'), usuario, t: { d: t.d, min: t.min - 1 }, exitoso: true, mov: m.id });
  const destino = m.lote || fifo(m.sku, m.bod)[0].lote;
  const f = fila(m.sku, destino, m.bod);
  f.fis = r4(f.fis + m.cantidad);
  mov(t, { tipo: ENTRADA, motivo: MOT.reverso, sku: m.sku, bod: m.bod, lote: destino, usuario,
           desc: `Reversión del movimiento #${m.id}`, revertido: m.id, cantidad: m.cantidad });
  m.estado = 'revertido';
}

/** CU-107: movimiento desde Terreno. Salida por FIFO (guarda el lote principal); entrada = devolución al lote más antiguo. */
function integracion(t, { tipo, sku, bod, cant, ref, clave, desc, usuario = U.jop }) {
  if (tipo === 'salida') {
    const usados = descontar(sku, bod, cant);
    return mov(t, { tipo: SALIDA, sku, bod, lote: usados[0].lote, usuario, desc, modulo: 'terreno', ref, clave, cantidad: cant });
  }
  const f = fifo(sku, bod)[0];
  f.fis = r4(f.fis + cant);
  return mov(t, { tipo: ENTRADA, motivo: MOT.devolucion, sku, bod, lote: f.lote, usuario, desc, modulo: 'terreno', ref, clave, cantidad: cant });
}

/* ── Reservas ── */

function reservarEnBodega(sku, bod, cant, crear) {
  let resto = cant;
  for (const f of fifo(sku, bod).filter(x => x.fis > x.res + 1e-9)) {
    if (resto <= 1e-9) break;
    const x = r4(Math.min(resto, f.fis - f.res));
    f.res = r4(f.res + x);
    crear(f.lote, f.bod, x);
    resto = r4(resto - x);
  }
  return r4(cant - resto);
}
/** D58: la bodega principal primero; lo que falta, de las demás (la de más disponible primero). */
function reservarConReparto(sku, principal, cant, crear) {
  let r = reservarEnBodega(sku, principal, cant, crear);
  const otras = BODEGAS.map(b => b[0]).filter(b => b !== principal && libreEn(sku, b) > 0)
    .sort((a, b) => libreEn(sku, b) - libreEn(sku, a) || a - b);
  for (const o of otras) {
    if (cant - r <= 1e-9) break;
    r = r4(r + reservarEnBodega(sku, o, r4(cant - r), crear));
  }
  return r;
}

/* ══════════════════════════════════════════════════════════════════════
   Motor de eventos
   ══════════════════════════════════════════════════════════════════════ */

const eventos = [];
const en = (t, fn) => eventos.push({ k: claveT(t), seq: eventos.length, fn });

/* ══════════════════════════════════════════════════════════════════════
   Historia genérica: compras por punto de reorden y consumos diarios
   ══════════════════════════════════════════════════════════════════════ */

const DESC_CONSUMO = {
  taller: ['Consumo en taller de corte', 'Consumo en armado', 'Consumo en producción'],
  pintura: ['Consumo en cabina de pintura', 'Consumo en pintura'],
  instalacion: ['Retiro para instalación en obra', 'Consumo en obra', 'Reposición a cuadrilla de instalación'],
  general: ['Consumo en taller', 'Consumo en producción', 'Entrega a cuadrilla'],
};

/*
 * Perfil por material: bodega y anaquel, proveedor (y alternativo), precio inicial e
 * inflación mensual, cantidad a pedir, punto de reorden, día de la primera compra,
 * hasta qué día se repone y se consume en forma genérica, y los "objetivos": en esos
 * días se deja el DISPONIBLE de la bodega en un valor fijo (consumo en obra o compra).
 */
const PERFILES = [
  { sku: 'ACE-C14', bod: 1, an: 1, prov: 1, alt: { prov: 3, cada: 4, factor: 1.08 }, precio: 29000, infl: 0.009, q: 60, rop: 25, start: 456,
    cons: { p: 0.35, min: 1, max: 4, paso: 1 }, desc: 'taller', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 60], [2, 12]] },
  { sku: 'ACE-C16', bod: 1, an: 1, prov: 1, precio: 26500, infl: 0.009, q: 30, rop: 12, start: 452,
    cons: { p: 0.2, min: 1, max: 3, paso: 1 }, desc: 'taller', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 40], [2, 30]] },
  { sku: 'TUB-4040', bod: 1, an: 1, prov: 1, leadH: 6, precio: 8900, infl: 0.008, q: 150, rop: 50, start: 450,
    cons: { p: 0.3, min: 4, max: 12, paso: 2 }, desc: 'taller', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 150], [2, 150]] },
  { sku: 'PIN-BLA', bod: 2, an: 5, prov: 2, precio: 13500, infl: 0.007, saltos: [[180, 1.05]], q: 40, rop: 15, start: 448,
    cons: { p: 0.3, min: 0.5, max: 3, paso: 0.5 }, desc: 'pintura', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 40], [2, 25]] },
  { sku: 'PIN-GRS', bod: 2, an: 5, prov: 2, precio: 14200, infl: 0.007, saltos: [[180, 1.06]], q: 50, rop: 18, start: 447,
    cons: { p: 0.35, min: 0.5, max: 3.5, paso: 0.5 }, desc: 'pintura', reponerHasta: 12, consumoHasta: 3, objetivos: [[16, 50], [2, 30]] },
  { sku: 'MAD-PIN', bod: 2, an: 6, prov: 4, precio: 4200, infl: 0.006, q: 200, rop: 60, start: 445,
    cons: { p: 0.2, min: 2, max: 10, paso: 1 }, desc: 'general', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 150], [2, 120]] },
  { sku: 'ELE-SOLD', bod: 1, an: 4, prov: 3, precio: 6900, infl: 0.008, q: 20, rop: 6, start: 444,
    cons: { p: 0.15, min: 0.5, max: 2, paso: 0.5 }, desc: 'taller', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 20], [2, 14]] },
  { sku: 'DIS-CORTE', bod: 1, an: 4, prov: 3, precio: 2300, infl: 0.006, q: 60, rop: 25, start: 443,
    cons: { p: 0.45, min: 1, max: 4, paso: 1 }, desc: 'taller', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 60], [2, 12]] },
  { sku: 'CER-MUL', bod: 1, an: 2, prov: 3, alt: { prov: 5, cada: 3, factor: 0.93 }, precio: 48900, infl: 0.005, q: 15, rop: 6, start: 440,
    cons: { p: 0.08, min: 1, max: 2, paso: 1 }, desc: 'instalacion', reponerHasta: 22, consumoHasta: 21, objetivos: [[21, 26], [2, 8]] },
  { sku: 'BIS-ACE', bod: 1, an: 2, prov: 3, precio: 3900, infl: 0.006, q: 60, rop: 20, start: 439,
    cons: { p: 0.1, min: 2, max: 6, paso: 1 }, desc: 'instalacion', reponerHasta: 32, consumoHasta: 21, objetivos: [[31, 30], [21, 40], [2, 4]] },
  { sku: 'MIR-PUE', bod: 1, an: 2, prov: 3, precio: 5200, infl: 0.005, q: 15, rop: 5, start: 438,
    cons: { p: 0.08, min: 1, max: 2, paso: 1 }, desc: 'instalacion', reponerHasta: 22, consumoHasta: 21, objetivos: [[21, 12], [5, 0], [2, 15]] },
  { sku: 'TAR-ANC', bod: 1, an: 3, prov: 3, precio: 180, infl: 0.006, q: 500, rop: 150, start: 437,
    cons: { p: 0.25, min: 8, max: 24, paso: 4 }, desc: 'instalacion', reponerHasta: 22, consumoHasta: 21, objetivos: [[21, 360], [2, 150]] },
  { sku: 'ESP-POL', bod: 1, an: 3, prov: 7, precio: 3900, infl: 0.006, q: 36, rop: 8, start: 436,
    cons: { p: 0.12, min: 1, max: 3, paso: 1 }, desc: 'instalacion', reponerHasta: 22, consumoHasta: 21, objetivos: [[21, 45], [2, 20]] },
  { sku: 'SIL-TRA', bod: 1, an: 3, prov: 3, precio: 2900, infl: 0.006, q: 36, rop: 12, start: 435,
    cons: { p: 0.15, min: 1, max: 3, paso: 1 }, desc: 'instalacion', reponerHasta: 22, consumoHasta: 21, objetivos: [[26, 30], [21, 70], [2, 30]] },
  { sku: 'BUR-GOM', bod: 1, an: 3, prov: 3, precio: 850, infl: 0.006, q: 150, rop: 50, start: 434,
    cons: { p: 0.12, min: 5, max: 15, paso: 0.5 }, desc: 'instalacion', reponerHasta: 22, consumoHasta: 21, objetivos: [[21, 240], [2, 80]] },
  { sku: 'LIJ-120', bod: 1, an: 4, prov: 3, precio: 350, infl: 0.006, q: 100, rop: 30, start: 432,
    cons: { p: 0.2, min: 2, max: 10, paso: 1 }, desc: 'general', reponerHasta: 12, consumoHasta: 3, objetivos: [[12, 60], [2, 40]] },
  // Un solo ciclo: se compra, se consume entero y queda en cero (CU-47 Exc 3, CU-71 Exc 2)
  { sku: 'GUA-NIT', bod: 1, an: 4, prov: 3, precio: 450, infl: 0, q: 60, rop: -1, start: 40,
    cons: { p: 0.5, min: 2, max: 6, paso: 1 }, desc: 'general', reponerHasta: 40, consumoHasta: 20, objetivos: [[19, 0]] },
  // Dado de baja: se usó hace más de un año y quedó en cero
  { sku: 'MAT-INAC', bod: 1, an: 1, prov: 1, precio: 5400, infl: 0, q: 40, rop: -1, start: 440,
    cons: { p: 0.3, min: 1, max: 3, paso: 1 }, desc: 'taller', reponerHasta: 440, consumoHasta: 331, objetivos: [[330, 0]] },
];

function precioDe(p, d, prov) {
  let x = p.precio * Math.pow(1 + p.infl, (p.start - d) / 30);
  for (const [dia, factor] of p.saltos || []) if (d <= dia) x *= factor;
  if (p.alt && prov === p.alt.prov) x *= p.alt.factor;
  return x >= 1000 ? Math.round(x / 10) * 10 : Math.round(x);
}

function programarPerfil(p, indice) {
  const rnd = prng(1000 + indice * 7919);
  const estado = { pend: null, pedidos: 0 };
  const minuto = (base) => `${base}:${String(5 + (indice * 3) % 50).padStart(2, '0')}`;
  const bodegaPlazo = (prov) => plazoDe(p.sku, prov) ?? p.leadH ?? 5;
  const leadCorrido = (prov) => {
    const deltas = [-1, 0, 0, 0, 1, 1, 2, 3];
    const h = Math.max(1, bodegaPlazo(prov) + deltas[Math.floor(rnd() * deltas.length)]);
    return Math.max(1, Math.round(h * 7 / 5));
  };
  const provDelPedido = () => (p.alt && estado.pedidos % p.alt.cada === p.alt.cada - 1 ? p.alt.prov : p.prov);

  for (let d = p.start; d >= 1; d--) {
    // 09:xx llegada de pedidos y decisión de reorden
    en(T(d, minuto('09')), () => {
      const t = T(d, minuto('09'));
      if (d === p.start) {
        const lead = leadCorrido(p.prov);
        compra(t, { sku: p.sku, bod: p.bod, cant: p.q, prov: p.prov, precio: precioDe(p, d + lead, p.prov), lead, anaquel: p.an });
        estado.pedidos++;
      } else if (estado.pend && estado.pend.llega === d) {
        const x = estado.pend;
        compra(t, { sku: p.sku, bod: p.bod, cant: p.q, prov: x.prov, precio: x.precio, lead: x.pedido - d, anaquel: p.an });
        estado.pend = null;
      }
      if (!estado.pend && d > p.reponerHasta && libreEn(p.sku, p.bod) <= p.rop) {
        const prov = provDelPedido();
        const lead = leadCorrido(prov);
        if (d - lead >= p.reponerHasta) {
          estado.pend = { llega: d - lead, pedido: d, prov, precio: precioDe(p, d, prov) };
          estado.pedidos++;
        }
      }
    });
    // Consumos genéricos: dos turnos por día
    if (d < p.start && d >= p.consumoHasta) {
      for (const base of ['11', '15']) {
        const t = T(d, minuto(base));
        en(t, () => {
          if (rnd() >= p.cons.p) return;
          const pasos = Math.round((p.cons.max - p.cons.min) / p.cons.paso);
          let cant = r4(p.cons.min + Math.floor(rnd() * (pasos + 1)) * p.cons.paso);
          const libre = libreEn(p.sku, p.bod);
          cant = r4(Math.min(cant, libre));
          if (cant <= 0) return;
          const lista = DESC_CONSUMO[p.desc];
          salida(t, { sku: p.sku, bod: p.bod, cant, usuario: rnd() < 0.8 ? U.jop : U.gerente, desc: lista[Math.floor(rnd() * lista.length)] });
        });
      }
    }
  }
  // Objetivos: deja el disponible de la bodega en un valor (consumo en obra o compra)
  for (const [d, objetivo] of p.objetivos) {
    const t = T(d, '18:00');
    en(t, () => ajustar(t, p, objetivo));
  }
}

function ajustar(t, p, objetivo) {
  const libre = libreEn(p.sku, p.bod);
  if (libre > objetivo + 1e-9) {
    salida(t, { sku: p.sku, bod: p.bod, cant: r4(libre - objetivo), usuario: U.jop, desc: DESC_CONSUMO[p.desc][0] });
  } else if (libre < objetivo - 1e-9) {
    const lead = Math.max(1, Math.round((plazoDe(p.sku, p.prov) ?? p.leadH ?? 5) * 7 / 5));
    compra(t, { sku: p.sku, bod: p.bod, cant: r4(objetivo - libre), prov: p.prov, precio: precioDe(p, t.d, p.prov), lead, anaquel: p.an });
  }
}

PERFILES.forEach(programarPerfil);

/* ══════════════════════════════════════════════════════════════════════
   Eventos puntuales de la historia
   ══════════════════════════════════════════════════════════════════════ */

// Compras únicas
en(T(300, '10:30'), () => compra(T(300, '10:30'), { sku: 'HER-TAL', bod: 1, cant: 3, prov: 3, precio: 89990, lead: 7, anaquel: 4 }));
en(T(280, '10:30'), () => compra(T(280, '10:30'), { sku: 'HER-ESM', bod: 1, cant: 4, prov: 3, precio: 54990, lead: 7, anaquel: 4 }));
en(T(120, '11:10'), () => compra(T(120, '11:10'), { sku: 'ADH-EPO', bod: 1, cant: 12, prov: 3, precio: 7500, lead: 4, anaquel: 4 }));
// Insumos especiales: una importación antigua de cada uno, entregada entera
en(T(210, '12:00'), () => compra(T(210, '12:00'), { sku: 'VID-BLI', bod: 1, cant: 2, prov: 5, precio: 98000, lead: 38, anaquel: 2, numeroLote: 'IMP-VIS-2025-01' }));
en(T(200, '12:00'), () => salida(T(200, '12:00'), { sku: 'VID-BLI', bod: 1, cant: 2, desc: 'Instalación en obra (venta anterior)' }));
en(T(110, '12:00'), () => compra(T(110, '12:00'), { sku: 'CER-BIO', bod: 1, cant: 2, prov: 5, precio: 189000, lead: 30, anaquel: 2, numeroLote: 'IMP-BIO-01' }));
en(T(100, '12:00'), () => salida(T(100, '12:00'), { sku: 'CER-BIO', bod: 1, cant: 2, desc: 'Instalación en obra (venta anterior)' }));

// Mermas: una de gerencia (completada) y una de un producto crítico hecha por jop (pendiente de aprobación)
en(T(200, '15:00'), () => salida(T(200, '15:00'), { sku: 'ACE-C14', bod: 1, cant: 2, motivo: MOT.merma, usuario: U.gerente,
  desc: 'Planchas dobladas en la descarga', evidencia: 'https://fotos.puertasblindadas.test/merma-acero-01.jpg' }));
en(T(3, '16:00'), () => salida(T(3, '16:00'), { sku: 'CER-MUL', bod: 1, cant: 1, motivo: MOT.merma, usuario: U.jop, estado: 'pendiente_aprobacion',
  desc: 'Cerradura con el cilindro dañado', evidencia: 'https://fotos.puertasblindadas.test/merma-cerradura-01.jpg' }));

// CU-44 Exc 1: una salida ya revertida (con su reautenticación)
let salidaRevertida = null;
en(T(60, '16:10'), () => { salidaRevertida = salida(T(60, '16:10'), { sku: 'SIL-TRA', bod: 1, cant: 3, desc: 'Consumo en obra (cantidad mal digitada)' }); });
en(T(59, '09:40'), () => revertirSalida(T(59, '09:40'), salidaRevertida));

// Traslados (D60): herrajes a Planta y el stock de la Bodega Obra Norte
en(T(30, '10:00'), () => traslado(T(30, '10:00'), { sku: 'BIS-ACE', de: 1, a: 2, cant: 3, anaquel: 6 }));
for (const [sku, cant] of [['TAR-ANC', 100], ['SIL-TRA', 24], ['ESP-POL', 12], ['BUR-GOM', 50], ['CER-MUL', 4]]) {
  en(T(20, '09:30'), () => traslado(T(20, '09:30'), { sku, de: 1, a: 3, cant, anaquel: 7 }));
}

// CU-107: movimientos registrados desde Terreno (los de los últimos 30 días son la Exc 3 de CU-108)
en(T(75, '12:20'), () => integracion(T(75, '12:20'), { tipo: 'salida', sku: 'MIR-PUE', bod: 1, cant: 1, ref: 'OBRA-PRUEBA-090', clave: 'terreno-prueba-0000', desc: 'Reposición en obra' }));
en(T(25, '11:40'), () => integracion(T(25, '11:40'), { tipo: 'salida', sku: 'SIL-TRA', bod: 1, cant: 2, ref: 'OBRA-PRUEBA-101', clave: 'terreno-prueba-0001', desc: 'Sellado en obra' }));
en(T(12, '11:00'), () => integracion(T(12, '11:00'), { tipo: 'salida', sku: 'BUR-GOM', bod: 1, cant: 10, ref: 'OBRA-PRUEBA-102', clave: 'terreno-prueba-0002', desc: 'Burlete para ajuste en obra' }));
en(T(6, '15:00'), () => integracion(T(6, '15:00'), { tipo: 'entrada', sku: 'TAR-ANC', bod: 1, cant: 16, ref: 'OBRA-PRUEBA-101', clave: 'terreno-prueba-0003', desc: 'Sobrante devuelto de la obra' }));

// Reposición puntual de mirillas (después de que se agotaran: el pedido V05 quedó parcial)
en(T(3, '09:00'), () => compra(T(3, '09:00'), { sku: 'MIR-PUE', bod: 1, cant: 20, prov: 3, precio: 5480, lead: 5, anaquel: 2 }));
// CU-44 caso 1: entrada reciente cuyo lote sigue entero (se puede revertir)
en(T(2, '12:00'), () => compra(T(2, '12:00'), { sku: 'TUB-4040', bod: 1, cant: 60, prov: 1, precio: 9950, lead: 9, anaquel: 1, numeroLote: 'TUB-RECIENTE-01' }));

// Historial de precios "manual" y "cotización" (CU-60, CU-61, CU-64: la fuente del cambio)
const HPM_EXTRA = [
  ['ACE-C14', 1, 30500, 250, 'manual', U.gerente], ['ACE-C14', 1, 31800, 95, 'manual', U.gerente],
  ['ACE-C14', 3, 33900, 140, 'cotizacion', U.gerente], ['DIS-CORTE', 3, 2450, 160, 'manual', U.gerente],
  ['CER-MUL', 5, 45500, 60, 'cotizacion', U.gerente],
];
for (const [sku, prov, precio, d, fuente, usuario] of HPM_EXTRA) {
  en(T(d, '17:30'), () => st.hpm.push({ id: nuevo('hpm'), sku, prov, precio, desde: d, fuente, factura: null, usuario, t: T(d, '17:30') }));
}

/* ══════════════════════════════════════════════════════════════════════
   Ventas (finanzas.nota_venta) y pedidos de instalación
   ══════════════════════════════════════════════════════════════════════ */

const PRECIO_PUERTA = { 1: 1250000, 2: 2100000, 3: 1890000, 4: 690000 };
/*
 * n, cliente, proyecto financiero, emisión (días atrás), entrega (días; negativo = futuro), estado,
 * ítems: { receta, cant, inst } = puertas; { sku, cant, precio } = material suelto; { servicio, cant, precio }.
 */
const VENTAS = [
  { n: '01', c: 1, p: 1, em: 20, en: -25, estado: 'aprobada', items: [{ receta: 1, cant: 2, inst: true }, { servicio: 'Instalación de puerta blindada', cant: 2, precio: 180000 }] },
  { n: '02', c: 4, p: 4, em: 18, en: -30, estado: 'aprobada', items: [{ receta: 4, cant: 1, inst: true }] },
  { n: '03', c: 2, p: 2, em: 16, en: -40, estado: 'aprobada', items: [{ receta: 2, cant: 10, inst: true }, { servicio: 'Instalación de puerta doble hoja', cant: 10, precio: 250000 }] },
  { n: '04', c: 3, p: 3, em: 15, en: -15, estado: 'aprobada', items: [{ receta: 1, cant: 1, inst: true }] },
  { n: '05', c: 1, p: 1, em: 14, en: -18, estado: 'aprobada', items: [{ receta: 2, cant: 1, inst: true }] },
  { n: '06', c: 2, p: 2, em: 22, en: -10, estado: 'aprobada', items: [{ receta: 1, cant: 1, inst: true }] },
  { n: '07', c: 4, p: 4, em: 24, en: -8,  estado: 'aprobada', items: [{ receta: 1, cant: 1, inst: true }] },
  { n: '08', c: 1, p: 1, em: 26, en: -7,  estado: 'aprobada', items: [{ receta: 1, cant: 1, inst: true }] },
  { n: '09', c: 2, p: 2, em: 28, en: -5,  estado: 'aprobada', items: [{ receta: 2, cant: 1, inst: true }] },
  { n: '10', c: 3, p: 3, em: 21, en: -9,  estado: 'aprobada', items: [{ receta: 1, cant: 1, inst: true }] },
  { n: '11', c: 1, p: 1, em: 35, en: 5,   estado: 'aprobada', items: [{ receta: 1, cant: 2, inst: true }, { servicio: 'Instalación de puerta blindada', cant: 2, precio: 180000 }] },
  { n: '12', c: 2, p: 2, em: 12, en: -20, estado: 'aprobada', items: [{ sku: 'ACE-C16', cant: 5, precio: 32000 }, { sku: 'MAD-PIN', cant: 12, precio: 5200 }, { sku: 'PIN-BLA', cant: 4, precio: 16500 }] },
  { n: '13', c: 3, p: 3, em: 11, en: -20, estado: 'aprobada', items: [{ sku: 'MAT-INAC', cant: 10, precio: 7000 }, { sku: 'ELE-SOLD', cant: 3, precio: 8900 }] },
  { n: '14', c: 1, p: 1, em: 10, en: -35, estado: 'aprobada', items: [{ sku: 'ACE-C14', cant: 150, precio: 36000 }] },
  { n: '15', c: 4, p: 4, em: 9,  en: -25, estado: 'pendiente', items: [{ sku: 'SIL-TRA', cant: 5, precio: 3900 }] },
  { n: '16', c: 2, p: 2, em: 13, en: -12, estado: 'aprobada', items: [{ sku: 'DIS-CORTE', cant: 10, precio: 3100 }, { sku: 'BUR-GOM', cant: 20, precio: 1200 }] },
  { n: '17', c: 3, p: 3, em: 19, en: -10, estado: 'cancelada', items: [{ sku: 'PIN-GRS', cant: 6, precio: 17500 }] },
  { n: '18', c: 4, p: 4, em: 10, en: -25, estado: 'aprobada', items: [{ sku: 'CER-BIO', cant: 2, precio: 245000 }, { receta: 3, cant: 1, inst: true }] },
  { n: '19', c: 2, p: 2, em: 5,  en: -12, estado: 'aprobada', items: [{ sku: 'CER-BIO', cant: 2, precio: 245000 }] },
  { n: '20', c: 1, p: 1, em: 12, en: -30, estado: 'aprobada', items: [{ sku: 'VID-BLI', cant: 2, precio: 129000 }] },
  { n: '21', c: 3, p: 3, em: 8,  en: -20, estado: 'cancelada', items: [{ sku: 'CER-BIO', cant: 1, precio: 245000 }] },
  { n: '22', c: 4, p: 4, em: 7,  en: -14, estado: 'aprobada', items: [{ sku: 'ELE-SOLD', cant: 2, precio: 8900 }] },
];
for (const v of VENTAS) {
  v.id = nuevo('venta');
  v.numero = `NV-PRUEBA-${v.n}`;
  for (const i of v.items) {
    i.id = nuevo('item');
    if (i.receta) { i.precio = PRECIO_PUERTA[i.receta]; i.desc = RECETA[i.receta].nombre; }
    else if (i.sku) i.desc = `${MAT[i.sku].nombre}`;
    else i.desc = i.servicio;
  }
  st.ventas.push(v);
}
const V = Object.fromEntries(VENTAS.map(v => [v.n, v]));

/** Sugerencia de CU-120: insumos del área Instalación × puertas que requieren instalación. */
function sugerencia(v) {
  const acc = new Map();
  for (const i of v.items.filter(x => x.receta && x.inst)) {
    for (const [sku, area, cant, merma] of RECETA[i.receta].items) {
      if (area !== AREA.instalacion) continue;
      acc.set(sku, r4((acc.get(sku) || 0) + cant * (1 + merma) * i.cant));
    }
  }
  return [...acc.entries()].map(([sku, cant]) => ({ sku, cant }));
}

function estadoPrep(v, nombre, t, usuario, rut = null) {
  st.estados.push({ id: nuevo('est'), nombre, t, prep: v.prep.id, usuario, rut });
}
function vincular(t, v, usuario = U.jop) {
  v.prep = { id: nuevo('prep'), venta: v.id, usuario, t, obs: null };
  st.preps.push(v.prep);
  estadoPrep(v, 'vinculado', t, usuario);
  for (const l of sugerencia(v)) {
    const det = { id: nuevo('det'), prep: v.prep.id, sku: l.sku, req: l.cant, origen: 'receta', bod: 1, retirada: null, fRetiro: null, uRetiro: null };
    st.dets.push(det);
    reservarConReparto(l.sku, det.bod, l.cant, (lote, bod, x) => st.reservas.push({
      id: nuevo('res'), cant: x, t, estado: 'activa', sku: l.sku, venta: v.id, lote, bod, det: det.id, usuario: null }));
  }
}
const detDe = (v, sku) => st.dets.find(d => d.prep === v.prep.id && d.sku === sku);
function retirar(t, v, sku, cant, usuario = U.jop) {
  const d = detDe(v, sku);
  d.retirada = r4((d.retirada || 0) + (cant ?? d.req));
  d.fRetiro = t; d.uRetiro = usuario;
}
function retirarTodo(t, v, usuario = U.jop, excepto = []) {
  for (const d of st.dets.filter(x => x.prep === v.prep.id && !excepto.includes(x.sku))) retirar(t, v, d.sku, d.req, usuario);
}
/** CU-127: salida definitiva por reserva (lote y bodega exactos), reserva liberada. */
function despachar(t, v, usuario, obs) {
  const dets = st.dets.filter(d => d.prep === v.prep.id).map(d => d.id);
  const reservas = st.reservas.filter(r => dets.includes(r.det) && r.estado === 'activa')
    .sort((a, b) => a.sku.localeCompare(b.sku) || loteDe(b.lote).ingreso - loteDe(a.lote).ingreso || a.id - b.id);
  for (const r of reservas) {
    const f = fila(r.sku, r.lote, r.bod);
    f.fis = r4(f.fis - r.cant); f.res = r4(f.res - r.cant);
    if (f.fis < -1e-9 || f.res < -1e-9) throw new Error(`Despacho deja negativo ${r.sku}`);
    mov(t, { tipo: SALIDA, motivo: MOT.despacho, sku: r.sku, bod: r.bod, lote: r.lote, usuario,
             desc: `Despacho de la venta ${v.numero} (pedido de instalación)`, ref: v.numero, cantidad: r.cant });
    r.estado = 'liberada'; r.fLib = t;
  }
  v.prep.obs = obs;
  estadoPrep(v, 'en_transito', t, usuario);
}

/** CU-131: reserva lo pendiente de las líneas con SKU, FIFO en todas las bodegas. */
function reservarVenta(t, v, usuario) {
  for (const i of v.items.filter(x => x.sku)) {
    const m = MAT[i.sku];
    if (m.estado === 'inactivo' || m.herramienta) continue;
    reservarEnBodega(i.sku, null, i.cant, (lote, bod, x) => st.reservas.push({
      id: nuevo('res'), cant: x, t, estado: 'activa', sku: i.sku, venta: v.id, lote, bod, det: null, usuario }));
  }
}
function cerrarReservasDe(t, v, estado, usuario, motivo) {
  for (const r of st.reservas.filter(x => x.venta === v.id && x.estado === 'activa')) {
    const f = fila(r.sku, r.lote, r.bod);
    f.res = r4(f.res - r.cant);
    Object.assign(r, { estado, fLib: t, uLib: usuario, motivo });
  }
}

// V17: reservada y después anulada por la cancelación de la venta (CU-132 Exc 1)
en(T(15, '10:00'), () => reservarVenta(T(15, '10:00'), V['17'], U.jop));
en(T(8, '12:00'), () => cerrarReservasDe(T(8, '12:00'), V['17'], 'anulada', U.gerente, 'Venta cancelada por el cliente'));

// V11: la cadena completa, ya despachada (CU-127 Exc 2, CU-121)
en(T(14, '10:00'), () => vincular(T(14, '10:00'), V['11']));
en(T(12, '15:00'), () => estadoPrep(V['11'], 'preparado', T(12, '15:00'), U.jop));
en(T(11, '10:30'), () => retirarTodo(T(11, '10:30'), V['11']));
en(T(10, '09:00'), () => estadoPrep(V['11'], 'en_carga', T(10, '09:00'), U.jop, EMP.Marcela));
en(T(10, '09:20'), () => estadoPrep(V['11'], 'en_carga', T(10, '09:20'), U.jop, EMP.Diego));
en(T(9, '08:45'), () => despachar(T(9, '08:45'), V['11'], U.gerente, 'Salida en camión de reparto, patente PR-UE-26.'));

// V09: en carga (CU-125 Exc 2, CU-127 caso 1)
en(T(12, '10:00'), () => vincular(T(12, '10:00'), V['09']));
en(T(9, '15:00'), () => estadoPrep(V['09'], 'preparado', T(9, '15:00'), U.jop));
en(T(8, '10:00'), () => retirarTodo(T(8, '10:00'), V['09']));
en(T(7, '09:15'), () => estadoPrep(V['09'], 'en_carga', T(7, '09:15'), U.jop, EMP.Pedro));

// V08: preparado y retirado entero (CU-125 caso 1 y Exc 1)
en(T(10, '11:00'), () => vincular(T(10, '11:00'), V['08']));
en(T(8, '16:00'), () => estadoPrep(V['08'], 'preparado', T(8, '16:00'), U.jop));
en(T(7, '11:00'), () => retirarTodo(T(7, '11:00'), V['08']));

// V07: preparado con un retiro parcial y sus alertas (CU-126 Exc 2 y caso 5)
en(T(8, '11:00'), () => vincular(T(8, '11:00'), V['07']));
en(T(7, '16:00'), () => estadoPrep(V['07'], 'preparado', T(7, '16:00'), U.jop));
en(T(5, '10:00'), () => retirar(T(5, '10:00'), V['07'], 'CER-MUL', null, U.jop));
en(T(5, '11:00'), () => retirarTodo(T(5, '11:00'), V['07'], U.jop, ['CER-MUL', 'TAR-ANC']));
en(T(5, '11:20'), () => retirar(T(5, '11:20'), V['07'], 'TAR-ANC', 6, U.jop));

// V06: preparado, sin retiros (CU-119 Exc 3, CU-126 casos 1-4, CU-125 Exc 3, CU-132 Exc 3)
en(T(7, '10:00'), () => vincular(T(7, '10:00'), V['06']));
en(T(6, '16:00'), () => estadoPrep(V['06'], 'preparado', T(6, '16:00'), U.jop));

// V10: preparado y retirado, sin carga (CU-127 Exc 1)
en(T(6, '10:00'), () => vincular(T(6, '10:00'), V['10']));
en(T(5, '15:00'), () => estadoPrep(V['10'], 'preparado', T(5, '15:00'), U.jop));
en(T(4, '10:00'), () => retirarTodo(T(4, '10:00'), V['10']));

// V05: vinculado parcial (se agotaron las mirillas) (CU-119 Exc 2)
en(T(4, '10:30'), () => vincular(T(4, '10:30'), V['05']));
// V04: vinculado completo (CU-120 Exc 3, CU-119 caso 1)
en(T(3, '11:00'), () => vincular(T(3, '11:00'), V['04']));

// CU-131: V16 ya reservada (Exc 3), V22 reservada para liberarla en CU-132
en(T(5, '10:30'), () => reservarVenta(T(5, '10:30'), V['16'], U.gerente));
en(T(4, '12:00'), () => reservarVenta(T(4, '12:00'), V['22'], U.jop));

/* ══════════════════════════════════════════════════════════════════════
   Órdenes de trabajo (R1, CU-103, CU-104)
   ══════════════════════════════════════════════════════════════════════ */

const ESPEC_DE_RECETA = { 1: 1, 2: 2, 3: 3 };
/*
 * d, área, estado, receta, puertas, proyecto, reales { sku: real | null }, estimados distintos de la receta,
 * procesar (días atrás en que se procesaron los diferenciales).
 */
const OTS = [
  { d: 60, area: AREA.corte,   estado: 'finalizada', receta: 1, puertas: 4, proyecto: 1, real: { 'ACE-C14': 10, 'TUB-4040': 24 }, procesar: 55 },
  { d: 58, area: AREA.pintura, estado: 'finalizada', receta: 1, puertas: 4, proyecto: 1, real: { 'PIN-GRS': 6.1, 'PIN-BLA': 4.4 }, procesar: 53 },
  { d: 56, area: AREA.armado,  estado: 'finalizada', receta: 1, puertas: 4, proyecto: 1, real: { 'ELE-SOLD': 3, 'DIS-CORTE': 4 }, procesar: 52 },
  { d: 35, area: AREA.corte,   estado: 'finalizada', receta: 2, puertas: 2, proyecto: 2, real: { 'ACE-C14': 9, 'TUB-4040': 23, 'DIS-CORTE': 2 }, extra: { 'DIS-CORTE': 0 }, procesar: 30 },
  { d: 33, area: AREA.pintura, estado: 'finalizada', receta: 2, puertas: 2, proyecto: 2, real: { 'PIN-GRS': 4.5, 'PIN-BLA': 4.2 }, procesar: 29 },
  { d: 20, area: AREA.corte,   estado: 'finalizada', receta: 1, puertas: 3, proyecto: 3, real: { 'ACE-C14': 7, 'TUB-4040': 20 } },          // CU-103 caso 1
  { d: 15, area: AREA.armado,  estado: 'finalizada', receta: 1, puertas: 2, proyecto: 3, real: {} },                                       // CU-103 Exc 1
  { d: 12, area: AREA.pintura, estado: 'finalizada', receta: 1, puertas: 2, proyecto: 3, real: { 'PIN-GRS': 2.8, 'PIN-BLA': 1 }, extra: { 'PIN-BLA': 0 } }, // CU-103 Exc 2
  { d: 3,  area: AREA.corte,   estado: 'en_curso',   receta: 2, puertas: 1, proyecto: 4, real: { 'ACE-C14': 4, 'TUB-4040': null } },
  { d: 2,  area: AREA.pintura, estado: 'en_curso',   receta: 1, puertas: 2, proyecto: 4, real: {} },
];
for (const o of OTS) {
  o.id = nuevo('ot');
  st.ots.push(o);
  // Estimado = receta del área × puertas (merma como fracción); `extra` fuerza un estimado (0 = sin base)
  const est = {};
  for (const [sku, area, cant, merma] of RECETA[o.receta].items) if (area === o.area) est[sku] = r4(cant * (1 + merma) * o.puertas);
  Object.assign(est, o.extra || {});
  for (const sku of new Set([...Object.keys(est), ...Object.keys(o.real)])) {
    st.mots.push({ ot: o.id, sku, est: est[sku] ?? null, real: o.real[sku] ?? null });
  }
  const bod = o.area === AREA.pintura ? 2 : 1;
  const tc = T(o.d === 3 ? 3 : o.d - 1, '10:15');
  for (const [sku, real] of Object.entries(o.real)) {
    if (!(real > 0)) continue;
    en(tc, () => salida(tc, { sku, bod, cant: real, ot: o.id, proyecto: o.proyecto, conLote: true, usuario: U.jop,
                              desc: `Consumo registrado en la OT #${o.id}` }));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Conteos cíclicos (CU-37, CU-43, CU-57)
   ══════════════════════════════════════════════════════════════════════ */

const nombreMat = (sku) => MAT[sku].nombre;
const fmt = (v) => Number(v).toLocaleString('es-CL', { maximumFractionDigits: 4 });

function conteo(t, { bod, usuario, contar, procesar = null, alertas = null }) {
  const skus = [...new Set([...st.ib.values()].filter(f => f.bod === bod).map(f => f.sku))]
    .sort((a, b) => nombreMat(a).localeCompare(nombreMat(b)));
  const c = { id: nuevo('conteo'), t, bod, usuario, estado: 'confirmado', resultado: null, fProc: null, uProc: null };
  st.conteos.push(c);
  const lineas = skus.map(sku => {
    const teo = r4(fifo(sku, bod).reduce((s, f) => s + f.fis, 0));
    const regla = contar[sku];
    const contada = regla === undefined || regla === null ? null : typeof regla === 'function' ? r4(regla(teo)) : regla;
    return { sku, teo, contada };
  });
  for (const l of lineas) st.detConteo.push({ conteo: c.id, sku: l.sku, contada: l.contada, teo: l.teo });
  if (!procesar) return c;

  const difs = [];
  for (const l of lineas.filter(x => x.contada != null)) {
    const tol = TOLERANCIA[MAT[l.sku].critico ? 'critico' : 'no_critico'];
    const t4 = Math.round(l.teo * 10000), c4 = Math.round(l.contada * 10000), dif = c4 - t4;
    const pct = t4 !== 0 ? Math.round((dif / t4) * 10000) / 100 : null;
    const clasif = dif < 0 ? 'faltante' : dif > 0 ? 'sobrante' : 'sin_diferencia';
    const supera = t4 === 0 ? c4 > 0 : Math.abs(pct) > tol.tol;
    const d = { id: nuevo('difInv'), conteo: c.id, sku: l.sku, teo: l.teo, contada: l.contada, dif: dif / 10000, pct, clasif, supera,
                t: procesar.t, usuario: procesar.usuario, tol: tol.tol, umbral: tol.umbral };
    st.difInv.push(d);
    difs.push(d);
  }
  Object.assign(c, { estado: 'procesado', resultado: difs.some(x => x.supera) ? 'con_diferencias' : 'conforme', fProc: procesar.t, uProc: procesar.usuario });
  if (!alertas) return c;
  for (const d of difs.filter(x => x.supera)) {
    const critica = d.pct === null || Math.abs(d.pct) > d.umbral;
    const pctTxt = d.pct === null ? 'sin stock teórico' : `${d.pct > 0 ? '+' : ''}${fmt(d.pct)} %`;
    alerta({ t: alertas.t, sku: d.sku, tipo: critica ? TIPO_ALERTA.diferenciaCritica : TIPO_ALERTA.diferencia,
             mensaje: `Diferencia de conteo: ${d.clasif} de ${fmt(Math.abs(d.dif))} (${pctTxt}). Teórico ${fmt(d.teo)}, contado ${fmt(d.contada)} en el conteo #${c.id}.`,
             bod, conteo: c.id, dif: d.dif, pct: d.pct, usuario: alertas.usuario, resolucion: alertas.resolucion || null });
  }
  return c;
}

/** Alerta de inventario con su fila de historial. resolucion: { t, usuario } | 'sin_registro' | null (activa). */
function alerta({ t, sku, tipo, mensaje, bod = null, conteo = null, dif = null, pct = null, usuario = null, prov = null,
                  sugerida = null, agotamiento = null, resolucion = null }) {
  const h = { id: nuevo('hist'), fRes: resolucion && resolucion !== 'sin_registro' ? resolucion.t : null,
              usuario: resolucion && resolucion !== 'sin_registro' ? resolucion.usuario : null };
  st.hist.push(h);
  const a = { id: nuevo('alerta'), t, sku, tipo, mensaje, estado: resolucion ? 'resuelta' : 'activa', bod, conteo, dif, pct,
              usuario, prov, sugerida, agotamiento, hist: h.id };
  st.alertas.push(a);
  return a;
}

// Conteo antiguo de la Bodega Central, procesado y con sus alertas ya resueltas
en(T(90, '16:30'), () => conteo(T(90, '16:30'), { bod: 1, usuario: U.jop,
  contar: { 'ACE-C14': (x) => x - 1, 'DIS-CORTE': (x) => x + 2, 'TAR-ANC': (x) => x, 'BUR-GOM': (x) => x - 0.5, 'SIL-TRA': (x) => x },
  procesar: { t: T(88, '10:00'), usuario: U.gerente },
  alertas: { t: T(88, '10:05'), usuario: U.gerente, resolucion: { t: T(85, '12:00'), usuario: U.gerente } } }));
// Conteo de la Obra Norte hace 10 días: procesado, con una alerta ACTIVA de Tarugos (CU-57 Exc 2)
en(T(10, '16:00'), () => conteo(T(10, '16:00'), { bod: 3, usuario: U.jop,
  contar: { 'TAR-ANC': 94, 'SIL-TRA': (x) => x, 'ESP-POL': (x) => x, 'BUR-GOM': (x) => x, 'CER-MUL': (x) => x },
  procesar: { t: T(9, '09:00'), usuario: U.gerente }, alertas: { t: T(9, '09:05'), usuario: U.gerente } }));
// Conteo de la Obra Norte: confirmado, sin procesar (CU-43 caso 1 y Exc 1, CU-57 casos 1, 3 y 4)
en(T(2, '16:00'), () => conteo(T(2, '16:00'), { bod: 3, usuario: U.jop,
  contar: { 'TAR-ANC': 92, 'CER-MUL': 3, 'ESP-POL': (x) => x, 'BUR-GOM': 49.5 } }));
// Conteo de la Bodega Planta: confirmado, todo dentro de tolerancia (CU-43 Exc 2, CU-57 Exc 1)
en(T(1, '11:00'), () => conteo(T(1, '11:00'), { bod: 2, usuario: U.jop,
  contar: { 'PIN-BLA': (x) => x - 0.5, 'PIN-GRS': (x) => x, 'MAD-PIN': (x) => x - 2, 'BIS-ACE': (x) => x } }));

/* ══════════════════════════════════════════════════════════════════════
   Ejecutar la simulación
   ══════════════════════════════════════════════════════════════════════ */

eventos.sort((a, b) => a.k - b.k || a.seq - b.seq);
for (const e of eventos) e.fn();

/* ── Después de la simulación: alertas y diferenciales ── */

// Alertas del retiro de V07 (CU-126): ubicación incorrecta y faltante en retiro, activas
{
  const v = V['07'];
  const det = detDe(v, 'TAR-ANC');
  const reserva = st.reservas.find(r => r.det === det.id && r.estado === 'activa');
  const l = loteDe(reserva.lote);
  const donde = `'Venta ${v.numero}: ${nombreMat('TAR-ANC')} no está en la ubicación indicada (Bodega Central: ${NOMBRE_ANAQUEL[fila('TAR-ANC', l.id, 1).anaquel]} (lote ' || ${numeroLoteSql(l)} || ')). Observación: El anaquel tiene otra medida de tarugo.'`;
  alerta({ t: T(5, '11:10'), sku: 'TAR-ANC', tipo: TIPO_ALERTA.ubicacion, mensaje: raw(donde), bod: 1, usuario: U.jop });
  alerta({ t: T(5, '11:20'), sku: 'TAR-ANC', tipo: TIPO_ALERTA.faltanteRetiro, bod: 1, usuario: U.jop, dif: -4,
           mensaje: `Venta ${v.numero}: retiro parcial de ${nombreMat('TAR-ANC')} en Bodega Central. Se retiraron 6 de 10; faltan 4. ` +
                    'Reponga o ubique el material: el pedido no se puede cargar hasta completarlo.' });
}

// Historial de alertas resueltas (CU-55): stock, reposición; resueltas por usuarios, por el sistema o sin registro
{
  const rnd = prng(424242);
  const plantilla = [
    ['ACE-C14', TIPO_ALERTA.bajoMinimo], ['DIS-CORTE', TIPO_ALERTA.bajoMinimo], ['PIN-GRS', TIPO_ALERTA.bajoMinimo],
    ['TAR-ANC', TIPO_ALERTA.bajoMinimo], ['BUR-GOM', TIPO_ALERTA.bajoMinimo], ['CER-MUL', TIPO_ALERTA.critico],
    ['ACE-C14', TIPO_ALERTA.reposicion], ['DIS-CORTE', TIPO_ALERTA.reposicion], ['ELE-SOLD', TIPO_ALERTA.bajoMinimo],
    ['MAD-PIN', TIPO_ALERTA.bajoMinimo], ['PIN-BLA', TIPO_ALERTA.critico], ['SIL-TRA', TIPO_ALERTA.bajoMinimo],
  ];
  const texto = (tipo, sku) => tipo === TIPO_ALERTA.bajoMinimo ? 'Stock actual bajo el mínimo definido'
    : tipo === TIPO_ALERTA.critico ? 'Stock actual en nivel crítico'
    : `Cobertura menor que el plazo del proveedor. Reordenar ${nombreMat(sku)}.`;
  for (let k = 0; k < 36; k++) {
    const [sku, tipo] = plantilla[k % plantilla.length];
    const d = 330 - k * 9;
    const horas = 2 + Math.floor(rnd() * 70);
    const t = T(d, `${8 + Math.floor(rnd() * 9)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`);
    const tr = { d: t.d - Math.floor((t.min + horas * 60) / 1440), min: (t.min + horas * 60) % 1440 };
    const modo = k % 6;   // 0-2 usuario, 3-4 sistema, 5 sin registro (datos antiguos)
    const resolucion = modo === 5 ? 'sin_registro' : { t: tr, usuario: modo <= 1 ? U.gerente : modo === 2 ? U.jop : null };
    alerta({ t, sku, tipo, mensaje: texto(tipo, sku), resolucion,
             prov: tipo === TIPO_ALERTA.reposicion ? principalDe(sku) : null });
  }
}

// Alertas de stock ACTIVAS, las mismas que dejaría generarAlertasAutomaticas con el stock final
for (const m of MATERIALES.filter(x => x.min != null && (x.estado || 'activo') === 'activo' && x.rotativo !== false)) {
  const fis = r4([...st.ib.values()].filter(f => f.sku === m.sku).reduce((s, f) => s + f.fis, 0));
  const tipo = fis <= m.crit && m.crit > 0 ? TIPO_ALERTA.critico : fis <= m.min && m.min > 0 ? TIPO_ALERTA.bajoMinimo : null;
  if (!tipo) continue;
  alerta({ t: T(2, '18:30'), sku: m.sku, tipo,
           mensaje: `Stock actual (${fis}) ${tipo === TIPO_ALERTA.critico ? 'en nivel crítico' : 'bajo el mínimo definido'}` });
}

// Diferenciales de las OT procesadas (CU-103): misma fórmula y precio vigente a la fecha de la OT
function precioVigente(sku, d) {
  const principal = principalDe(sku);
  const vigentes = (prov) => st.hpm.filter(h => h.sku === sku && (prov == null || h.prov === prov) && h.desde >= d)
    .sort((a, b) => a.desde - b.desde || b.id - a.id)[0]?.precio ?? null;
  return vigentes(principal) ?? vigentes(null) ?? referencial(sku, principal);
}
for (const o of OTS.filter(x => x.procesar)) {
  for (const m of st.mots.filter(x => x.ot === o.id && x.real != null)) {
    const e = m.est ?? 0, r = m.real, abs = r4(r - e);
    const tipo = e <= 1e-9 ? 'sin_base' : abs > 1e-9 ? 'sobre_gasto' : abs < -1e-9 ? 'ahorro' : 'sin_desviacion';
    const pct = e <= 1e-9 ? null : Math.round((abs / e) * 100 * 100) / 100;
    const precio = precioVigente(m.sku, o.d);
    st.difc.push({ id: nuevo('difc'), ot: o.id, sku: m.sku, t: T(o.procesar, '11:00'), est: e, real: r, abs, pct, tipo,
                   impacto: precio == null ? null : Math.round(abs * precio * 100) / 100, usuario: U.gerente });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Controles (fallan fuerte: los DML nunca salen descuadrados)
   ══════════════════════════════════════════════════════════════════════ */

function referencial(sku, prov) {
  const fijo = MAT_PROV.find(x => x[0] === sku && x[1] === prov)?.[3];
  if (fijo != null) return fijo;
  return st.hpm.filter(h => h.sku === sku && h.prov === prov).sort((a, b) => a.desde - b.desde || b.id - a.id)[0]?.precio ?? null;
}

const errores = [];
for (const f of st.ib.values()) {
  if (f.fis < -1e-9 || f.res < -1e-9 || f.res > f.fis + 1e-9) errores.push(`Fila de stock inválida ${f.sku} lote ${f.lote} bodega ${f.bod}: ${f.fis}/${f.res}`);
}
// Reservas activas == reservado, por fila
const resPorFila = new Map();
for (const r of st.reservas.filter(x => x.estado === 'activa')) {
  const k = kIb(r.sku, r.lote, r.bod);
  resPorFila.set(k, r4((resPorFila.get(k) || 0) + r.cant));
}
for (const [k, f] of st.ib) if (Math.abs((resPorFila.get(k) || 0) - f.res) > 1e-9) errores.push(`Reservas descuadradas en ${k}`);
// stockAFecha antes del primer movimiento = 0 (el stock sale entero de los movimientos)
const netoMov = new Map();
for (const m of st.movs) {
  if (m.estado === 'revertido' || m.estado === 'rechazado' || m.revertido) continue;
  netoMov.set(m.sku, r4((netoMov.get(m.sku) || 0) + (m.tipo === ENTRADA ? m.cantidad : -m.cantidad)));
}
const fisPorSku = new Map();
for (const f of st.ib.values()) fisPorSku.set(f.sku, r4((fisPorSku.get(f.sku) || 0) + f.fis));
for (const sku of new Set([...netoMov.keys(), ...fisPorSku.keys()])) {
  if (Math.abs((netoMov.get(sku) || 0) - (fisPorSku.get(sku) || 0)) > 1e-6) errores.push(`Stock de ${sku} no cuadra con sus movimientos`);
}
// Todo en el pasado
for (const m of st.movs) if (m.t.d < 1) errores.push(`Movimiento ${m.id} con fecha de hoy o futura`);
if (errores.length) { console.error(errores.join('\n')); process.exit(1); }

/* ══════════════════════════════════════════════════════════════════════
   Resumen (para ajustar los perfiles)
   ══════════════════════════════════════════════════════════════════════ */

function resumen() {
  const lineas = [];
  lineas.push(`Movimientos: ${st.movs.length} · lotes: ${st.lotes.length} · reservas: ${st.reservas.length} (${st.reservas.filter(r => r.estado === 'activa').length} activas)`);
  const consumo90 = new Map();
  for (const m of st.movs) {
    if (m.t.d > 90 || !['completado', 'confirmado'].includes(m.estado) || m.revertido) continue;
    if (m.tipo === SALIDA && m.motivo !== MOT.traslado) consumo90.set(m.sku, r4((consumo90.get(m.sku) || 0) + m.cantidad));
    if (m.tipo === ENTRADA && (m.motivo === MOT.devolucion || m.ot)) consumo90.set(m.sku, r4((consumo90.get(m.sku) || 0) - m.cantidad));
  }
  for (const m of MATERIALES) {
    const porBod = BODEGAS.map(b => {
      const filas = fifo(m.sku, b[0]);
      if (!filas.length) return null;
      const fis = r4(filas.reduce((s, f) => s + f.fis, 0)), res = r4(filas.reduce((s, f) => s + f.res, 0));
      return `${b[3]} ${fis}${res ? `(r${res})` : ''}`;
    }).filter(Boolean).join(' ');
    const disp = libreEn(m.sku);
    const diario = Math.max(consumo90.get(m.sku) || 0, 0) / 90;
    const prov = principalDe(m.sku);
    let plazo = prov ? plazoDe(m.sku, prov) : null;
    if (plazo == null) plazo = MAT_PROV.filter(x => x[0] === m.sku && x[2] && PROVEEDORES.find(p => p[0] === x[1])[6] === 'activo').map(x => x[2]).sort((a, b) => a - b)[0] ?? null;
    const corridos = plazo ? Math.ceil(plazo * 7 / 5) : null;
    const cob = diario > 0 ? r4(disp / diario) : null;
    const cls = m.herramienta || m.rotativo === false || m.estado === 'inactivo' ? '-' : disp <= 0 ? 'CRITICA' : !diario ? 'sin rotación'
      : corridos == null || PROVEEDORES.find(p => p[0] === prov)?.[6] !== 'activo' ? 'pendiente config' : cob <= corridos ? 'PREVENTIVA' : 'ok';
    lineas.push(`${m.sku.padEnd(10)} ${porBod.padEnd(40)} disp ${String(disp).padEnd(8)} diario ${diario.toFixed(2).padEnd(6)} cob ${String(cob && cob.toFixed(1)).padEnd(6)} plazo ${corridos} → ${cls}`);
  }
  return lineas.join('\n');
}

/* ══════════════════════════════════════════════════════════════════════
   Escritura de los archivos
   ══════════════════════════════════════════════════════════════════════ */

const CABECERA = (titulo, detalle) => `-- ============================================================
-- Datos de prueba (BD NUEVA) — ${titulo}
-- Grupo 14 | Generado por generador/generar.js: NO editar a mano (regenerar).
--
${detalle.map(l => `-- ${l}`).join('\n')}
--
-- Orden de carga: ddl_inventario.sql, ddl_terreno.sql, ddl_finanzas.sql,
-- catalogos_inventario.sql y luego 01..06 de esta carpeta (ver README.md).
-- Las fechas son relativas al día de carga (CURRENT_DATE - n).
-- ============================================================

-- El archivo es UTF-8: sin esto, psql en Windows lo lee como WIN1252 y daña los acentos
SET client_encoding = 'UTF8';

BEGIN;

`;
const PIE = 'COMMIT;\n';

function escribir(nombre, contenido) {
  fs.writeFileSync(path.join(DESTINO, nombre), contenido.replace(/\r?\n/g, '\n'), 'utf8');
}

/* ── 01: finanzas y terreno ── */
{
  let s = CABECERA('01 · Finanzas y Terreno (filas mínimas)', [
    'EXCEPCIÓN a la regla 7 (no escribir en finanzas ni terreno), autorizada por el usuario el 2026-09-30:',
    'una BD nueva no tiene clientes, proyectos, empleados ni ventas, y sin ellos no se prueban los CU',
    'de pedidos, ventas y carga. Todo es reconocible: códigos PRY-PRUEBA-*, correos .test.',
  ]);
  s += '-- Finanzas: tipos de cliente, clientes y proyectos\n';
  s += insert('finanzas.tipo_cliente', ['id_tipo_cliente', 'nombre_tipo_cliente', 'descripcion', 'activo'],
    [[1, 'Empresa', 'Cliente con RUT de empresa (dato de prueba)', true], [2, 'Persona natural', 'Cliente particular (dato de prueba)', true]]);
  s += insert('finanzas.cliente_financiero', ['id_cliente_financiero', 'rut_cliente', 'id_tipo_cliente', 'nombre_razon_social', 'telefono_principal', 'correo_principal', 'estado_cliente'],
    CLIENTES.map(c => [c[0], rut(c[1]), c[3], c[2], c[5], c[6], 'activo']));
  s += insert('finanzas.proyecto_financiero', ['id_proyecto_financiero', 'id_cliente_financiero', 'id_proyecto_terreno', 'codigo_proyecto', 'nombre_referencia', 'fecha_ingreso', 'estado_financiero', 'observacion'],
    PROYECTOS.map(p => [p[0], p[3], p[0], p[1], p[2], fecha(p[4]), 'activo', 'DATOS DE PRUEBA — Inventario G14']));
  s += '\n-- Finanzas: empleados (CU-125: responsable de la carga; Ricardo Toro está inactivo)\n';
  s += insert('finanzas.empleado_cargo', ['empleado_cargo_id_cargo', 'empleado_cargo_nombre'],
    [[1, 'Operario de bodega'], [2, 'Chofer'], [3, 'Instaladora'], [4, 'Jefe de cuadrilla']]);
  s += insert('finanzas.empleado_tipo_vinculo_laboral', ['empleado_tipo_vinculo_laboral_id_tipo_vinculo', 'empleado_tipo_vinculo_laboral_nombre', 'empleado_tipo_vinculo_laboral_seguro_cesantia'],
    [[1, 'Indefinido', true], [2, 'Plazo fijo', true]]);
  s += insert('finanzas.empleado', ['empleado_rut_empleado', 'empleado_nombre_empleado_primer_nombre_empleado', 'empleado_nombre_empleado_primer_apellido_empleado', 'empleado_estado', 'empleado_fecha_ingreso', 'empleado_cargo_id_cargo', 'empleado_tipo_vinculo_laboral_id_tipo_vinculo'],
    EMPLEADOS.map((e, i) => [rut(e[0]), e[1], e[2], e[4], fecha(900 - i * 120), e[3], 1]), { identidad: false });
  s += '\n-- Terreno: clientes, proyectos y especificaciones de puerta (ligadas a las recetas)\n';
  s += insert('terreno.cliente', ['rut_cliente', 'razon_social', 'contacto_principal', 'correo', 'telefono', 'es_cliente_b2c', 'es_cliente_b2b'],
    CLIENTES.map(c => [rut(c[1]), c[2], c[4], c[6], c[5], c[3] === 2, c[3] === 1]), { identidad: false });
  s += insert('terreno.proyecto', ['id_proyecto', 'codigo_proyecto', 'nombre_referencia', 'fecha_instalacion', 'fecha_ingreso', 'estado_operacional', 'estado_produccion', 'rut_cliente'],
    PROYECTOS.map(p => [p[0], p[1], p[2], fecha(p[5]), fecha(p[4]), 'en_curso', 'en_proceso', rut(CLIENTES[p[3] - 1][1])]));
  const medidas = [[90, 200], [160, 210], [90, 200], [80, 200]];
  s += insert('terreno.medidas_puerta', ['id_medidas', 'medidas_marco_ancho', 'medidas_marco_alto', 'medidas_marco_espesor',
    'medidas_vano_vertical_ancho', 'medidas_vano_vertical_alto', 'medidas_vano_vertical_espesor',
    'medidas_vano_horizontal_ancho', 'medidas_vano_horizontal_alto', 'medidas_vano_horizontal_espesor',
    'medidas_alojamiento_vertical_alto', 'medidas_alojamiento_vertical_ancho', 'medidas_alojamiento_vertical_espesor',
    'medidas_alojamiento_horizontal_alto', 'medidas_alojamiento_horizontal_ancho', 'medidas_alojamiento_horizontal_espesor',
    'alojamiento_vertical', 'medidas_de_marco_ancho', 'medidas_de_marco_alto', 'medidas_de_marco_espesor'],
    medidas.map(([a, h], i) => [i + 1, a, h, 10, a, h, 10, a, h, 10, h, a, 10, h, a, 10, h, a, h, 10]));
  s += insert('terreno.especificacion_puerta', ['id_especificacion_puerta', 'modelo_puerta', 'zona', 'sentido_apertura', 'materialidad_vano',
    'materialidad_marco_actual', 'solucion_marco', 'hoja_pasiva', 'hoja_activa', 'diseno_puerta', 'cubrejuntas', 'bisagras', 'id_medidas', 'producto_terminado_id'],
    [[1, 'Estándar 90x200', 'acceso principal', 'derecha', 'hormigón', 'madera', 'reemplazo', 'no aplica', 'hoja activa acero', 'liso', true, 'tres bisagras', 1, 1],
     [2, 'Doble hoja 160x210', 'acceso edificio', 'doble', 'hormigón', 'acero', 'reemplazo', 'hoja pasiva acero', 'hoja activa acero', 'liso', true, 'seis bisagras', 2, 2],
     [3, 'Estándar con biometría', 'acceso departamento', 'izquierda', 'albañilería', 'madera', 'marco nuevo', 'no aplica', 'hoja activa acero', 'tablero', true, 'tres bisagras', 3, 3],
     [4, 'Hoja de reposición', 'bodega', 'derecha', 'hormigón', 'acero', 'se mantiene', 'no aplica', 'hoja activa acero', 'liso', false, 'tres bisagras', 4, 4]]);
  s += '\n' + [
    ['finanzas.tipo_cliente', 'id_tipo_cliente'], ['finanzas.cliente_financiero', 'id_cliente_financiero'],
    ['finanzas.proyecto_financiero', 'id_proyecto_financiero'], ['finanzas.empleado_cargo', 'empleado_cargo_id_cargo'],
    ['finanzas.empleado_tipo_vinculo_laboral', 'empleado_tipo_vinculo_laboral_id_tipo_vinculo'], ['terreno.proyecto', 'id_proyecto'],
    ['terreno.medidas_puerta', 'id_medidas'], ['terreno.especificacion_puerta', 'id_especificacion_puerta'],
  ].map(([t, c]) => setval(t, c)).join('');
  escribir('01_finanzas_terreno.sql', s + '\n' + PIE);
}

/* ── 02: usuarios ── */
{
  let s = CABECERA('02 · Usuarios', [
    'Un usuario por rol, más un segundo de gerencia para probar el bloqueo de CU-42 sin trabar al primero.',
    'Todos con la MISMA contraseña de prueba (ver README.md). Sirve también para la BD vacía.',
  ]);
  s += insert('inventario.usuario', ['usuario_id_usuario', 'usuario_username', 'usuario_correo', 'usuario_estado_cuenta',
    'usuario_nombre_completo_primer_nombre_usuario', 'usuario_nombre_completo_primer_apellido_usuario',
    'usuario_es_gerencia', 'usuario_es_jop', 'usuario_es_tecnico', 'usuario_es_administrador', 'usuario_es_secretaria',
    'perfil_id_perfil', 'usuario_fecha_de_creacion'],
    USUARIOS.map(u => [u[0], u[1], `${u[1]}@puertasblindadas.test`, 'activo', u[2], u[3],
      u[4] === 'gerencia', u[4] === 'jop', u[4] === 'tecnico', u[4] === 'administrador', u[4] === 'secretaria', u[5], ts(T(460, '09:00'))]));
  s += insert('inventario.usuario_contrasena', ['usuario_id_usuario', 'usuario_contrasena', 'es_temporal'],
    USUARIOS.map(u => [u[0], HASH, false]), { identidad: false });
  s += setval('inventario.usuario', 'usuario_id_usuario');
  escribir('02_usuarios.sql', s + '\n' + PIE);
}

/* ── 03: maestros ── */
{
  let s = CABECERA('03 · Maestros: bodegas, proveedores, materiales, recetas y reglas de integración', [
    'Bodega Sur no tiene productos a propósito (CU-37 Exc 2).',
    'Perfiles Nuevo Norte no tiene compras ni precios (CU-61, CU-62, CU-64); Distribuidora Cerrada está inactiva.',
    'LIJ-120 y PIN-CUS no tienen proveedor; MAT-INAC está inactivo; VID-BLI está descontinuado.',
  ]);
  s += insert('inventario.bodega', ['bodega_id_bodega', 'bodega_nombre_bodega', 'bodega_direccion', 'bodega_estado', 'bodega_codigo'],
    BODEGAS.map(b => [b[0], b[1], b[2], 'activo', b[3]]));
  s += insert('inventario.anaquel', ['anaquel_id_anaquel', 'anaquel_descripcion', 'bodega_id_bodega'], ANAQUELES);
  s += '\n';
  s += insert('inventario.proveedor', ['proveedor_id_proveedor', 'proveedor_razon_social', 'proveedor_pais', 'proveedor_tipo_proveedor', 'proveedor_rubro',
    'proveedor_contacto_primer_nombre', 'proveedor_contacto_primer_apellido', 'proveedor_estado',
    'proveedor_doc_identidad_tipo_identificador', 'proveedor_doc_identidad_rut_proveedor_opcional'],
    PROVEEDORES.map(p => [p[0], p[1], p[2], p[3], p[4], p[5][0], p[5][1], p[6], 'RUT', rut(p[7])]));
  s += insert('inventario.proveedor_contacto_telefono', ['proveedor_id_proveedor', 'proveedor_contacto_telefono'], PROVEEDORES.map(p => [p[0], p[8]]), { identidad: false });
  s += insert('inventario.proveedor_contacto_correo', ['proveedor_id_proveedor', 'proveedor_contacto_correo'], PROVEEDORES.map(p => [p[0], p[9]]), { identidad: false });
  s += '\n';
  s += insert('inventario.material', ['material_sku', 'material_nombre_material', 'material_descripcion', 'material_material_critico',
    'material_presentacion', 'material_presentacion_fecha_modificacion', 'material_stock_critico', 'material_stock_maximo', 'material_stock_minimo',
    'material_es_rotativo', 'material_estado', 'es_material_pintura_custom', 'material_pintura_pintura_custom',
    'es_material_pintura_no_custom', 'material_pintura_no_custom', 'material_categoria_general_id_categoria_general',
    'material_categoria_funcional_id_categoria_funcional', 'material_clasificacion_nivel_especifico_id', 'material_unidad_medida_id_unidad_medida',
    'material_es_herramienta', 'material_valor_adquisicion', 'material_fecha_adquisicion', 'material_descontinuado'],
    MATERIALES.map(m => [m.sku, m.nombre, m.desc || null, !!m.critico, m.pres || null, m.pres ? ts(T(400, '12:00')) : null,
      m.crit ?? null, m.max ?? null, m.min ?? null, m.rotativo !== false, m.estado || 'activo',
      m.custom ? true : null, m.custom || null, m.noCustom ? true : null, m.noCustom || null,
      m.gen ?? null, m.fun ?? null, m.nivel ?? null, m.unidad, !!m.herramienta, m.valor ?? null, m.adq ? fecha(m.adq) : null, !!m.descontinuado]),
    { identidad: false });
  s += '\n-- CU-30: un código interno por SKU (prefijo 2, 12 dígitos), como los genera el backend\n';
  s += insert('inventario.material_codigo_barras', ['material_sku', 'material_codigo_barras'],
    MATERIALES.map((m, i) => [m.sku, '2' + String(i + 1).padStart(11, '0')]), { identidad: false });
  s += `SELECT setval('inventario.seq_codigo_barras_interno', ${MATERIALES.length});\n\n`;
  s += insert('inventario.material_proveedor', ['material_sku', 'proveedor_id_proveedor', 'material_proveedor_tiempo_reposicion',
    'material_proveedor_precio_referencial', 'material_proveedor_proveedor_principal', 'material_proveedor_cantidad_minima'],
    MAT_PROV.map(([sku, prov, plazo, , principal, min]) => [sku, prov, plazo, referencial(sku, prov), principal, min]), { identidad: false });
  s += '\n-- Recetas (CU-102). PB-STD-000 es la versión anterior, desactivada y reemplazada por PB-STD-001\n';
  s += insert('inventario.producto_terminado', ['producto_terminado_id_producto', 'producto_terminado_tipo_producto', 'producto_terminado_nombre_producto',
    'producto_terminado_codigo_producto', 'producto_terminado_activo', 'producto_terminado_fecha_creacion', 'producto_terminado_reemplazada_por'],
    RECETAS.map(r => [r.id, r.tipo, r.nombre, r.codigo, r.activo !== false, ts(T(r.id === 5 ? 420 : 380, '10:00')), r.reemplazo ?? null]));
  s += insert('inventario.material_producto_terminado', ['material_sku', 'producto_terminado_id_producto', 'material_producto_terminado_cantidad_estimada',
    'material_producto_terminado_merma_estimada', 'area_trabajo_id_area'],
    RECETAS.flatMap(r => r.items.map(([sku, area, cant, merma]) => [sku, r.id, cant, merma, area])), { identidad: false });
  s += '\n-- CU-108: una sola regla, Terreno + jop (entradas y salidas). Finanzas no tiene reglas.\n';
  s += insert('inventario.permiso', ['permiso_id_permiso', 'permiso_modulo', 'permiso_accion', 'permiso_descripcion', 'permiso_nombre_del_permiso'],
    [[8, 'inventario', 'entrada_desde_terreno', 'CU-108: registrar entradas de inventario desde Terreno', 'inv_entrada_desde_terreno'],
     [9, 'inventario', 'salida_desde_terreno', 'CU-108: registrar salidas de inventario desde Terreno', 'inv_salida_desde_terreno']]);
  s += insert('inventario.perfil_permiso', ['perfil_id_perfil', 'permiso_id_permiso', 'perfil_permiso_activo'], [[2, 8, true], [2, 9, true]], { identidad: false });
  s += '\n' + [['inventario.bodega', 'bodega_id_bodega'], ['inventario.anaquel', 'anaquel_id_anaquel'], ['inventario.proveedor', 'proveedor_id_proveedor'],
    ['inventario.producto_terminado', 'producto_terminado_id_producto'], ['inventario.permiso', 'permiso_id_permiso']].map(([t, c]) => setval(t, c)).join('');
  escribir('03_maestros.sql', s + '\n' + PIE);
}

/* ── 04: historia ── */
{
  let s = CABECERA('04 · Historia: compras, consumos, traslados y stock', [
    `${st.movs.length} movimientos en unos 15 meses. El stock (inventario_bodega) es exactamente lo que dejan`,
    'los movimientos, y lo reservado es la suma de las reservas activas de 05. Incluye una salida ya',
    'revertida (CU-44), traslados (D60), mermas, despachos (CU-127) y movimientos desde Terreno (CU-107).',
  ]);
  s += insert('inventario.factura_compra', ['factura_compra_id_factura', 'factura_compra_numero_factura', 'factura_compra_fecha_emision', 'proveedor_id_proveedor', 'factura_compra_tipo_compra'],
    st.facturas.map(f => [f.id, f.numero, fecha(f.fecha), f.prov, 'nacional']));
  s += insert('inventario.lote', ['lote_id_lote', 'lote_numero_lote', 'lote_fecha_ingreso', 'lote_fecha_recepcion', 'lote_estado', 'proveedor_id_proveedor', 'factura_compra_id_factura'],
    st.lotes.map(l => [l.id, raw(numeroLoteSql(l)), fecha(l.ingreso), l.recepcion == null ? null : fecha(l.recepcion), 'activo', l.prov, l.factura]));
  s += insert('inventario.lote_fecha_pedido', ['lote_fecha_pedido_id', 'lote_fecha_pedido_fecha_pedido', 'lote_fecha_pedido_precio_unitario', 'lote_id_lote'],
    st.lfp.map(x => [x.id, fecha(x.pedido), x.precio, x.lote]));
  s += insert('inventario.historial_precio_material', ['historial_precio_id', 'material_sku', 'proveedor_id_proveedor', 'precio_unitario', 'moneda',
    'fecha_vigencia_desde', 'fuente', 'factura_compra_id', 'usuario_id_usuario', 'created_at'],
    st.hpm.sort((a, b) => a.id - b.id).map(h => [h.id, h.sku, h.prov, h.precio, 'CLP', fecha(h.desde), h.fuente, h.factura, h.usuario, ts(h.t)]));
  s += '\n';
  s += insert('inventario.movimiento_inventario', ['movimiento_inventario_id_movimiento', 'movimiento_inventario_fecha_hora', 'movimiento_inventario_cantidad',
    'movimiento_inventario_estado', 'material_sku', 'bodega_id_bodega', 'lote_id_lote', 'proyecto_id_proyecto', 'factura_compra_id_factura_compra',
    'usuario_id_usuario', 'movimiento_inventario_tipo_movimiento_id_tipo_movimiento', 'movimiento_inventario_motivo_movimiento_id_motivo_movimiento',
    'movimiento_inventario_descripcion_motivo', 'movimiento_inventario_evidencia_url', 'orden_trabajo_id_orden', 'movimiento_inventario_id_revertido',
    'movimiento_inventario_modulo_origen', 'movimiento_inventario_referencia_origen', 'movimiento_inventario_clave_envio'],
    st.movs.map(m => [m.id, ts(m.t), m.cantidad, m.estado, m.sku, m.bod, m.lote, m.proyecto, m.factura, m.usuario, m.tipo, m.motivo,
      m.desc, m.evidencia, m.ot, m.revertido, m.modulo, m.ref, m.clave]));
  s += '\n-- Stock final: una fila por SKU + lote + bodega (las filas en 0 se conservan, como en el sistema)\n';
  s += insert('inventario.inventario_bodega', ['material_sku', 'lote_id_lote', 'bodega_id_bodega', 'inventario_bodega_cantidad_fisica',
    'inventario_bodega_cantidad_reservada', 'anaquel_id_anaquel'],
    [...st.ib.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.lote - b.lote || a.bod - b.bod)
      .map(f => [f.sku, f.lote, f.bod, f.fis, f.res, f.anaquel]), { identidad: false });
  s += '\n-- CU-42: la autorización de la reversión ya registrada\n';
  s += insert('inventario.reautenticacion_intento', ['reautenticacion_intento_id', 'usuario_id_usuario', 'reautenticacion_intento_fecha_hora',
    'reautenticacion_intento_exitoso', 'reautenticacion_intento_accion', 'movimiento_inventario_id_movimiento'],
    st.reauth.map(r => [r.id, r.usuario, ts(r.t), r.exitoso, 'revertir_movimiento', r.mov]));
  s += '\n' + [['inventario.factura_compra', 'factura_compra_id_factura'], ['inventario.lote', 'lote_id_lote'],
    ['inventario.lote_fecha_pedido', 'lote_fecha_pedido_id'], ['inventario.historial_precio_material', 'historial_precio_id'],
    ['inventario.movimiento_inventario', 'movimiento_inventario_id_movimiento'], ['inventario.reautenticacion_intento', 'reautenticacion_intento_id']]
    .map(([t, c]) => setval(t, c)).join('');
  escribir('04_historia.sql', s + '\n' + PIE);
}

/* ── 05: ventas y pedidos ── */
{
  let s = CABECERA('05 · Ventas (finanzas) y pedidos de instalación', [
    'Ventas NV-PRUEBA-01..22 en finanzas (excepción autorizada a la regla 7), con puertas (recetas) y',
    'materiales sueltos (sku_material). Los pedidos de instalación están en cada estado de despacho y',
    'las reservas cuadran con inventario_bodega de 04. Detalle de qué venta sirve para cada caso: README.md.',
  ]);
  s += insert('finanzas.nota_venta', ['id_nota_venta', 'numero_nota_venta', 'id_cliente_financiero', 'id_proyecto_financiero', 'fecha_emision',
    'fecha_max_entrega', 'tipo_nota_venta', 'estado_pedido', 'estado_pago', 'observacion'],
    st.ventas.map(v => [v.id, v.numero, v.c, v.p, fecha(v.em), fecha(v.en), 'producto', v.estado, 'pendiente', 'DATOS DE PRUEBA — Inventario G14']));
  s += insert('finanzas.item_nota_venta', ['id_item_nota_venta', 'id_nota_venta', 'id_producto_terminado', 'sku_material', 'descripcion_item', 'cantidad',
    'precio_unitario', 'requiere_produccion', 'requiere_instalacion', 'estado_item'],
    st.ventas.flatMap(v => v.items.map(i => [i.id, v.id, i.receta ?? null, i.sku ?? null, i.desc, i.cant, i.precio, !!i.receta, !!i.inst, 'pendiente'])));
  s += '\n';
  s += insert('inventario.preparacion_pedido', ['preparacion_pedido_id_preparacion', 'preparacion_pedido_observacion', 'usuario_id_usuario',
    'nota_venta_id_nota_venta', 'preparacion_pedido_fecha_creacion'],
    st.preps.map(p => [p.id, p.obs, p.usuario, p.venta, ts(p.t)]));
  s += insert('inventario.preparacion_pedido_detalle', ['preparacion_pedido_detalle_id', 'preparacion_pedido_id_preparacion', 'material_sku',
    'preparacion_pedido_detalle_cantidad_requerida', 'preparacion_pedido_detalle_origen', 'bodega_id_bodega',
    'preparacion_pedido_detalle_cantidad_retirada', 'preparacion_pedido_detalle_fecha_retiro', 'usuario_id_retiro'],
    st.dets.map(d => [d.id, d.prep, d.sku, d.req, d.origen, d.bod, d.retirada, d.fRetiro ? ts(d.fRetiro) : null, d.uRetiro]));
  s += insert('inventario.preparacion_pedido_estado', ['preparacion_pedido_estado_id_estado_preparacion', 'preparacion_pedido_estado_nombre_estado',
    'preparacion_pedido_estado_timestamp_accion', 'preparacion_pedido_id_preparacion', 'usuario_id_usuario', 'empleado_rut'],
    st.estados.map(e => [e.id, e.nombre, ts(e.t), e.prep, e.usuario, e.rut]));
  s += '\n';
  s += insert('inventario.reserva_inventario', ['reserva_inventario_id_reserva', 'reserva_inventario_cantidad_reservada', 'reserva_inventario_fecha_reserva',
    'reserva_inventario_fecha_liberacion', 'reserva_inventario_estado_reserva', 'material_sku', 'nota_venta_id_nota_venta', 'lote_id_lote',
    'bodega_id_bodega', 'preparacion_pedido_detalle_id', 'usuario_id_usuario', 'usuario_id_liberacion', 'reserva_inventario_motivo_liberacion'],
    st.reservas.map(r => [r.id, r.cant, ts(r.t), r.fLib ? ts(r.fLib) : null, r.estado, r.sku, r.venta, r.lote, r.bod, r.det, r.usuario, r.uLib ?? null, r.motivo ?? null]));
  s += '\n' + [['finanzas.nota_venta', 'id_nota_venta'], ['finanzas.item_nota_venta', 'id_item_nota_venta'],
    ['inventario.preparacion_pedido', 'preparacion_pedido_id_preparacion'], ['inventario.preparacion_pedido_detalle', 'preparacion_pedido_detalle_id'],
    ['inventario.preparacion_pedido_estado', 'preparacion_pedido_estado_id_estado_preparacion'], ['inventario.reserva_inventario', 'reserva_inventario_id_reserva']]
    .map(([t, c]) => setval(t, c)).join('');
  escribir('05_ventas_y_pedidos.sql', s + '\n' + PIE);
}

/* ── 06: operación ── */
{
  let s = CABECERA('06 · Operación: órdenes de trabajo, conteos y alertas', [
    'OT abiertas, finalizadas sin procesar y procesadas con sus diferenciales (CU-103, CU-104).',
    'Conteos: uno antiguo procesado, uno de la Obra Norte procesado con alerta activa, y dos confirmados',
    'sin procesar (Obra Norte con diferencias, Planta conforme). Historial de alertas para CU-55.',
  ]);
  s += insert('inventario.orden_trabajo', ['orden_trabajo_id_orden', 'orden_trabajo_fecha_hora', 'orden_trabajo_estado', 'especificaciones_puerta_id_especificacion_puerta',
    'proyecto_id_proyecto', 'area_trabajo_id_area', 'usuario_id_usuario', 'producto_terminado_id_producto', 'orden_trabajo_cantidad_puertas'],
    st.ots.map(o => [o.id, ts(T(o.d, '08:30')), o.estado, ESPEC_DE_RECETA[o.receta], o.proyecto, o.area, U.jop, o.receta, o.puertas]));
  s += insert('inventario.material_orden_trabajo', ['material_sku', 'orden_trabajo_id_orden', 'material_orden_trabajo_consumo_estimado', 'material_orden_trabajo_consumo_real'],
    st.mots.map(m => [m.sku, m.ot, m.est, m.real]), { identidad: false });
  s += insert('inventario.diferencial_consumo', ['diferencial_consumo_id', 'orden_trabajo_id_orden', 'material_sku', 'diferencial_consumo_fecha',
    'diferencial_consumo_estimado', 'diferencial_consumo_real', 'diferencial_consumo_desviacion_abs', 'diferencial_consumo_desviacion_pct',
    'diferencial_consumo_tipo', 'diferencial_consumo_impacto_clp', 'usuario_id_usuario'],
    st.difc.map(d => [d.id, d.ot, d.sku, ts(d.t), d.est, d.real, d.abs, d.pct, d.tipo, d.impacto, d.usuario]));
  s += '\n';
  s += insert('inventario.conteo_ciclico', ['conteo_ciclico_id_conteo', 'conteo_ciclico_fecha_hora', 'conteo_ciclico_estado', 'conteo_ciclico_fecha_confirmacion',
    'conteo_ciclico_fecha_procesamiento', 'conteo_ciclico_resultado', 'bodega_id_bodega', 'usuario_id_usuario', 'usuario_procesa_id'],
    st.conteos.map(c => [c.id, ts(c.t), c.estado, ts(c.t), c.fProc ? ts(c.fProc) : null, c.resultado, c.bod, c.usuario, c.uProc]));
  s += insert('inventario.conteo_ciclico_detalle', ['conteo_ciclico_id_conteo', 'material_sku', 'conteo_ciclico_detalle_cantidad_contada',
    'conteo_ciclico_detalle_stock_teorico', 'conteo_ciclico_detalle_no_esperado'],
    st.detConteo.map(d => [d.conteo, d.sku, d.contada, d.teo, false]), { identidad: false });
  s += insert('inventario.diferencia_inventario', ['diferencia_inventario_id', 'conteo_ciclico_id_conteo', 'material_sku', 'diferencia_inventario_stock_teorico',
    'diferencia_inventario_cantidad_contada', 'diferencia_inventario_diferencia', 'diferencia_inventario_diferencia_pct', 'diferencia_inventario_clasificacion',
    'diferencia_inventario_supera_tolerancia', 'diferencia_inventario_fecha', 'usuario_id_usuario', 'diferencia_inventario_tolerancia_pct',
    'diferencia_inventario_umbral_critico_pct'],
    st.difInv.map(d => [d.id, d.conteo, d.sku, d.teo, d.contada, d.dif, d.pct, d.clasif, d.supera, ts(d.t), d.usuario, d.tol, d.umbral]));
  s += '\n-- Alertas: historial (CU-55), las de los conteos, las del retiro de NV-PRUEBA-07 y las de stock vigentes\n';
  s += insert('inventario.historial_alerta', ['historial_alerta_id_historial', 'historial_alerta_fecha_hora_resolucion', 'usuario_id_usuario'],
    st.hist.map(h => [h.id, h.fRes ? ts(h.fRes) : null, h.usuario]));
  s += insert('inventario.alerta_inventario', ['alerta_inventario_id_alerta', 'alerta_inventario_mensaje', 'alerta_inventario_fecha_generacion',
    'alerta_inventario_fecha_est_agotamiento', 'alerta_inventario_estado', 'material_sku', 'proveedor_id_proveedor', 'alerta_inventario_tipo_alerta_id_tipo_alerta',
    'historial_alerta_id_historial', 'bodega_id_bodega', 'conteo_ciclico_id_conteo', 'alerta_inventario_diferencia', 'alerta_inventario_diferencia_pct',
    'alerta_inventario_cantidad_sugerida', 'usuario_id_usuario'],
    st.alertas.map(a => [a.id, a.mensaje, ts(a.t), a.agotamiento, a.estado, a.sku, a.prov, a.tipo, a.hist, a.bod, a.conteo, a.dif, a.pct, a.sugerida, a.usuario]));
  s += '\n' + [['inventario.orden_trabajo', 'orden_trabajo_id_orden'], ['inventario.diferencial_consumo', 'diferencial_consumo_id'],
    ['inventario.conteo_ciclico', 'conteo_ciclico_id_conteo'], ['inventario.diferencia_inventario', 'diferencia_inventario_id'],
    ['inventario.historial_alerta', 'historial_alerta_id_historial'], ['inventario.alerta_inventario', 'alerta_inventario_id_alerta']]
    .map(([t, c]) => setval(t, c)).join('');
  escribir('06_operacion.sql', s + '\n' + PIE);
}

console.log(resumen());
console.log('\nArchivos 01..06 escritos en', DESTINO);
