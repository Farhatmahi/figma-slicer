// Run after `npm run build`: node tests/klaviyo-account-search.cjs
// Uses the available Playwright installation and Chromium; all API calls are mocked.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const builtUiPath = path.join(root, manifest.ui);
const builtUi = fs.readFileSync(builtUiPath, 'utf8');
assert.equal(builtUi, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild before testing: manifest UI must match source');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    // Even if UI initialization fails, the field is static markup with no popup/CSS gate.
    // Reveal only the outer workspace, which normally requires a Figma frame message.
    const staticPage = await browser.newPage({ javaScriptEnabled: false });
    await staticPage.route('https://static-plugin.test/', route => route.fulfill({
      contentType: 'text/html',
      body: builtUi.replace('</head>', '<style>#workspace { display: block !important; }</style></head>')
    }));
    await staticPage.goto('https://static-plugin.test/', { waitUntil: 'domcontentloaded', timeout: 5000 });
    assert(await staticPage.locator('#klaviyoAccountSearch').isVisible(), 'Built search is static visible markup and does not depend on JavaScript initialization');
    assert(!(await staticPage.locator('#klaviyoAccountDropdown').isVisible()));
    await staticPage.close();

    const page = await browser.newPage({ viewport: { width: 700, height: 840 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const accounts = Array.from({ length: 81 }, (_, index) => ({
      id: `vault-account-${index}`,
      displayName: index === 42 ? 'Northwind Store' : index === 77 ? 'northstar Design' : `Account ${String(index).padStart(2, '0')}`,
      apiKeyLast4: String(index).padStart(4, '0')
    }));
    let accountResult = { accounts }, accountStatus = 200, reads = 0, createBody;
    let release;
    let hold = new Promise(resolve => { release = resolve; });
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'https://plugin.test/') {
        return route.fulfill({ contentType: 'text/html', body: builtUi });
      }
      if (url.endsWith('/api/klaviyo-accounts')) {
        reads++;
        if (hold) await hold;
        return route.fulfill({ status: accountStatus, json: accountResult });
      }
      if (url.endsWith('/api/create-klaviyo-template')) {
        createBody = route.request().postDataJSON();
        return route.fulfill({ json: { templateName: createBody.templateName, rowCount: 1, accountName: 'Northwind Store' } });
      }
      errors.push(`Unexpected network request: ${url}`);
      return route.abort();
    });
    await page.goto('https://plugin.test/');
    await page.evaluate(() => {
      document.documentElement.style.cssText = '--figma-color-bg:#222;--figma-color-bg-secondary:#383838;--figma-color-text:#eee;--figma-color-text-secondary:#aaa;--figma-color-border:#555';
      window.selectionChanges = 0;
      document.getElementById('klaviyoAccount').addEventListener('change', () => window.selectionChanges++);
      // Use the plugin's normal host message to reveal the workspace, not CSS overrides.
      const preview = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n94AAAAASUVORK5CYII='), char => char.charCodeAt(0));
      window.postMessage({ pluginMessage: {
        type: 'FRAME_READY', frame: { id: 'fixture-frame', name: 'Email fixture', width: 600, height: 1200, autoScale: 2 },
        layerBounds: [], textItems: [], preview
      } }, '*');
    });

    const search = page.locator('#klaviyoAccountSearch');
    const trigger = page.locator('#klaviyoAccountTrigger');
    const refresh = page.locator('#refreshAccounts');
    const rows = page.locator('#klaviyoAccountOptions [role=option]');
    const popup = page.locator('#klaviyoAccountDropdown');
    const waitForRows = count => page.waitForFunction(expected => document.querySelectorAll('#klaviyoAccountOptions [role=option]').length === expected, count);
    await search.waitFor({ state: 'visible' });
    await search.scrollIntoViewIfNeeded();
    assert.equal(await search.getAttribute('placeholder'), 'Search Klaviyo accounts...');
    assert.equal(await page.locator('#klaviyoPanel .card-number').textContent(), '4');
    assert(await page.locator('#klaviyoPanel #klaviyoAccountSearch').count(), 'Search belongs to Step 4');
    assert(!(await popup.isVisible()), 'Search must be visible before opening any dropdown');
    assert.equal(await search.evaluate(el => Boolean(el.closest('[hidden], .account-dropdown'))), false, 'Search cannot live in hidden popup');
    const searchBox = await search.boundingBox(), triggerBox = await trigger.boundingBox(), refreshBox = await refresh.boundingBox();
    assert(searchBox.y + searchBox.height <= triggerBox.y + 1, 'Permanent search appears directly above selector');
    assert(refreshBox.x >= triggerBox.x + triggerBox.width, 'Refresh remains beside selector');
    assert(Math.abs(refreshBox.y + refreshBox.height - triggerBox.y - triggerBox.height) <= 1, 'Refresh and selector align');

    // The permanently visible field survives delayed, dynamically loaded accounts.
    release(); hold = null;
    await page.waitForFunction(() => !document.getElementById('klaviyoAccountTrigger').disabled);
    if (process.env.ACCOUNT_SEARCH_SCREENSHOT) {
      await page.locator('#klaviyoPanel').screenshot({ path: process.env.ACCOUNT_SEARCH_SCREENSHOT });
    }
    await search.fill('nOrTh');
    await waitForRows(2);
    assert(await popup.isVisible(), 'Typing opens matching accounts without Enter');
    assert.equal(reads, 1, 'Typing makes no extra API requests');
    await search.fill('wInD');
    await waitForRows(1);
    assert.match(await rows.first().textContent(), /Northwind Store/);
    await rows.first().click();
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    assert.equal(await page.evaluate(() => state.selectedKlaviyoAccountId), 'vault-account-42');
    assert.equal(await page.evaluate(() => window.selectionChanges), 1);
    assert.match(await page.locator('#accountStatus').textContent(), /Selected: Northwind Store/);
    assert(!(await popup.isVisible()));
    assert(await search.isVisible(), 'Search remains visible after selecting');
    await trigger.click();
    assert.equal(await search.inputValue(), 'wInD', 'Reopening preserves the visible query');
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().getAttribute('aria-selected'), 'true');

    await search.fill('');
    await waitForRows(81);
    await search.press('ArrowDown');
    await search.press('Enter');
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-43');
    await trigger.press('ArrowUp');
    await search.press('ArrowUp');
    await search.press('Enter');
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    await search.fill('no account matches this');
    await waitForRows(0);
    assert(await page.locator('#klaviyoAccountEmpty').isVisible());
    await search.press('Enter');
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    await search.press('Escape');
    assert(!(await popup.isVisible()));
    assert(await search.isVisible());

    // Re-query the updated account list after Refresh while preserving selection and query.
    await search.fill('nOrTh');
    await waitForRows(2);
    accountResult = { accounts: [
      ...accounts.filter(account => account.id !== 'vault-account-77').map(account => account.id === 'vault-account-42' ? { ...account, displayName: 'Northwind Updated' } : account),
      { id: 'north-new-id', displayName: 'Northern New Account' }
    ] };
    hold = new Promise(resolve => { release = resolve; });
    await refresh.click();
    await page.waitForFunction(() => document.getElementById('klaviyoAccountTrigger').disabled);
    assert(await search.isVisible(), 'Loading must not hide the permanent search');
    assert.equal(await search.inputValue(), 'nOrTh');
    release(); hold = null;
    await page.waitForFunction(() => !document.getElementById('klaviyoAccountTrigger').disabled);
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    await trigger.click();
    await waitForRows(2);
    assert.equal(await search.inputValue(), 'nOrTh');
    assert.match(await rows.first().textContent(), /Northwind Updated/);
    assert.match(await rows.last().textContent(), /Northern New Account/);
    await rows.last().click();
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'north-new-id');

    // Exercise the existing template request; no live Klaviyo write occurs.
    await page.evaluate(() => {
      state.preparedBackendResult = { templateName: 'Account search regression', slices: [{ imageUrl: 'https://images.test/slice.jpg' }] };
      document.getElementById('backendResultBox').style.display = 'block';
      document.getElementById('createKlaviyoTemplate').disabled = false;
    });
    await page.locator('#createKlaviyoTemplate').click();
    await page.waitForFunction(() => document.getElementById('klaviyoCreateStatus').textContent.includes('Created'));
    assert.equal(createBody.accountId, 'north-new-id', 'Template creation sends the selected original ID');
    assert.equal(createBody.templateName, 'Account search regression');
    assert.equal(createBody.slices.length, 1);

    // Assert rendered permanent visibility and popup containment in both themes and small windows.
    for (const [width, background, foreground] of [[700, '#222', '#eee'], [360, '#fff', '#222']]) {
      await page.setViewportSize({ width, height: 500 });
      await page.evaluate(({ background, foreground }) => {
        document.documentElement.style.setProperty('--figma-color-bg', background);
        document.documentElement.style.setProperty('--figma-color-text', foreground);
      }, { background, foreground });
      await search.scrollIntoViewIfNeeded();
      assert(await search.isVisible());
      await search.fill('');
      if (!(await popup.isVisible())) await trigger.click();
      await waitForRows(81);
      const box = await popup.boundingBox();
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 500, 'Dropdown stays inside plugin window');
      const visibleSearchBox = await search.boundingBox();
      assert(box.y + box.height <= visibleSearchBox.y || box.y >= visibleSearchBox.y + visibleSearchBox.height, 'Results never cover the permanent search');
      assert(await page.locator('#klaviyoAccountOptions').evaluate(el => el.scrollHeight > el.clientHeight), '81 results scroll within popup');
      await search.press('Escape');
    }

    // Force upward opening near the bottom edge and ensure the input remains usable.
    await page.evaluate(() => {
      const rect = document.getElementById('klaviyoAccountTrigger').getBoundingClientRect();
      window.scrollBy(0, rect.bottom - window.innerHeight + 12);
    });
    await trigger.click();
    const abovePopupBox = await popup.boundingBox(), aboveSearchBox = await search.boundingBox();
    assert(abovePopupBox.y >= 0 && abovePopupBox.y + abovePopupBox.height <= aboveSearchBox.y, 'Upward results stop above the search field');
    await search.press('Escape');

    accountResult = { accounts: [] };
    await refresh.click();
    await page.waitForFunction(() => document.getElementById('klaviyoAccountValue').textContent === 'No active accounts found');
    assert(await search.isVisible());
    assert(await trigger.isDisabled());
    accountStatus = 500; accountResult = { error: 'Fixture error' };
    await refresh.click();
    await page.waitForFunction(() => document.getElementById('klaviyoAccountValue').textContent === 'Could not load accounts');
    assert(await search.isVisible(), 'Failed API load must not hide search');
    assert(await trigger.isDisabled());
    assert.deepEqual(errors, []);
    console.log(`PASS: rendered ${manifest.ui} has permanently visible Step 4 search above selector; 81-account instant filtering, IDs, keyboard, Refresh, template payload, themes, viewport, and loading/error visibility verified.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
