const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

class WeeklyAnalysis {
  constructor(anthropicKey, sheetsLogger, whatsAppAlerts) {
    this.client = new Anthropic({ apiKey: anthropicKey });
    this.sheets = sheetsLogger;
    this.alerts = whatsAppAlerts;
    this.systemPromptPath = path.join(__dirname, '../../prompts/system-prompt.md');
    this.pendingSuggestionsPath = path.join(__dirname, '../../data/pending-suggestions.json');
  }

  async run() {
    console.log('[FEEDBACK] Running weekly analysis...');

    // 1. Get all outcome data from sheets
    const outcomeData = await this.sheets.getOutcomeData();

    if (outcomeData.length === 0) {
      console.log('[FEEDBACK] No outcome data to analyse yet');
      return;
    }

    // 2. Categorise outcomes
    const successful = outcomeData.filter(r =>
      ['Booked', 'Showed Up', 'Closed'].includes(r.outcome)
    );
    const unsuccessful = outcomeData.filter(r =>
      ['Ghosted', 'Not Qualified', 'No Show'].includes(r.outcome)
    );
    const stillWarm = outcomeData.filter(r => r.outcome === 'Still Warm');

    // 3. Build analysis prompt
    const currentPrompt = fs.readFileSync(this.systemPromptPath, 'utf-8');

    const analysisPrompt = `You are an analyst for an OnlyFans management agency called Only Rising.

Analyse the following conversation outcome data and provide insights.

SUCCESSFUL OUTCOMES (Booked, Showed Up, or Closed):
${JSON.stringify(successful, null, 2)}

UNSUCCESSFUL OUTCOMES (Ghosted or Not Qualified):
${JSON.stringify(unsuccessful, null, 2)}

STILL WARM:
${JSON.stringify(stillWarm, null, 2)}

CURRENT AI SYSTEM PROMPT:
${currentPrompt}

Please provide:

1. WEEKLY SUMMARY (keep it short, max 5 bullet points):
   - Total conversations this period
   - Conversion rate (booked / total)
   - Best performing platform
   - Best performing traffic source
   - Any notable patterns

2. PATTERN ANALYSIS:
   - Which platforms convert best
   - Which income ranges convert best
   - Which traffic sources correlate with bookings
   - Which message counts lead to bookings vs ghosting
   - Any patterns in creators who ghost vs book

3. PROMPT IMPROVEMENT SUGGESTIONS (max 3):
   For each suggestion provide:
   - description: what to change and why
   - current_text: the exact text in the current prompt to replace (or "ADD" if adding new content)
   - new_text: the replacement text
   - confidence: high/medium/low

Respond in JSON format:
{
  "summary": "short summary text",
  "patterns": { ... },
  "suggestions": [
    {
      "description": "...",
      "current_text": "...",
      "new_text": "...",
      "confidence": "..."
    }
  ]
}`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: analysisPrompt }],
      });

      const rawText = response.content[0].text;
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

      if (!analysis) {
        console.error('[FEEDBACK] Could not parse analysis response');
        return;
      }

      // 4. Send WhatsApp summary
      await this.alerts.sendWeeklySummary(analysis.summary);

      // 5. If there are suggestions, save them and send for approval
      if (analysis.suggestions && analysis.suggestions.length > 0) {
        // Save pending suggestions
        fs.writeFileSync(
          this.pendingSuggestionsPath,
          JSON.stringify(analysis.suggestions, null, 2)
        );

        await this.alerts.sendPromptSuggestions(analysis.suggestions);
        console.log('[FEEDBACK] Suggestions sent for approval');
      }

      console.log('[FEEDBACK] Weekly analysis complete');
      return analysis;
    } catch (error) {
      console.error('[FEEDBACK] Analysis error:', error.message);
      throw error;
    }
  }

  // Process approval response (called when you reply to WhatsApp)
  async processApproval(approvedNumbers) {
    const suggestionsPath = this.pendingSuggestionsPath;

    if (!fs.existsSync(suggestionsPath)) {
      console.log('[FEEDBACK] No pending suggestions');
      return;
    }

    const suggestions = JSON.parse(fs.readFileSync(suggestionsPath, 'utf-8'));
    let currentPrompt = fs.readFileSync(this.systemPromptPath, 'utf-8');
    let appliedCount = 0;

    for (const num of approvedNumbers) {
      const index = num - 1; // Convert 1-indexed to 0-indexed
      if (index >= 0 && index < suggestions.length) {
        const suggestion = suggestions[index];

        if (suggestion.current_text === 'ADD') {
          // Append new content
          currentPrompt += '\n\n' + suggestion.new_text;
        } else {
          // Replace existing text
          currentPrompt = currentPrompt.replace(
            suggestion.current_text,
            suggestion.new_text
          );
        }
        appliedCount++;
        console.log(`[FEEDBACK] Applied suggestion ${num}: ${suggestion.description}`);
      }
    }

    if (appliedCount > 0) {
      // Backup current prompt
      const backupPath = path.join(
        __dirname,
        '../../prompts',
        `system-prompt.backup.${Date.now()}.md`
      );
      const originalPrompt = fs.readFileSync(this.systemPromptPath, 'utf-8');
      fs.writeFileSync(backupPath, originalPrompt);

      // Write updated prompt
      fs.writeFileSync(this.systemPromptPath, currentPrompt);
      console.log(`[FEEDBACK] Prompt updated with ${appliedCount} changes. Backup saved.`);
    }

    // Clean up pending suggestions
    fs.unlinkSync(suggestionsPath);
    return appliedCount;
  }
}

module.exports = WeeklyAnalysis;
