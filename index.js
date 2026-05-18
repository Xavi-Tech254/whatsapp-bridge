import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} from '@whiskeysockets/baileys';
import axios from 'axios';
import pino from 'pino';
import { readFileSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const FLASK_URL = process.env.FLASK_URL || 'http://localhost:5000';
const PHONE_NUMBER = process.env.PHONE_NUMBER || ''; // e.g. 254712345678
const logger = pino({ level: 'silent' });

let sock = null;
let isConnected = false;

async function sendToFlask(from, message) {
  try {
    const res = await axios.post(`${FLASK_URL}/webhook`, {
      from: from,
      message: message
    }, { timeout: 15000 });

    return res.data?.reply || null;
  } catch (err) {
    console.error('❌ Flask error:', err.message);
    return null;
  }
}

async function sendWhatsAppMessage(jid, text) {
  if (!sock || !isConnected) {
    console.error('❌ Not connected to WhatsApp');
    return;
  }
  try {
    // Split long messages
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
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

async function sendFile(jid, filePath, caption = '') {
  // filePath can be a URL or local path
  try {
    if (filePath.startsWith('http')) {
      // It's a link — send as text
      await sock.sendMessage(jid, { text: `${caption}\n${filePath}` });
    } else {
      // Local file — send as document
      const fileName = filePath.split('/').pop();
      const ext = fileName.split('.').pop().toLowerCase();
      const mimeMap = {
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'mp4': 'video/mp4',
        'mp3': 'audio/mpeg',
        'zip': 'application/zip',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      // Fetch file from Flask
      const fileUrl = `${FLASK_URL}${filePath}`;
      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);

      await sock.sendMessage(jid, {
        document: buffer,
        mimetype: mimeType,
        fileName: fileName,
        caption: caption
      });
    }
  } catch (err) {
    console.error('❌ File send error:', err.message);
    await sock.sendMessage(jid, { text: `${caption}\n📎 File: ${FLASK_URL}${filePath}` });
  }
}

async function processReply(jid, reply) {
  if (!reply) return;

  // Check if reply contains a file path
  const fileMatch = reply.match(/📎 FILE:(.+?)(\n|$)/);
  if (fileMatch) {
    const filePath = fileMatch[1].trim();
    const caption = reply.replace(/📎 FILE:.+?(\n|$)/, '').trim();
    await sendFile(jid, filePath, caption);
  } else {
    await sendWhatsAppMessage(jid, reply);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    browser: ['MyBot', 'Chrome', '120.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false, // NO QR CODE
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  // ── PAIRING CODE ──────────────────────────────────────────────
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error('❌ Set PHONE_NUMBER in .env (e.g. 254712345678)');
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 3000));
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔗 PAIRING CODE:', code.match(/.{1,4}/g).join('-'));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📱 On your phone:');
    console.log('   WhatsApp → Settings → Linked Devices');
    console.log('   → Link a Device → Link with phone number');
    console.log('   → Enter the code above');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  // ── CONNECTION EVENTS ─────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log(`⚠️  Connection closed (code: ${code}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 5000);
      } else {
        console.log('🚪 Logged out. Delete auth_info folder and restart.');
      }
    }

    if (connection === 'open') {
      isConnected = true;
      console.log('✅ WhatsApp connected! Dev Clin Studies is LIVE 🎓');
    }
  });

  // ── SAVE CREDENTIALS ──────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── INCOMING MESSAGES ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignore: broadcast, status, own messages
      if (isJidBroadcast(msg.key.remoteJid)) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      const from = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

      // Extract text from any message type
      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
      ).trim();

      if (!text) continue;

      console.log(`📩 From ${from}: ${text.substring(0, 60)}${text.length > 60 ? '...' : ''}`);

      // Get reply from Flask
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
      const reply = await sendToFlask(from, text);

      if (reply) {
        await processReply(jid, reply);
        console.log(`📤 Replied to ${from}`);
      }
    }
  });
}

// ── START ──────────────────────────────────────────────────────
console.log('🚀 Starting Dev Clin Studies WhatsApp Bridge...');
console.log(`📡 Flask URL: ${FLASK_URL}`);
connectToWhatsApp().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
