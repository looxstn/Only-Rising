const axios = require('axios');

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

class InstagramAPI {
  constructor(pageAccessToken, igAccountId) {
    this.token = pageAccessToken;
    this.igAccountId = igAccountId;
  }

  // Send a DM reply to a user
  async sendMessage(recipientId, messageText) {
    try {
      const response = await axios.post(
        `${GRAPH_API_BASE}/me/messages`,
        {
          recipient: { id: recipientId },
          message: { text: messageText },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          params: { access_token: this.token },
        }
      );
      console.log(`[IG] Message sent to ${recipientId}`);
      return response.data;
    } catch (error) {
      console.error(`[IG] Error sending message:`, error.response?.data || error.message);
      throw error;
    }
  }

  // Get user profile info (username, name, follower count)
  async getUserProfile(igScopedUserId) {
    try {
      const response = await axios.get(
        `${GRAPH_API_BASE}/${igScopedUserId}`,
        {
          params: {
            fields: 'name,username,follower_count,is_verified_user',
            access_token: this.token,
          },
        }
      );
      return response.data;
    } catch (error) {
      // Fallback: profile info may not be available for all users
      console.warn(`[IG] Could not fetch profile for ${igScopedUserId}:`, error.response?.data?.error?.message || error.message);
      return { id: igScopedUserId, username: 'unknown', name: 'Unknown' };
    }
  }

  // Get conversation history with a user
  async getConversation(conversationId) {
    try {
      const response = await axios.get(
        `${GRAPH_API_BASE}/${conversationId}/messages`,
        {
          params: {
            fields: 'id,message,from,created_time',
            access_token: this.token,
          },
        }
      );
      return response.data.data || [];
    } catch (error) {
      console.error(`[IG] Error fetching conversation:`, error.response?.data || error.message);
      return [];
    }
  }

  // Find or get conversations
  async getConversations() {
    try {
      const response = await axios.get(
        `${GRAPH_API_BASE}/${this.igAccountId}/conversations`,
        {
          params: {
            platform: 'instagram',
            fields: 'id,participants,updated_time',
            access_token: this.token,
          },
        }
      );
      return response.data.data || [];
    } catch (error) {
      console.error(`[IG] Error fetching conversations:`, error.response?.data || error.message);
      return [];
    }
  }

  // Verify webhook signature
  static verifySignature(payload, signature, appSecret) {
    const crypto = require('crypto');
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('hex');
    return `sha256=${expectedSig}` === signature;
  }
}

module.exports = InstagramAPI;
