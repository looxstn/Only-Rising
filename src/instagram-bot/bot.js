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

    // Load saved session - try file first, then env var fallback
    if (fs.existsSync(SESSION_PATH)) {
      console.log('[BOT] Loading saved session from file...');
      contextOptions.storageState = SESSION_PATH;
    } else if (process.env.IG_SESSION_DATA) {
      console.log('[BOT] Loading saved session from env var...');
      try {
        const sessionData = JSON.parse(Buffer.from(process.env.IG_SESSION_DATA, 'base64').toString());
        const dir = path.dirname(SESSION_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SESSION_PATH, JSON.stringify(sessionData));
        contextOptions.storageState = SESSION_PATH;
      } catch (e) {
        console.error('[BOT] Failed to load session from env:', e.message);
      }
    } else {
      console.log('[BOT] No saved session found - will need to login fresh');
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
    console.log('[BOT] Checking if session is still valid...');
    console.log('[BOT] Session file exists: ' + fs.existsSync(SESSION_PATH));

    // Navigate to Instagram and wait for it to fully render
    await this.page.goto('https://www.instagram.com/', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    // Wait extra time for SPA to render
    await this.humanDelay(5000, 8000);
    console.log('[BOT] Page loaded, URL: ' + this.page.url());

    // Check if already logged in
    const loggedIn = await this.isLoggedIn();
    if (loggedIn) {
      console.log('[BOT] Already logged in from saved session - no login needed');
      await this.dismissPopups();
      await this.saveSession();
      return true;
    }

    // Might be on a "Continue as" screen or redirected to login
    // Wait and detect what screen we're on
    console.log('[BOT] Not logged in yet, detecting screen...');

    // Try up to 3 times with different approaches
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[BOT] Login attempt ${attempt}/3...`);
      const currentUrl = this.page.url();
      console.log(`[BOT] Current URL: ${currentUrl}`);

      try {
        // Wait for SOMETHING to render
        await this.page.waitForSelector('button, input, a[href*="accounts"]', { timeout: 15000 });
      } catch {
        console.log('[BOT] Page still loading, waiting more...');
        await this.humanDelay(5000, 8000);
      }

      // SCREEN 1: "Continue as" screen
      const continueBtn = await this.page.$('button:has-text("Continue"), div[role="button"]:has-text("Continue"), a:has-text("Continue")');
      if (continueBtn) {
        console.log('[BOT] Found "Continue as" screen, clicking...');
        await continueBtn.click();
        await this.humanDelay(5000, 8000);
        await this.page.waitForNavigation({ timeout: 15000 }).catch(() => {});
        await this.humanDelay(3000, 5000);

        if (await this.isLoggedIn()) {
          console.log('[BOT] Logged in via Continue');
          await this.dismissPopups();
          await this.saveSession();
          return true;
        }
        continue;
      }

      // SCREEN 2: Cookie consent popup
      const cookieBtn = await this.page.$('button:has-text("Allow all cookies"), button:has-text("Allow essential and optional cookies"), button:has-text("Accept"), button:has-text("Only allow essential cookies")');
      if (cookieBtn) {
        console.log('[BOT] Dismissing cookie popup...');
        await cookieBtn.click();
        await this.humanDelay(2000, 3000);
        continue; // Re-check what's behind it
      }

      // SCREEN 3: Login form
      const loginInput = await this.page.$('input[type="text"], input[name="username"], input[name="email"]');
      if (loginInput) {
        console.log('[BOT] Found login form, entering credentials...');
        break; // Exit loop and proceed to credential entry
      }

      // SCREEN 4: Not on login page yet
      if (!currentUrl.includes('accounts/login')) {
        console.log('[BOT] Navigating to login page...');
        await this.page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await this.humanDelay(5000, 8000);
        continue;
      }

      // Nothing found, wait and retry
      console.log('[BOT] Page not ready, waiting...');
      await this.humanDelay(5000, 8000);
    }

    // Now enter credentials
    console.log('[BOT] Logging in as @' + this.username + '...');

    try {
      console.log('[BOT] Looking for login fields...');
      // Wait for input fields with generous timeout
      await this.page.waitForSelector('input', { timeout: 30000 });

      // Get all input fields and find the right ones
      const inputs = await this.page.$$('input');
      console.log(`[BOT] Found ${inputs.length} input fields`);

      let usernameInput = null;
      let passwordInput = null;

      for (const input of inputs) {
        const type = await input.getAttribute('type');
        const name = await input.getAttribute('name');
        const ariaLabel = await input.getAttribute('aria-label');
        const placeholder = await input.getAttribute('placeholder');
        console.log(`[BOT] Input: type=${type}, name=${name}, aria-label=${ariaLabel}, placeholder=${placeholder}`);

        if (type === 'password' || name === 'password') {
          passwordInput = input;
        } else if (name === 'username' || (ariaLabel && ariaLabel.toLowerCase().includes('username')) ||
                   (ariaLabel && ariaLabel.toLowerCase().includes('phone')) ||
                   (ariaLabel && ariaLabel.toLowerCase().includes('email')) ||
                   (placeholder && placeholder.toLowerCase().includes('username')) ||
                   (placeholder && placeholder.toLowerCase().includes('phone')) ||
                   type === 'text') {
          if (!usernameInput) usernameInput = input;
        }
      }

      if (!usernameInput || !passwordInput) {
        console.error('[BOT] Could not find login fields. Username:', !!usernameInput, 'Password:', !!passwordInput);
        return false;
      }

      console.log('[BOT] Found login fields, entering credentials...');

      // Click and type username
      await usernameInput.click();
      await this.humanDelay(400, 800);
      await this.page.keyboard.type(this.username, { delay: Math.floor(Math.random() * 80) + 40 });
      await this.humanDelay(600, 1200);

      // Click and type password
      await passwordInput.click();
      await this.humanDelay(300, 700);
      await this.page.keyboard.type(this.password, { delay: Math.floor(Math.random() * 80) + 40 });
      await this.humanDelay(1000, 2000);

      // Click login button
      const loginBtn = await this.page.$('button[type="submit"]') || await this.page.$('button:has-text("Log in"), button:has-text("Log In")');
      if (loginBtn) {
        await loginBtn.click();
      } else {
        await this.page.keyboard.press('Enter');
      }
      console.log('[BOT] Login submitted, waiting...');

      await this.page.waitForNavigation({ timeout: 30000 }).catch(() => {});
      await this.humanDelay(3000, 5000);

      // Check for 2FA - look for various verification inputs
      const twoFactorInput = await this.page.$('input[name="verificationCode"], input[name="security_code"], input[aria-label*="Security code"], input[aria-label*="Confirmation code"], input[placeholder*="code" i]');
      if (twoFactorInput) {
        // Grab the MAIN heading/description text to figure out what type of 2FA
        // Important: check the primary instruction, not alternative links at the bottom
        let twoFactorType = 'unknown';
        try {
          const pageText = await this.page.evaluate(() => document.body.innerText);
          // Log for debugging
          const relevantText = pageText.substring(0, 500).replace(/\n+/g, ' | ');
          console.log(`[BOT] 2FA page text: ${relevantText}`);

          // Get just the main heading/instruction (first ~200 chars before alternatives)
          const mainText = pageText.substring(0, 200).toLowerCase();

          // Check SMS first - "we sent via SMS" or "sent to your mobile" is the primary instruction
          if (mainText.includes('sms') || mainText.includes('sent to your mobile') || mainText.includes('text message') || mainText.includes('we sent via')) {
            twoFactorType = 'sms';
          } else if (mainText.includes('authentication app') || mainText.includes('authenticator')) {
            twoFactorType = 'authenticator_app';
          } else if (mainText.includes('email')) {
            twoFactorType = 'email';
          } else if (mainText.includes('whatsapp')) {
            twoFactorType = 'whatsapp';
          }
        } catch {}

        console.log(`[BOT] 2FA required (type: ${twoFactorType}). Waiting for code...`);
        this.waitingFor2FA = true;

        if (this.onTwoFactorNeeded) {
          await this.onTwoFactorNeeded(twoFactorType);
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
        // Click the 2FA input and type the code
        await twoFactorInput.click();
        await this.humanDelay(300, 600);
        // Clear any existing value first
        await this.page.keyboard.press('Control+A');
        await this.humanDelay(100, 200);
        await this.page.keyboard.type(this.twoFactorCode, { delay: Math.floor(Math.random() * 60) + 40 });
        await this.humanDelay(800, 1500);

        console.log('[BOT] Looking for confirm/submit button...');
        // Try multiple selectors for the confirm button
        let confirmBtn = null;
        const btnSelectors = [
          'button:has-text("Confirm")',
          'button:has-text("confirm")',
          'button[type="submit"]',
          'button:has-text("Submit")',
          'button:has-text("Next")',
          'button:has-text("Verify")',
        ];
        for (const sel of btnSelectors) {
          confirmBtn = await this.page.$(sel);
          if (confirmBtn) {
            console.log(`[BOT] Found confirm button with selector: ${sel}`);
            break;
          }
        }

        if (confirmBtn) {
          await confirmBtn.click();
          console.log('[BOT] Confirm button clicked');
        } else {
          console.log('[BOT] No confirm button found, pressing Enter');
          await this.page.keyboard.press('Enter');
        }

        this.waitingFor2FA = false;
        this.twoFactorCode = null;

        // Wait for navigation after 2FA
        console.log('[BOT] Waiting for page to load after 2FA...');
        await this.page.waitForNavigation({ timeout: 15000 }).catch(() => {
          console.log('[BOT] No navigation detected, checking page anyway...');
        });
        await this.humanDelay(3000, 5000);
        console.log('[BOT] Post-2FA URL: ' + this.page.url());

        // Handle "Trust this device" or "Save login info" pages
        await this.dismissPopups();
        await this.humanDelay(2000, 3000);
      }

      const currentUrl = this.page.url();
      console.log('[BOT] Checking login status, URL: ' + currentUrl);
      const success = await this.isLoggedIn();
      if (!success) {
        // Take a screenshot for debugging
        console.error('[BOT] Login failed. Check credentials.');
        console.log('[BOT] Check /bot/screenshot to see what the page looks like.');
        // Keep the page accessible for screenshot debugging
        console.log('[BOT] Bot page still accessible for debugging.');
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
        this.page.waitForSelector('svg[aria-label="Home"]', { timeout: 10000 }).then(() => 'home-svg'),
        this.page.waitForSelector('a[href="/direct/inbox/"]', { timeout: 10000 }).then(() => 'dm-link'),
        this.page.waitForSelector('svg[aria-label="Messages"]', { timeout: 10000 }).then(() => 'messages-svg'),
        this.page.waitForSelector('span:has-text("Messages")', { timeout: 10000 }).then(() => 'messages-text'),
        this.page.waitForSelector('nav[role="navigation"]', { timeout: 10000 }).then(() => 'nav'),
      ]);
      console.log(`[BOT] Logged in check: found ${indicators}`);
      return true;
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
    const stateJson = JSON.stringify(state);
    fs.writeFileSync(SESSION_PATH, stateJson);

    // Also save to env var via Railway API so it survives deploys
    if (process.env.RAILWAY_PROJECT_ID && process.env.RAILWAY_API_TOKEN) {
      try {
        const base64Session = Buffer.from(stateJson).toString('base64');
        const axios = require('axios');
        await axios.post('https://backboard.railway.app/graphql/v2', {
          query: `mutation { variableUpsert(input: { projectId: "${process.env.RAILWAY_PROJECT_ID}", environmentId: "${process.env.RAILWAY_ENVIRONMENT_ID}", serviceId: "${process.env.RAILWAY_SERVICE_ID}", name: "IG_SESSION_DATA", value: "${base64Session}" }) }`,
        }, {
          headers: { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` },
        });
        console.log('[BOT] Session saved to Railway env var');
      } catch (e) {
        console.log('[BOT] Could not save session to Railway env (non-critical):', e.message);
      }
    }

    console.log('[BOT] Session saved to file');
  }

  async goToInbox() {
    console.log('[BOT] Navigating to DM inbox...');
    await this.page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded',
    });
    await this.humanDelay(2000, 4000);
    await this.dismissPopups();
  }

  // ─── Use Instagram's internal API via the authenticated browser ───
  // Intercept network to get correct headers, or use page context fetch

  async _apiCall(endpoint, method = 'GET', body = null) {
    try {
      const args = { url: endpoint, method, body };
      const result = await this.page.evaluate(async (a) => {
        // Extract all required tokens from the page context
        const csrfToken = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
        // Get the claim token from Instagram's shared data
        let wwwClaim = '0';
        try {
          const sd = window._sharedData || window.__initialData;
          if (sd) wwwClaim = sd.config?.viewerId ? 'hmac.' + sd.config.viewerId : '0';
        } catch {}

        const headers = {
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'X-IG-App-ID': '936619743392459',
          'X-IG-WWW-Claim': wwwClaim,
          'X-ASBD-ID': '129477',
          'Accept': '*/*',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'Referer': 'https://www.instagram.com/direct/inbox/',
        };
        if (a.body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

        const opts = { method: a.method, credentials: 'include', headers };
        if (a.body) opts.body = a.body;

        const res = await fetch('https://www.instagram.com' + a.url, opts);
        const contentType = res.headers.get('content-type') || '';
        const text = await res.text();

        // Debug: return first bit of response if not JSON
        try {
          return { ok: true, data: JSON.parse(text), status: res.status, contentType };
        } catch {
          return { ok: false, text: text.substring(0, 200), status: res.status, contentType };
        }
      }, args);

      if (!result.ok) {
        console.error(`[BOT] API ${endpoint} status=${result.status} type=${result.contentType} body=${result.text.substring(0, 80)}`);
        return null;
      }
      return result.data;
    } catch (e) {
      console.error(`[BOT] API ${endpoint} error:`, e.message);
      return null;
    }
  }

  // Alternative: intercept inbox data by navigating to the inbox page
  // and capturing the XHR responses Instagram makes
  async getInboxViaIntercept() {
    return new Promise(async (resolve) => {
      let inboxData = null;
      const handler = async (response) => {
        const url = response.url();
        if (url.includes('/api/v1/direct_v2/inbox/') || url.includes('direct_v2/inbox')) {
          try {
            const json = await response.json();
            if (json?.inbox?.threads) inboxData = json;
          } catch {}
        }
      };

      this.page.on('response', handler);

      // Navigate to inbox to trigger Instagram's own API calls
      await this.page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await this.humanDelay(3000, 5000);

      this.page.off('response', handler);

      if (inboxData) {
        console.log(`[BOT] Intercepted inbox: ${inboxData.inbox.threads.length} threads`);
      } else {
        console.log('[BOT] No inbox data intercepted from page load');
      }
      resolve(inboxData);
    });
  }

  async apiGetInbox() {
    return this._apiCall('/api/v1/direct_v2/inbox/?per_page=20&persistentBadging=true&folder=0');
  }

  async apiGetThread(threadId) {
    return this._apiCall(`/api/v1/direct_v2/threads/${threadId}/`);
  }

  async apiGetPendingInbox() {
    return this._apiCall('/api/v1/direct_v2/pending_inbox/?per_page=20');
  }

  async apiSendMessage(threadId, text) {
    // Try the thread-specific send endpoint first
    const body = new URLSearchParams();
    body.append('action', 'send_item');
    body.append('thread_ids', `[${threadId}]`);
    body.append('client_context', `6${Date.now()}_${Math.floor(Math.random() * 1000000000)}`);
    body.append('text', text);

    // Try multiple send endpoints
    const endpoints = [
      `/api/v1/direct_v2/threads/${threadId}/items/`,
      '/api/v1/direct_v2/threads/broadcast/text/',
      `/ig/direct_v2/threads/${threadId}/items/`,
    ];

    for (const endpoint of endpoints) {
      const result = await this._apiCall(endpoint, 'POST', body.toString());
      if (result) {
        console.log(`[BOT] Send succeeded via ${endpoint}`);
        return result;
      }
    }

    // Fallback: navigate to the conversation and type it manually
    console.log('[BOT] API send failed, falling back to typing...');
    await this.page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'domcontentloaded' });
    await this.humanDelay(3000, 5000);
    return await this.typeAndSend(text) ? { status: 'ok' } : null;
  }

  async apiApproveThread(threadId) {
    return this._apiCall(`/api/v1/direct_v2/threads/${threadId}/approve/`, 'POST');
  }

  async getUnreadConversations() {
    const unreadConvos = [];

    try {
      // Try direct API first, fall back to intercept
      let inbox = await this.apiGetInbox();
      if (!inbox?.inbox?.threads) {
        console.log('[BOT] Direct API failed, trying intercept method...');
        inbox = await this.getInboxViaIntercept();
      }
      if (inbox?.inbox?.threads) {
        for (const thread of inbox.inbox.threads) {
          const lastItem = thread.items?.[0];
          const isUnread = !thread.read_state || (lastItem && lastItem.user_id !== thread.viewer_id);

          if (isUnread && lastItem) {
            const username = thread.users?.[0]?.username || 'unknown';
            const lastMessage = lastItem.text || lastItem.item_type || '';
            unreadConvos.push({
              threadId: thread.thread_id,
              username,
              lastMessage,
              isPending: false,
            });
          }
        }
        console.log(`[BOT] Inbox: ${inbox.inbox.threads.length} threads, ${unreadConvos.length} unread`);
      }

      // Check pending/requests inbox too
      const pending = await this.apiGetPendingInbox();
      if (pending?.inbox?.threads) {
        for (const thread of pending.inbox.threads) {
          const lastItem = thread.items?.[0];
          if (lastItem) {
            const username = thread.users?.[0]?.username || 'unknown';
            const lastMessage = lastItem.text || lastItem.item_type || '';
            unreadConvos.push({
              threadId: thread.thread_id,
              username,
              lastMessage,
              isPending: true,
            });
          }
        }
        console.log(`[BOT] Pending: ${pending.inbox.threads.length} message requests`);
      }
    } catch (error) {
      console.error('[BOT] Error scanning inbox:', error.message);
    }

    return unreadConvos;
  }

  async getConversationMessages(threadId) {
    try {
      const thread = await this.apiGetThread(threadId);
      if (!thread?.thread) return { username: 'unknown', messages: [], lastMessage: null };

      const username = thread.thread.users?.[0]?.username || 'unknown';
      const viewerId = thread.thread.viewer_id;

      const messages = (thread.thread.items || []).reverse().map(item => ({
        text: item.text || (item.item_type === 'like' ? '❤️' : `[${item.item_type}]`),
        isFromThem: item.user_id !== viewerId,
        timestamp: item.timestamp,
      }));

      const theirMessages = messages.filter(m => m.isFromThem);
      const lastMessage = theirMessages.length > 0 ? theirMessages[theirMessages.length - 1].text : null;

      return { username, messages, lastMessage };
    } catch (error) {
      console.error('[BOT] Error reading conversation:', error.message);
      return { username: 'unknown', messages: [], lastMessage: null };
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
      console.log('[BOT] No unread conversations found');
      return;
    }

    console.log(`[BOT] Found ${unread.length} unread conversation(s)`);

    // Don't process all at once — a real person handles them one at a time
    const maxToProcess = Math.min(unread.length, 3);

    for (let i = 0; i < maxToProcess; i++) {
      const convo = unread[i];
      try {
        // If it's a message request, approve it first
        if (convo.isPending) {
          console.log(`[BOT] Approving message request from @${convo.username}...`);
          await this.apiApproveThread(convo.threadId);
          await this.humanDelay(1000, 2000);
        }

        // Get full conversation via API
        const info = await this.getConversationMessages(convo.threadId);
        const latestMessage = info.lastMessage || convo.lastMessage;

        if (!latestMessage) {
          console.log(`[BOT] No readable message from @${convo.username}`);
          continue;
        }

        const msgId = `${convo.threadId}_${latestMessage.substring(0, 50)}`;
        if (this.processedMessages.has(msgId)) {
          console.log(`[BOT] Already processed message from @${convo.username}`);
          continue;
        }

        console.log(`[BOT] New message from @${convo.username}: ${latestMessage}`);

        // ─── Realistic response timing ───
        const wordCount = latestMessage.split(' ').length;
        const readingMs = Math.max(wordCount * 300, 2000) + Math.floor(Math.random() * 3000);
        console.log(`[BOT] Reading (${Math.round(readingMs/1000)}s)...`);
        await this.humanDelay(readingMs, readingMs + 2000);

        // Sometimes extra think time
        if (Math.random() < 0.3) {
          const extraThinkTime = Math.floor(Math.random() * 15000) + 5000;
          console.log(`[BOT] Thinking (${Math.round(extraThinkTime/1000)}s)...`);
          await this.humanDelay(extraThinkTime, extraThinkTime + 3000);
        }

        // Get AI response
        if (this.onMessage) {
          const response = await this.onMessage(convo.threadId, convo.username, latestMessage);

          if (response) {
            // Simulate typing delay based on response length
            const typingMs = response.length * 50 + Math.floor(Math.random() * 3000) + 2000;
            console.log(`[TYPING] Simulating ${Math.round(typingMs/1000)}s delay for natural feel`);
            await this.humanDelay(typingMs, typingMs + 2000);

            // Send via API
            const sendResult = await this.apiSendMessage(convo.threadId, response);
            if (sendResult) {
              console.log(`[MSG] Replied to @${convo.username}: ${response.substring(0, 60)}...`);
              this.messageCount++;
            } else {
              console.error(`[BOT] Failed to send to @${convo.username}`);
            }
          }
        }

        this.processedMessages.add(msgId);
        this.saveProcessed();

        // Break between conversations
        if (i < maxToProcess - 1) {
          const breakTime = Math.floor(Math.random() * 10000) + 5000;
          console.log(`[BOT] Taking a break before next conversation (${Math.round(breakTime/1000)}s)...`);
          await this.humanDelay(breakTime, breakTime + 3000);
        }
      } catch (error) {
        console.error(`[BOT] Error processing @${convo.username}:`, error.message);
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
