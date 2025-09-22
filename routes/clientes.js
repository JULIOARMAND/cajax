const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const db = require('../config/db');
const Joi = require('joi');
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info', // Cambiado a 'info' para registrar más eventos
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

// Esquema de validación para query params
const clienteQuerySchema = Joi.object({
  search: Joi.string().allow('').optional(),
});

// Esquema de validación para el cuerpo
const clienteSchema = Joi.object({
  nombre: Joi.string().min(3).max(100).required(),
  dni: Joi.string().max(20).allow('', null).optional(),
  whatsapp: Joi.string().max(20).allow('', null).optional(),
  email: Joi.string().email().max(100).allow('', null).optional(),
});

// GET: Listar clientes
router.get('/', auth, async (req, res) => {
  const { error, value } = clienteQuerySchema.validate(req.query);
  if (error) {
    const errorMessage = error.details.map(detail => detail.message).join(', ');
    logger.error(`Validación fallida en GET /clientes: ${errorMessage}`, { user: req.user.id });
    return res.status(400).json({ success: false, message: errorMessage });
  }

  const { search } = value;
  try {
    let query = 'SELECT id, nombre, dni, whatsapp, email FROM clientes WHERE deleted_at IS NULL';
    let params = [];
    if (search) {
      query += ' AND (nombre LIKE ? OR dni LIKE ?)';
      params = [`%${search}%`, `%${search}%`];
    }
    query += ' ORDER BY nombre ASC';

    const [results] = await db.query(query, params);
    logger.info(`Clientes obtenidos: ${results.length}`, { user: req.user.id, search });
    res.json({ success: true, data: results, total: results.length });
  } catch (err) {
    logger.error(`Error obteniendo clientes: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, message: `Error al obtener clientes: ${err.message}` });
  }
});

// POST: Crear cliente
router.post('/', auth, async (req, res) => {
  const { error } = clienteSchema.validate(req.body, { abortEarly: false });
  if (error) {
    const errorMessage = error.details.map(detail => detail.message).join(', ');
    logger.error(`Validación fallida en POST /clientes: ${errorMessage}`, { user: req.user.id });
    return res.status(400).json({ success: false, message: errorMessage });
  }

  const { nombre, dni, whatsapp, email } = req.body;

  try {
    const [existing] = await db.query('SELECT id FROM clientes WHERE dni = ? AND deleted_at IS NULL', [dni || null]);
    if (existing.length > 0 && dni) {
      logger.warn(`Intento de crear cliente con DNI duplicado: ${dni}`, { user: req.user.id });
      return res.status(400).json({ success: false, message: 'El DNI ya está registrado' });
    }

    const [result] = await db.query(
      'INSERT INTO clientes (nombre, dni, whatsapp, email, created_at) VALUES (?, ?, ?, ?, NOW())',
      [nombre, dni || null, whatsapp || null, email || null]
    );
    logger.info(`Cliente creado: ${nombre}, ID: ${result.insertId}`, { user: req.user.id });
    res.json({ success: true, message: 'Cliente creado', data: { id: result.insertId, nombre, dni, whatsapp, email } });
  } catch (err) {
    logger.error(`Error creando cliente: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, message: `Error al crear cliente: ${err.message}` });
  }
});

// PUT: Actualizar cliente
router.put('/:id', auth, async (req, res) => {
  const { error } = clienteSchema.validate(req.body, { abortEarly: false });
  if (error) {
    const errorMessage = error.details.map(detail => detail.message).join(', ');
    logger.error(`Validación fallida en PUT /clientes/:id: ${errorMessage}`, { user: req.user.id });
    return res.status(400).json({ success: false, message: errorMessage });
  }

  const { nombre, dni, whatsapp, email } = req.body;
  const clienteId = parseInt(req.params.id);

  try {
    const [existing] = await db.query('SELECT id FROM clientes WHERE id = ? AND deleted_at IS NULL', [clienteId]);
    if (existing.length === 0) {
      logger.warn(`Cliente no encontrado: ${clienteId}`, { user: req.user.id });
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    const [dniDuplicate] = await db.query('SELECT id FROM clientes WHERE dni = ? AND id != ? AND deleted_at IS NULL', [dni || null, clienteId]);
    if (dniDuplicate.length > 0 && dni) {
      logger.warn(`Intento de actualizar cliente con DNI duplicado: ${dni}`, { user: req.user.id });
      return res.status(400).json({ success: false, message: 'El DNI ya está registrado' });
    }

    await db.query(
      'UPDATE clientes SET nombre = ?, dni = ?, whatsapp = ?, email = ?, updated_at = NOW() WHERE id = ?',
      [nombre, dni || null, whatsapp || null, email || null, clienteId]
    );
    logger.info(`Cliente actualizado: ${nombre}, ID: ${clienteId}`, { user: req.user.id });
    res.json({ success: true, message: 'Cliente actualizado', data: { id: clienteId, nombre, dni, whatsapp, email } });
  } catch (err) {
    logger.error(`Error actualizando cliente: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, message: `Error al actualizar cliente: ${err.message}` });
  }
});

// DELETE: Eliminar cliente (soft delete)
router.delete('/:id', auth, async (req, res) => {
  const clienteId = parseInt(req.params.id);

  try {
    const [existing] = await db.query('SELECT id FROM clientes WHERE id = ? AND deleted_at IS NULL', [clienteId]);
    if (existing.length === 0) {
      logger.warn(`Cliente no encontrado: ${clienteId}`, { user: req.user.id });
      return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
    }

    await db.query('UPDATE clientes SET deleted_at = NOW() WHERE id = ?', [clienteId]);
    logger.info(`Cliente eliminado: ID ${clienteId}`, { user: req.user.id });
    res.json({ success: true, message: 'Cliente eliminado', data: { id: clienteId } });
  } catch (err) {
    logger.error(`Error eliminando cliente: ${err.message}`, { user: req.user.id, stack: err.stack });
    res.status(500).json({ success: false, message: `Error al eliminar cliente: ${err.message}` });
  }
});

module.exports = router;