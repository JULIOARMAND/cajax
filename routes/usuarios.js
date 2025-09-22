const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const Joi = require('joi');

// Esquema de validación
const userSchema = Joi.object({
  nombre: Joi.string().min(3).max(100).required(),
  email: Joi.string().email().required(),
  whatsapp: Joi.string().max(20).optional().allow(null, ''),
  password: Joi.string().min(6).when('isEdit', { is: true, then: Joi.optional().allow(''), otherwise: Joi.required() }),
  rol: Joi.string().valid('Admin', 'Cajero', 'Auditor').required(),
});

// GET: Listar usuarios (con paginación básica)
router.get('/', auth, async (req, res) => {
  if (req.user.rol !== 'Admin') return res.status(403).json({ success: false, message: 'Acceso denegado' });

  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [results] = await db.query(
      'SELECT id, nombre, email, whatsapp, rol FROM users WHERE deleted_at IS NULL LIMIT ? OFFSET ?',
      [limit, offset]
    );
    res.json({ success: true, data: results });
  } catch (err) {
    console.error('❌ Error obteniendo usuarios:', err);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
  }
});

// POST: Crear usuario
router.post('/', auth, async (req, res) => {
  if (req.user.rol !== 'Admin') return res.status(403).json({ success: false, message: 'Acceso denegado' });

  const { error } = userSchema.validate({ ...req.body, isEdit: false });
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });

  const { nombre, email, whatsapp, password, rol } = req.body;

  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [email]);
    if (existing.length > 0) return res.status(400).json({ success: false, message: 'Email ya registrado' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO users (nombre, email, whatsapp, password_hash, rol, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [nombre, email, whatsapp || null, hashedPassword, rol]
    );
    res.json({ success: true, message: 'Usuario creado', data: { id: result.insertId } });
  } catch (err) {
    console.error('❌ Error creando usuario:', err);
    res.status(500).json({ success: false, message: 'Error al crear usuario' });
  }
});

// PUT: Actualizar usuario
router.put('/:id', auth, async (req, res) => {
  if (req.user.rol !== 'Admin') return res.status(403).json({ success: false, message: 'Acceso denegado' });

  const { error } = userSchema.validate({ ...req.body, isEdit: true });
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });

  const { nombre, email, whatsapp, password, rol } = req.body;
  const userId = parseInt(req.params.id);

  try {
    const [existing] = await db.query('SELECT id, rol FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    // Seguridad: No permitir cambiar último Admin
    if (existing[0].rol === 'Admin' && rol !== 'Admin') {
      const [admins] = await db.query('SELECT COUNT(*) as count FROM users WHERE rol = "Admin" AND deleted_at IS NULL');
      if (admins[0].count <= 1) return res.status(400).json({ success: false, message: 'No puedes degradar el último Admin' });
    }

    const [emailCheck] = await db.query('SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL', [email, userId]);
    if (emailCheck.length > 0) return res.status(400).json({ success: false, message: 'Email ya registrado' });

    let query = 'UPDATE users SET nombre = ?, email = ?, whatsapp = ?, rol = ?';
    let params = [nombre, email, whatsapp || null, rol];
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      query += ', password_hash = ?';
      params.push(hashedPassword);
    }
    query += ' WHERE id = ?';
    params.push(userId);

    await db.query(query, params);
    res.json({ success: true, message: 'Usuario actualizado' });
  } catch (err) {
    console.error('❌ Error actualizando usuario:', err);
    res.status(500).json({ success: false, message: 'Error al actualizar usuario' });
  }
});

// DELETE: Eliminar usuario (soft delete)
router.delete('/:id', auth, async (req, res) => {
  if (req.user.rol !== 'Admin') return res.status(403).json({ success: false, message: 'Acceso denegado' });

  const userId = parseInt(req.params.id);
  if (userId === req.user.id) return res.status(400).json({ success: false, message: 'No puedes eliminarte a ti mismo' });

  try {
    const [existing] = await db.query('SELECT id, rol FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    // Seguridad: No eliminar último Admin
    if (existing[0].rol === 'Admin') {
      const [admins] = await db.query('SELECT COUNT(*) as count FROM users WHERE rol = "Admin" AND deleted_at IS NULL');
      if (admins[0].count <= 1) return res.status(400).json({ success: false, message: 'No puedes eliminar el último Admin' });
    }

    await db.query('UPDATE users SET deleted_at = NOW() WHERE id = ?', [userId]);
    res.json({ success: true, message: 'Usuario eliminado' });
  } catch (err) {
    console.error('❌ Error eliminando usuario:', err);
    res.status(500).json({ success: false, message: 'Error al eliminar usuario' });
  }
});

module.exports = router;