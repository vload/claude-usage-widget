const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA_DIR = path.join(APPDATA, 'ClaudeUsageWidget');
const OUTPUT_FILE = path.join(DATA_DIR, 'usage.json');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

async function scrapeUsage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // First try headless
  let context = await firefox.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    firefoxUserPrefs: {
      'dom.webdriver.enabled': false,
      'useAutomationExtension': false,
    },
  });

  let page = context.pages()[0] || await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    console.log('Navigating to Claude usage page (headless)...');
    await page.goto('https://claude.ai/settings/usage', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    let url = page.url();
    if (!url.includes('/settings/usage')) {
      // Need to log in - close headless and reopen visible
      console.log('Login required - opening visible browser...');
      await context.close();

      context = await firefox.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
        firefoxUserPrefs: {
          'dom.webdriver.enabled': false,
          'useAutomationExtension': false,
        },
      });

      page = context.pages()[0] || await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      await page.goto('https://claude.ai/settings/usage', { waitUntil: 'networkidle', timeout: 60000 });
      console.log('Please log in to Claude, then navigate to Settings > Usage.');
      await page.waitForURL('**/settings/usage', { timeout: 300000 });
      await page.waitForLoadState('networkidle');
    }

    await page.waitForTimeout(3000);

    // Extract usage data with better parsing
    const usageData = await page.evaluate(() => {
      const allText = document.body.innerText;

      // Detect plan
      let planName = 'Unknown';
      const planMatch = allText.match(/(\w+)\s+plan/i);
      if (planMatch) planName = planMatch[1] + ' Plan';

      // Parse usage sections from the page text
      // The page has sections like:
      //   "Current session" / "Resets in X hr Y min" / "XX% used"
      //   "All models" / "Resets DAY TIME" / "XX% used"
      //   "Sonnet only" / "Resets DAY TIME" / "XX% used"
      const sections = [];
      const sectionPattern = /(Current session|All models|Sonnet only|Haiku only|Opus only)[\s\S]*?(\d+)%\s*used/gi;
      let match;
      while ((match = sectionPattern.exec(allText)) !== null) {
        const name = match[1];
        const percent = parseInt(match[2]);
        // Find reset info between name and percent
        const chunk = match[0];
        let resetText = '';
        const resetMatch = chunk.match(/Resets?\s+((?:in\s+)?[^%]*?)(?:\d+%|$)/i);
        if (resetMatch) resetText = resetMatch[1].trim().replace(/\n/g, ' ');
        sections.push({ name, percent, resetText });
      }

      // Primary = current session, secondary = all models weekly
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
