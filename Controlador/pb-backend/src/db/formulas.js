const { VARIABLES_FORMULA, MEDIDAS_EJEMPLO, variablesDeMedidas } = require('../config/medidas');

/**
 * F-08 (D74): evaluador de las fórmulas de una línea de receta.
 *
 * Una fórmula calcula la cantidad POR PUERTA a partir de las medidas de la OT, por ejemplo
 * `(2 * marco_alto + marco_ancho) / 1000` metros de perfil. La merma y las puertas se
 * aplican después, igual que a una cantidad fija.
 *
 * Es un parser propio (descenso recursivo), SIN `eval` ni `Function` y sin dependencias:
 * el texto lo escribe un usuario y nunca se ejecuta como código. Acepta:
 *  - números con punto decimal, + − * /, paréntesis y signo
 *  - las variables de VARIABLES_FORMULA (config/medidas.js); cualquier otro nombre es error
 *  - redondear_arriba(x) o redondear_arriba(x, decimales), max(a, b, ...), min(a, b, ...)
 */

const LARGO_MAXIMO = 500;
const PROFUNDIDAD_MAXIMA = 50;
const VARIABLES = new Set(VARIABLES_FORMULA);

class ErrorFormula extends Error {}

/** redondear_arriba con decimales sin arrastrar el error binario (2.0000000001 no sube a 3). */
function redondearArriba(x, decimales = 0) {
  if (!Number.isInteger(decimales) || decimales < 0 || decimales > 4) {
    throw new ErrorFormula('redondear_arriba acepta de 0 a 4 decimales.');
  }
  const k = 10 ** decimales;
  return Math.ceil(Number((x * k).toFixed(9))) / k;
}

const FUNCIONES = {
  redondear_arriba: { min: 1, max: 2, fn: (x, d) => redondearArriba(x, d) },
  max: { min: 2, max: 20, fn: (...a) => Math.max(...a) },
  min: { min: 2, max: 20, fn: (...a) => Math.min(...a) },
};

function tokenizar(texto) {
  const tokens = [];
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^\d+(\.\d+)?/.exec(texto.slice(i));
    if (num) { tokens.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const nombre = /^[A-Za-z_][A-Za-z0-9_]*/.exec(texto.slice(i));
    if (nombre) { tokens.push({ t: 'nombre', v: nombre[0].toLowerCase() }); i += nombre[0].length; continue; }
    if ('+-*/(),'.includes(c)) { tokens.push({ t: c }); i++; continue; }
    throw new ErrorFormula(`Carácter no permitido: "${c}".`);
  }
  return tokens;
}

/** Texto → árbol. Lanza ErrorFormula con un mensaje para el usuario. */
function analizar(texto) {
  const fuente = String(texto ?? '').trim();
  if (!fuente) throw new ErrorFormula('La fórmula está vacía.');
  if (fuente.length > LARGO_MAXIMO) throw new ErrorFormula(`La fórmula no puede superar ${LARGO_MAXIMO} caracteres.`);

  const tokens = tokenizar(fuente);
  let pos = 0;
  let profundidad = 0;
  const ver = () => tokens[pos];
  const tomar = (t) => (ver()?.t === t ? tokens[pos++] : null);

  const entrar = () => {
    if (++profundidad > PROFUNDIDAD_MAXIMA) throw new ErrorFormula('La fórmula tiene demasiados paréntesis anidados.');
  };

  function expresion() {
    let nodo = termino();
    for (let op = ver()?.t; op === '+' || op === '-'; op = ver()?.t) {
      pos++;
      nodo = { t: 'op', op, a: nodo, b: termino() };
    }
    return nodo;
  }

  function termino() {
    let nodo = factor();
    for (let op = ver()?.t; op === '*' || op === '/'; op = ver()?.t) {
      pos++;
      nodo = { t: 'op', op, a: nodo, b: factor() };
    }
    return nodo;
  }

  function factor() {
    entrar();
    let nodo;
    if (tomar('-')) nodo = { t: 'neg', a: factor() };
    else if (tomar('+')) nodo = factor();
    else nodo = primario();
    profundidad--;
    return nodo;
  }

  function primario() {
    const tk = ver();
    if (!tk) throw new ErrorFormula('La fórmula termina antes de tiempo.');
    if (tk.t === 'num') { pos++; return { t: 'num', v: tk.v }; }
    if (tk.t === '(') {
      pos++;
      const nodo = expresion();
      if (!tomar(')')) throw new ErrorFormula('Falta cerrar un paréntesis.');
      return nodo;
    }
    if (tk.t === 'nombre') {
      pos++;
      if (tomar('(')) {
        const f = FUNCIONES[tk.v];
        if (!Object.hasOwn(FUNCIONES, tk.v) || !f) {
          throw new ErrorFormula(`Función desconocida: "${tk.v}". Se permiten: ${Object.keys(FUNCIONES).join(', ')}.`);
        }
        const args = [expresion()];
        while (tomar(',')) args.push(expresion());
        if (!tomar(')')) throw new ErrorFormula(`Falta cerrar el paréntesis de ${tk.v}.`);
        if (args.length < f.min || args.length > f.max) {
          throw new ErrorFormula(`${tk.v} recibe ${f.min === f.max ? f.min : `de ${f.min} a ${f.max}`} valores.`);
        }
        return { t: 'fn', n: tk.v, args };
      }
      if (!VARIABLES.has(tk.v)) {
        throw new ErrorFormula(`Medida desconocida: "${tk.v}". Se permiten: ${VARIABLES_FORMULA.join(', ')}.`);
      }
      return { t: 'var', n: tk.v };
    }
    if (tk.t === ',') throw new ErrorFormula('Coma fuera de lugar: los decimales se escriben con punto (1.5).');
    throw new ErrorFormula(`Símbolo fuera de lugar: "${tk.t}".`);
  }

  const arbol = expresion();
  if (pos < tokens.length) {
    const tk = tokens[pos];
    throw new ErrorFormula(tk.t === ','
      ? 'Coma fuera de lugar: los decimales se escriben con punto (1.5).'
      : `Sobra "${tk.t === 'num' || tk.t === 'nombre' ? tk.v : tk.t}" en la fórmula.`);
  }
  return arbol;
}

function calcularNodo(nodo, vars) {
  switch (nodo.t) {
    case 'num': return nodo.v;
    case 'var':
      if (!Object.hasOwn(vars, nodo.n) || typeof vars[nodo.n] !== 'number') {
        throw new ErrorFormula(`Falta la medida "${nodo.n}".`);
      }
      return vars[nodo.n];
    case 'neg': return -calcularNodo(nodo.a, vars);
    case 'fn': return FUNCIONES[nodo.n].fn(...nodo.args.map(a => calcularNodo(a, vars)));
    case 'op': {
      const a = calcularNodo(nodo.a, vars);
      const b = calcularNodo(nodo.b, vars);
      if (nodo.op === '+') return a + b;
      if (nodo.op === '-') return a - b;
      if (nodo.op === '*') return a * b;
      if (b === 0) throw new ErrorFormula('La fórmula divide por cero.');
      return a / b;
    }
    default: throw new ErrorFormula('Fórmula no válida.');
  }
}

/**
 * Evalúa la fórmula con las variables dadas (las de variablesDeMedidas). Devuelve un número
 * finito redondeado a 4 decimales, como las cantidades de la BD. Lanza ErrorFormula.
 */
function evaluar(texto, variables) {
  const vars = Object.assign(Object.create(null), variables);
  const r = calcularNodo(analizar(texto), vars);
  if (!Number.isFinite(r)) throw new ErrorFormula('El resultado de la fórmula no es un número válido.');
  return Math.round(r * 10000) / 10000;
}

/** Cantidad por puerta para unas medidas de OT. Lanza ErrorFormula si da negativo. */
function cantidadPorMedidas(texto, medidas) {
  const r = evaluar(texto, variablesDeMedidas(medidas));
  if (r < 0) throw new ErrorFormula(`La fórmula da una cantidad negativa (${r}) para estas medidas.`);
  return r;
}

/**
 * Valida una fórmula al guardarla en la receta: que se entienda y que dé un número
 * no negativo con la puerta de ejemplo. Devuelve { ejemplo } o lanza ErrorFormula.
 */
function validarFormula(texto) {
  return { ejemplo: cantidadPorMedidas(texto, MEDIDAS_EJEMPLO) };
}

module.exports = { ErrorFormula, analizar, evaluar, cantidadPorMedidas, validarFormula, LARGO_MAXIMO };
