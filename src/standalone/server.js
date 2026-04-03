/**
 * Only Rising — Standalone DM Sales AI Server
 *
 * A self-contained API server that handles the AI conversation engine
 * independently of ManyChat. Can be deployed to any platform (Railway,
 * Render, Fly.io, VPS, etc.) and integrated with any messaging frontend.
 *
 * Endpoints:
 *   POST /api/message       — Send a creator message, get AI response
 *   POST /api/message/raw   — Same but returns raw text instead of JSON metadata
 *   GET  /api/conversation/:id — Get full conversation history
 *   GET  /api/conversations    — List all conversations
 *   DELETE /api/conversation/:id — Delete a conversation
 *   POST /api/reset/:id     — Reset a conversation
 *   GET  /health             — Health check
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY  — Required. Claude API key.
 *   PORT               — Optional. Default 3001.
 *   WHATSAPP_ALERTS    — Optional. Set to "true" to enable Twilio alerts.
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, MY_WHATSAPP_NUMBER
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), override: true }); } catch(e) {}
const express = require('express');
const path = require('path');

// Reuse the shared modules from the main app
const ConversationEngine = require('../ai/conversation-engine');
const conversationStore = require('../conversations/store');

// Optional: WhatsApp alerts (only if configured)
let whatsapp = null;
if (process.env.WHATSAPP_ALERTS === 'true' && process.env.TWILIO_ACCOUNT_SID) {
  const WhatsAppAlerts = require('../alerts/whatsapp');
  whatsapp = new WhatsAppAlerts(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
    process.env.TWILIO_WHATSAPP_FROM,
    process.env.MY_WHATSAPP_NUMBER
  );
}

const app = express();
const PORT = process.env.STANDALONE_PORT || process.env.PORT || 3001;

const ai = new ConversationEngine(process.env.ANTHROPIC_API_KEY);

app.use(express.json());

// CORS for external frontends
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Optional: simple API key auth
app.use('/api', (req, res, next) => {
  const apiKey = process.env.STANDALONE_API_KEY;
  if (!apiKey) return next(); // no key configured = open
  const provided = req.headers['authorization']?.replace('Bearer ', '') || req.query.api_key;
  if (provided !== apiKey) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

/**
 * POST /api/message
 *
 * Send a creator's message and get the AI response with full metadata.
 *
 * Body:
 * {
 *   "user_id": "unique_creator_id",        // Required. Any string that identifies this creator.
 *   "message": "the creator's message",     // Required. What the creator said.
 *   "username": "their_ig_handle",          // Optional. For context.
 *   "follower_count": 5000,                 // Optional. For context.
 *   "page": "charmframes"                   // Optional. Which page they messaged.
 * }
 *
 * Returns:
 * {
 *   "message": "the AI's response to send back",
 *   "qualification": {...} or null,
 *   "escalation": {...} or null,
 *   "send_calendly": false,
 *   "send_whatsapp_link": false,
 *   "conversation_stage": "building_trust",
 *   "conversation_id": "unique_creator_id",
 *   "message_count": 4
 * }
 */
app.post('/api/message', async (req, res) => {
  try {
    const { user_id, message, username, follower_count, page } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ error: 'user_id and message are required' });
    }

    const profile = {
      username: username || 'unknown',
      follower_count: follower_count || 0,
      page: page || 'standalone',
    };

    // Store profile and creator message
    conversationStore.setProfile(user_id, profile.username, profile.page);
    conversationStore.addMessage(user_id, 'creator', message);

    // Get full conversation for AI context
    const conversation = conversationStore.getConversation(user_id);

    // Generate AI response
    const aiResponse = await ai.generateResponse(conversation.messages, profile);

    if (!aiResponse || !aiResponse.message) {
      return res.status(500).json({ error: 'AI returned no message' });
    }

    // Store assistant message and update conversation
    conversationStore.addMessage(user_id, 'assistant', aiResponse.message);

    if (aiResponse.conversation_stage) {
      conversationStore.updateStage(user_id, aiResponse.conversation_stage);
    }

    if (aiResponse.qualification) {
      conversationStore.updateQualification(user_id, aiResponse.qualification.field, aiResponse.qualification.value);
    }

    if (aiResponse.send_calendly) {
      const convo = conversationStore.getConversation(user_id);
      convo.calendlySent = true;
      conversationStore.saveConversation(user_id, convo);
    }

    if (aiResponse.send_whatsapp_link) {
      const convo = conversationStore.getConversation(user_id);
      convo.whatsappLinkSent = true;
      conversationStore.saveConversation(user_id, convo);
    }

    // Process escalations
    if (aiResponse.escalation) {
      conversationStore.addEscalation(user_id, aiResponse.escalation);
      if (whatsapp) {
        await whatsapp.processEscalation(
          aiResponse.escalation,
          username || user_id,
          aiResponse.conversation_stage || 'unknown'
        );
      }
    }

    // Return the full response
    const updatedConvo = conversationStore.getConversation(user_id);
    res.json({
      ...aiResponse,
      conversation_id: user_id,
      message_count: updatedConvo.messageCount,
    });

  } catch (error) {
    console.error('[STANDALONE] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/message/raw
 *
 * Same as /api/message but returns just the text message (for simple integrations).
 */
app.post('/api/message/raw', async (req, res) => {
  try {
    const { user_id, message, username, follower_count, page } = req.body;

    if (!user_id || !message) {
      return res.status(400).json({ error: 'user_id and message are required' });
    }

    const profile = {
      username: username || 'unknown',
      follower_count: follower_count || 0,
      page: page || 'standalone',
    };

    conversationStore.setProfile(user_id, profile.username, profile.page);
    conversationStore.addMessage(user_id, 'creator', message);
    const conversation = conversationStore.getConversation(user_id);
    const aiResponse = await ai.generateResponse(conversation.messages, profile);

    if (!aiResponse || !aiResponse.message) {
      return res.status(500).json({ error: 'AI returned no message' });
    }

    conversationStore.addMessage(user_id, 'assistant', aiResponse.message);
    if (aiResponse.conversation_stage) {
      conversationStore.updateStage(user_id, aiResponse.conversation_stage);
    }
    if (aiResponse.qualification) {
      conversationStore.updateQualification(user_id, aiResponse.qualification.field, aiResponse.qualification.value);
    }

    res.json({ reply: aiResponse.message });

  } catch (error) {
    console.error('[STANDALONE] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/conversation/:id
 */
app.get('/api/conversation/:id', (req, res) => {
  const convo = conversationStore.getConversation(req.params.id);
  res.json(convo);
});

/**
 * GET /api/conversations
 */
app.get('/api/conversations', (req, res) => {
  const convos = conversationStore.getAllConversations();
  res.json(convos.map(c => ({
    user_id: c.igUserId,
    username: c.username,
    stage: c.conversationStage,
    messageCount: c.messageCount,
    lastMessage: c.messages[c.messages.length - 1]?.timestamp,
    qualification: c.qualification,
  })));
});

/**
 * DELETE /api/conversation/:id
 */
app.delete('/api/conversation/:id', (req, res) => {
  const fs = require('fs');
  const filePath = path.join(
    fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data'),
    'conversations',
    `${req.params.id}.json`
  );
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Conversation deleted' });
  } else {
    res.status(404).json({ error: 'Conversation not found' });
  }
});

/**
 * POST /api/reset/:id — Clear conversation history but keep profile
 */
app.post('/api/reset/:id', (req, res) => {
  const convo = conversationStore.getConversation(req.params.id);
  convo.messages = [];
  convo.messageCount = 0;
  convo.conversationStage = 'opening';
  convo.calendlySent = false;
  convo.whatsappLinkSent = false;
  convo.escalations = [];
  convo.qualification = {
    platform: null,
    traffic_source: null,
    subscriber_count: null,
    monthly_income: null,
    has_agency: null,
    agency_issues: null,
    content_hours: null,
    audience_location: null,
    niche: null,
    goal: null,
    urgency: null,
  };
  conversationStore.saveConversation(req.params.id, convo);
  res.json({ success: true, message: 'Conversation reset' });
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'standalone',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`\n=================================`);
  console.log(`  Only Rising Standalone API`);
  console.log(`  Running on port ${PORT}`);
  console.log(`  Alerts: ${whatsapp ? 'enabled' : 'disabled'}`);
  console.log(`=================================\n`);
});
