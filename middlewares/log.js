const db = require('../config/db');

module.exports = (req, res, next) => {
  if (req.user) {
    const accion = `${req.method} en ${req.originalUrl}`;
    db.query('INSERT INTO actividad_log (usuario_id, accion) VALUES (?, ?)', [req.user.id, accion]);
  }
  next();
};