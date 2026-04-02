const twilio = require('twilio');

class WhatsAppAlerts {
  constructor(accountSid, authToken, fromNumber, toNumber) {
    this.client = accountSid && authToken ? twilio(accountSid, authToken) : null;
    this.from = fromNumber; // Twilio WhatsApp sandbox number: 'whatsapp:+14155238886'
    this.to = toNumber; // Your WhatsApp number: 'whatsapp:+44...'
  }

  async sendAlert(message) {
    if (!this.client) {
      console.log(`[WHATSAPP ALERT] (not configured, logging only): ${message}`);
      return null;
    }

    try {
      const result = await this.client.messages.create({
        body: message,
        from: this.from,
        to: this.to,
      });
      console.log(`[WHATSAPP] Alert sent: ${result.sid}`);
      return result;
    } catch (error) {
      console.error(`[WHATSAPP] Error sending alert:`, error.message);
      // Don't throw - alerts failing shouldn't break the main flow
      return null;
    }
  }

  // Escalation alert: creator asking for proof/results
  async alertProofRequest(username, summary) {
    return this.sendAlert(
      `Only Rising Alert\n\n@${username} is asking for live results.\n\n${summary}\n\nHandle manually if needed.`
    );
  }

  // Escalation alert: voice note suggested
  async alertVoiceNoteSuggested(username, summary) {
    return this.sendAlert(
      `Only Rising Alert\n\n@${username} could use a voice note right now.\n\n${summary}\n\nSending one could help build trust.`
    );
  }

  // Escalation alert: high value creator
  async alertHighValue(username, summary) {
    return this.sendAlert(
      `Only Rising Alert\n\nHigh value creator: @${username}\n\n${summary}\n\nMight want to jump in personally.`
    );
  }

  // Escalation alert: creator going cold
  async alertGoingCold(username, summary) {
    return this.sendAlert(
      `Only Rising Alert\n\n@${username} is going cold after being warm.\n\n${summary}\n\nMight need a personal touch.`
    );
  }

  // Escalation alert: 10+ messages without booking
  async alertMessageThreshold(username, messageCount, summary) {
    return this.sendAlert(
      `Only Rising Alert\n\n@${username} has exchanged ${messageCount} messages with no booking yet.\n\n${summary}\n\nConsider stepping in.`
    );
  }

  // Process escalation from AI response
  async processEscalation(escalation, username, conversationStage) {
    if (!escalation) return;

    const summary = `Stage: ${conversationStage}. ${escalation.reason}`;

    switch (escalation.type) {
      case 'proof_request':
        return this.alertProofRequest(username, summary);
      case 'voice_note_suggested':
        return this.alertVoiceNoteSuggested(username, summary);
      case 'high_value':
        return this.alertHighValue(username, summary);
      case 'going_cold':
        return this.alertGoingCold(username, summary);
      default:
        console.warn(`[WHATSAPP] Unknown escalation type: ${escalation.type}`);
    }
  }

  // Weekly summary alert
  async sendWeeklySummary(summaryText) {
    return this.sendAlert(`Only Rising Weekly Summary\n\n${summaryText}`);
  }

  // Send prompt update suggestions for approval
  async sendPromptSuggestions(suggestions) {
    let message = `Only Rising Prompt Update Suggestions\n\n`;
    suggestions.forEach((s, i) => {
      message += `${i + 1}. ${s.description}\n`;
    });
    message += `\nReply with the numbers you approve (e.g. "1,3") or "none" to reject all.`;
    return this.sendAlert(message);
  }
}

module.exports = WhatsAppAlerts;
