// Instagram Webhook Proxy for Make - Versión con Agrupación de Mensajes por Usuario

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/4s7wx0ykfgbjal58ehkh9jb2xwr4ced6';
const VERIFY_TOKEN = 'eurekaToken2025';

// Estructura para agrupar mensajes por usuario
const userMessageBuffer = {};
const userTimers = {};
const AGGREGATION_WINDOW = 15000; // 15 segundos

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

app.post('/webhook', (req, res) => {
  try {
    const body = req.body;
    if (!body.entry || !body.entry[0] || !body.entry[0].messaging || !body.entry[0].messaging[0]) {
      console.log('Webhook received but no valid messaging event.');
      return res.sendStatus(200);
    }

    const messagingEvent = body.entry[0].messaging[0];
    const senderId = messagingEvent.sender.id;
    const messageText = messagingEvent.message?.text;
    const isEcho = messagingEvent.message?.is_echo;

    // Solo procesar si es un mensaje real (no echo y tiene texto)
    if (!messageText || isEcho) {
      return res.sendStatus(200);
    }

    if (!userMessageBuffer[senderId]) {
      userMessageBuffer[senderId] = [];
    }

    userMessageBuffer[senderId].push(messageText);

    if (userTimers[senderId]) {
      clearTimeout(userTimers[senderId]);
    }

    userTimers[senderId] = setTimeout(async () => {
      const combinedMessage = userMessageBuffer[senderId].join(' ');

      const payload = {
        object: 'instagram',
        entry: [
          {
            id: body.entry[0].id,
            time: Date.now(),
            messaging: [
              {
                sender: { id: senderId },
                recipient: messagingEvent.recipient,
                timestamp: Date.now(),
                message: {
                  text: combinedMessage
                },
                pasar_a_make: true
              }
            ]
          }
        ]
      };

      await axios.post(MAKE_WEBHOOK_URL, payload);

      console.log('Mensaje agrupado enviado a Make:', combinedMessage);

      delete userMessageBuffer[senderId];
      delete userTimers[senderId];
    }, AGGREGATION_WINDOW);

    res.sendStatus(200);
  } catch (error) {
    console.error('Error handling webhook:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Instagram Webhook Proxy is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
