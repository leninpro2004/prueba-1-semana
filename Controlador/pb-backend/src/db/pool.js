const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'puertas_blindadas',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Verificar conexión al arrancar
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conectado a PostgreSQL');
    // Establecer schema por defecto para todas las queries
    client.query(`SET search_path TO ${process.env.DB_SCHEMA || 'inventario'}`, (err) => {
      release();
      if (err) console.error('❌ Error seteando schema:', err.message);
    });
  }
});

// Helper: ejecuta query con search_path siempre seteado
async function query(text, params) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${process.env.DB_SCHEMA || 'inventario'}`);
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

module.exports = { pool, query };
