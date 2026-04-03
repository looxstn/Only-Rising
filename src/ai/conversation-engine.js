const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const trainingExamples = require('./training-examples');

class ConversationEngine {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.systemPromptPath = path.join(__dirname, '../../prompts/system-prompt.md');
  }

  getSystemPrompt() {
    const basePrompt = fs.readFileSync(this.systemPromptPath, 'utf-8');
    const trainingContext = trainingExamples.buildTrainingContext();
    return basePrompt + trainingContext;
  }

  // Build conversation history for Claude from stored messages
  buildMessages(conversationHistory, creatorProfile) {
    const messages = [];

    // Add creator context as first user message context
    const contextNote = `[INTERNAL CONTEXT - not part of the conversation]
Creator: @${creatorProfile.username || 'unknown'}
Followers: ${creatorProfile.follower_count || 'unknown'}
Page they messaged: ${creatorProfile.page || 'charmframes'}
This creator responded to our cold outreach DM. Continue the conversation naturally.`;

    for (let i = 0; i < conversationHistory.length; i++) {
      const msg = conversationHistory[i];
      if (msg.role === 'creator') {
        let content = msg.text;
        // Prepend context to first creator message
        if (i === 0) {
          content = `${contextNote}\n\n[Creator's message]: ${msg.text}`;
        }
        messages.push({ role: 'user', content });
      } else if (msg.role === 'assistant') {
        messages.push({ role: 'assistant', content: msg.text });
      }
    }

    return messages;
  }

  async generateResponse(conversationHistory, creatorProfile) {
    const messages = this.buildMessages(conversationHistory, creatorProfile);
    const systemPrompt = this.getSystemPrompt();

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      });

      const rawText = response.content[0].text;

      // Parse the JSON response
      let parsed;
      try {
        // Try to extract JSON from the response
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          // Fallback: treat entire response as the message
          parsed = {
            message: rawText,
            qualification: null,
            escalation: null,
            send_calendly: false,
            conversation_stage: 'building_trust',
          };
        }
      } catch (parseError) {
        console.warn('[AI] Failed to parse JSON response, using raw text');
        parsed = {
          message: rawText,
          qualification: null,
          escalation: null,
          send_calendly: false,
          conversation_stage: 'building_trust',
        };
      }

      // Insert Calendly link if needed
      if (parsed.send_calendly && parsed.message) {
        parsed.message = parsed.message.replace(
          '[CALENDLY_LINK]',
          'https://calendly.com/only-rising/ofsm-deployment'
        );
      }

      // Insert WhatsApp link if needed
      if (parsed.send_whatsapp_link && parsed.message && !parsed.message.includes('wa.me')) {
        parsed.message += '\nhttps://wa.me/447828765884';
      }

      return parsed;
    } catch (error) {
      console.error('[AI] Error generating response:', error.message);
      throw error;
    }
  }
}

module.exports = ConversationEngine;
