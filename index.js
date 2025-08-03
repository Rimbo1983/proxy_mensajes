// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// —— Configuración ——
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;  
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;

// Flow namespaces
const FLOW_NS_MAP = {
  Face: 'content20250624124745_310388',
  Ig: 'content20250531215213_464672',
  default: 'content20250531215213_464672'
};
// Flow para pausar y reanudar automatizaciones
const PAUSE_FLOW_NS = 'content20250803191652_983164';
const RESUME_FLOW_NS = 'content20250803192542_067803';

// —— Estructuras en memoria ——
const subscriberName = {};           // subscriber_id → usuario
const subscriberPlatform = {};       // subscriber_id → plataforma
const blockedUsers = new Set();      // nombres de usuario bloqueados
const bufferUsuarios = {};           // buffers temporales por subscriber
let colaMensajes = [];               // cola de respuestas pendientes
const waitingUsuarios = new Set();   // espera de respuesta completa

// —— Middlewares ——
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// —— Endpoint Admin UI ——
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});

// —— Endpoint para bloquear usuario ——
app.post('/block', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  // 1) Marcamos como bloqueado
  blockedUsers.add(usuario);
  console.log(`🚫 Usuario bloqueado: ${usuario}`);

  // 2) Cancelar buffers pendientes
  Object.entries(subscriberName).forEach(([id, u]) => {
    if (u === usuario && bufferUsuarios[id]?.timer) {
      clearTimeout(bufferUsuarios[id].timer);
      delete bufferUsuarios[id];
      console.log(`🛑 Buffer cancelado para ${usuario} (${id})`);
    }
  });

  // 3) Purgar cola de mensajes
  colaMensajes = colaMensajes.filter(msg => {
    const u = subscriberName[msg.subscriber_id];
    if (u === usuario) {
      console.log(`🗑️ Mensaje en cola descartado para ${usuario} (${msg.subscriber_id})`);
      return false;
    }
    return true;
  });

  // 4) Disparar flow de pausa en ManyChat para cada subscriber_id
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
  const calls = Object.entries(subscriberName)
    .filter(([id, u]) => u === usuario)
    .map(([id]) => axios.post(url, { subscriber_id: id, flow_ns: PAUSE_FLOW_NS }, { headers })
      .then(() => console.log(`⏸️ Flow pausa enviado a ${id}`))
      .catch(err => console.error(`❌ Error pausar ${id}:`, err.response?.data || err.message))
    );
  await Promise.all(calls);

  res.send(`Usuario ${usuario} bloqueado y automatizaciones pausadas`);
});

// —— Endpoint para desbloquear usuario ——
app.post('/unblock', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  // 1) Quitamos del set de bloqueados
  blockedUsers.delete(usuario);
  console.log(`✅ Usuario desbloqueado: ${usuario}`);

  // 2) Disparar flow de reanudación en ManyChat
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
  const calls = Object.entries(subscriberName)
    .filter(([id, u]) => u === usuario)
    .map(([id]) => axios.post(url, { subscriber_id: id, flow_ns: RESUME_FLOW_NS }, { headers })
      .then(() => console.log(`▶️ Flow reanudar enviado a ${id}`))
      .catch(err => console.error(`❌ Error reanudar ${id}:`, err.response?.data || err.message))
    );
  await Promise.all(calls);

  res.send(`Usuario ${usuario} desbloqueado y automatizaciones reanudadas`);
});

// —— Endpoint ManyChat → proxy (agrupa y reenvía a Make) ——
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, teléfono, Plataforma } = req.body;
  if (!id || !mensaje) return res.status(400).send('Faltan datos');

  if (waitingUsuarios.has(id)) {
    console.log(`🛑 Ignorado ${id}, esperando respuesta`);
    return res.sendStatus(204);
  }

  // Guardamos nombre y plataforma
  subscriberName[id] = usuario;
  subscriberPlatform[id] = Plataforma;

  // Buffer por usuario
  if (!bufferUsuarios[id]) bufferUsuarios[id] = { mensajes: [], timer: null };
  bufferUsuarios[id].mensajes.push(mensaje.trim());

  if (!bufferUsuarios[id].timer) {
    bufferUsuarios[id].timer = setTimeout(async () => {
      const grouped = bufferUsuarios[id].mensajes.join('\n');
      try {
        await axios.post(MAKE_WEBHOOK_URL, { usuario, mensaje: grouped, id, teléfono, Plataforma });
        console.log(`📤 Enviado a Make: ${id} [${Plataforma}]`);
        waitingUsuarios.add(id);
        console.log(`⏳ ${id} en espera de respuesta.`);
      } catch (err) {
        console.error(`❌ Error enviando a Make ${id}:`, err.response?.data || err.message);
      }
      delete bufferUsuarios[id];
    }, 60000);
  }

  res.status(200).send('Mensaje recibido y agrupando...');
});

// —— Endpoint Make → proxy (recibe respuesta GPT y encola) ——
app.post('/respuesta-gpt', (req, res) => {
  const { subscriber_id, respuesta } = req.body;
  if (!subscriber_id || !respuesta) return res.status(400).send('Faltan campos');

  const usuario = subscriberName[subscriber_id];
  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Descarta respuesta para bloqueado ${usuario} (${subscriber_id})`);
    return res.status(200).send('Usuario bloqueado');
  }

  const plataforma = subscriberPlatform[subscriber_id] || 'default';
  colaMensajes.push({ subscriber_id, respuesta, plataforma });
  console.log(`📥 Encolado ${subscriber_id} [${plataforma}]: ${respuesta}`);
  res.send('Encolado OK');
});

// —— Procesador de cola (cada 2s) ——
setInterval(async () => {
  if (colaMensajes.length === 0) return;
  const { subscriber_id, respuesta, plataforma } = colaMensajes.shift();
  const usuario = subscriberName[subscriber_id];
  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Envío cancelado para bloqueado ${usuario} (${subscriber_id})`);
    return;
  }

  const flow_ns = FLOW_NS_MAP[plataforma] || FLOW_NS_MAP.default;
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };

  try {
    await axios.post('https://api.manychat.com/fb/subscriber/setCustomFieldByName', {
      subscriber_id,
      field_name: 'respuestaGPT',
      field_value: respuesta
    }, { headers });
    console.log(`✅ respuestaGPT guardado para ${subscriber_id}`);

    await axios.post('https://api.manychat.com/fb/sending/sendFlow', {
      subscriber_id,
      flow_ns
    }, { headers });
    console.log(`🚀 Flow ${flow_ns} lanzado a ${subscriber_id}`);

    if (waitingUsuarios.has(subscriber_id)) {
      waitingUsuarios.delete(subscriber_id);
      console.log(`🔄 ${subscriber_id} ya no está en espera.`);
    }
  } catch (err) {
    console.error(`❌ Error procesando ${subscriber_id}:`, err.response?.data || err.message);
  }
}, 2000);

// —— Página de estado ——
app.get('/', (req, res) => res.send('🟢 Proxy activo'));

app.listen(port, () => console.log(`🚀 Servidor activo en puerto ${port}`));
