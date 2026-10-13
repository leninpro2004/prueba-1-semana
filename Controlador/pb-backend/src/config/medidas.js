/**
 * F-08 (D74): medidas de la puerta para calcular la receta por fórmula.
 *
 * La OT guarda las medidas de ENTRADA (vano, hojas, MDF, perfil del marco) y de ahí
 * salen las DERIVADAS (marco, alojamiento, hoja, bastidor). Se calculan SOLO aquí: las
 * fórmulas de la receta usan los nombres de VARIABLES_FORMULA y nunca repiten estas
 * restas. Todas las medidas van en milímetros.
 *
 * REGLAS (ajuste del 12/10 con las planillas del cliente, insumos/ de la fase de cierre):
 *  - marco = vano − 5 de holgura, en ancho y en alto (reunión, min 15-16, y planilla de 19 modelos)
 *  - el marco tiene 3 lados (dos laterales y el superior; abajo no lleva perfil): el alojamiento
 *    descuenta 2 perfiles en el ancho y 1 en el alto. La carta 250380 también mide el marco
 *    como 2 altos + 1 ancho
 *  - hoja = alojamiento − 9 de ancho con una hoja (bisagra 5 + cierre 4) o − 13 con dos hojas
 *    (PROVISIONAL: solo viene de la planilla de 19 modelos), y − 10 de alto. Con dos hojas,
 *    cada una mide la mitad
 *  - bastidor = hoja − 8 si lleva MDF (4 mm por lado); sin MDF, igual a la hoja
 * hoja_* y bastidor_* son POR HOJA: con dos hojas, la fórmula multiplica por `hojas`.
 * Cambiar los números de REGLAS no toca la lógica ni las fórmulas guardadas en las recetas.
 */
const REGLAS = {
  holgura_marco_mm: 5,
  perfiles_marco_en_ancho: 2,
  perfiles_marco_en_alto: 1,
  holgura_hoja_ancho_mm: { 1: 9, 2: 13 },   // por cantidad de hojas
  holgura_hoja_alto_mm: 10,
  mdf_ancho_mm: 8,
  mdf_alto_mm: 8,
};

/** Nombres que puede usar una fórmula de receta. */
const VARIABLES_FORMULA = [
  'vano_ancho', 'vano_alto', 'hojas', 'mdf', 'perfil_marco',
  'marco_ancho', 'marco_alto', 'alojamiento_ancho', 'alojamiento_alto',
  'hoja_ancho', 'hoja_alto', 'bastidor_ancho', 'bastidor_alto',
];

/** Puerta de ejemplo con la que se prueba una fórmula al guardarla y en el ayudante de la receta. */
const MEDIDAS_EJEMPLO = { vano_ancho_mm: 1000, vano_alto_mm: 2100, hojas: 1, mdf: false, perfil_marco_mm: 20 };

/**
 * Variables de la fórmula a partir de las medidas de entrada de la OT.
 * `mdf` vale 1 o 0 para poder usarlo en una fórmula (ej. `mdf * bastidor_ancho / 1000`).
 */
function variablesDeMedidas({ vano_ancho_mm, vano_alto_mm, hojas, mdf, perfil_marco_mm }) {
  const r = REGLAS;
  const marcoAncho = vano_ancho_mm - r.holgura_marco_mm;
  const marcoAlto  = vano_alto_mm - r.holgura_marco_mm;
  const alojAncho  = marcoAncho - r.perfiles_marco_en_ancho * perfil_marco_mm;
  const alojAlto   = marcoAlto - r.perfiles_marco_en_alto * perfil_marco_mm;
  const hojaAncho  = (alojAncho - r.holgura_hoja_ancho_mm[hojas]) / hojas;
  const hojaAlto   = alojAlto - r.holgura_hoja_alto_mm;
  return {
    vano_ancho: vano_ancho_mm,
    vano_alto: vano_alto_mm,
    hojas,
    mdf: mdf ? 1 : 0,
    perfil_marco: perfil_marco_mm,
    marco_ancho: marcoAncho,
    marco_alto: marcoAlto,
    alojamiento_ancho: alojAncho,
    alojamiento_alto: alojAlto,
    hoja_ancho: hojaAncho,
    hoja_alto: hojaAlto,
    bastidor_ancho: hojaAncho - (mdf ? r.mdf_ancho_mm : 0),
    bastidor_alto: hojaAlto - (mdf ? r.mdf_alto_mm : 0),
  };
}

/** Rangos aceptados al guardar las medidas de una OT (mm). */
const LIMITES = {
  vano_ancho_mm: { min: 100, max: 10000 },
  vano_alto_mm: { min: 100, max: 10000 },
  perfil_marco_mm: { min: 1, max: 500 },
  hojas: { min: 1, max: 2 },   // la planilla del cliente solo define 1 o 2 hojas
};

/**
 * Valida y normaliza las medidas que llegan para una OT. Devuelve { medidas } o { errores }
 * ([{ campo, error }]). Acepta números como texto y la coma decimal. `origen` queda en
 * 'manual' (la precarga desde Terreno no está en F-08, D74).
 */
function normalizarMedidas(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const errores = [];
  const numero = (campo, nombre, entero = false) => {
    const txt = String(e[campo] ?? '').trim().replace(',', '.');
    const v = Number(txt);
    const { min, max } = LIMITES[campo];
    if (!txt || !Number.isFinite(v) || (entero && !Number.isInteger(v)) || v < min || v > max) {
      errores.push({ campo, error: `${nombre}: ${entero ? 'número entero' : 'número'} entre ${min} y ${max}` });
      return null;
    }
    return v;
  };
  const medidas = {
    vano_ancho_mm: numero('vano_ancho_mm', 'Ancho del vano (mm)'),
    vano_alto_mm: numero('vano_alto_mm', 'Alto del vano (mm)'),
    hojas: numero('hojas', 'Hojas', true),
    mdf: e.mdf === true || e.mdf === 'true',
    perfil_marco_mm: numero('perfil_marco_mm', 'Perfil del marco (mm)'),
    origen: 'manual',
  };
  if (errores.length) return { errores };
  const v = variablesDeMedidas(medidas);
  if (v.bastidor_ancho <= 0 || v.bastidor_alto <= 0) {
    return { errores: [{ campo: 'vano_ancho_mm', error: 'Con estas medidas el bastidor queda sin tamaño: revise el vano y el perfil' }] };
  }
  return { medidas };
}

module.exports = { REGLAS, VARIABLES_FORMULA, MEDIDAS_EJEMPLO, LIMITES, variablesDeMedidas, normalizarMedidas };
