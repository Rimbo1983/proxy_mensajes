// index.js
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// —— Configuración ——
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';
const MANYCHAT_API_KEY = '807862065951550:771c99826f7011f4d47ab018e4207b60';

// Flow namespaces
const FLOW_NS_MAP = {
  Face: 'content20250624124745_310388',
  Ig:   'content20250531215213_464672',
  default: 'content20250531215213_464672'
};
// Flow para pausar y reanudar automatizaciones
const PAUSE_FLOW_NS  = 'content20250803191652_983164';
const RESUME_FLOW_NS = 'content20250803192542_067803';

// —— Estructuras en memoria ——
const subscriberName     = {};        // subscriber_id → usuario
const subscriberPlatform = {};        // subscriber_id → plataforma
const blockedUsers       = new Set(); // nombres de usuario bloqueados
const bufferUsuarios     = {};        // buffers temporales por subscriber
let colaMensajes         = [];        // cola de respuestas pendientes
const waitingUsuarios    = new Set(); // espera de respuesta completa

// Detección de carpeta pública
let publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) publicDir = path.join(__dirname, '..', 'public');
console.log('▶️ Sirviendo estáticos desde:', publicDir);

// —— Middlewares ——
app.use(express.json());
app.use(express.static(publicDir));

// —— Endpoint Admin UI ——
app.get('/admin', (req, res) => {
  res.type('html');
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// —— Endpoint para bloquear usuario ——
app.post('/block', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');
  blockedUsers.add(usuario);
  console.log(`🚫 Usuario bloqueado: ${usuario}`);
  // Cancelar buffers y purgar cola (idéntico a antes)…
  // … código de pausa de flow …
  res.send(`Usuario ${usuario} bloqueado y automatizaciones pausadas`);
});

// —— Endpoint para desbloquear usuario ——
app.post('/unblock', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');
  blockedUsers.delete(usuario);
  console.log(`✅ Usuario desbloqueado: ${usuario}`);
  // Código de reanudación de flow…
  res.send(`Usuario ${usuario} desbloqueado y automatizaciones reanudadas`);
});

// —— Endpoint ManyChat → proxy ——
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, teléfono, Plataforma } = req.body;
  if (!id || !mensaje) return res.status(400).send('Faltan datos');
  // **Ignorar usuarios bloqueados**
  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Ignorado mensaje de bloqueado ${usuario} (${id})`);
    return res.status(200).send('Usuario bloqueado');
  }
  if (waitingUsuarios.has(id)) {
    console.log(`🛑 Ignorado ${id}, esperando respuesta`);
    return res.sendStatus(204);
  }
  subscriberName[id]     = usuario;
  subscriberPlatform[id] = Plataforma;
  if (!bufferUsuarios[id]) bufferUsuarios[id] = { mensajes: [], timer: null };
  bufferUsuarios[id].mensajes.push(mensaje.trim());
  if (!bufferUsuarios[id].timer) {
    bufferUsuarios[id].timer = setTimeout(async () => {
      const grouped = bufferUsuarios[id].mensajes.join('\n');
      // Chequeo adicional antes de enviar a Make
      if (blockedUsers.has(usuario)) {
        console.log(`🛑 Buffer descartado para bloqueado ${usuario} (${id})`);
        delete bufferUsuarios[id];
        return;
      }
      try {
        await axios.post(MAKE_WEBHOOK_URL, { usuario, mensaje: grouped, id, teléfono, Plataforma });
        console.log(`📤 Enviado a Make: ${id}`);
        waitingUsuarios.add(id);
      } catch (e) {
        console.error(`❌ Error enviando a Make ${id}:`, e.response?.data || e.message);
      }
      delete bufferUsuarios[id];
    }, 60000);
  }
  res.status(200).send('Mensaje recibido y agrupando...');
});

// —— Endpoint Make → proxy ——
app.post('/respuesta-gpt', (req, res) => {
  const { subscriber_id, respuesta } = req.body;
  if (!subscriber_id || !respuesta) return res.status(400).send('Faltan campos');
  const usuario = subscriberName[subscriber_id];
  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Descarta respuesta para bloqueado ${usuario}`);
    return res.status(200).send('Usuario bloqueado');
  }
  const plataforma = subscriberPlatform[subscriber_id] || 'default';
  colaMensajes.push({ subscriber_id, respuesta, plataforma });
  console.log(`📥 Encolado ${subscriber_id}: ${respuesta}`);
  res.send('Encolado OK');
});

// —— Procesador de cola — cada 2s
setInterval(async () => {
  if (colaMensajes.length === 0) return;
  const { subscriber_id, respuesta, plataforma } = colaMensajes.shift();
  const usuario = subscriberName[subscriber_id];
  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Envío cancelado para bloqueado ${usuario}`);
    return;
  }
  const flow_ns = FLOW_NS_MAP[plataforma] || FLOW_NS_MAP.default;
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
  try {
    await axios.post('https://api.manychat.com/fb/subscriber/setCustomFieldByName',
      { subscriber_id, field_name: 'respuestaGPT', field_value: respuesta },
      { headers }
    );
    await axios.post('https://api.manychat.com/fb/sending/sendFlow', { subscriber_id, flow_ns }, { headers });
    console.log(`🚀 Flow ${flow_ns} enviado a ${subscriber_id}`);
    waitingUsuarios.delete(subscriber_id);
  } catch (e) {
    console.error(`❌ Error procesando ${subscriber_id}:`, e.response?.data || e.message);
  }
}, 2000);

// —— Página de estado ——
app.get('/', (req, res) => res.send('🟢 Proxy activo'));

app.listen(port, () => console.log(`🚀 Servidor activo en puerto ${port}`));
