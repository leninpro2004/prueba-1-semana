const express = require('express');
const router  = express.Router();
const { login, cambiarPassword, solicitarRecuperacion, resetearPassword, sessionStatus, reautenticar } = require('../controllers/authController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

router.post('/login', login);
router.post('/cambiar-password', authMiddleware, cambiarPassword);
// OPUS-8: estado de la cuenta para el cierre de sesion en vivo
router.get('/session-status', authMiddleware, sessionStatus);
// CU-42: reautenticación antes de revertir un movimiento
router.post('/reautenticar', authMiddleware, soloGerencia, reautenticar);
// CU-77
router.post('/solicitar-recuperacion', solicitarRecuperacion);
router.post('/resetear-password', resetearPassword);

module.exports = router;
