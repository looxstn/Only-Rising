const fs = require('fs');
const path = require('path');

// Use /data (Railway persistent volume) if available, otherwise local
const PERSIST_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data');
const CONVERSATIONS_DIR = path.join(PERSIST_DIR, 'conversations');

// Ensure data directory exists
if (!fs.existsSync(CONVERSATIONS_DIR)) {
  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
}

class ConversationStore {
  // Get or create a conversation record for a creator
  getConversation(igUserId) {
    const filePath = path.join(CONVERSATIONS_DIR, `${igUserId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    return {
      igUserId,
      username: null,
      page: null,
      firstMessageDate: null,
      messages: [],
      qualification: {
        platform: null,
        traffic_source: null,
        subscriber_count: null,
        monthly_income: null,
        has_agency: null,
      },
      escalations: [],
      messageCount: 0,
      conversationStage: 'opening',
      calendlySent: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // Save conversation to disk
  saveConversation(igUserId, conversation) {
    const filePath = path.join(CONVERSATIONS_DIR, `${igUserId}.json`);
    conversation.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(conversation, null, 2));
  }

  // Add a message to a conversation
  addMessage(igUserId, role, text) {
    const convo = this.getConversation(igUserId);
    convo.messages.push({
      role, // 'creator' or 'assistant'
      text,
      timestamp: new Date().toISOString(),
    });
    convo.messageCount = convo.messages.length;
    if (!convo.firstMessageDate) {
      convo.firstMessageDate = new Date().toISOString();
    }
    this.saveConversation(igUserId, convo);
    return convo;
  }

  // Update qualification data
  updateQualification(igUserId, field, value) {
    const convo = this.getConversation(igUserId);
    if (convo.qualification.hasOwnProperty(field)) {
      convo.qualification[field] = value;
      this.saveConversation(igUserId, convo);
    }
    return convo;
  }

  // Update conversation stage
  updateStage(igUserId, stage) {
    const convo = this.getConversation(igUserId);
    convo.conversationStage = stage;
    this.saveConversation(igUserId, convo);
    return convo;
  }

  // Add escalation event
  addEscalation(igUserId, escalation) {
    const convo = this.getConversation(igUserId);
    convo.escalations.push({
      ...escalation,
      timestamp: new Date().toISOString(),
    });
    this.saveConversation(igUserId, convo);
    return convo;
  }

  // Set creator profile info
  setProfile(igUserId, username, page) {
    const convo = this.getConversation(igUserId);
    convo.username = username;
    convo.page = page;
    this.saveConversation(igUserId, convo);
    return convo;
  }

  // Get all conversations (for reporting)
  getAllConversations() {
    const files = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      return JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf-8'));
    });
  }

  // Check if message count threshold reached
  checkMessageThreshold(igUserId, threshold = 10) {
    const convo = this.getConversation(igUserId);
    const creatorMessages = convo.messages.filter(m => m.role === 'creator').length;
    return creatorMessages >= threshold && !convo.calendlySent;
  }
}

module.exports = new ConversationStore();
