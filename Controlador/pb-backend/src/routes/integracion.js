const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/integracionController');
const { authMiddleware } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

// CU-108: la precondicion pide administrador y el actor es Gerencia → ambos
function soloGerenciaOAdmin(req, res, next) {
  if (!['gerencia', 'administrador'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y administración' });
  }
  next();
}

router.use(authMiddleware);

router.get('/reglas', soloGerenciaOAdmin, ctrl.listarReglas);      // CU-108
router.post('/reglas', soloGerenciaOAdmin, requiereFirma('reglas_integracion'), ctrl.crearRegla);       // CU-108 Exc 2
router.put('/reglas', soloGerenciaOAdmin, requiereFirma('reglas_integracion'), ctrl.actualizarRegla);   // CU-108 Exc 3
router.delete('/reglas', soloGerenciaOAdmin, requiereFirma('reglas_integracion'), ctrl.eliminarRegla);  // CU-108: corregir una regla creada por error

// CU-107: sin filtro de rol aquí; lo decide la regla de CU-108 (Exc 1)
router.post('/movimientos', ctrl.registrarMovimiento);

// CU-106: consulta de stock; basta la sesión (token del login común), sin regla de CU-108
router.get('/stock', ctrl.consultarStock);

module.exports = router;
