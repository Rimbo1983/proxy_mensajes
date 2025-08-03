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
const subscriberIdsByName = {};        // usuario → set de subscriber_id
const blockedUsers        = new Set(); // usuarios bloqueados por nombre
const blockedIds          = new Set(); // subscriber_id bloqueados directamente
const bufferUsuarios      = {};        // buffers por usuario
let colaMensajes          = [];        // cola de respuestas pendientes
const waitingUsuarios     = new Set(); // usuarios que esperan respuesta

app.use(express.json());

// —— Bloquear usuario ——
app.post('/block', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  // Marcamos usuario bloqueado
  blockedUsers.add(usuario);
  console.log(`🚫 Usuario bloqueado: ${usuario}`);

  // Resolución de IDs para este usuario
  const ids = subscriberIdsByName[usuario] || [];
  ids.forEach(id => blockedIds.add(id));

  // Cancelar buffers y purgar cola por ID
  ids.forEach(id => {
    if (bufferUsuarios[id]?.timer) {
      clearTimeout(bufferUsuarios[id].timer);
      delete bufferUsuarios[id];
      console.log(`🛑 Buffer cancelado para ${usuario} (${id})`);
    }
  });
  colaMensajes = colaMensajes.filter(msg => {
    if (ids.includes(msg.subscriber_id)) {
      console.log(`🗑️ Mensaje en cola descartado para ${usuario} (${msg.subscriber_id})`);
      return false;
    }
    return true;
  });

  // Disparar flow de pausa en ManyChat para cada ID
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type':'application/json' };
  await Promise.all(ids.map(id =>
    axios.post(url, { subscriber_id: id, flow_ns: PAUSE_FLOW_NS }, { headers })
      .then(() => console.log(`⏸️ Flow pausa enviado a ${id}`))
      .catch(e => console.error(`❌ Error pausar ${id}`, e.response?.data || e.message))
  ));

  res.send(`Usuario ${usuario} bloqueado`);
});

// —— Desbloquear usuario ——
app.post('/unblock', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedUsers.delete(usuario);
  console.log(`✅ Usuario desbloqueado: ${usuario}`);

  // Desbloqueamos todos los IDs asociados
  const ids = subscriberIdsByName[usuario] || [];
  ids.forEach(id => blockedIds.delete(id));

  // Disparar flow de reanudación
  const url = 'https://api.manychat.com/fb/sending/sendFlow';
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type':'application/json' };
  await Promise.all(ids.map(id =>
    axios.post(url, { subscriber_id: id, flow_ns: RESUME_FLOW_NS }, { headers })
      .then(() => console.log(`▶️ Flow reanudar enviado a ${id}`))
      .catch(e => console.error(`❌ Error reanudar ${id}`, e.response?.data || e.message))
  ));

  res.send(`Usuario ${usuario} desbloqueado`);
});

// —— ManyChat → proxy (agrupa y reenvía a Make) ——
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, telefono, Plataforma } = req.body;
  if (!usuario || !mensaje || !id) return res.status(400).send('Faltan datos');

  // Asociar nombre a ID
  subscriberName[id] = usuario;
  subscriberIdsByName[usuario] = subscriberIdsByName[usuario] || [];
  if (!subscriberIdsByName[usuario].includes(id)) subscriberIdsByName[usuario].push(id);

  // Ignorar bloqueados por ID o nombre
  if (blockedUsers.has(usuario) || blockedIds.has(id)) {
    console.log(`🛑 Ignorado ${mensaje} de ${usuario} (${id})`);
    return res.status(200).send('Usuario bloqueado');
  }
  if (waitingUsuarios.has(id)) {
    console.log(`🛑 Ignorado ${id}, esperando respuesta`);
    return res.sendStatus(204);
  }

  // Buffer de mensajes
  if (!bufferUsuarios[id]) bufferUsuarios[id] = { mensajes: [], timer: null };
  bufferUsuarios[id].mensajes.push(mensaje.trim());

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
          { headers: { 'Content-Type':'application/json' } }
        );
        console.log(`📤 Enviado a Make: ${id}`);
        waitingUsuarios.add(id);
      } catch (e) {
        console.error(`❌ Error enviando a Make ${id}`, e.response?.data || e.message);
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
  if (blockedIds.has(subscriber_id) || blockedUsers.has(subscriberName[subscriber_id])) {
    console.log(`🛑 Descarta respuesta de bloqueado ${subscriberName[subscriber_id]} (${subscriber_id})`);
    return res.status(200).send('Usuario bloqueado');
  }

  const plataforma = subscriberPlatform[subscriber_id] || 'default';
  colaMensajes.push({ subscriber_id, respuesta, plataforma });
  console.log(`📥 Encolado ${subscriber_id}`);
  res.send('Encolado');
});

// —— Procesador de cola (cada 2s) ——
setInterval(async () => {
  if (!colaMensajes.length) return;
  const { subscriber_id, respuesta, plataforma } = colaMensajes.shift();

  if (blockedIds.has(subscriber_id) || blockedUsers.has(subscriberName[subscriber_id])) {
    console.log(`🛑 Envío cancelado para bloqueado ${subscriberName[subscriber_id]} (${subscriber_id})`);
    return;
  }

  const flow_ns = FLOW_NS_MAP[plataforma] || FLOW_NS_MAP.default;
  const headers = { Authorization: `Bearer ${MANYCHAT_API_KEY}`, 'Content-Type':'application/json' };

  try {
    await axios.post('https://api.manychat.com/fb/subscriber/setCustomFieldByName',
      { subscriber_id, field_name:'respuestaGPT', field_value:respuesta },
      { headers }
    );
    await axios.post('https://api.manychat.com/fb/sending/sendFlow', { subscriber_id, flow_ns }, { headers });
    console.log(`🚀 Flow ${flow_ns} enviado a ${subscriber_id}`);
    waitingUsuarios.delete(subscriber_id);
  } catch (e) {
    console.error(`❌ Error procesando ${subscriber_id}`, e.response?.data || e.message);
  }
}, 2000);

// —— Página de estado ——
app.get('/', (req, res) => res.send('🟢 Proxy activo'));

app.listen(port, () => console.log(`🚀 Servidor activo en puerto ${port}`));
