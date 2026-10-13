/**
 * B-02 (D80): recuperación de acceso desde el servidor.
 *
 * Es la salida cuando la recuperación normal no sirve: un gerente que olvidó su
 * contraseña (CU-84 no deja que otro gerente se la resetee desde la web) o que no
 * haya ningún gerente disponible. No es una ruta web: solo la puede correr quien
 * tiene acceso al servidor y a su .env.
 *
 *   npm run recuperar-acceso -- <usuario o correo>
 *
 * Genera una contraseña temporal aleatoria, la muestra una sola vez y la marca
 * como temporal, así que el login obliga a cambiarla. Registra la auditoría como
 * usuario sistema. No reactiva cuentas: si está inactiva, lo avisa.
 *
 * Funcionamiento completo: docs/fase-cierre/recuperacion-acceso.md
 */
const path = require('path');
// Antes del pool: pool.js lee la conexión de process.env al cargarse.
// dotenv no pisa variables ya definidas (los tests cargan las suyas antes).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool, query } = require('../src/db/pool');
const auditoria = require('../src/controllers/auditoriaController');

/**
 * Asigna una contraseña temporal al usuario (por username o correo).
 * Devuelve { id, username, estado, es_gerencia, clave }. Lanza si no existe.
 */
async function recuperarAcceso(identificador) {
  const buscado = String(identificador || '').trim();
  if (!buscado) throw new Error('Indique el usuario o el correo.');

  const { rows } = await query(
    `SELECT usuario_id_usuario AS id, usuario_username AS username,
            usuario_estado_cuenta AS estado, usuario_es_gerencia AS es_gerencia
     FROM usuario
     WHERE usuario_username = $1 OR usuario_correo = $1
     ORDER BY usuario_id_usuario`,
    [buscado]
  );
  if (rows.length === 0) throw new Error(`No existe un usuario con usuario o correo "${buscado}".`);
  if (rows.length > 1) throw new Error(`"${buscado}" coincide con ${rows.length} usuarios. Use el nombre de usuario.`);

  const usuario = rows[0];
  const clave = crypto.randomBytes(9).toString('base64url'); // 12 caracteres
  const hash = await bcrypt.hash(clave, 12);

  // Un usuario puede no tener fila de contraseña todavía: se crea.
  await query(
    `INSERT INTO usuario_contrasena (usuario_id_usuario, usuario_contrasena, es_temporal)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (usuario_id_usuario)
     DO UPDATE SET usuario_contrasena = EXCLUDED.usuario_contrasena, es_temporal = TRUE`,
    [usuario.id, hash]
  );

  await auditoria.registrar(auditoria.USUARIO_SISTEMA, 'recuperar_acceso_servidor',
    `Contraseña temporal generada desde el servidor para ${usuario.username} (ID ${usuario.id})`);

  return { ...usuario, clave };
}

async function main() {
  const identificador = process.argv[2];
  if (!identificador) {
    console.error('Uso: npm run recuperar-acceso -- <usuario o correo>');
    process.exitCode = 1;
    await pool.end();
    return;
  }
  try {
    const r = await recuperarAcceso(identificador);
    console.log(`\nUsuario:               ${r.username} (ID ${r.id})${r.es_gerencia ? ' — gerencia' : ''}`);
    console.log(`Contraseña temporal:   ${r.clave}`);
    console.log('Se pedirá cambiarla al iniciar sesión. Entréguela por un canal privado; no se vuelve a mostrar.');
    if (!['activo', 'activa'].includes(r.estado)) {
      console.log(`\nAVISO: la cuenta está "${r.estado}". No podrá entrar hasta que la reactiven desde Usuarios.`);
    }
  } catch (err) {
    console.error(`\nNo se pudo recuperar el acceso: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { recuperarAcceso };
