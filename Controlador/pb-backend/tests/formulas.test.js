const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ErrorFormula, analizar, evaluar, cantidadPorMedidas, validarFormula } = require('../src/db/formulas');
const { REGLAS, variablesDeMedidas } = require('../src/config/medidas');

/**
 * F-08 (D74): motor de fórmulas de la receta. No usa la BD.
 *
 * Lo que protegen: que una fórmula escrita por un usuario NUNCA se ejecute como código
 * (sin eval ni Function: un nombre que no es medida o función permitida es error), que la
 * aritmética y el redondeo den lo esperado, y que las medidas derivadas salgan de las
 * reglas de config/medidas.js y no de números repetidos en el código.
 */

const PUERTA = { vano_ancho_mm: 1000, vano_alto_mm: 2100, hojas: 1, mdf: false, perfil_marco_mm: 20 };
const VARS = variablesDeMedidas(PUERTA);

const rechaza = (fn, patron) => assert.throws(fn, (e) => e instanceof ErrorFormula && (!patron || patron.test(e.message)));

describe('aritmética', () => {
  test('precedencia, paréntesis y signo', () => {
    assert.equal(evaluar('2 + 3 * 4', {}), 14);
    assert.equal(evaluar('(2 + 3) * 4', {}), 20);
    assert.equal(evaluar('10 - 4 - 3', {}), 3);
    assert.equal(evaluar('12 / 4 / 3', {}), 1);
    assert.equal(evaluar('-3 + 5', {}), 2);
    assert.equal(evaluar('2 * -(1 + 1)', {}), -4);
  });

  test('decimales con punto y resultado a 4 decimales', () => {
    assert.equal(evaluar('1.5 * 2', {}), 3);
    assert.equal(evaluar('1 / 3', {}), 0.3333);
  });

  test('funciones', () => {
    assert.equal(evaluar('redondear_arriba(2.01)', {}), 3);
    assert.equal(evaluar('redondear_arriba(2)', {}), 2);
    assert.equal(evaluar('redondear_arriba(1.231, 2)', {}), 1.24);
    // 0.1 * 3 = 0.30000000000000004 en binario: no debe subir a 0.31
    assert.equal(evaluar('redondear_arriba(0.1 * 3, 2)', {}), 0.3);
    assert.equal(evaluar('max(1, 5, 3)', {}), 5);
    assert.equal(evaluar('min(4, 2)', {}), 2);
    assert.equal(evaluar('MAX(1, 2)', {}), 2);
  });

  test('variables', () => {
    assert.equal(evaluar('(2 * marco_alto + marco_ancho) / 1000', VARS), 5.185);
    assert.equal(evaluar('hojas * 4', VARS), 4);
  });
});

describe('medidas derivadas (reglas de las planillas del cliente)', () => {
  test('vano 1000 × 2100, perfil 20, una hoja: marco de 3 lados, hoja y bastidor', () => {
    assert.equal(VARS.marco_ancho, 995);
    assert.equal(VARS.marco_alto, 2095);
    assert.equal(VARS.alojamiento_ancho, 955);          // 2 perfiles en el ancho
    assert.equal(VARS.alojamiento_alto, 2075);          // 1 perfil en el alto: el marco no lleva perfil abajo
    assert.equal(VARS.hoja_ancho, 955 - REGLAS.holgura_hoja_ancho_mm[1]);
    assert.equal(VARS.hoja_alto, 2075 - REGLAS.holgura_hoja_alto_mm);
    assert.equal(VARS.bastidor_ancho, VARS.hoja_ancho);  // sin MDF el bastidor es la hoja
    assert.equal(VARS.bastidor_alto, VARS.hoja_alto);
    assert.equal(VARS.mdf, 0);
  });

  test('con MDF el bastidor descuenta además lo del MDF', () => {
    const v = variablesDeMedidas({ ...PUERTA, mdf: true });
    assert.equal(v.mdf, 1);
    assert.equal(v.hoja_ancho, VARS.hoja_ancho);
    assert.equal(v.bastidor_ancho, VARS.hoja_ancho - REGLAS.mdf_ancho_mm);
    assert.equal(v.bastidor_alto, VARS.hoja_alto - REGLAS.mdf_alto_mm);
  });

  test('dos hojas: otra holgura y cada hoja mide la mitad', () => {
    const v = variablesDeMedidas({ ...PUERTA, hojas: 2 });
    assert.equal(v.alojamiento_ancho, 955);
    assert.equal(v.hoja_ancho, (955 - REGLAS.holgura_hoja_ancho_mm[2]) / 2);
    assert.equal(v.hoja_alto, VARS.hoja_alto);
    assert.equal(v.bastidor_ancho, v.hoja_ancho);
  });

  test('cantidadPorMedidas evalúa con las medidas de la OT (948 × 2045 con MDF)', () => {
    const r = cantidadPorMedidas('(2 * bastidor_alto + 2 * bastidor_ancho) / 1000',
      { ...PUERTA, vano_ancho_mm: 948, vano_alto_mm: 2045, mdf: true });
    // ancho 948 → marco 943 → alojamiento 903 → hoja 894 → bastidor 886
    // alto 2045 → marco 2040 → alojamiento 2020 → hoja 2010 → bastidor 2002
    assert.equal(r, (2 * 2002 + 2 * 886) / 1000);
  });
});

describe('errores', () => {
  test('vacía, mal formada o con paréntesis sin cerrar', () => {
    rechaza(() => analizar(''), /vacía/);
    rechaza(() => analizar('   '), /vacía/);
    rechaza(() => analizar('2 +'), /antes de tiempo/);
    rechaza(() => analizar('(2 + 3'), /paréntesis/);
    rechaza(() => analizar('2 3'), /Sobra/);
    rechaza(() => analizar('max(1, 2'), /paréntesis/);
  });

  test('coma decimal: pide punto', () => {
    rechaza(() => analizar('1,5 * 2'), /punto/);
  });

  test('variable o función desconocida', () => {
    rechaza(() => analizar('ancho * 2'), /desconocida/);
    rechaza(() => analizar('raiz(4)'), /Función desconocida/);
    rechaza(() => analizar('max(1)'), /recibe/);
    rechaza(() => analizar('redondear_arriba(1, 2, 3)'), /recibe/);
    rechaza(() => evaluar('redondear_arriba(1.5, 9)', {}), /decimales/);
  });

  test('una medida que falta al evaluar', () => {
    rechaza(() => evaluar('vano_ancho * 2', {}), /Falta la medida/);
  });

  test('división por cero', () => {
    rechaza(() => evaluar('1 / (hojas - 1)', VARS), /cero/);
  });

  test('cantidad negativa para las medidas dadas', () => {
    rechaza(() => cantidadPorMedidas('vano_ancho - 2000', PUERTA), /negativa/);
  });

  test('demasiado larga o anidada', () => {
    rechaza(() => analizar('1+'.repeat(300) + '1'), /superar/);
    rechaza(() => analizar('('.repeat(60) + '1' + ')'.repeat(60)), /anidados/);
  });
});

describe('inyección: el texto nunca se ejecuta como código', () => {
  const intentos = [
    'process.exit()',
    'process.exit(1)',
    'constructor',
    'constructor(1, 2)',
    '__proto__',
    'tostring(1)',
    'hasownproperty(1, 2)',
    'require("fs")',
    "this['x']",
    '1; process.exit()',
    '`1`',
    'globalThis',
    'max.constructor',
  ];
  for (const t of intentos) {
    test(`rechaza ${t}`, () => {
      rechaza(() => evaluar(t, VARS));
    });
  }

  test('una variable con nombre de propiedad del prototipo no se resuelve', () => {
    rechaza(() => evaluar('constructor * 1', {}), /desconocida/);
  });
});

describe('validarFormula (al guardar la receta)', () => {
  test('devuelve el resultado con la puerta de ejemplo', () => {
    assert.deepEqual(validarFormula('(2 * marco_alto + marco_ancho) / 1000'), { ejemplo: 5.185 });
  });

  test('rechaza una fórmula que da negativo con la puerta de ejemplo', () => {
    rechaza(() => validarFormula('vano_ancho - 5000'), /negativa/);
  });
});
