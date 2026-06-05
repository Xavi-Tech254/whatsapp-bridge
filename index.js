import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} from '@whiskeysockets/baileys';
import axios from 'axios';
import pino from 'pino';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const FLASK_URL = process.env.FLASK_URL || 'http://localhost:5000';
const PHONE_NUMBER = process.env.PHONE_NUMBER || '';
const PORT = process.env.PORT || 3000;
const logger = pino({ level: 'silent' });

let sock = null;
let isConnected = false;

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', connected: isConnected }));

app.post('/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: 'number and message required' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' });
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  try {
    await sendWhatsAppMessage(jid, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🌐 Bridge server on port ${PORT}`));

async function sendToFlask(from, message) {
  try {
    const res = await axios.post(`${FLASK_URL}/webhook`, { from, message }, { timeout: 15000 });
    return res.data || null;
  } catch (err) {
    console.error('❌ Flask error:', err.message);
    return null;
  }
}

async function sendWhatsAppMessage(jid, text) {
  if (!sock || !isConnected) return;
  try {
    if (text.length <= 4096) {
      await sock.sendMessage(jid, { text });
    } else {
      const parts = text.match(/.{1,4096}/gs) || [];
      for (const part of parts) {
        await sock.sendMessage(jid, { text: part });
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) {
    console.error('❌ Send error:', err.message);
  }
}

async function sendListMessage(jid, text, buttons) {
  if (!sock || !isConnected) return;
  try {
    // Check if any button has a URL — send as template with URL button
    const urlBtn = buttons.find(b => b.url);
    const normalBtns = buttons.filter(b => !b.url);

    if (urlBtn) {
      // Send URL button as WhatsApp template CTA
      const templateButtons = [
        {
          index: 1,
          urlButton: {
            displayText: urlBtn.text,
            url: urlBtn.url
          }
        },
        ...normalBtns.slice(0, 2).map((b, i) => ({
          index: i + 2,
          quickReplyButton: {
            displayText: b.text,
            id: b.id || b.text
          }
        }))
      ];

      await sock.sendMessage(jid, {
        text,
        templateButtons,
        footer: ''
      });
      return;
    }

    // Normal buttons (≤3) or list (>3)
    if (buttons.length <= 3) {
      const waButtons = buttons.map((b, i) => ({
        buttonId: b.id || String(i + 1),
        buttonText: { displayText: b.text },
        type: 1
      }));
      await sock.sendMessage(jid, { text, buttons: waButtons, headerType: 1 });
    } else {
      const rows = buttons.map(b => ({
        rowId: b.id || b.text,
        title: b.text,
        description: b.desc || ''
      }));
      await sock.sendMessage(jid, {
        text,
        sections: [{ title: 'Choose an option', rows }],
        buttonText: '≡  View Options',
        listType: 1
      });
    }
  } catch (err) {
    console.error('❌ List error, falling back:', err.message);
    // Fallback: send URL as plain text
    const urlBtn = buttons.find(b => b.url);
    if (urlBtn) {
      await sendWhatsAppMessage(jid, `${text}\n\n${urlBtn.text}:\n${urlBtn.url}`);
    } else {
      await sendWhatsAppMessage(jid, text);
    }
  }
}

async function sendFile(jid, filePath, caption = '') {
  try {
    const fileName = filePath.split('/').pop();
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeMap = {
      'pdf': 'application/pdf', 'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'mp4': 'video/mp4', 'mp3': 'audio/mpeg', 'zip': 'application/zip',
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    const fileUrl = filePath.startsWith('http') ? filePath : `${FLASK_URL}${filePath}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    await sock.sendMessage(jid, { document: buffer, mimetype: mimeType, fileName, caption });
  } catch (err) {
    console.error('❌ File error:', err.message);
    await sendWhatsAppMessage(jid, `${caption}\n📎 ${FLASK_URL}${filePath}`);
  }
}

async function processReply(jid, replyData) {
  if (!replyData) return;

  if (typeof replyData === 'object' && replyData.reply) {
    const { reply, buttons, banner, file_path } = replyData;

    if (banner) {
      try {
        const response = await axios.get(banner, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        await sock.sendMessage(jid, { image: buffer, caption: '' });
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        console.error('❌ Banner error:', err.message);
      }
    }

    if (buttons && buttons.length > 0) {
      await sendListMessage(jid, reply, buttons);
    } else {
      await sendWhatsAppMessage(jid, reply);
    }

    if (file_path) {
      await new Promise(r => setTimeout(r, 500));
      await sendFile(jid, file_path, '');
    }
    return;
  }

  const text = String(replyData);
  const bannerMatch = text.match(/^BANNER:(.+?)\n/);
  const fileMatch = text.match(/📎 FILE:(.+?)(\n|$)/);

  if (bannerMatch) {
    const bannerPath = bannerMatch[1].trim();
    const rest = text.replace(/^BANNER:.+?\n/, '').trim();
    try {
      const bannerUrl = `${FLASK_URL}${bannerPath}`;
      const response = await axios.get(bannerUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      await sock.sendMessage(jid, { image: buffer, caption: '' });
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error('❌ Banner error:', err.message);
    }
    if (rest) await sendWhatsAppMessage(jid, rest);
  } else if (fileMatch) {
    const filePath = fileMatch[1].trim();
    const caption = text.replace(/📎 FILE:.+?(\n|$)/, '').trim();
    await sendFile(jid, filePath, caption);
  } else {
    await sendWhatsAppMessage(jid, text);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) { console.error('❌ Set PHONE_NUMBER in env'); process.exit(1); }
    await new Promise(r => setTimeout(r, 3000));
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔗 PAIRING CODE:', code.match(/.{1,4}/g).join('-'));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📱 WhatsApp → Settings → Linked Devices → Link with phone number');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`⚠️ Connection closed (code: ${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 5000);
      else console.log('🚪 Logged out. Delete auth_info and restart.');
    }
    if (connection === 'open') {
      isConnected = true;
      console.log('✅ WhatsApp connected! Dev Clin Studies is LIVE 🎓');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      const from = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        msg.message?.templateButtonReplyMessage?.selectedId ||
        msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        ''
      ).trim();

      if (!text) continue;
      console.log(`📩 From ${from}: ${text.substring(0, 60)}`);
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
      const replyData = await sendToFlask(from, text);
      if (replyData) {
        await processReply(jid, replyData);
        console.log(`📤 Replied to ${from}`);
      }
    }
  });
}

console.log('🚀 Starting Dev Clin Studies WhatsApp Bridge...');
console.log(`📡 Flask URL: ${FLASK_URL}`);
connectToWhatsApp().catch(err => { console.error('Fatal error:', err); process.exit(1); });
