const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// Webhook real de Make
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/kwlyfg2erb2pswddghg1kkbptq4m330n';

app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;

    console.log('📩 Mensaje recibido desde ManyChat:', data);

    // Reenviar a Make
    await axios.post(MAKE_WEBHOOK_URL, data);

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error al reenviar a Make:', error.message);
    res.status(500).send('Error interno');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Proxy para ManyChat está corriendo.');
});

app.listen(port, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${port}`);
});
