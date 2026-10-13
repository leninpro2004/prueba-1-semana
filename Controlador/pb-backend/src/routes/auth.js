const express = require('express');
const router  = express.Router();
const { login, cambiarPassword, solicitarRecuperacion, resetearPassword, me, sessionStatus, reautenticar } = require('../controllers/authController');
const { authMiddleware, soloOperativo } = require('../middleware/auth');

router.post('/login', login);
router.post('/cambiar-password', authMiddleware, cambiarPassword);
// B-01: usuario y rol de la sesión, siempre desde la BD
router.get('/me', authMiddleware, me);
// OPUS-8: estado de la cuenta para el cierre de sesion en vivo
router.get('/session-status', authMiddleware, sessionStatus);
// CU-42 y F-11: firma de un gerente (usuario y contraseña) para una acción sensible. La pide
// también el personal operativo (jop); firma solo un gerente.
router.post('/reautenticar', authMiddleware, soloOperativo, reautenticar);
// CU-77
router.post('/solicitar-recuperacion', solicitarRecuperacion);
router.post('/resetear-password', resetearPassword);

module.exports = router;
