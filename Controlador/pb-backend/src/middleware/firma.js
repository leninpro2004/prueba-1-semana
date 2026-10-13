const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ACCIONES_FIRMA, firmaActiva } = require('../config/firmas');

/**
 * F-11: firma de gerencia para las acciones sensibles (catálogo en config/firmas.js).
 *
 * El cliente pide el token con POST /api/auth/reautenticar { username, password, accion } y lo
 * manda en el header X-Autorizacion al repetir la petición. Sin un token válido la ruta responde
 * 428 { requiere_firma } ANTES de llegar al controller: un rechazo nunca toca la BD.
 *
 * El token dura 5 minutos, vale para UNA acción y se usa UNA vez CON ÉXITO (B-22). Al aceptarlo
 * queda "en uso" (otra petición simultánea con el mismo token se rechaza); si la respuesta es un
 * rechazo (≥ 400: validación, 404, 409...) se libera y sirve para el reintento mientras no venza.
 * Los usados se recuerdan en memoria hasta que vencen (sin DDL); tras un reinicio un token sin
 * usar sigue valiendo hasta vencer, igual que antes del reinicio.
 */

const MINUTOS = 5;
const usados = new Map();   // jti -> instante de vencimiento (ms); en uso o ya usados con éxito

function purgar(ahora) {
  for (const [jti, vence] of usados) if (vence <= ahora) usados.delete(jti);
}

/** Token de firma para `accion`, firmado por el gerente `firmante` (id). */
function firmarToken(accion, firmante) {
  return jwt.sign({ tipo: 'firma', accion, firmante, jti: crypto.randomUUID() },
    process.env.JWT_SECRET, { expiresIn: `${MINUTOS}m` });
}

/**
 * null si la petición puede seguir (la acción no pide firma o trae un token válido, que queda usado);
 * si no, el cuerpo de la respuesta 428.
 */
function faltaFirma(req, accion) {
  if (!firmaActiva(accion)) return null;
  const rechazo = (motivo) => ({
    error: `Para ${ACCIONES_FIRMA[accion]} se necesita la autorización de un gerente. ${motivo}`.trim(),
    requiere_firma: accion,
    descripcion: ACCIONES_FIRMA[accion],
  });

  const token = req.get('X-Autorizacion');
  if (!token) return rechazo('');
  let c;
  try {
    c = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return rechazo('La autorización venció: vuelva a ingresarla.');
  }
  if (c.tipo !== 'firma' || c.accion !== accion || !c.jti) {
    return rechazo('La autorización es para otra acción.');
  }
  const ahora = Date.now();
  purgar(ahora);
  if (usados.has(c.jti)) return rechazo('La autorización ya se usó.');
  usados.set(c.jti, c.exp * 1000);
  // B-22: si la operación se rechaza, la firma no se gasta. Si el cliente corta la conexión
  // antes de la respuesta ('finish' no llega), queda usada: no se sabe si la operación se hizo.
  req.res?.once('finish', () => {
    if (req.res.statusCode >= 400) usados.delete(c.jti);
  });
  req.firma = { accion, firmante: c.firmante };
  return null;
}

/**
 * Middleware: exige la firma de `accion` (o de la que devuelva `accion(req)`, cuando depende de la
 * petición). Va después del middleware de rol.
 */
function requiereFirma(accion) {
  return (req, res, next) => {
    const nombre = typeof accion === 'function' ? accion(req) : accion;
    const falta = faltaFirma(req, nombre);
    if (falta) return res.status(428).json(falta);
    next();
  };
}

module.exports = { requiereFirma, faltaFirma, firmarToken };
