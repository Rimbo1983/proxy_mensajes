// Instagram Webhook Proxy for Make with File-based Deduplication (FINAL)

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Tu Webhook real de Make
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/6mnxysnihqg53lmoeg88kp4t3ldu1rgh';
const VERIFY_TOKEN = 'eurekaToken2025'; // El mismo que pusiste en Meta Developers

const LAST_SENDER_FILE = path.join(__dirname, 'last_sender.json');

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

    const senderId = messagingEvent.sender.id;
    const timestamp = Math.floor(messagingEvent.timestamp / 1000);

    let lastSenderData = {};

    if (fs.existsSync(LAST_SENDER_FILE)) {
      const rawData = fs.readFileSync(LAST_SENDER_FILE);
      lastSenderData = JSON.parse(rawData);
    }

    const currentTime = Date.now() / 1000;

    if (lastSenderData.senderId === senderId && (currentTime - lastSenderData.timestamp) < 2) {
      console.log('Duplicate detected, ignoring event:', senderId);
      return res.sendStatus(200);
    }

    // Update last sender file
    fs.writeFileSync(LAST_SENDER_FILE, JSON.stringify({
      senderId: senderId,
      timestamp: currentTime
    }));

    console.log('Forwarding event to Make:', senderId);

    await axios.post(MAKE_WEBHOOK_URL, body);

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
