const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// —— Configuración —— //
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';
const MANYCHAT_API_KEY = '807862065951550:771c99826f7011f4d47ab018e4207b60';

// Mapa de Flows por plataforma
const FLOW_NS_MAP = {
  Face: 'content20250624124745_310388',   // Flow Messenger
  Ig:   'content20250531215213_464672',   // Flow Instagram
  default: 'content20250531215213_464672' // fallback
};

app.use(bodyParser.json());

// —— Estructuras de datos —— //

// Buffer de mensajes entrantes por usuario
const bufferUsuarios = {};

// Cola de respuestas pendientes de envío a ManyChat
const colaMensajes = [];

// Mapa temporal subscriber_id → plataforma
const subscriberPlatform = {};


// —— Procesador de cola (cada 2 segundos) —— //
setInterval(async () => {
  if (colaMensajes.length === 0) return;

  const { subscriber_id, respuesta, plataforma } = colaMensajes.shift();
  const flow_ns = FLOW_NS_MAP[plataforma] || FLOW_NS_MAP.default;

  try {
    // 1) Guardar custom field
    await axios.post(
      'https://api.manychat.com/fb/subscriber/setCustomFieldByName',
      {
        subscriber_id,
        field_name: 'respuestaGPT',
        field_value: respuesta
      },
      {
        headers: {
          Authorization: `Bearer ${MANYCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`✅ respuestaGPT guardado para ${subscriber_id}`);

    // 2) Disparar flow correspondiente
    await axios.post(
      'https://api.manychat.com/fb/sending/sendFlow',
      {
        subscriber_id,
        flow_ns
      },
      {
        headers: {
          Authorization: `Bearer ${MANYCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🚀 Flow ${flow_ns} lanzado a ${subscriber_id}`);
  } catch (err) {
    console.error(`❌ Error procesando ${subscriber_id}:`, err.response?.data || err.message);
  }
}, 2000);


// —— Endpoint ManyChat → proxy (agrupa y reenvía a Make) —— //
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, teléfono, Plataforma } = req.body;

  if (!id || !mensaje) {
    return res.status(400).send('Faltan datos');
  }

  // Guarda la plataforma elegida por este subscriber
  subscriberPlatform[id] = Plataforma;

  // Inicializa buffer si hace falta
  if (!bufferUsuarios[id]) {
    bufferUsuarios[id] = { mensajes: [], timer: null };
  }

  bufferUsuarios[id].mensajes.push(mensaje.trim());

  // Si no había timer, lo arrancamos
  if (!bufferUsuarios[id].timer) {
    bufferUsuarios[id].timer = setTimeout(async () => {
      const mensajesAgrupados = bufferUsuarios[id].mensajes.join('\n');
      try {
        await axios.post(MAKE_WEBHOOK_URL, {
          usuario,
          mensaje: mensajesAgrupados,
          id,
          teléfono,
          Plataforma
        });
        console.log(`📤 Enviado a Make: ${id} [${Plataforma}]\n${mensajesAgrupados}`);
      } catch (err) {
        console.error(`❌ Error enviando a Make ${id}:`, err.response?.data || err.message);
      }
      delete bufferUsuarios[id];
    }, 60000);
  }

  res.status(200).send('Mensaje recibido y agrupando...');
});


// —— Endpoint Make → proxy (recibe respuesta GPT y encola) —— //
app.post('/respuesta-gpt', (req, res) => {
  const { subscriber_id, respuesta } = req.body;
  const plataforma = subscriberPlatform[subscriber_id] || 'default';

  if (!subscriber_id || !respuesta) {
    return res.status(400).send('Faltan campos requeridos');
  }

  colaMensajes.push({ subscriber_id, respuesta, plataforma });
  console.log(`📥 Encolado ${subscriber_id} [${plataforma}]: ${respuesta}`);
  res.send('Encolado OK');
});


// —— Página de estado —— //
app.get('/', (req, res) => {
  res.send('🟢 Proxy activo');
});

app.listen(port, () => {
  console.log(`🚀 Servidor activo en puerto ${port}`);
});
