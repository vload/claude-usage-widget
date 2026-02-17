const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA_DIR = path.join(APPDATA, 'ClaudeUsageWidget');
const OUTPUT_FILE = path.join(DATA_DIR, 'usage.json');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

const LOGIN_MODE = process.argv.includes('--login');

async function scrapeUsage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: !LOGIN_MODE,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    firefoxUserPrefs: {
      'dom.webdriver.enabled': false,
      'useAutomationExtension': false,
    },
  });

  const page = context.pages()[0] || await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    console.log(LOGIN_MODE ? 'Opening browser for login...' : 'Scraping usage (headless)...');
    await page.goto('https://claude.ai/settings/usage', {
      waitUntil: 'networkidle',
      timeout: LOGIN_MODE ? 60000 : 30000,
    });

    if (!page.url().includes('/settings/usage')) {
      if (LOGIN_MODE) {
        console.log('Please log in to Claude, then navigate to Settings > Usage.');
        await page.waitForURL('**/settings/usage', { timeout: 300000 });
        await page.waitForLoadState('networkidle');
      } else {
        throw new Error('Not logged in. Run with --login to authenticate.');
      }
    }

    await page.waitForTimeout(3000);

    const usageData = await page.evaluate(() => {
      const allText = document.body.innerText;

      let planName = 'Unknown';
      const planMatch = allText.match(/(\w+)\s+plan/i);
      if (planMatch) planName = planMatch[1] + ' Plan';

      const sections = [];
      const sectionPattern = /(Current session|All models|Sonnet only|Haiku only|Opus only)[\s\S]*?(\d+)%\s*used/gi;
      let match;
      while ((match = sectionPattern.exec(allText)) !== null) {
        const name = match[1];
        const percent = parseInt(match[2]);
        const chunk = match[0];
        let resetText = '';
        const resetMatch = chunk.match(/Resets?\s+((?:in\s+)?[^%]*?)(?:\d+%|$)/i);
        if (resetMatch) resetText = resetMatch[1].trim().replace(/\n/g, ' ');
        sections.push({ name, percent, resetText });
      }

      const currentSession = sections.find(s => /current session/i.test(s.name));
      const allModels = sections.find(s => /all models/i.test(s.name));
      const primary = currentSession || allModels || sections[0];

      return {
        planName,
        sections,
        usedPercent: primary ? primary.percent : 0,
        remainingPercent: primary ? (100 - primary.percent) : 100,
        resetDate: primary ? primary.resetText : '',
        usageText: primary ? `${primary.name}: ${primary.percent}% used` : '0% used',
        scrapedAt: new Date().toISOString(),
      };
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(usageData, null, 2));
    console.log('Usage data saved to', OUTPUT_FILE);
    console.log(JSON.stringify(usageData, null, 2));
  } catch (err) {
    console.error('Error scraping usage:', err.message);
    const errorData = {
      planName: 'Error',
      usageText: 'Could not fetch usage data',
      usedPercent: 0,
      remainingPercent: 100,
      resetDate: '',
      error: err.message,
      scrapedAt: new Date().toISOString(),
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(errorData, null, 2));
  } finally {
    await context.close();
  }
}

scrapeUsage();
