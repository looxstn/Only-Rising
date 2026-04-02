const fs = require('fs');
const path = require('path');

const EXAMPLES_DIR = path.join(__dirname, '../../data/training-examples');

// Ensure directory exists
if (!fs.existsSync(EXAMPLES_DIR)) {
  fs.mkdirSync(EXAMPLES_DIR, { recursive: true });
}

class TrainingExamples {
  // Load all training examples
  getAll() {
    const files = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      return JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf-8'));
    });
  }

  // Add a training example (a past conversation that led to a booking)
  addExample(name, messages, outcome, notes) {
    const example = {
      name,
      messages, // Array of { role: 'creator' | 'assistant', text: '...' }
      outcome,  // 'Booked', 'Closed', etc.
      notes,
      addedAt: new Date().toISOString(),
    };

    const filename = `${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(EXAMPLES_DIR, filename),
      JSON.stringify(example, null, 2)
    );
    console.log(`[TRAINING] Added example: ${name}`);
    return example;
  }

  // Build a training context block for the system prompt
  buildTrainingContext() {
    const examples = this.getAll();
    if (examples.length === 0) return '';

    let context = '\n\nTRAINING EXAMPLES:\nBelow are real conversations that successfully led to bookings. Study the tone, pacing, and how objections were handled. Use these as a reference for your own responses but do not copy them word for word.\n';

    for (const example of examples) {
      context += `\n--- Example: ${example.name} (Outcome: ${example.outcome}) ---\n`;
      if (example.notes) {
        context += `Notes: ${example.notes}\n`;
      }
      for (const msg of example.messages) {
        const label = msg.role === 'creator' ? 'Creator' : 'Us';
        context += `${label}: ${msg.text}\n`;
      }
      context += '--- End ---\n';
    }

    return context;
  }
}

module.exports = new TrainingExamples();
