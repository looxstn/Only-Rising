const { google } = require('googleapis');

class SheetsLogger {
  constructor(credentials, spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = null;
    this.credentials = credentials;
  }

  async init() {
    if (!this.credentials || !this.spreadsheetId) {
      console.log('[SHEETS] Not configured, logging to console only');
      return false;
    }

    try {
      const auth = new google.auth.GoogleAuth({
        credentials: this.credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });

      // Ensure headers exist
      await this.ensureHeaders();
      console.log('[SHEETS] Connected successfully');
      return true;
    } catch (error) {
      console.error('[SHEETS] Init error:', error.message);
      return false;
    }
  }

  async ensureHeaders() {
    const headers = [
      'Instagram Username',
      'Page They Messaged',
      'Date First Message',
      'Platform',
      'Main Traffic Source',
      'Subscriber Count',
      'Monthly Income',
      'Currently With Agency',
      'Conversation Outcome',
      'Number of Messages',
      'Link to Transcript',
      'Notes',
    ];

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: 'Sheet1!A1:L1',
      });

      if (!response.data.values || response.data.values.length === 0) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: 'Sheet1!A1:L1',
          valueInputOption: 'RAW',
          resource: { values: [headers] },
        });
        console.log('[SHEETS] Headers created');
      }
    } catch (error) {
      // If sheet doesn't exist yet, try to create headers
      console.warn('[SHEETS] Header check failed:', error.message);
    }
  }

  // Find existing row for a username, or return null
  async findRow(username) {
    if (!this.sheets) return null;

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: 'Sheet1!A:A',
      });

      const rows = response.data.values || [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === username) {
          return i + 1; // 1-indexed
        }
      }
      return null;
    } catch (error) {
      console.error('[SHEETS] Find row error:', error.message);
      return null;
    }
  }

  // Log or update a conversation
  async logConversation(conversation) {
    if (!this.sheets) {
      console.log(`[SHEETS LOG] @${conversation.username} | Messages: ${conversation.messageCount} | Stage: ${conversation.conversationStage}`);
      return;
    }

    const username = conversation.username || 'unknown';
    const q = conversation.qualification || {};

    const rowData = [
      username,
      conversation.page || 'charmframes',
      conversation.firstMessageDate ? new Date(conversation.firstMessageDate).toLocaleDateString() : '',
      q.platform || '',
      q.traffic_source || '',
      q.subscriber_count || '',
      q.monthly_income || '',
      q.has_agency !== null ? (q.has_agency ? 'Yes' : 'No') : '',
      '', // Outcome - left blank for manual entry
      conversation.messageCount || 0,
      '', // Transcript link - can be filled with a hosted URL later
      '', // Notes - left blank for manual entry
    ];

    try {
      const existingRow = await this.findRow(username);

      if (existingRow) {
        // Update existing row (preserve outcome and notes columns)
        const existing = await this.sheets.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `Sheet1!A${existingRow}:L${existingRow}`,
        });
        const currentData = existing.data.values?.[0] || [];

        // Keep outcome (col 8) and notes (col 11) if already filled
        rowData[8] = currentData[8] || '';
        rowData[10] = currentData[10] || '';
        rowData[11] = currentData[11] || '';

        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `Sheet1!A${existingRow}:L${existingRow}`,
          valueInputOption: 'RAW',
          resource: { values: [rowData] },
        });
        console.log(`[SHEETS] Updated row for @${username}`);
      } else {
        // Append new row
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId,
          range: 'Sheet1!A:L',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: [rowData] },
        });
        console.log(`[SHEETS] New row added for @${username}`);
      }
    } catch (error) {
      console.error('[SHEETS] Log error:', error.message);
    }
  }

  // Get all rows with outcomes filled in (for feedback loop)
  async getOutcomeData() {
    if (!this.sheets) return [];

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: 'Sheet1!A2:L',
      });

      const rows = response.data.values || [];
      return rows
        .filter(row => row[8] && row[8].trim() !== '') // Has outcome
        .map(row => ({
          username: row[0] || '',
          page: row[1] || '',
          date: row[2] || '',
          platform: row[3] || '',
          traffic_source: row[4] || '',
          subscriber_count: row[5] || '',
          monthly_income: row[6] || '',
          has_agency: row[7] || '',
          outcome: row[8] || '',
          message_count: row[9] || '',
          transcript: row[10] || '',
          notes: row[11] || '',
        }));
    } catch (error) {
      console.error('[SHEETS] Get outcome data error:', error.message);
      return [];
    }
  }
}

module.exports = SheetsLogger;
