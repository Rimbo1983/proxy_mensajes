const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Webhook de destino en Make (nuevo)
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';

app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    console.log('📩 Mensaje recibido desde ManyChat:', data);

    // Reenvía directamente a Make
    await axios.post(MAKE_WEBHOOK_URL, data);

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error al reenviar a Make:', error.message);
    res.status(500).send('Error interno');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Proxy para ManyChat activo');
});

app.listen(port, () => {
  console.log(`🚀 Servidor activo en el puerto ${port}`);
});
