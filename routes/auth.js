const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db'); // Asegúrate de que esto apunte a tu conexión MySQL

// Cambia '/auth/login' a '/login' (quita el '/auth' extra)
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ msg: 'Email y contraseña son requeridos' });
    }

    const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (!users.length) {
      return res.status(401).json({ msg: 'Correo o contraseña incorrectos' });
    }

    const user = users[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ msg: 'Correo o contraseña incorrectos' });
    }

    const token = jwt.sign({ id: user.id, rol: user.rol }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        whatsapp: user.whatsapp,
      },
      token,
    });
  } catch (err) {
    console.error('Error en /login:', err);  // Actualiza el log para reflejar la nueva ruta
    res.status(500).json({ msg: 'Error del servidor' });
  }
});

// Para '/auth/me', cambia a '/me' si quieres consistencia (opcional, pero recomendado)
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ msg: 'No se proporcionó token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [users] = await db.query('SELECT id, nombre, email, rol, whatsapp FROM users WHERE id = ? AND deleted_at IS NULL', [decoded.id]);
    if (!users.length) {
      return res.status(401).json({ msg: 'Usuario no encontrado' });
    }

    res.json({
      user: users[0],
    });
  } catch (err) {
    console.error('Error en /me:', err);  // Actualiza el log
    res.status(401).json({ msg: 'Token inválido' });
  }
});

module.exports = router;


