// Simple Instagram Webhook Proxy for Make

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Memory store for deduplication
const eventStore = new Map();

// Replace this with your actual Make Webhook URL
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/TU_WEBHOOK_ID_AQUI'; // <-- ACA poné tu URL de Make

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (!body.entry || !body.entry[0] || !body.entry[0].messaging || !body.entry[0].messaging[0]) {
      console.log('Webhook received but no valid messaging event.');
      return res.sendStatus(200);
    }

    const messagingEvent = body.entry[0].messaging[0];

    const senderId = messagingEvent.sender.id;
    const timestamp = Math.floor(messagingEvent.timestamp / 1000); // round to seconds
    const text = messagingEvent.message && messagingEvent.message.text ? messagingEvent.message.text : '';

    const eventKey = `${senderId}_${timestamp}_${text}`;

    if (eventStore.has(eventKey)) {
      console.log('Duplicate event ignored:', eventKey);
      return res.sendStatus(200);
    }

    // Store event key for 5 seconds
    eventStore.set(eventKey, true);
    setTimeout(() => eventStore.delete(eventKey), 5000);

    console.log('Forwarding event to Make:', eventKey);

    await axios.post(MAKE_WEBHOOK_URL, body);

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
