const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// CONFIGURACIÓN
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';
const MANYCHAT_API_KEY = '807862065951550:771c99826f7011f4d47ab018e4207b60';
const FLOW_NS = 'content20250531215213_464672'; // Flow que usará {{user.respuestaGPT}}

app.use(bodyParser.json());

// 🧠 Cola de procesamiento
const colaMensajes = [];

// ⏱️ Procesador de cola (cada 2 segundos)
setInterval(async () => {
  if (colaMensajes.length === 0) return;

  const { subscriber_id, respuesta } = colaMensajes.shift(); // Tomar el primero

  try {
    // 1. Guardar en campo personalizado
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
    console.log(`✅ Campo respuestaGPT guardado para ${subscriber_id}`);

    // 2. Lanzar flow
    await axios.post(
      'https://api.manychat.com/fb/sending/sendFlow',
      {
        subscriber_id,
        flow_ns: FLOW_NS
      },
      {
        headers: {
          Authorization: `Bearer ${MANYCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`🚀 Flow lanzado a ${subscriber_id}`);
  } catch (error) {
    console.error(`❌ Error al procesar ${subscriber_id}:`, error.response?.data || error.message);
  }
}, 2000);

// 1. ManyChat → Make (reenviar mensaje)
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('📩 Mensaje recibido desde ManyChat:', data);
    await axios.post(MAKE_WEBHOOK_URL, data);
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error al reenviar a Make:', error.message);
    res.status(500).send('Error interno');
  }
});

// 2. Make → proxy (respuesta GPT → cola)
app.post('/respuesta-gpt', (req, res) => {
  const { subscriber_id, respuesta } = req.body;

  if (!subscriber_id || !respuesta) {
    return res.status(400).send('Faltan campos requeridos');
  }

  // Encolar mensaje
  colaMensajes.push({ subscriber_id, respuesta });
  console.log(`📥 Mensaje encolado para ${subscriber_id}`);
  res.send('Encolado OK');
});

// 3. Página de prueba
app.get('/', (req, res) => {
  res.send('🟢 Proxy activo con cola: ManyChat ↔ Make ↔ GPT');
});

app.listen(port, () => {
  console.log(`🚀 Servidor activo en el puerto ${port}`);
});
