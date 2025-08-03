// index.js
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// —— Configuración ——
const MAKE_WEBHOOK_URL  = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';
const MANYCHAT_API_KEY  = '807862065951550:771c99826f7011f4d47ab018e4207b60';

// Flow namespaces
const FLOW_NS_MAP = {
  Face:    'content20250624124745_310388',
  Ig:      'content20250531215213_464672',
  default: 'content20250531215213_464672'
};

// Flows para pausar y reanudar automatizaciones
const PAUSE_FLOW_NS  = 'content20250803191652_983164';
const RESUME_FLOW_NS = 'content20250803192542_067803';

// —— Estructuras en memoria ——
const subscriberName     = {};        // subscriber_id → usuario
const subscriberPlatform = {};        // subscriber_id → plataforma
const blockedUsers       = new Set(); // usuarios bloqueados
const bufferUsuarios     = {};        // buffers por usuario
let colaMensajes         = [];        // cola de respuestas pendientes
const waitingUsuarios    = new Set(); // usuarios que esperan respuesta completa

// —— Middlewares ——
app.use(express.json());

// —— Bloquear usuario ——
app.post('/block', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedUsers.add(usuario);
  console.log(`🚫 Usuario bloqueado: ${usuario}`);

  // Cancelar buffers
  for (const [id, buf] of Object.entries(bufferUsuarios)) {
    if (subscriberName[id] === usuario && buf.timer) {
      clearTimeout(buf.timer);
      delete bufferUsuarios[id];
      console.log(`🛑 Buffer cancelado para ${usuario} (${id})`);
    }
  }

  // Purgar colaMensajes
  colaMensajes = colaMensajes.filter(msg => {
    if (subscriberName[msg.subscriber_id] === usuario) {
      console.log(`🗑️ Mensaje en cola descartado para ${usuario} (${msg.subscriber_id})`);
      return false;
    }
    return true;
  });

  // Disparar flow de pausa en ManyChat
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type':'application/json' };
  await Promise.all(
    Object.entries(subscriberName)
      .filter(([id, u]) => u === usuario)
      .map(([id]) =>
        axios.post(url, { subscriber_id: id, flow_ns: PAUSE_FLOW_NS }, { headers })
          .then(() => console.log(`⏸️ Flow pausa enviado a ${id}`))
          .catch(err => console.error(`❌ Error pausar ${id}:`, err.response?.data || err.message))
      )
  );

  res.send(`Usuario ${usuario} bloqueado y pausado`);
});

// —— Desbloquear usuario ——
app.post('/unblock', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedUsers.delete(usuario);
  console.log(`✅ Usuario desbloqueado: ${usuario}`);

  // Disparar flow de reanudación en ManyChat
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type':'application/json' };
  await Promise.all(
    Object.entries(subscriberName)
      .filter(([id, u]) => u === usuario)
      .map(([id]) =>
        axios.post(url, { subscriber_id: id, flow_ns: RESUME_FLOW_NS }, { headers })
          .then(() => console.log(`▶️ Flow reanudar enviado a ${id}`))
          .catch(err => console.error(`❌ Error reanudar ${id}:`, err.response?.data || err.message))
      )
  );

  res.send(`Usuario ${usuario} desbloqueado y reanudado`);
});

// —— ManyChat → proxy (agrupa y reenvía a Make) ——
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, telefono, Plataforma } = req.body;

  // Validación
  if (!usuario || !mensaje || !id) return res.status(400).send('Faltan datos');

  // Ignorar bloqueados
  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Ignorado mensaje de bloqueado ${usuario} (${id})`);
    return res.status(200).send('Usuario bloqueado');
  }

  // Ignorar mientras espera
  if (waitingUsuarios.has(id)) {
    console.log(`🛑 Ignorado ${id}, esperando respuesta`);
    return res.sendStatus(204);
  }

  subscriberName[id]     = usuario;
  subscriberPlatform[id] = Plataforma;

  // Buffer de mensajes para agrupar
  if (!bufferUsuarios[id]) bufferUsuarios[id] = { mensajes: [], timer: null };
  bufferUsuarios[id].mensajes.push(mensaje.trim());

  // Lanzar timer si no existe
  if (!bufferUsuarios[id].timer) {
    bufferUsuarios[id].timer = setTimeout(async () => {
      const grouped = bufferUsuarios[id].mensajes.join('\n');

      // Re-chequeo bloqueo
      if (blockedUsers.has(usuario)) {
        console.log(`🛑 Buffer descartado para bloqueado ${usuario} (${id})`);
        delete bufferUsuarios[id];
        return;
      }

      try {
        await axios.post(MAKE_WEBHOOK_URL, { usuario, mensaje: grouped, id, telefono, Plataforma },
          { headers: { 'Content-Type':'application/json' } }
        );
        console.log(`📤 Enviado a Make: ${id}`);
        waitingUsuarios.add(id);
      } catch (err) {
        console.error(`❌ Error enviando a Make ${id}:`, err.response?.data || err.message);
      }

      delete bufferUsuarios[id];
    }, 60000);
  }

  res.send('Mensaje recibido');
});

// —— Make → proxy (recibe respuesta GPT y encola) ——
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
  console.log(`📥 Encolado ${subscriber_id}`);
  res.send('Encolado');
});

// —— Procesador de cola (cada 2s) ——
setInterval(async () => {
  if (colaMensajes.length === 0) return;
  const { subscriber_id, respuesta, plataforma } = colaMensajes.shift();
  const usuario = subscriberName[subscriber_id];

  if (blockedUsers.has(usuario)) {
    console.log(`🛑 Envío cancelado para bloqueado ${usuario}`);
    return;
  }

  const flow_ns = FLOW_NS_MAP[plataforma] || FLOW_NS_MAP.default;
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type':'application/json' };

  try {
    await axios.post('https://api.manychat.com/fb/subscriber/setCustomFieldByName', {
      subscriber_id,
      field_name: 'respuestaGPT',
      field_value: respuesta
    }, { headers });

    await axios.post('https://api.manychat.com/fb/sending/sendFlow', { subscriber_id, flow_ns }, { headers });
    console.log(`🚀 Flow ${flow_ns} enviado a ${subscriber_id}`);

    waitingUsuarios.delete(subscriber_id);
  } catch (err) {
    console.error(`❌ Error procesando ${subscriber_id}:`, err.response?.data || err.message);
  }
}, 2000);

// —— Página de estado ——
app.get('/', (req, res) => res.send('🟢 Proxy activo'));

app.listen(port, () => console.log(`🚀 Servidor activo en puerto ${port}`));
