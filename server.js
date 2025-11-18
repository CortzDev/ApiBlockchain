const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.static('public'));
app.use(express.json());


// Credenciales PostgreSQL 
const pool = new Pool({
  host: 'switchback.proxy.rlwy.net',
  port: 19460,
  database: 'railway',
  user: 'postgres',
  password: 'AVssGhMQQPLMTTbVzozjfCbFDODTfOUh',
  ssl: {
    rejectUnauthorized: false
  }
});

const DIFFICULTY = 4;
const TARGET = '0'.repeat(DIFFICULTY);

//SHA265
function calculateHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

//Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Blockchain Validator Server Running',
    timestamp: new Date().toISOString()
  });
});

//Información de la BC
app.get('/api/blockchain/info', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) as total_blocks FROM blockchain_blocks'
    );
    
    const lastBlock = await pool.query(
      'SELECT * FROM blockchain_blocks ORDER BY index_int DESC LIMIT 1'
    );

    res.json({
      success: true,
      totalBlocks: parseInt(result.rows[0].total_blocks),
      lastBlock: lastBlock.rows[0] || null,
      difficulty: DIFFICULTY
    });
  } catch (error) {
    console.error('Error getting blockchain info:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al obtener información de la blockchain' 
    });
  }
});

// Validar un bloque 
app.get('/api/block/:index/validate', async (req, res) => {
  try {
    const { index } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM blockchain_blocks WHERE index_int = $1',
      [index]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Bloque no encontrado' 
      });
    }

    const block = result.rows[0];
    const dataJson = typeof block.data_json === 'string' 
      ? JSON.parse(block.data_json) 
      : block.data_json;

    // Validar que el nonce almacenado coincida con el del JSON
    const isNonceValid = block.nonce.toString() === dataJson.nonce.toString();
    
    // Validar que el hash cumpla con la dificultad (si no es el génesis)
    const meetsTarget = block.index_int === 0 || block.hash.startsWith(TARGET);

    // Validar que el hash coincida
    const isHashValid = block.hash === dataJson.hash;

    res.json({
      success: true,
      block: {
        index: block.index_int,
        hash: block.hash,
        nonce: block.nonce.toString(),
        previousHash: block.prev_hash
      },
      validation: {
        nonceValid: isNonceValid,
        hashValid: isHashValid,
        meetsTarget: meetsTarget,
        isValid: isNonceValid && isHashValid && meetsTarget
      }
    });
  } catch (error) {
    console.error('Error validating block:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al validar bloque' 
    });
  }
});

// Validar nonce de un bloque (CORREGIDO)
app.post('/api/block/validate-nonce', async (req, res) => {
  try {
    const { index, nonce } = req.body;

    if (index === undefined || nonce === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: 'Se requieren los campos index y nonce' 
      });
    }

    const result = await pool.query(
      'SELECT nonce FROM blockchain_blocks WHERE index_int = $1',
      [index]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Bloque no encontrado' 
      });
    }

    const storedNonce = result.rows[0].nonce;
    
    // Convertir ambos valores a string para comparación segura
    const providedNonceStr = nonce.toString();
    const storedNonceStr = storedNonce.toString();
    
    const isValid = providedNonceStr === storedNonceStr;

    res.json({
      success: true,
      validation: {
        blockIndex: index,
        providedNonce: providedNonceStr,
        storedNonce: storedNonceStr,
        isValid: isValid
      }
    });
  } catch (error) {
    console.error('Error validating nonce:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al validar nonce',
      details: error.message
    });
  }
});

// Endpoint de debug (temporal - para diagnosticar problemas)
app.get('/api/block/:index/debug', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT nonce, pg_typeof(nonce) as nonce_type FROM blockchain_blocks WHERE index_int = $1',
      [req.params.index]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Bloque no encontrado' 
      });
    }
    
    const row = result.rows[0];
    res.json({
      success: true,
      debug: {
        rawNonce: row.nonce,
        nonceType: row.nonce_type,
        nonceAsString: row.nonce.toString(),
        nonceLength: row.nonce.toString().length,
        nonceTypeOf: typeof row.nonce
      }
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

//Validar toda la cadena
app.get('/api/blockchain/validate', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM blockchain_blocks ORDER BY index_int ASC'
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        isValid: false,
        error: 'No hay bloques en la blockchain'
      });
    }

    const issues = [];
    let previousHash = '0';

    for (let i = 0; i < result.rows.length; i++) {
      const block = result.rows[i];
      const dataJson = typeof block.data_json === 'string' 
        ? JSON.parse(block.data_json) 
        : block.data_json;

      // Validar índice
      if (block.index_int !== i) {
        issues.push(`Bloque #${i}: Índice inconsistente`);
      }

      // Validar previousHash
      if (block.prev_hash !== previousHash) {
        issues.push(`Bloque #${i}: previousHash no coincide con el hash anterior`);
      }

      // Validar nonce (corregido)
      if (block.nonce.toString() !== dataJson.nonce.toString()) {
        issues.push(`Bloque #${i}: Nonce no coincide`);
      }

      // Validar hash
      if (block.hash !== dataJson.hash) {
        issues.push(`Bloque #${i}: Hash no coincide`);
      }

      // Validar dificultad (excepto génesis)
      if (i > 0 && !block.hash.startsWith(TARGET)) {
        issues.push(`Bloque #${i}: No cumple con la dificultad requerida`);
      }

      previousHash = block.hash;
    }

    res.json({
      success: true,
      isValid: issues.length === 0,
      totalBlocks: result.rows.length,
      issues: issues.length > 0 ? issues : null
    });
  } catch (error) {
    console.error('Error validating blockchain:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al validar blockchain' 
    });
  }
});

//Obtener el último nonce
app.get('/api/blockchain/last-nonce', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT nonce, index_int FROM blockchain_blocks ORDER BY index_int DESC LIMIT 1'
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'No hay bloques en la blockchain' 
      });
    }

    res.json({
      success: true,
      lastNonce: result.rows[0].nonce.toString(),
      blockIndex: result.rows[0].index_int
    });
  } catch (error) {
    console.error('Error getting last nonce:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error al obtener último nonce' 
    });
  }
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Error interno del servidor' 
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Endpoints disponibles:`);
  console.log(`GET  /health - Health check`);
  console.log(`GET  /api/blockchain/info - Info de la blockchain`);
  console.log(`GET  /api/block/:index/validate - Validar bloque`);
  console.log(`POST /api/block/validate-nonce - Validar nonce`);
  console.log(`GET  /api/blockchain/validate - Validar cadena completa`);
  console.log(`GET  /api/blockchain/last-nonce - Obtener último nonce`);
  console.log(`GET  /api/block/:index/debug - Debug de nonce (temporal)`);
});