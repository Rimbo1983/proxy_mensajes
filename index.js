const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(bodyParser.json());

// 1. CONFIGURACIÓN
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';
const MANYCHAT_API_KEY = '807862065951550:771c99826f7011f4d47ab018e4207b60';
const FLOW_NS = 'content20250531215213_464672'; // Este es tu flow válido

// 2. Memoria temporal para respuestas GPT
const respuestas = new Map();

// 3. Endpoint que ManyChat llama para reenviar a Make
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

// 4. Endpoint que Make llama para guardar respuesta y lanzar el Flow
app.post('/respuesta-gpt', async (req, res) => {
  const { subscriber_id, respuesta } = req.body;

  if (!subscriber_id || !respuesta) {
    return res.status(400).send('Faltan campos requeridos');
  }

  // Guarda la respuesta del GPT
  respuestas.set(subscriber_id, respuesta);

  try {
    await axios.post(
      'https://api.manychat.com/fb/sending/sendFlow',
      {
        subscriber_id,
        flow_ns: FLOW_NS
      },
      {
        headers: {
          'Authorization': `Bearer ${MANYCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Flow lanzado a ${subscriber_id}`);
    res.send('OK');
  } catch (error) {
    console.error('❌ Error al lanzar flow:', error.response?.data || error.message);
    res.status(500).send('Error al lanzar flow');
  }
});

// 5. Endpoint que ManyChat consulta con GET → responde mensaje ya formateado
app.get('/respuesta', (req, res) => {
  const subscriber_id = req.query.subscriber_id;

  if (!subscriber_id || !respuestas.has(subscriber_id)) {
    return res.status(404).send('No se encontró respuesta');
  }

  const respuestaGPT = respuestas.get(subscriber_id);

  // Formato compatible con ManyChat (v2)
  res.json({
    version: "v2",
    content: {
      messages: [
        {
          type: "text",
          text: respuestaGPT
        }
      ]
    }
  });
});

// 6. Página raíz de prueba
app.get('/', (req, res) => {
  res.send('🟢 Proxy activo para ManyChat ↔ Make ↔ GPT');
});

// Inicio del servidor
app.listen(port, () => {
  console.log(`🚀 Servidor activo en el puerto ${port}`);
});
