const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const mysqldump = require('mysqldump');
const path = require('path');
const fs = require('fs');

router.get('/', auth, async (req, res) => {
  try {
    const backupPath = path.join(__dirname, '..', 'backups', `backup-${Date.now()}.sql`);
    await mysqldump({
      connection: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
      },
      dumpToFile: backupPath,
    });
    res.json({ msg: 'Backup creado', path: backupPath });
  } catch (err) {
    res.status(500).json({ msg: 'Error al crear backup', error: err.message });
  }
});

module.exports = router;