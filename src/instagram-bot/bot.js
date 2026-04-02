const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = path.join(__dirname, '../../data/ig-session.json');
const PROCESSED_PATH = path.join(__dirname, '../../data/processed-messages.json');

class InstagramBot {
  constructor({ username, password, onMessage, onTwoFactorNeeded }) {
    this.username = username;
    this.password = password;
    this.onMessage = onMessage;
    this.onTwoFactorNeeded = onTwoFactorNeeded;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.waitingFor2FA = false;
    this.twoFactorCode = null;
    this.processedMessages = this.loadProcessed();
    this.messageCount = 0; // track messages this session for rate limiting
    this.sessionStart = Date.now();
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
    const arr = [...this.processedMessages].slice(-5000);
    fs.writeFileSync(PROCESSED_PATH, JSON.stringify(arr));
  }

  // ─── Anti-detection: check if we should be "active" right now ───
  // Simulates a real person who isn't online 24/7
  isActiveHours() {
    const hour = new Date().getUTCHours();
    // Active roughly 8am-11pm UTC (adjust based on your timezone)
    // Add some randomness so it's not exact
    const activeStart = 7 + Math.floor(Math.random() * 2); // 7-8am
    const activeEnd = 22 + Math.floor(Math.random() * 2); // 22-23pm
    return hour >= activeStart && hour <= activeEnd;
  }

  // ─── Anti-detection: rate limit messages per hour ───
  shouldRateLimit() {
    const hoursRunning = (Date.now() - this.sessionStart) / (1000 * 60 * 60);
    const messagesPerHour = this.messageCount / Math.max(hoursRunning, 0.1);
    // A real person wouldn't reply to more than ~15-20 conversations per hour
    return messagesPerHour > 15;
  }

  async init() {
    console.log('[BOT] Launching browser...');

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    });

    // Randomise viewport slightly each session (real screens vary)
    const widths = [1280, 1366, 1440, 1536, 1920];
    const heights = [720, 768, 900, 864, 1080];
    const vpWidth = widths[Math.floor(Math.random() * widths.length)];
    const vpHeight = heights[Math.floor(Math.random() * heights.length)];

    // Rotate user agents to look like different devices
    const userAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    ];
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

    const contextOptions = {
      viewport: { width: vpWidth, height: vpHeight },
      userAgent: ua,
      locale: 'en-GB',
      timezoneId: 'Europe/London',
      // Realistic device pixel ratio
      deviceScaleFactor: Math.random() > 0.5 ? 2 : 1,
    };

    // Load saved session if available
    if (fs.existsSync(SESSION_PATH)) {
      console.log('[BOT] Loading saved session...');
      contextOptions.storageState = SESSION_PATH;
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();

    // ─── Anti-detection: mask automation signals ───
    await this.page.addInitScript(() => {
      // Hide webdriver flag
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Fake plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      // Fake languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-GB', 'en-US', 'en'],
      });
      // Override permissions query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    });

    // Don't block images — a real user loads images. Only block tracking/analytics
    await this.page.route('**/logging_client_events*', route => route.abort());
    await this.page.route('**/batch/log*', route => route.abort());
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
      await this.page.waitForSelector('input[name="username"]', { timeout: 15000 });

      // Click the field first, wait, then type slowly like a real person
      await this.page.click('input[name="username"]');
      await this.humanDelay(400, 800);
      await this.humanType('input[name="username"]', this.username);
      await this.humanDelay(600, 1200);

      // Tab to password field like a human would
      await this.page.keyboard.press('Tab');
      await this.humanDelay(300, 700);
      await this.humanType('input[name="password"]', this.password);
      await this.humanDelay(1000, 2000);

      // Click login
      await this.page.click('button[type="submit"]');
      console.log('[BOT] Login submitted, waiting...');

      await this.page.waitForNavigation({ timeout: 30000 }).catch(() => {});
      await this.humanDelay(3000, 5000);

      // Check for 2FA
      const twoFactorInput = await this.page.$('input[name="verificationCode"]');
      if (twoFactorInput) {
        console.log('[BOT] 2FA required. Waiting for code...');
        this.waitingFor2FA = true;

        if (this.onTwoFactorNeeded) {
          await this.onTwoFactorNeeded();
        }

        const maxWait = 300000;
        const checkInterval = 2000;
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
        await this.humanType('input[name="verificationCode"]', this.twoFactorCode);
        await this.humanDelay(500, 1000);

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
    try {
      const saveInfo = await this.page.$('button:has-text("Save info"), button:has-text("Save Info")');
      if (saveInfo) {
        await saveInfo.click();
        await this.humanDelay(1000, 2000);
      }
    } catch {}

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

  async getUnreadConversations() {
    await this.goToInbox();
    await this.humanDelay(1500, 3000);

    const unreadConvos = [];

    try {
      const conversationItems = await this.page.$$('[role="listbox"] > div > div, div[class*="x9f619"] a[href*="/direct/t/"]');

      if (conversationItems.length === 0) {
        try {
          const dmIcon = await this.page.$('svg[aria-label="Messenger"], svg[aria-label="Direct messaging"], a[href="/direct/inbox/"]');
          if (dmIcon) {
            await dmIcon.click();
            await this.humanDelay(2000, 3000);
          }
        } catch {}
      }

      const convoLinks = await this.page.$$('a[href*="/direct/t/"]');

      for (const link of convoLinks) {
        try {
          const parent = await link.evaluateHandle(el => el.closest('div[role="listitem"]') || el.parentElement?.parentElement);
          const hasUnread = await parent.evaluate(el => {
            const spans = el.querySelectorAll('span');
            for (const span of spans) {
              const style = window.getComputedStyle(span);
              if (style.fontWeight === '600' || style.fontWeight === '700' || style.fontWeight === 'bold') {
                return true;
              }
            }
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

  async openConversation(convo) {
    console.log(`[BOT] Opening conversation ${convo.threadId}...`);
    await this.page.goto(`https://www.instagram.com/direct/t/${convo.threadId}/`, {
      waitUntil: 'domcontentloaded',
    });
    await this.humanDelay(2000, 3000);
    console.log(`[BOT] Conversation opened (Seen triggered)`);
  }

  async getConversationInfo() {
    try {
      let username = 'unknown';
      try {
        const headerLink = await this.page.$('header a[href*="/"] span, div[role="heading"] span');
        if (headerLink) {
          username = await headerLink.textContent();
          username = username.trim().replace('@', '');
        }
      } catch {}

      const messages = await this.page.evaluate(() => {
        const result = [];
        const messageRows = document.querySelectorAll('div[role="row"]');

        for (const row of messageRows) {
          const textElements = row.querySelectorAll('div[dir="auto"] span');
          for (const el of textElements) {
            const text = el.textContent?.trim();
            if (text && text.length > 0 && text.length < 2000) {
              const rect = row.getBoundingClientRect();
              result.push({
                text,
                position: rect.left < window.innerWidth / 2 ? 'left' : 'right',
              });
            }
          }
        }

        return result;
      });

      const theirMessages = messages.filter(m => m.position === 'left');
      const latestMessage = theirMessages.length > 0 ? theirMessages[theirMessages.length - 1].text : null;

      return { username, latestMessage, allMessages: messages };
    } catch (error) {
      console.error('[BOT] Error reading conversation:', error.message);
      return { username: 'unknown', latestMessage: null, allMessages: [] };
    }
  }

  // ─── Human-like typing with realistic patterns ───
  async typeAndSend(text) {
    try {
      const input = await this.page.$(
        'div[role="textbox"][contenteditable="true"], textarea[placeholder*="Message"], div[aria-label*="Message"]'
      );

      if (!input) {
        console.error('[BOT] Could not find message input');
        return false;
      }

      // Click the input to focus
      await input.click();
      await this.humanDelay(600, 1200);

      // Type in bursts like a real person (type a few words, pause, type more)
      const words = text.split(' ');
      let charIndex = 0;

      for (let w = 0; w < words.length; w++) {
        const word = words[w];
        const isLastWord = w === words.length - 1;

        // Type each character of the word
        for (let i = 0; i < word.length; i++) {
          const char = word[i];
          await this.page.keyboard.type(char, { delay: 0 });

          // Base typing speed: 35-85ms per character (realistic WPM range)
          const baseDelay = Math.floor(Math.random() * 50) + 35;

          // Slow down for punctuation
          if ('.!?,;:'.includes(char)) {
            await this.humanDelay(100, 250);
          } else {
            await this.humanDelay(baseDelay, baseDelay + 30);
          }
        }

        // Add space between words (not after last word)
        if (!isLastWord) {
          await this.page.keyboard.type(' ', { delay: 0 });
          await this.humanDelay(50, 120);
        }

        // Occasional pause between words (thinking while typing)
        // More likely at sentence boundaries or after every 4-8 words
        if (!isLastWord) {
          const wordsSinceLastPause = w % (Math.floor(Math.random() * 5) + 4);
          if (wordsSinceLastPause === 0 && Math.random() < 0.4) {
            await this.humanDelay(800, 2500);
          }
        }

        // Rare: simulate a typo and correction (makes it look very human)
        if (Math.random() < 0.02 && word.length > 4) {
          // Type a wrong char, pause, backspace, type the right one
          await this.page.keyboard.type('x', { delay: 0 });
          await this.humanDelay(200, 400);
          await this.page.keyboard.press('Backspace');
          await this.humanDelay(100, 300);
        }
      }

      // Pause before sending (reviewing the message)
      await this.humanDelay(500, 1500);

      // Press Enter to send
      await this.page.keyboard.press('Enter');
      console.log(`[BOT] Message sent: ${text.substring(0, 60)}...`);

      // Stay on the conversation briefly like a real person would
      await this.humanDelay(1500, 3000);
      return true;
    } catch (error) {
      console.error('[BOT] Error typing message:', error.message);
      return false;
    }
  }

  // ─── Main polling loop with human-like patterns ───
  async startPolling(intervalMs = 15000) {
    this.isRunning = true;
    console.log(`[BOT] Starting DM monitoring...`);

    while (this.isRunning) {
      try {
        // Don't respond outside active hours (like a real person sleeping)
        if (!this.isActiveHours()) {
          console.log('[BOT] Outside active hours, sleeping...');
          await this.humanDelay(300000, 600000); // check again in 5-10 mins
          continue;
        }

        // Rate limit: don't reply too fast
        if (this.shouldRateLimit()) {
          console.log('[BOT] Rate limiting, taking a break...');
          await this.humanDelay(120000, 300000); // 2-5 min break
          continue;
        }

        await this.checkAndReply();
      } catch (error) {
        console.error('[BOT] Polling error:', error.message);
        try {
          await this.page.goto('https://www.instagram.com/direct/inbox/', {
            waitUntil: 'domcontentloaded',
          });
        } catch {}
      }

      // Variable polling interval (not a fixed pattern)
      // Real people don't check DMs at exact intervals
      const baseWait = intervalMs;
      const variation = Math.floor(Math.random() * 20000); // 0-20s extra
      const occasionalLongPause = Math.random() < 0.1 ? Math.floor(Math.random() * 60000) : 0; // 10% chance of extra 0-60s pause
      await this.humanDelay(baseWait + variation, baseWait + variation + occasionalLongPause + 5000);

      // Periodically save session to stay logged in
      if (Math.random() < 0.05) {
        await this.saveSession();
      }
    }
  }

  async checkAndReply() {
    const unread = await this.getUnreadConversations();

    if (unread.length === 0) {
      return;
    }

    console.log(`[BOT] Found ${unread.length} unread conversation(s)`);

    // Don't process all at once — a real person handles them one at a time
    // with breaks in between
    const maxToProcess = Math.min(unread.length, 3); // max 3 at a time

    for (let i = 0; i < maxToProcess; i++) {
      const convo = unread[i];
      try {
        // Open the conversation (triggers "Seen")
        await this.openConversation(convo);

        // Realistic reading time — actually read the message
        const info = await this.getConversationInfo();

        if (!info.latestMessage) {
          console.log(`[BOT] No readable message in conversation ${convo.threadId}`);
          continue;
        }

        const msgId = `${convo.threadId}_${info.latestMessage.substring(0, 50)}`;
        if (this.processedMessages.has(msgId)) {
          console.log(`[BOT] Already processed message in ${convo.threadId}`);
          continue;
        }

        console.log(`[BOT] New message from @${info.username}: ${info.latestMessage}`);

        // ─── Realistic response timing ───
        // A real person: sees message → reads it → thinks → types reply

        // 1. Reading time (based on message length, ~200-250 WPM reading speed)
        const wordCount = info.latestMessage.split(' ').length;
        const readingMs = Math.max(wordCount * 300, 2000) + Math.floor(Math.random() * 3000);
        console.log(`[BOT] Reading (${Math.round(readingMs/1000)}s)...`);
        await this.humanDelay(readingMs, readingMs + 2000);

        // 2. Sometimes a person doesn't reply immediately — they might:
        //    - Check the profile first
        //    - Think about what to say
        //    - Get distracted briefly
        if (Math.random() < 0.3) {
          const extraThinkTime = Math.floor(Math.random() * 15000) + 5000; // 5-20s extra
          console.log(`[BOT] Thinking (${Math.round(extraThinkTime/1000)}s)...`);
          await this.humanDelay(extraThinkTime, extraThinkTime + 3000);
        }

        // 3. Get AI response (this takes a second or two from the API)
        if (this.onMessage) {
          const response = await this.onMessage(convo.threadId, info.username, info.latestMessage);

          if (response) {
            // 4. Brief pause before typing starts
            await this.humanDelay(1500, 4000);

            // 5. Type and send with realistic keystrokes
            await this.typeAndSend(response);
            this.messageCount++;
          }
        }

        this.processedMessages.add(msgId);
        this.saveProcessed();

        // Break between conversations (real person doesn't instantly jump to next)
        if (i < maxToProcess - 1) {
          const breakTime = Math.floor(Math.random() * 10000) + 5000; // 5-15s between convos
          console.log(`[BOT] Taking a break before next conversation (${Math.round(breakTime/1000)}s)...`);
          await this.humanDelay(breakTime, breakTime + 3000);
        }

        await this.goToInbox();
        await this.humanDelay(1500, 3000);
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

  // Human-like typing into an input field
  async humanType(selector, text) {
    for (const char of text) {
      await this.page.type(selector, char, { delay: Math.floor(Math.random() * 80) + 40 });
    }
  }

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
