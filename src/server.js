try { require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: true }); } catch(e) {}
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

const ManyChatAPI = require('./manychat/api');
const InstagramBot = require('./instagram-bot/bot');
const ConversationEngine = require('./ai/conversation-engine');
const conversationStore = require('./conversations/store');
const WhatsAppAlerts = require('./alerts/whatsapp');
const SheetsLogger = require('./sheets/logger');
const WeeklyAnalysis = require('./feedback/weekly-analysis');
const trainingExamples = require('./ai/training-examples');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Live log buffer ───
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push({ time: new Date().toISOString(), type: 'log', msg });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  originalLog.apply(console, args);
};
console.error = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push({ time: new Date().toISOString(), type: 'error', msg });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  originalError.apply(console, args);
};

// Serve landing page
app.use(express.static(require('path').join(__dirname, '../public')));

// ─── Initialize services ───

const manychat = new ManyChatAPI(process.env.MANYCHAT_API_TOKEN);

const ai = new ConversationEngine(process.env.ANTHROPIC_API_KEY);

const whatsapp = new WhatsAppAlerts(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
  process.env.TWILIO_WHATSAPP_FROM,
  process.env.MY_WHATSAPP_NUMBER
);

const sheetsCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;
const sheets = new SheetsLogger(sheetsCredentials, process.env.GOOGLE_SHEET_ID);

const weeklyAnalysis = new WeeklyAnalysis(
  process.env.ANTHROPIC_API_KEY,
  sheets,
  whatsapp
);

// ─── Middleware ───

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── ManyChat Webhook (POST) ───
// ManyChat sends creator messages here via External Request action
// Expected JSON body from ManyChat:
// {
//   "subscriber_id": "12345678",
//   "username": "creator_username",
//   "first_name": "Jane",
//   "last_name": "Doe",
//   "message": "the creator's message text",
//   "ig_username": "creator_ig_handle",
//   "follower_count": 5000,
//   "page": "charmframes"
// }

app.post('/manychat-webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('[MANYCHAT WEBHOOK] Received:', JSON.stringify(body).substring(0, 500));

    // Validate required fields
    const subscriberId = body.subscriber_id;
    const messageText = body.message || body.last_input_text || body.text;

    if (!subscriberId || !messageText) {
      console.warn('[MANYCHAT WEBHOOK] Missing subscriber_id or message');
      return res.status(400).json({ error: 'subscriber_id and message are required' });
    }

    // Verify webhook secret if configured
    if (process.env.MANYCHAT_WEBHOOK_SECRET) {
      const authHeader = req.headers['authorization'] || req.headers['x-webhook-secret'];
      if (authHeader !== process.env.MANYCHAT_WEBHOOK_SECRET && authHeader !== `Bearer ${process.env.MANYCHAT_WEBHOOK_SECRET}`) {
        console.warn('[MANYCHAT WEBHOOK] Invalid webhook secret');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Build creator profile from ManyChat data
    const username = body.ig_username || body.username || body.first_name || 'unknown';
    const followerCount = body.follower_count || 0;
    const page = body.page || 'charmframes';

    const profile = {
      username,
      follower_count: followerCount,
      page,
    };

    // Set profile in conversation store (use ManyChat subscriber_id as the user key)
    conversationStore.setProfile(subscriberId, username, page);

    // Add creator message to conversation history
    conversationStore.addMessage(subscriberId, 'creator', messageText);

    // Get full conversation for AI context
    const conversation = conversationStore.getConversation(subscriberId);

    // Generate AI response
    const aiResponse = await ai.generateResponse(conversation.messages, profile);

    if (!aiResponse || !aiResponse.message) {
      console.error('[MSG] AI returned no message');
      return res.status(500).json({ error: 'AI returned no message' });
    }

    console.log(`[AI] Response for ${subscriberId} (@${username}): ${aiResponse.message}`);
    console.log(`[AI] Stage: ${aiResponse.conversation_stage} | Escalation: ${JSON.stringify(aiResponse.escalation)} | Qualification: ${JSON.stringify(aiResponse.qualification)}`);

    // Simulate human typing delay based on message length
    // ~40-60 words per minute typing speed, plus reading time
    const messageLength = aiResponse.message.length;
    const readingDelay = Math.min(messageText.length * 50, 3000); // time to "read" their message
    const typingDelay = Math.min(messageLength * 30, 6000); // time to "type" the reply
    const randomJitter = Math.floor(Math.random() * 2000) + 1000; // 1-3s random variation
    const totalDelay = Math.min(readingDelay + typingDelay + randomJitter, 8000); // cap at 8s to avoid ManyChat timeout

    console.log(`[TYPING] Simulating ${totalDelay}ms delay for natural feel`);
    await new Promise(resolve => setTimeout(resolve, totalDelay));

    // Store assistant message
    conversationStore.addMessage(subscriberId, 'assistant', aiResponse.message);

    // Update conversation stage
    if (aiResponse.conversation_stage) {
      conversationStore.updateStage(subscriberId, aiResponse.conversation_stage);
    }

    // Process qualification data
    if (aiResponse.qualification) {
      const q = aiResponse.qualification;
      conversationStore.updateQualification(subscriberId, q.field, q.value);
    }

    // Mark if Calendly was sent
    if (aiResponse.send_calendly) {
      const convo = conversationStore.getConversation(subscriberId);
      convo.calendlySent = true;
      conversationStore.saveConversation(subscriberId, convo);
    }

    // Process escalations
    if (aiResponse.escalation) {
      conversationStore.addEscalation(subscriberId, aiResponse.escalation);
      await whatsapp.processEscalation(
        aiResponse.escalation,
        username || subscriberId,
        aiResponse.conversation_stage || 'unknown'
      );
    }

    // Check message threshold (10+ messages without booking)
    const updatedConvo = conversationStore.getConversation(subscriberId);
    if (updatedConvo.messageCount >= 10 && !updatedConvo.calendlySent) {
      const alreadyAlerted = updatedConvo.escalations.some(
        e => e.type === 'message_threshold'
      );
      if (!alreadyAlerted) {
        conversationStore.addEscalation(subscriberId, {
          type: 'message_threshold',
          reason: `${updatedConvo.messageCount} messages exchanged, no booking yet`,
        });
        await whatsapp.alertMessageThreshold(
          username || subscriberId,
          updatedConvo.messageCount,
          `Stage: ${updatedConvo.conversationStage}`
        );
      }
    }

    // Log to Google Sheets
    const finalConvo = conversationStore.getConversation(subscriberId);
    await sheets.logConversation(finalConvo);

    console.log(`[MSG] Replied to @${username}: ${aiResponse.message.substring(0, 50)}...`);

    // Return the AI response to ManyChat so it can also be used in the flow
    // ManyChat can use {{ai_response}} custom field or the response body
    return res.json({
      success: true,
      message: aiResponse.message,
      conversation_stage: aiResponse.conversation_stage,
      send_calendly: aiResponse.send_calendly || false,
    });

  } catch (error) {
    console.error('[MANYCHAT WEBHOOK] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ─── Approval webhook (Twilio incoming WhatsApp) ───

app.post('/whatsapp-reply', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    const from = body.From;
    const messageBody = (body.Body || '').trim().toLowerCase();

    // Only process replies from your number
    if (from !== process.env.MY_WHATSAPP_NUMBER) return;

    if (messageBody === 'none') {
      console.log('[APPROVAL] All suggestions rejected');
      const fs = require('fs');
      const path = require('path');
      const pendingPath = path.join(__dirname, '../data/pending-suggestions.json');
      if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
      return;
    }

    // Parse approved numbers (e.g., "1,3" or "1, 2, 3")
    const approvedNumbers = messageBody
      .split(',')
      .map(n => parseInt(n.trim()))
      .filter(n => !isNaN(n));

    if (approvedNumbers.length > 0) {
      const applied = await weeklyAnalysis.processApproval(approvedNumbers);
      await whatsapp.sendAlert(
        `Done. ${applied} prompt update(s) applied. The AI will use the updated prompt from now.`
      );
    }
  } catch (error) {
    console.error('[APPROVAL] Error:', error.message);
  }
});

// ─── Admin endpoints ───

// Submit 2FA code for Instagram bot login
app.post('/bot/2fa', (req, res) => {
  const code = req.body.code || req.query.code;
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (global.igBot && global.igBot.submit2FACode(code)) {
    res.json({ success: true, message: '2FA code submitted' });
  } else {
    res.status(400).json({ error: 'Bot is not waiting for 2FA code' });
  }
});

// Debug: see what the bot's browser is showing
app.get('/bot/screenshot', async (req, res) => {
  if (!global.igBot || !global.igBot.page) {
    return res.status(400).json({ error: 'Bot not running' });
  }
  try {
    const screenshot = await global.igBot.page.screenshot({ fullPage: false });
    res.set('Content-Type', 'image/png');
    res.send(screenshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug: dump inbox HTML structure
app.get('/bot/debug-inbox', async (req, res) => {
  if (!global.igBot || !global.igBot.page) {
    return res.status(400).json({ error: 'Bot not running' });
  }
  try {
    await global.igBot.page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 5000));

    const debug = await global.igBot.page.evaluate(() => {
      const results = { links: [], allHrefs: [], inboxStructure: '' };

      // Find all links with /direct/t/
      document.querySelectorAll('a[href*="/direct/t/"]').forEach(a => {
        results.links.push({ href: a.href, text: a.textContent?.substring(0, 80), tag: a.tagName });
      });

      // Find all links period
      document.querySelectorAll('a[href*="direct"]').forEach(a => {
        results.allHrefs.push(a.href);
      });

      // Get the inbox container structure
      const inbox = document.querySelector('[role="list"], [role="listbox"], div[aria-label*="Direct"], div[aria-label*="inbox"], div[aria-label*="Chats"]');
      if (inbox) {
        results.inboxStructure = inbox.outerHTML.substring(0, 3000);
      }

      // Try to find conversation items by various methods
      const methods = {
        'role=listitem': document.querySelectorAll('[role="listitem"]').length,
        'role=row': document.querySelectorAll('[role="row"]').length,
        'role=option': document.querySelectorAll('[role="option"]').length,
        'a[href*=direct/t]': document.querySelectorAll('a[href*="/direct/t/"]').length,
        'a[href*=direct]': document.querySelectorAll('a[href*="direct"]').length,
        'div with blue dot': document.querySelectorAll('div[style*="background-color: rgb(0, 149, 246)"]').length,
      };
      results.selectorCounts = methods;

      return results;
    });

    res.json(debug);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug: get current page info
app.get('/bot/status', async (req, res) => {
  if (!global.igBot || !global.igBot.page) {
    return res.status(400).json({ error: 'Bot not running' });
  }
  try {
    const url = global.igBot.page.url();
    const title = await global.igBot.page.title();
    const html = await global.igBot.page.content();
    res.json({ url, title, htmlLength: html.length, waitingFor2FA: global.igBot.waitingFor2FA });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simple 2FA form page
app.get('/bot/2fa', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:50px auto;text-align:center">
      <h2>Instagram 2FA Code</h2>
      <p>Enter the 2FA code sent to your phone:</p>
      <form method="POST" action="/bot/2fa">
        <input name="code" type="text" placeholder="123456" style="font-size:24px;padding:10px;width:200px;text-align:center" autofocus>
        <br><br>
        <button type="submit" style="font-size:18px;padding:10px 30px;background:#c864ff;color:white;border:none;border-radius:8px;cursor:pointer">Submit</button>
      </form>
    </body></html>
  `);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: process.env.IG_BOT_USERNAME ? 'browser-bot' : 'manychat',
    botRunning: !!global.igBot?.isRunning,
    timestamp: new Date().toISOString(),
  });
});

// View conversation
app.get('/conversations/:userId', (req, res) => {
  const convo = conversationStore.getConversation(req.params.userId);
  res.json(convo);
});

// List all conversations
app.get('/conversations', (req, res) => {
  const convos = conversationStore.getAllConversations();
  res.json(convos.map(c => ({
    username: c.username,
    igUserId: c.igUserId,
    stage: c.conversationStage,
    messageCount: c.messageCount,
    lastMessage: c.messages[c.messages.length - 1]?.timestamp,
  })));
});

// Add training example via API
app.post('/training-examples', (req, res) => {
  const { name, messages, outcome, notes } = req.body;
  if (!name || !messages) {
    return res.status(400).json({ error: 'name and messages required' });
  }
  const example = trainingExamples.addExample(name, messages, outcome, notes);
  res.json({ success: true, example });
});

// List training examples
app.get('/training-examples', (req, res) => {
  res.json(trainingExamples.getAll());
});

// Manually trigger weekly analysis
app.post('/run-weekly-analysis', async (req, res) => {
  try {
    const result = await weeklyAnalysis.run();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Weekly cron job ───

// Run every Monday at 9am
cron.schedule('0 9 * * 1', async () => {
  console.log('[CRON] Running weekly analysis...');
  try {
    await weeklyAnalysis.run();
  } catch (error) {
    console.error('[CRON] Weekly analysis failed:', error.message);
  }
});

// ─── Instagram Bot message handler ───

async function handleBotMessage(senderId, senderUsername, messageText) {
  const profile = {
    username: senderUsername,
    follower_count: 0,
    page: 'charmframes',
  };

  // Set profile in conversation store
  conversationStore.setProfile(senderId, senderUsername, 'charmframes');

  // Add creator message to conversation history
  conversationStore.addMessage(senderId, 'creator', messageText);

  // Get full conversation for AI context
  const conversation = conversationStore.getConversation(senderId);

  // Generate AI response
  const aiResponse = await ai.generateResponse(conversation.messages, profile);

  if (!aiResponse || !aiResponse.message) {
    console.error('[BOT] AI returned no message');
    return null;
  }

  console.log(`[BOT AI] Response for @${senderUsername}: ${aiResponse.message}`);
  console.log(`[BOT AI] Stage: ${aiResponse.conversation_stage} | Escalation: ${JSON.stringify(aiResponse.escalation)}`);

  // Store assistant message
  conversationStore.addMessage(senderId, 'assistant', aiResponse.message);

  // Update conversation stage
  if (aiResponse.conversation_stage) {
    conversationStore.updateStage(senderId, aiResponse.conversation_stage);
  }

  // Process qualification data
  if (aiResponse.qualification) {
    conversationStore.updateQualification(senderId, aiResponse.qualification.field, aiResponse.qualification.value);
  }

  // Mark if Calendly was sent
  if (aiResponse.send_calendly) {
    const convo = conversationStore.getConversation(senderId);
    convo.calendlySent = true;
    conversationStore.saveConversation(senderId, convo);
  }

  // Process escalations
  if (aiResponse.escalation) {
    conversationStore.addEscalation(senderId, aiResponse.escalation);
    await whatsapp.processEscalation(
      aiResponse.escalation,
      senderUsername || senderId,
      aiResponse.conversation_stage || 'unknown'
    );
  }

  // Check message threshold
  const updatedConvo = conversationStore.getConversation(senderId);
  if (updatedConvo.messageCount >= 10 && !updatedConvo.calendlySent) {
    const alreadyAlerted = updatedConvo.escalations.some(e => e.type === 'message_threshold');
    if (!alreadyAlerted) {
      conversationStore.addEscalation(senderId, {
        type: 'message_threshold',
        reason: `${updatedConvo.messageCount} messages exchanged, no booking yet`,
      });
      await whatsapp.alertMessageThreshold(
        senderUsername || senderId,
        updatedConvo.messageCount,
        `Stage: ${updatedConvo.conversationStage}`
      );
    }
  }

  // Log to Google Sheets
  const finalConvo = conversationStore.getConversation(senderId);
  await sheets.logConversation(finalConvo);

  return aiResponse.message;
}

// ─── Start server ───

async function start() {
  // Initialize Google Sheets
  await sheets.init();

  app.listen(PORT, () => {
    const mode = process.env.IG_BOT_USERNAME ? 'Browser Bot' : 'ManyChat';
    console.log(`\n=================================`);
    console.log(`  Only Rising DM System`);
    console.log(`  Mode: ${mode}`);
    console.log(`  Running on port ${PORT}`);
    console.log(`=================================\n`);
  });

  // Start Instagram browser bot if credentials are configured
  if (process.env.IG_BOT_USERNAME && process.env.IG_BOT_PASSWORD) {
    console.log('[BOT] Instagram bot credentials found, starting bot...');

    const bot = new InstagramBot({
      username: process.env.IG_BOT_USERNAME,
      password: process.env.IG_BOT_PASSWORD,
      onMessage: handleBotMessage,
      onTwoFactorNeeded: async (twoFactorType) => {
        const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : `https://web-production-30bf0.up.railway.app`;

        let typeMsg = '';
        if (twoFactorType === 'authenticator_app') {
          typeMsg = '🔐 Instagram wants a code from your AUTHENTICATOR APP (Google Auth / Duo etc)';
        } else if (twoFactorType === 'sms') {
          typeMsg = '📱 Instagram sent an SMS code to your phone';
        } else if (twoFactorType === 'email') {
          typeMsg = '📧 Instagram sent a code to your email';
        } else if (twoFactorType === 'whatsapp') {
          typeMsg = '💬 Instagram sent a code via WhatsApp';
        } else {
          typeMsg = '🔑 Check your phone/email/authenticator app for the code';
        }

        await whatsapp.sendAlert(
          `Only Rising Bot needs your 2FA code to login to @${process.env.IG_BOT_USERNAME}.\n\n${typeMsg}\n\nEnter it here:\n${serverUrl}/bot/2fa\n\nYou can also check what the page looks like:\n${serverUrl}/bot/screenshot\n\nYou have 5 minutes.`
        );
      },
    });

    global.igBot = bot;

    try {
      await bot.init();
      const loggedIn = await bot.login();

      if (loggedIn) {
        bot.startPolling(15000);
      } else {
        console.error('[BOT] Could not login. Check /bot/screenshot to see what the page looks like.');
        console.error('[BOT] Bot page still accessible for debugging.');
      }
    } catch (error) {
      console.error('[BOT] Failed to start:', error.message);
    }
  }
}

// Retry login endpoint - so you don't need to redeploy
// Live logs API
app.get('/bot/logs', (req, res) => {
  const since = req.query.since ? new Date(req.query.since).toISOString() : null;
  const logs = since ? logBuffer.filter(l => l.time > since) : logBuffer;
  res.json(logs);
});

// Live dashboard
app.get('/bot/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head>
<title>Only Rising Bot - Live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, system-ui, sans-serif; padding: 16px; }
  h1 { font-size: 18px; color: #c864ff; margin-bottom: 4px; }
  .status { font-size: 13px; color: #888; margin-bottom: 16px; }
  .status .live { color: #4ade80; }
  .status .dead { color: #f87171; }
  .stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; flex: 1; min-width: 120px; }
  .stat .label { font-size: 11px; color: #888; text-transform: uppercase; }
  .stat .value { font-size: 20px; font-weight: 600; color: #fff; margin-top: 2px; }
  #logs { background: #111; border: 1px solid #222; border-radius: 8px; padding: 12px; height: calc(100vh - 200px); overflow-y: auto; font-family: 'SF Mono', Monaco, monospace; font-size: 12px; line-height: 1.6; }
  .log-line { padding: 1px 0; }
  .log-line .time { color: #555; margin-right: 8px; }
  .log-line.error { color: #f87171; }
  .log-line .bot { color: #60a5fa; }
  .log-line .ai { color: #c864ff; }
  .log-line .msg { color: #4ade80; }
  .log-line .sheets { color: #fbbf24; }
  .log-line .whatsapp { color: #22c55e; }
  .log-line .typing { color: #888; }
</style>
</head><body>
<h1>Only Rising Bot</h1>
<div class="status">Status: <span id="statusLabel" class="live">Connecting...</span> | <span id="lastUpdate">-</span></div>
<div class="stats">
  <div class="stat"><div class="label">Bot</div><div class="value" id="botStatus">-</div></div>
  <div class="stat"><div class="label">Messages</div><div class="value" id="msgCount">-</div></div>
  <div class="stat"><div class="label">URL</div><div class="value" id="botUrl" style="font-size:11px;word-break:break-all">-</div></div>
</div>
<div id="logs"></div>
<script>
let lastTime = null;
let msgCount = 0;

function colorLine(msg) {
  if (msg.includes('[BOT]')) return 'bot';
  if (msg.includes('[AI]')) return 'ai';
  if (msg.includes('[MSG]')) return 'msg';
  if (msg.includes('[SHEETS]')) return 'sheets';
  if (msg.includes('[WHATSAPP]')) return 'whatsapp';
  if (msg.includes('[TYPING]')) return 'typing';
  return '';
}

async function poll() {
  try {
    const url = '/bot/logs' + (lastTime ? '?since=' + encodeURIComponent(lastTime) : '');
    const res = await fetch(url);
    const logs = await res.json();
    const el = document.getElementById('logs');

    logs.forEach(l => {
      const div = document.createElement('div');
      div.className = 'log-line ' + (l.type === 'error' ? 'error' : '') ;
      const t = new Date(l.time).toLocaleTimeString();
      const cls = colorLine(l.msg);
      div.innerHTML = '<span class="time">' + t + '</span><span class="' + cls + '">' + l.msg.replace(/</g,'&lt;') + '</span>';
      el.appendChild(div);
      lastTime = l.time;
      if (l.msg.includes('[MSG]')) msgCount++;
    });

    if (logs.length > 0) {
      el.scrollTop = el.scrollHeight;
      document.getElementById('msgCount').textContent = msgCount;
    }

    document.getElementById('lastUpdate').textContent = 'Updated: ' + new Date().toLocaleTimeString();

    // Get status
    const sRes = await fetch('/bot/status').catch(() => null);
    if (sRes) {
      const status = await sRes.json();
      document.getElementById('botStatus').textContent = status.waitingFor2FA ? '2FA' : (status.url?.includes('instagram.com') ? 'Running' : 'Starting');
      document.getElementById('botUrl').textContent = status.url || '-';
      document.getElementById('statusLabel').textContent = 'Connected';
      document.getElementById('statusLabel').className = 'live';
    }
  } catch(e) {
    document.getElementById('statusLabel').textContent = 'Disconnected';
    document.getElementById('statusLabel').className = 'dead';
  }
}

poll();
setInterval(poll, 3000);
</script>
</body></html>`);
});

app.get('/bot/retry-login', async (req, res) => {
  try {
    console.log('[BOT] Retrying login...');
    // Create a completely fresh bot instance
    if (global.igBot) {
      await global.igBot.stop().catch(() => {});
      global.igBot = null;
    }
    // Wait a moment for cleanup
    await new Promise(r => setTimeout(r, 2000));

    const bot = new (require('./instagram-bot/bot'))({
      username: process.env.IG_BOT_USERNAME,
      password: process.env.IG_BOT_PASSWORD,
      onMessage: handleBotMessage,
      onTwoFactorNeeded: async (twoFactorType) => {
        const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : `https://web-production-30bf0.up.railway.app`;
        let typeMsg = twoFactorType === 'sms' ? '📱 SMS code' : twoFactorType === 'authenticator_app' ? '🔐 Authenticator app' : '🔑 Check phone/email/auth app';
        await whatsapp.sendAlert(`2FA needed for @${process.env.IG_BOT_USERNAME}.\n${typeMsg}\n\nEnter here: ${serverUrl}/bot/2fa\n\n5 minutes.`);
      },
    });
    global.igBot = bot;
    await bot.init();
    const loggedIn = await bot.login();
    if (loggedIn) {
      bot.startPolling(15000);
      res.json({ success: true, message: 'Login successful, bot is now monitoring DMs' });
    } else {
      res.json({ success: false, message: 'Login failed. Check /bot/screenshot for details' });
    }
  } catch (error) {
    console.error('[BOT] Retry error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

start();
