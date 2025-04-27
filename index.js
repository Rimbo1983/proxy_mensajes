// Instagram Webhook Proxy for Make - Versión Compuerta (Gate)

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Tu Webhook real de Make
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/6mnxysnihqg53lmoeg88kp4t3ldu1rgh';
const VERIFY_TOKEN = 'eurekaToken2025'; // Token de verificación en Meta Developers

// GATE FLAG: Compuerta de control
let isGateOpen = true;

// Webhook verification endpoint (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook event receiver (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (!body.entry || !body.entry[0] || !body.entry[0].messaging || !body.entry[0].messaging[0]) {
      console.log('Webhook received but no valid messaging event.');
      return res.sendStatus(200);
    }

    const messagingEvent = body.entry[0].messaging[0];

    // SOLO reenviar el primer evento si la compuerta está abierta
    if (isGateOpen) {
      console.log('Compuerta abierta, reenviando evento a Make.');

      // Cerrar la compuerta
      isGateOpen = false;

      // Reenviar a Make
      await axios.post(MAKE_WEBHOOK_URL, body);

      // Reabrir compuerta después de 2 segundos
      setTimeout(() => {
        isGateOpen = true;
        console.log('Compuerta reabierta.');
      }, 2000);

    } else {
      console.log('Compuerta cerrada, ignorando evento.');
    }

    res.sendStatus(200);

  } catch (error) {
    console.error('Error handling webhook:', error);
    res.sendStatus(500);
  }
});

// Root test endpoint
app.get('/', (req, res) => {
  res.send('Instagram Webhook Proxy is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
