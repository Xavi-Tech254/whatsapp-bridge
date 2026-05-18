# Dev Clin Studies — WhatsApp Bridge

Connects your WhatsApp number to the Flask bot using **pairing code** (no QR scan needed).

---

## Local Setup

```bash
cd whatsapp_bridge
npm install
cp .env.example .env
# Edit .env — set your phone number and Flask URL
node index.js
```

On first run you'll see:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 PAIRING CODE: ABCD-1234
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 On your phone:
   WhatsApp → Settings → Linked Devices
   → Link a Device → Link with phone number
   → Enter the code above
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Enter the code on your phone → Done! ✅

After pairing, credentials are saved in `auth_info/` folder — you won't need to pair again unless you log out.

---

## Railway Deployment

1. Push `whatsapp_bridge/` to a **separate GitHub repo**
2. Create new Railway service → Deploy from GitHub
3. Add environment variables:
   - `PHONE_NUMBER` = `254712345678` (your number, no + sign)
   - `FLASK_URL` = `https://your-flask-app.up.railway.app`
4. On first deploy, check Railway logs for the pairing code
5. Enter it on your phone → connected forever!

---

## How it works

```
User sends WhatsApp message
        ↓
Baileys bridge receives it
        ↓
Forwards to Flask /webhook
        ↓
Flask processes + returns reply
        ↓
Bridge sends reply to user
        ↓
If reply has FILE: → sends as document
If reply has link → sends as text
```

---

## Important Notes

- Keep `auth_info/` folder safe — it's your WhatsApp session
- On Railway, use a **Volume** to persist `auth_info/` across deploys
- Don't use your main personal number — use a secondary number
- Free Railway plan works fine for this
