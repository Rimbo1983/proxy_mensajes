// index.js
const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/41c6xuwixq15wxc1p8ugu6syon72ys7w';

// —— Estado en memoria ——
const blockedIds = new Set();          // subscriber_id bloqueados directamente
const bufferUsuarios = {};            // buffers de mensajes por subscriber_id
let colaMensajes = [];                // cola de respuestas pendientes a procesar
const waitingUsuarios = new Set();    // subscriber_id que están esperando respuesta completa

app.use(express.json());

// —— Bloquear usuario por ID ——
app.post('/block', (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedIds.add(usuario);
  console.log(`🚫 Subscriber ID bloqueado: ${usuario}`);

  // Cancelar buffer si existe
  if (bufferUsuarios[usuario]?.timer) {
    clearTimeout(bufferUsuarios[usuario].timer);
    delete bufferUsuarios[usuario];
    console.log(`🛑 Buffer cancelado para ${usuario}`);
  }

  // Purgar cola de ese ID
  colaMensajes = colaMensajes.filter(msg => msg.subscriber_id !== usuario);

  // También quitarlo de waiting (por si estaba esperando)
  if (waitingUsuarios.has(usuario)) {
    waitingUsuarios.delete(usuario);
    console.log(`🗑️ Se removió ${usuario} de waitingUsuarios al bloquear`);
  }

  res.send(`Subscriber ID ${usuario} bloqueado`);
});

// —— Desbloquear usuario por ID ——
app.post('/unblock', (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).send('Falta campo usuario');

  blockedIds.delete(usuario);
  console.log(`✅ Subscriber ID desbloqueado: ${usuario}`);

  res.send(`Subscriber ID ${usuario} desbloqueado`);
});

// —— ManyChat → proxy (agrupa y reenvía a Make) ——
app.post('/webhook', (req, res) => {
  const { usuario, mensaje, id, telefono, Plataforma } = req.body;
  if (!usuario || !mensaje || !id) return res.status(400).send('Faltan datos');

  // Ignorar bloqueados por ID
  if (blockedIds.has(id)) {
    console.log(`🛑 Ignorado mensaje de bloqueado (${id})`);
    return res.status(200).send('Subscriber bloqueado');
  }

  // Ignorar si está esperando
  if (waitingUsuarios.has(id)) {
    console.log(`🛑 Ignorado ${id}, esperando respuesta`);
    return res.sendStatus(204);
  }

  // Buffer de mensajes
  if (!bufferUsuarios[id]) bufferUsuarios[id] = { mensajes: [], timer: null };
  bufferUsuarios[id].mensajes.push(mensaje.trim());

  if (!bufferUsuarios[id].timer) {
    bufferUsuarios[id].timer = setTimeout(async () => {
      const grouped = bufferUsuarios[id].mensajes.join('\n');
      delete bufferUsuarios[id];

      if (blockedIds.has(id)) {
        console.log(`🛑 Buffer descartado para bloqueado (${id})`);
        return;
      }

      try {
        await axios.post(
          MAKE_WEBHOOK_URL,
          { usuario, mensaje: grouped, id, telefono, Plataforma },
          { headers: { 'Content-Type': 'application/json' } }
        );
        console.log(`📤 Enviado a Make: ${id}`);
        waitingUsuarios.add(id);
      } catch (err) {
        console.error(`❌ Error enviando a Make ${id}:`, err.response?.data || err.message);
      }
    }, 60000);
  }

  res.send('Mensaje recibido y agrupando');
});

// —— Make → proxy (recibe respuesta GPT y encola) ——
app.post('/respuesta-gpt', (req, res) => {
  const { subscriber_id, respuesta } = req.body;
  if (!subscriber_id || !respuesta) return res.status(400).send('Faltan campos');

  if (blockedIds.has(subscriber_id)) {
    console.log(`🛑 Descarta respuesta de bloqueado (${subscriber_id})`);
    return res.status(200).send('Subscriber bloqueado');
  }

  colaMensajes.push({ subscriber_id, respuesta });
  console.log(`📥 Encolado ${subscriber_id}`);
  res.send('Encolado');
});

// —— Procesador de cola (cada 2s) ——
setInterval(() => {
  if (colaMensajes.length === 0) return;
  const { subscriber_id, respuesta } = colaMensajes.shift();

  if (blockedIds.has(subscriber_id)) {
    console.log(`🛑 Envío cancelado para bloqueado (${subscriber_id})`);
    return;
  }

  // Aquí ya no se dispara flow ni se setea custom field, porque eso lo hace App Script ahora.
  console.log(`📦 Procesado de cola para ${subscriber_id} (respuesta: ${respuesta.slice(0, 50)})`);
  waitingUsuarios.delete(subscriber_id);
}, 2000);

// —— Página de estado ——
app.get('/', (req, res) => res.send('🟢 Proxy simplificado activo'));

app.listen(port, () => console.log(`🚀 Servidor activo en puerto ${port}`));
