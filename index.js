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

// —— Estructuras de datos ——
const subscriberName      = {};        // subscriber_id → usuario
const subscriberIdsByName = {};        // usuario → array de subscriber_id
const subscriberPlatform  = {};        // subscriber_id → plataforma
const blockedUsers        = new Set(); // usuarios bloqueados por nombre
const blockedIds          = new Set(); // subscriber_id bloqueados directamente
const bufferUsuarios      = {};        // buffers de mensajes por subscriber_id
let colaMensajes          = [];        // cola de respuestas pendientes a ManyChat
const waitingUsuarios     = new Set(); // subscriber_id que esperan respuesta completa

app.use(express.json());

// —— Bloquear usuario ——
app.post('/block', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedUsers.add(usuario);
  console.log(`🚫 Usuario bloqueado: ${usuario}`);

  // Bloquear todos los IDs asociados
  const ids = subscriberIdsByName[usuario] || [];
  ids.forEach(id => blockedIds.add(id));

  // Cancelar buffers y purgar cola para esos IDs
  ids.forEach(id => {
    if (bufferUsuarios[id]?.timer) {
      clearTimeout(bufferUsuarios[id].timer);
      delete bufferUsuarios[id];
      console.log(`🛑 Buffer cancelado para ${usuario} (${id})`);
    }
  });
  colaMensajes = colaMensajes.filter(msg => !blockedIds.has(msg.subscriber_id));

  // Disparar flow de pausa en ManyChat
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
  await Promise.all(ids.map(id =>
    axios.post(url, { subscriber_id: id, flow_ns: PAUSE_FLOW_NS }, { headers })
      .then(() => console.log(`⏸️ Flow pausa enviado a ${id}`))
      .catch(err => console.error(`❌ Error pausar ${id}:`, err.response?.data || err.message))
  ));

  res.send(`Usuario ${usuario} bloqueado`);
});

// —— Desbloquear usuario ——
app.post('/unblock', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedUsers.delete(usuario);
  console.log(`✅ Usuario desbloqueado: ${usuario}`);

  const ids = subscriberIdsByName[usuario] || [];
  ids.forEach(id => blockedIds.delete(id));

  // Disparar flow de reanudación en ManyChat
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type': 'application/json' };
  await Promise.all(ids.map(id =>
    axios.post(url, { subscriber_id: id, flow_ns: RESUME_FLOW_NS }, { headers })
      .then(() => console.log(`▶️ Flow reanudar enviado a ${id}`))
      .catch(err => console.error(`❌ Error reanudar ${id}:`, err.response?.data || err.message))
  ));

  res.send(`Usuario ${usuario} desbloqueado`);
});

// —— ManyChat → proxy (agrupa y reenvía a Make) ——
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, telefono, Plataforma } = req.body;
  if (!usuario || !mensaje || !id) return res.status(400).send('Faltan datos');

  // Mapear estado del subscriber
  subscriberName[id] = usuario;
  subscriberPlatform[id] = Plataforma;
  subscriberIdsByName[usuario] = subscriberIdsByName[usuario] || [];
  if (!subscriberIdsByName[usuario].includes(id)) subscriberIdsByName[usuario].push(id);

  // Ignorar bloqueados por nombre o ID
  if (blockedUsers.has(usuario) || blockedIds.has(id)) {
    console.log(`🛑 Ignorado mensaje de bloqueado ${usuario} (${id})`);
    return res.status(200).send('Usuario bloqueado');
  }

  // Ignorar si está esperando
  if (waitingUsuarios.has(id)) {
    console.log(`🛑 Ignorado ${id}, esperando respuesta`);
    return res.sendStatus(204);
  }

  // Buffer de mensajes
  if (!bufferUsuarios[id]) bufferUsuarios[id] = { mensajes: [], timer: null };
  bufferUsuarios[id].mensajes.push(mensaje.trim());

  // Lanzar timer si no existe
  if (!bufferUsuarios[id].timer) {
    bufferUsuarios[id].timer = setTimeout(async () => {
      const grouped = bufferUsuarios[id].mensajes.join('\n');
      delete bufferUsuarios[id];

      // Segundo chequeo de bloqueo
      if (blockedUsers.has(usuario) || blockedIds.has(id)) {
        console.log(`🛑 Buffer descartado para bloqueado ${usuario} (${id})`);
        return;
      }

      try {
        await axios.post(MAKE_WEBHOOK_URL,
          { usuario, mensaje: grouped, id, telefono, Plataforma },
          { headers: { 'Content-Type': 'application/json' } }
        );
        console.log(`📤 Enviado a Make: ${id}`);
        waitingUsuarios.add(id);
      } catch (err) {
        console.error(`❌ Error enviando a Make ${id}:`, err.response?.data || err.message);
      }
    }, 60000);
  }

  res.send('Mensaje recibido y agrupando');
});

// —— Make → proxy (recibe respuesta GPT y encola) ——
app.post('/respuesta-gpt', (req, res) => {
  const { subscriber_id, respuesta } = req.body;
  if (!subscriber_id || !respuesta) return res.status(400).send('Faltan campos');

  // Ignorar bloqueados
  const usuario = subscriberName[subscriber_id];
  if (blockedUsers.has(usuario) || blockedIds.has(subscriber_id)) {
    console.log(`🛑 Descarta respuesta de bloqueado ${usuario} (${subscriber_id})`);
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
  if (blockedUsers.has(usuario) || blockedIds.has(subscriber_id)) {
    console.log(`🛑 Envío cancelado para bloqueado ${usuario} (${subscriber_id})`);
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
  } catch (err) {
    console.error(`❌ Error procesando ${subscriber_id}:`, err.response?.data || err.message);
  }
}, 2000);

// —— Página de estado ——
app.get('/', (req, res) => res.send('🟢 Proxy activo'));

app.listen(port, () => console.log(`🚀 Servidor activo en puerto ${port}`));
