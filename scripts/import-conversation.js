#!/usr/bin/env node

/**
 * Import a past conversation as a training example.
 *
 * Usage:
 *   node scripts/import-conversation.js
 *
 * Or create a JSON file and import it:
 *   node scripts/import-conversation.js path/to/conversation.json
 *
 * JSON format:
 * {
 *   "name": "Creator A - Booked Call",
 *   "outcome": "Booked",
 *   "notes": "She was skeptical at first but came around after we explained our approach",
 *   "messages": [
 *     { "role": "creator", "text": "hey, what exactly do you guys do?" },
 *     { "role": "assistant", "text": "hey! so we run an OFSM agency..." },
 *     { "role": "creator", "text": "how is that different from other agencies?" },
 *     { "role": "assistant", "text": "good question. most agencies just..." }
 *   ]
 * }
 *
 * The "role" field should be:
 *   - "creator" for the OnlyFans creator's messages
 *   - "assistant" for your team's messages (the ones AI should learn from)
 */

const path = require('path');
const fs = require('fs');

// Add parent to path
const trainingExamples = require(path.join(__dirname, '../src/ai/training-examples'));

const args = process.argv.slice(2);

if (args.length > 0) {
  // Import from file
  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Support both single conversation and array of conversations
  const conversations = Array.isArray(data) ? data : [data];

  for (const convo of conversations) {
    if (!convo.name || !convo.messages) {
      console.error('Each conversation needs "name" and "messages" fields');
      continue;
    }
    trainingExamples.addExample(
      convo.name,
      convo.messages,
      convo.outcome || 'Unknown',
      convo.notes || ''
    );
    console.log(`Imported: ${convo.name}`);
  }

  console.log(`\nDone. ${conversations.length} conversation(s) imported.`);
  console.log(`Total training examples: ${trainingExamples.getAll().length}`);
} else {
  console.log(`
Usage:
  node scripts/import-conversation.js <path-to-json>

Create a JSON file with your past conversations. Format:

{
  "name": "Creator A - Booked Call",
  "outcome": "Booked",
  "notes": "Optional notes about what worked well",
  "messages": [
    { "role": "creator", "text": "their message" },
    { "role": "assistant", "text": "your response" }
  ]
}

You can also pass an array of conversations in one file:
[
  { "name": "...", "messages": [...] },
  { "name": "...", "messages": [...] }
]
  `);
}
