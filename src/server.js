try { require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: true }); } catch(e) {}
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');

const InstagramAPI = require('./meta/instagram');
const ConversationEngine = require('./ai/conversation-engine');
const conversationStore = require('./conversations/store');
const WhatsAppAlerts = require('./alerts/whatsapp');
const SheetsLogger = require('./sheets/logger');
const WeeklyAnalysis = require('./feedback/weekly-analysis');
const trainingExamples = require('./ai/training-examples');
const { getPageByFbId, getPageByIgId } = require('./config/pages');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve landing page
app.use(express.static(require('path').join(__dirname, '../public')));

// ─── Initialize services ───

const instagram = new InstagramAPI(
  process.env.META_PAGE_ACCESS_TOKEN,
  process.env.IG_ACCOUNT_ID
);

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

// Raw body for signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Webhook verification (GET) ───

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[WEBHOOK] Verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[WEBHOOK] Verification failed');
  return res.sendStatus(403);
});

// ─── Webhook handler (POST) ───

app.post('/webhook', async (req, res) => {
  // Always respond 200 quickly to avoid Meta retries
  res.sendStatus(200);

  try {
    const rawBody = req.body.toString();
    console.log('[WEBHOOK] POST received:', rawBody.substring(0, 500));
    const body = JSON.parse(rawBody);

    // Verify signature
    const signature = req.headers['x-hub-signature-256'];
    if (signature && process.env.META_APP_SECRET) {
      const isValid = InstagramAPI.verifySignature(
        req.body.toString(),
        signature,
        process.env.META_APP_SECRET
      );
      if (!isValid) {
        console.warn('[WEBHOOK] Invalid signature');
        return;
      }
    }

    // Process Instagram messaging events
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        for (const messaging of entry.messaging || []) {
          await handleIncomingMessage(messaging, entry.id);
        }
      }
    }

    // Also handle page-level messaging (Meta sometimes sends as page)
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        for (const messaging of entry.messaging || []) {
          await handleIncomingMessage(messaging, entry.id);
        }
      }
    }
  } catch (error) {
    console.error('[WEBHOOK] Error processing:', error.message);
  }
});

// ─── Core message handler ───

async function handleIncomingMessage(messaging, pageId) {
  // Only process messages (not echoes, reads, etc.)
  if (!messaging.message || messaging.message.is_echo) return;

  const senderId = messaging.sender.id;
  const messageText = messaging.message.text;
  const timestamp = messaging.timestamp;

  if (!messageText) {
    console.log(`[MSG] Non-text message from ${senderId}, skipping`);
    return;
  }

  console.log(`[MSG] Received from ${senderId}: ${messageText}`);

  // Determine which page this is for
  const pageConfig = getPageByFbId(pageId) || { name: 'charmframes' };

  // Get or fetch creator profile
  let profile = { username: 'unknown', follower_count: 0, page: pageConfig.name };
  try {
    const igProfile = await instagram.getUserProfile(senderId);
    profile = { ...igProfile, page: pageConfig.name };
  } catch (e) {
    console.warn(`[MSG] Could not fetch profile for ${senderId}`);
  }

  // Set profile in conversation store
  conversationStore.setProfile(senderId, profile.username, pageConfig.name);

  // Add creator message to conversation history
  conversationStore.addMessage(senderId, 'creator', messageText);

  // Get full conversation for AI context
  const conversation = conversationStore.getConversation(senderId);

  // Generate AI response
  const aiResponse = await ai.generateResponse(conversation.messages, profile);

  if (!aiResponse || !aiResponse.message) {
    console.error('[MSG] AI returned no message');
    return;
  }

  console.log(`[AI] Response for ${senderId}: ${aiResponse.message}`);
  console.log(`[AI] Stage: ${aiResponse.conversation_stage} | Escalation: ${JSON.stringify(aiResponse.escalation)} | Qualification: ${JSON.stringify(aiResponse.qualification)}`);

  // Send the response on Instagram
  try {
    await instagram.sendMessage(senderId, aiResponse.message);
  } catch (sendError) {
    console.error(`[MSG] Failed to send IG message to ${senderId}:`, sendError.message);
    // Continue processing even if send fails (for testing)
  }

  // Store assistant message
  conversationStore.addMessage(senderId, 'assistant', aiResponse.message);

  // Update conversation stage
  if (aiResponse.conversation_stage) {
    conversationStore.updateStage(senderId, aiResponse.conversation_stage);
  }

  // Process qualification data
  if (aiResponse.qualification) {
    const q = aiResponse.qualification;
    conversationStore.updateQualification(senderId, q.field, q.value);
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
      profile.username || senderId,
      aiResponse.conversation_stage || 'unknown'
    );
  }

  // Check message threshold (10+ messages without booking)
  const updatedConvo = conversationStore.getConversation(senderId);
  if (updatedConvo.messageCount >= 10 && !updatedConvo.calendlySent) {
    // Only alert once
    const alreadyAlerted = updatedConvo.escalations.some(
      e => e.type === 'message_threshold'
    );
    if (!alreadyAlerted) {
      conversationStore.addEscalation(senderId, {
        type: 'message_threshold',
        reason: `${updatedConvo.messageCount} messages exchanged, no booking yet`,
      });
      await whatsapp.alertMessageThreshold(
        profile.username || senderId,
        updatedConvo.messageCount,
        `Stage: ${updatedConvo.conversationStage}`
      );
    }
  }

  // Log to Google Sheets
  const finalConvo = conversationStore.getConversation(senderId);
  await sheets.logConversation(finalConvo);

  console.log(`[MSG] Replied to @${profile.username}: ${aiResponse.message.substring(0, 50)}...`);
}

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
      // Clean up pending suggestions
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// ─── Start server ───

async function start() {
  // Initialize Google Sheets
  await sheets.init();

  app.listen(PORT, () => {
    console.log(`\n=================================`);
    console.log(`  Only Rising DM System`);
    console.log(`  Running on port ${PORT}`);
    console.log(`  Webhook: /webhook`);
    console.log(`=================================\n`);
  });
}

start();
