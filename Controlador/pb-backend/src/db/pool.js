const fs = require('fs');
const { Pool } = require('pg');

/*
 * Configuración de cada conexión (sección 8.3 del plan de la fase de cierre):
 *  C-03 search_path en las opciones de la conexión, no un SET antes de cada consulta
 *       (con la BD en otra máquina, cada SET era un viaje de red más).
 *  C-04 statement_timeout: una consulta trabada no retiene la conexión para siempre.
 *  C-05 timezone de Chile: en la nube la BD corre en UTC y desde las 21:00 "hoy" sería mañana.
 */
const SCHEMA = process.env.DB_SCHEMA || 'inventario';
const ZONA_HORARIA = process.env.DB_TIMEZONE || 'America/Santiago';
const TIMEOUT_CONSULTA_MS = parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000');

/**
 * C-02: SSL opcional. RDS PostgreSQL 15+ lo exige (rds.force_ssl). Con DB_SSL=true se
 * verifica el certificado contra el bundle de AWS (DB_SSL_CA = ruta del .pem).
 * Sin DB_SSL, igual que antes (BD local).
 */
function configuracionSsl() {
  if (process.env.DB_SSL !== 'true') return undefined;
  const ssl = { rejectUnauthorized: true };
  if (process.env.DB_SSL_CA) ssl.ca = fs.readFileSync(process.env.DB_SSL_CA, 'utf8');
  return ssl;
}

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'puertas_blindadas',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      configuracionSsl(),
  options:  `-c search_path=${SCHEMA} -c timezone=${ZONA_HORARIA} -c statement_timeout=${TIMEOUT_CONSULTA_MS}`,
  connectionTimeoutMillis: 10000, // C-04: sin BD, falla en 10 s en vez de esperar sin fin
  idleTimeoutMillis: 30000,
});

/* C-01: si la BD corta una conexión inactiva (reinicio o mantenimiento de RDS), pg emite
   'error' en el pool. Sin este manejador ese error termina el proceso de Node. El pool
   descarta la conexión rota y abre otra cuando haga falta. */
pool.on('error', (err) => {
  console.error('⚠️  Conexión inactiva con PostgreSQL perdida (el pool la reemplaza):', err.message);
});

// Verificar conexión al arrancar
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conectado a PostgreSQL');
    release();
  }
});

// Helper: una consulta con un cliente del pool (el search_path viene en la conexión, C-03)
async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
