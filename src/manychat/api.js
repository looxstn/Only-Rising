const axios = require('axios');

const MANYCHAT_API_BASE = 'https://api.manychat.com/fb';

class ManyChatAPI {
  constructor(apiToken) {
    this.token = apiToken;
    this.axios = axios.create({
      baseURL: MANYCHAT_API_BASE,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  }

  // Send a text message to a subscriber via ManyChat
  async sendMessage(subscriberId, text) {
    try {
      const response = await this.axios.post('/sending/sendContent', {
        subscriber_id: subscriberId,
        data: {
          version: 'v2',
          content: {
            messages: [
              {
                type: 'text',
                text: text,
              },
            ],
          },
        },
      });
      console.log(`[MANYCHAT] Message sent to subscriber ${subscriberId}`);
      return response.data;
    } catch (error) {
      console.error(`[MANYCHAT] Error sending message:`, error.response?.data || error.message);
      throw error;
    }
  }

  // Get subscriber info by ID
  async getSubscriber(subscriberId) {
    try {
      const response = await this.axios.get('/subscriber/getInfo', {
        params: { subscriber_id: subscriberId },
      });
      return response.data?.data;
    } catch (error) {
      console.error(`[MANYCHAT] Error fetching subscriber:`, error.response?.data || error.message);
      return null;
    }
  }

  // Get subscriber info by custom field or name
  async findSubscriberByName(name) {
    try {
      const response = await this.axios.get('/subscriber/findByName', {
        params: { name },
      });
      return response.data?.data;
    } catch (error) {
      console.error(`[MANYCHAT] Error finding subscriber:`, error.response?.data || error.message);
      return null;
    }
  }

  // Set a custom field on a subscriber
  async setCustomField(subscriberId, fieldId, value) {
    try {
      const response = await this.axios.post('/subscriber/setCustomField', {
        subscriber_id: subscriberId,
        field_id: fieldId,
        field_value: value,
      });
      return response.data;
    } catch (error) {
      console.error(`[MANYCHAT] Error setting custom field:`, error.response?.data || error.message);
      return null;
    }
  }
}

module.exports = ManyChatAPI;
