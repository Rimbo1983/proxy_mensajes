// Instagram Webhook Proxy for Make - Versión con Marca de Primer Mensaje

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Tu Webhook real de Make
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/4s7wx0ykfgbjal58ehkh9jb2xwr4ced6';
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

    if (isGateOpen) {
      console.log('Compuerta abierta, reenviando evento a Make.');

      // Marcar el primer mensaje
      body.entry[0].messaging[0].pasar_a_make = true;

      isGateOpen = false;

      await axios.post(MAKE_WEBHOOK_URL, body);

      // Reabrir la compuerta después de 2 segundos
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
