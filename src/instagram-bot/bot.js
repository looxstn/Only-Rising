const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = path.join(__dirname, '../../data/ig-session.json');
const PROCESSED_PATH = path.join(__dirname, '../../data/processed-messages.json');

class InstagramBot {
  constructor({ username, password, onMessage, onTwoFactorNeeded }) {
    this.username = username;
    this.password = password;
    this.onMessage = onMessage; // async callback(senderId, senderUsername, messageText)
    this.onTwoFactorNeeded = onTwoFactorNeeded; // async callback() - notify that 2FA is needed
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.waitingFor2FA = false;
    this.twoFactorCode = null;
    this.processedMessages = this.loadProcessed();
  }

  loadProcessed() {
    try {
      if (fs.existsSync(PROCESSED_PATH)) {
        const data = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf-8'));
        return new Set(data);
      }
    } catch {}
    return new Set();
  }

  saveProcessed() {
    const dir = path.dirname(PROCESSED_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Only keep last 5000 message IDs to prevent file bloat
    const arr = [...this.processedMessages].slice(-5000);
    fs.writeFileSync(PROCESSED_PATH, JSON.stringify(arr));
  }

  async init() {
    console.log('[BOT] Launching browser...');

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const contextOptions = {
      viewport: { width: 1366, height: 768 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-GB',
      timezoneId: 'Europe/London',
    };

    // Load saved session if available
    if (fs.existsSync(SESSION_PATH)) {
      console.log('[BOT] Loading saved session...');
      contextOptions.storageState = SESSION_PATH;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    // Block unnecessary resources for speed
    await this.page.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,webm}', route => route.abort());
    await this.page.route('**/logging_client_events*', route => route.abort());
  }

  async login() {
    console.log('[BOT] Navigating to Instagram...');
    await this.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await this.humanDelay(3000, 5000);

    // Check if already logged in
    const loggedIn = await this.isLoggedIn();
    if (loggedIn) {
      console.log('[BOT] Already logged in from saved session');
      await this.dismissPopups();
      await this.saveSession();
      return true;
    }

    console.log('[BOT] Logging in as @' + this.username + '...');

    try {
      // Wait for login form
      await this.page.waitForSelector('input[name="username"]', { timeout: 15000 });

      // Type username like a human
      await this.page.click('input[name="username"]');
      await this.humanDelay(300, 600);
      await this.humanType('input[name="username"]', this.username);
      await this.humanDelay(500, 1000);

      // Type password
      await this.page.click('input[name="password"]');
      await this.humanDelay(300, 600);
      await this.humanType('input[name="password"]', this.password);
      await this.humanDelay(800, 1500);

      // Click login
      await this.page.click('button[type="submit"]');
      console.log('[BOT] Login submitted, waiting...');

      // Wait for either success or 2FA
      await this.page.waitForNavigation({ timeout: 30000 }).catch(() => {});
      await this.humanDelay(3000, 5000);

      // Check for 2FA
      const twoFactorInput = await this.page.$('input[name="verificationCode"]');
      if (twoFactorInput) {
        console.log('[BOT] 2FA required. Waiting for code...');
        this.waitingFor2FA = true;

        // Notify that 2FA code is needed (sends WhatsApp alert)
        if (this.onTwoFactorNeeded) {
          await this.onTwoFactorNeeded();
        }

        // Wait up to 5 minutes for the code to be submitted
        const maxWait = 300000; // 5 minutes
        const checkInterval = 2000; // check every 2 seconds
        let waited = 0;

        while (!this.twoFactorCode && waited < maxWait) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waited += checkInterval;
        }

        if (!this.twoFactorCode) {
          console.error('[BOT] 2FA code not received within 5 minutes');
          this.waitingFor2FA = false;
          return false;
        }

        console.log('[BOT] 2FA code received, entering...');

        // Enter the 2FA code
        await this.page.fill('input[name="verificationCode"]', this.twoFactorCode);
        await this.humanDelay(500, 1000);

        // Click confirm/submit button
        const confirmBtn = await this.page.$('button:has-text("Confirm"), button[type="button"]:not([aria-label])');
        if (confirmBtn) {
          await confirmBtn.click();
        } else {
          await this.page.keyboard.press('Enter');
        }

        this.waitingFor2FA = false;
        this.twoFactorCode = null;

        await this.humanDelay(3000, 5000);
      }

      // Check if login succeeded
      const success = await this.isLoggedIn();
      if (!success) {
        console.error('[BOT] Login failed. Check credentials.');
        return false;
      }

      console.log('[BOT] Login successful');
      await this.dismissPopups();
      await this.saveSession();
      return true;
    } catch (error) {
      console.error('[BOT] Login error:', error.message);
      return false;
    }
  }

  async isLoggedIn() {
    try {
      // Multiple ways to detect logged in state
      const indicators = await Promise.race([
        this.page.waitForSelector('svg[aria-label="Home"]', { timeout: 5000 }).then(() => true),
        this.page.waitForSelector('a[href="/direct/inbox/"]', { timeout: 5000 }).then(() => true),
        this.page.waitForSelector('span[role="link"]:has-text("Direct")', { timeout: 5000 }).then(() => true),
      ]);
      return !!indicators;
    } catch {
      return false;
    }
  }

  async dismissPopups() {
    // Save login info popup
    try {
      const saveInfo = await this.page.$('button:has-text("Save info"), button:has-text("Save Info")');
      if (saveInfo) {
        await saveInfo.click();
        await this.humanDelay(1000, 2000);
      }
    } catch {}

    // Notifications popup
    try {
      const notNow = await this.page.$('button:has-text("Not Now"), button:has-text("not now")');
      if (notNow) {
        await notNow.click();
        await this.humanDelay(1000, 2000);
      }
    } catch {}
  }

  async saveSession() {
    const dir = path.dirname(SESSION_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const state = await this.context.storageState();
    fs.writeFileSync(SESSION_PATH, JSON.stringify(state));
    console.log('[BOT] Session saved');
  }

  // Navigate to DM inbox
  async goToInbox() {
    const currentUrl = this.page.url();
    if (!currentUrl.includes('/direct/inbox') && !currentUrl.includes('/direct/t/')) {
      console.log('[BOT] Navigating to DM inbox...');
      await this.page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded',
      });
      await this.humanDelay(2000, 4000);
      await this.dismissPopups();
    }
  }

  // Find conversations with unread messages
  async getUnreadConversations() {
    await this.goToInbox();
    await this.humanDelay(1000, 2000);

    const unreadConvos = [];

    try {
      // Instagram DM inbox: conversations are in a scrollable list
      // Unread conversations have bold text or a visual indicator
      // We look for conversation items that have unread styling

      // Get all conversation elements in the inbox
      const conversationItems = await this.page.$$('[role="listbox"] > div > div, div[class*="x9f619"] a[href*="/direct/t/"]');

      if (conversationItems.length === 0) {
        // Fallback: try clicking the messaging icon first
        try {
          const dmIcon = await this.page.$('svg[aria-label="Messenger"], svg[aria-label="Direct messaging"], a[href="/direct/inbox/"]');
          if (dmIcon) {
            await dmIcon.click();
            await this.humanDelay(2000, 3000);
          }
        } catch {}
      }

      // Get all links to conversations
      const convoLinks = await this.page.$$('a[href*="/direct/t/"]');

      for (const link of convoLinks) {
        try {
          // Check if this conversation has unread indicator
          // Instagram marks unread convos with a filled blue dot or bold text
          const parent = await link.evaluateHandle(el => el.closest('div[role="listitem"]') || el.parentElement?.parentElement);
          const hasUnread = await parent.evaluate(el => {
            // Check for bold/semibold font weight (unread indicator)
            const spans = el.querySelectorAll('span');
            for (const span of spans) {
              const style = window.getComputedStyle(span);
              if (style.fontWeight === '600' || style.fontWeight === '700' || style.fontWeight === 'bold') {
                return true;
              }
            }
            // Check for blue dot
            const dots = el.querySelectorAll('div[style*="background-color: rgb(0, 149, 246)"], div[class*="blue"]');
            if (dots.length > 0) return true;
            return false;
          });

          if (hasUnread) {
            const href = await link.getAttribute('href');
            const threadId = href.match(/\/direct\/t\/(\d+)/)?.[1];
            if (threadId) {
              unreadConvos.push({ element: link, threadId, href });
            }
          }
        } catch {}
      }
    } catch (error) {
      console.error('[BOT] Error scanning inbox:', error.message);
    }

    return unreadConvos;
  }

  // Open a specific conversation and read messages
  async openConversation(convo) {
    console.log(`[BOT] Opening conversation ${convo.threadId}...`);

    // Navigate directly to the conversation
    await this.page.goto(`https://www.instagram.com/direct/t/${convo.threadId}/`, {
      waitUntil: 'domcontentloaded',
    });
    await this.humanDelay(2000, 3000);

    // Being on the page triggers "Seen" receipt
    console.log(`[BOT] Conversation opened (Seen triggered)`);
  }

  // Get the username and latest message from the currently open conversation
  async getConversationInfo() {
    try {
      // Get the username from the conversation header
      let username = 'unknown';
      try {
        // The header usually has the username as a link
        const headerLink = await this.page.$('header a[href*="/"] span, div[role="heading"] span');
        if (headerLink) {
          username = await headerLink.textContent();
          username = username.trim().replace('@', '');
        }
      } catch {}

      // Get messages in the conversation
      // Messages are typically in div elements within the message thread
      const messages = await this.page.evaluate(() => {
        const result = [];
        // Instagram messages are in rows within the conversation
        const messageRows = document.querySelectorAll('div[role="row"]');

        for (const row of messageRows) {
          // Each row may contain a message
          const textElements = row.querySelectorAll('div[dir="auto"] span');
          for (const el of textElements) {
            const text = el.textContent?.trim();
            if (text && text.length > 0 && text.length < 2000) {
              // Try to determine if this is from the other user or from us
              // Messages from other users are typically on the left side
              const rect = row.getBoundingClientRect();
              const parentDiv = el.closest('div[class]');
              const style = parentDiv ? window.getComputedStyle(parentDiv) : null;

              result.push({
                text,
                // This is a heuristic: our messages tend to be right-aligned
                position: rect.left < window.innerWidth / 2 ? 'left' : 'right',
              });
            }
          }
        }

        return result;
      });

      // The last message from the other user (left side) is what we need to respond to
      const theirMessages = messages.filter(m => m.position === 'left');
      const latestMessage = theirMessages.length > 0 ? theirMessages[theirMessages.length - 1].text : null;

      return { username, latestMessage, allMessages: messages };
    } catch (error) {
      console.error('[BOT] Error reading conversation:', error.message);
      return { username: 'unknown', latestMessage: null, allMessages: [] };
    }
  }

  // Type a message with human-like keystrokes
  async typeAndSend(text) {
    try {
      // Find the message input
      const input = await this.page.$(
        'div[role="textbox"][contenteditable="true"], textarea[placeholder*="Message"], div[aria-label*="Message"]'
      );

      if (!input) {
        console.error('[BOT] Could not find message input');
        return false;
      }

      // Click the input to focus
      await input.click();
      await this.humanDelay(500, 1000);

      // Type character by character with human-like delays
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        await this.page.keyboard.type(char, { delay: 0 });

        // Variable delay between keystrokes
        // Faster for common letters, slower at word boundaries
        if (char === ' ' || char === '.' || char === ',' || char === '?' || char === '!') {
          await this.humanDelay(80, 200);
        } else if (char === '\n') {
          await this.humanDelay(200, 400);
        } else {
          await this.humanDelay(30, 90);
        }

        // Occasional longer pause (thinking while typing)
        if (Math.random() < 0.03) {
          await this.humanDelay(500, 1500);
        }
      }

      await this.humanDelay(300, 800);

      // Press Enter to send
      await this.page.keyboard.press('Enter');
      console.log(`[BOT] Message sent: ${text.substring(0, 50)}...`);

      await this.humanDelay(1000, 2000);
      return true;
    } catch (error) {
      console.error('[BOT] Error typing message:', error.message);
      return false;
    }
  }

  // Main polling loop
  async startPolling(intervalMs = 10000) {
    this.isRunning = true;
    console.log(`[BOT] Starting DM polling every ${intervalMs / 1000}s...`);

    while (this.isRunning) {
      try {
        await this.checkAndReply();
      } catch (error) {
        console.error('[BOT] Polling error:', error.message);
        // Try to recover
        try {
          await this.page.goto('https://www.instagram.com/direct/inbox/', {
            waitUntil: 'domcontentloaded',
          });
        } catch {}
      }

      // Wait before next check with some randomness
      const jitter = Math.floor(Math.random() * 5000);
      await this.humanDelay(intervalMs, intervalMs + jitter);
    }
  }

  async checkAndReply() {
    const unread = await this.getUnreadConversations();

    if (unread.length === 0) {
      return;
    }

    console.log(`[BOT] Found ${unread.length} unread conversation(s)`);

    for (const convo of unread) {
      try {
        // Open the conversation (triggers "Seen")
        await this.openConversation(convo);

        // Read the conversation info
        const info = await this.getConversationInfo();

        if (!info.latestMessage) {
          console.log(`[BOT] No readable message in conversation ${convo.threadId}`);
          continue;
        }

        // Create a unique message ID to avoid double-processing
        const msgId = `${convo.threadId}_${info.latestMessage.substring(0, 50)}`;
        if (this.processedMessages.has(msgId)) {
          console.log(`[BOT] Already processed message in ${convo.threadId}`);
          continue;
        }

        console.log(`[BOT] New message from @${info.username}: ${info.latestMessage}`);

        // Simulate reading time
        const readDelay = Math.min(info.latestMessage.length * 60, 4000) + 1000;
        console.log(`[BOT] Reading message (${readDelay}ms)...`);
        await this.humanDelay(readDelay, readDelay + 2000);

        // Call the message handler to get AI response
        if (this.onMessage) {
          const response = await this.onMessage(convo.threadId, info.username, info.latestMessage);

          if (response) {
            // Simulate thinking/typing delay based on response length
            const thinkDelay = Math.min(response.length * 25, 5000) + 2000;
            console.log(`[BOT] Thinking (${thinkDelay}ms)...`);
            await this.humanDelay(thinkDelay, thinkDelay + 3000);

            // Type and send the response
            await this.typeAndSend(response);
          }
        }

        // Mark as processed
        this.processedMessages.add(msgId);
        this.saveProcessed();

        // Go back to inbox for next conversation
        await this.goToInbox();
        await this.humanDelay(1000, 2000);
      } catch (error) {
        console.error(`[BOT] Error processing conversation ${convo.threadId}:`, error.message);
      }
    }
  }

  // Human-like random delay
  async humanDelay(minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  // Human-like typing into an input field (for login etc)
  async humanType(selector, text) {
    for (const char of text) {
      await this.page.type(selector, char, { delay: Math.floor(Math.random() * 100) + 30 });
    }
  }

  // Submit a 2FA code (called from the API endpoint)
  submit2FACode(code) {
    if (this.waitingFor2FA) {
      this.twoFactorCode = code.toString().trim();
      console.log('[BOT] 2FA code submitted');
      return true;
    }
    return false;
  }

  async stop() {
    console.log('[BOT] Stopping...');
    this.isRunning = false;
    if (this.browser) {
      await this.browser.close();
    }
  }
}

module.exports = InstagramBot;
