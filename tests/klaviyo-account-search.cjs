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
    // Closed markup must expose only the selector and Refresh, even without JavaScript.
    // Reveal only the outer workspace, which normally requires a Figma frame message.
    const staticPage = await browser.newPage({ javaScriptEnabled: false });
    await staticPage.route('https://static-plugin.test/', route => route.fulfill({
      contentType: 'text/html',
      body: builtUi.replace('</head>', '<style>#workspace { display: block !important; }</style></head>')
    }));
    await staticPage.goto('https://static-plugin.test/', { waitUntil: 'domcontentloaded', timeout: 5000 });
    assert(await staticPage.locator('#klaviyoAccountTrigger').isVisible());
    assert(await staticPage.locator('#refreshAccounts').isVisible());
    assert(!(await staticPage.locator('#klaviyoAccount').isVisible()));
    assert(!(await staticPage.locator('#klaviyoAccountSearch').isVisible()), 'Search belongs inside the closed dropdown, never above the trigger');
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
    await trigger.waitFor({ state: 'visible' });
    await trigger.scrollIntoViewIfNeeded();
    assert.equal(await search.getAttribute('placeholder'), 'Search Klaviyo accounts...');
    assert.equal(await page.locator('#klaviyoPanel .card-number').textContent(), '4');
    assert(await page.locator('#klaviyoPanel #klaviyoAccountTrigger').count(), 'Selector belongs to Step 4');
    assert(!(await popup.isVisible()));
    assert(!(await search.isVisible()), 'Closed selector has no permanent search input');
    assert(!(await page.locator('#klaviyoAccount').isVisible()), 'Original native select stays hidden');
    assert.equal(await search.evaluate(el => Boolean(el.closest('.account-dropdown'))), true, 'Search lives inside the dropdown');
    const triggerBox = await trigger.boundingBox(), refreshBox = await refresh.boundingBox();
    assert(refreshBox.x >= triggerBox.x + triggerBox.width, 'Refresh remains beside selector');
    assert(Math.abs(refreshBox.y + refreshBox.height - triggerBox.y - triggerBox.height) <= 1, 'Refresh and selector align');

    // Loading dynamically enables one selector, then opening reveals all 81 accounts.
    release(); hold = null;
    await page.waitForFunction(() => !document.getElementById('klaviyoAccountTrigger').disabled);
    if (process.env.ACCOUNT_SEARCH_SCREENSHOT_DIR) {
      await page.locator('#klaviyoPanel').screenshot({ path: path.join(process.env.ACCOUNT_SEARCH_SCREENSHOT_DIR, 'klaviyo-combobox-closed.png') });
    }
    await trigger.click();
    await search.waitFor({ state: 'visible' });
    assert(await search.evaluate(el => el === document.activeElement), 'Opening focuses the panel search');
    assert.equal(await rows.count(), 81);
    assert(await page.locator('#klaviyoAccountOptions').evaluate(el => el.scrollHeight > el.clientHeight), '81 accounts scroll within dropdown');
    assert(await popup.evaluate(el => el.parentElement === document.body), 'Panel is portaled outside clipping cards');
    const firstSearchBox = await search.boundingBox(), firstListBox = await page.locator('#klaviyoAccountOptions').boundingBox();
    assert(firstSearchBox.y + firstSearchBox.height <= firstListBox.y, 'Search sits at the top of the dropdown above results');
    if (process.env.ACCOUNT_SEARCH_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.ACCOUNT_SEARCH_SCREENSHOT_DIR, 'klaviyo-combobox-open.png') });
    }
    await search.fill('nOrTh');
    await waitForRows(2);
    assert(await popup.isVisible(), 'Typing filters matching accounts without Enter');
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
    assert(!(await search.isVisible()), 'Search hides when selection closes the dropdown');
    await trigger.click();
    assert.equal(await search.inputValue(), '', 'Reopening resets query to display all accounts');
    assert.equal(await rows.count(), 81);
    const selectedRow = page.locator('#klaviyoAccountOptions [aria-selected=true]');
    assert.match(await selectedRow.textContent(), /Northwind Store/);
    assert.match(await selectedRow.evaluate(el => getComputedStyle(el, '::before').content), /✓/, 'Selected account keeps its checkmark');

    await search.fill('');
    await waitForRows(81);
    await search.press('ArrowDown');
    await search.press('Enter');
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-43');
    await trigger.press('ArrowUp');
    await search.press('ArrowUp');
    await search.press('Enter');
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    await trigger.click();
    await search.fill('no account matches this');
    await waitForRows(0);
    assert(await page.locator('#klaviyoAccountEmpty').isVisible());
    await search.press('Enter');
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    await search.press('Escape');
    assert(!(await popup.isVisible()));
    assert(!(await search.isVisible()));
    assert(await trigger.evaluate(el => el === document.activeElement), 'Escape returns focus to the selector');
    await trigger.click();
    await page.mouse.click(2, 100); // Outside the panel regardless of opening direction.
    assert(!(await popup.isVisible()), 'Outside click closes the popup');
    await trigger.click();
    await search.press('Tab');
    assert(!(await popup.isVisible()), 'Tab closes the popup');
    assert(!(await search.evaluate(el => el === document.activeElement)), 'Tab cannot leave focus in the hidden input');

    // Refresh changes the loaded list while preserving the account ID; next open resets search.
    await trigger.click();
    await search.fill('nOrTh');
    await waitForRows(2);
    accountResult = { accounts: [
      ...accounts.filter(account => account.id !== 'vault-account-77').map(account => account.id === 'vault-account-42' ? { ...account, displayName: 'Northwind Updated' } : account),
      { id: 'north-new-id', displayName: 'Northern New Account' }
    ] };
    hold = new Promise(resolve => { release = resolve; });
    await refresh.click();
    await page.waitForFunction(() => document.getElementById('klaviyoAccountTrigger').disabled);
    assert(!(await search.isVisible()), 'Refresh closes the dropdown during loading');
    release(); hold = null;
    await page.waitForFunction(() => !document.getElementById('klaviyoAccountTrigger').disabled);
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'vault-account-42');
    await trigger.click();
    await waitForRows(81);
    assert.equal(await search.inputValue(), '');
    await search.fill('nOrTh');
    await waitForRows(2);
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

    // Panel contains its search above a scrollable list in both opening directions and themes.
    for (const [width, height, background, foreground] of [[700, 840, '#222', '#eee'], [360, 500, '#fff', '#222']]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(({ background, foreground }) => {
        document.documentElement.style.setProperty('--figma-color-bg', background);
        document.documentElement.style.setProperty('--figma-color-text', foreground);
      }, { background, foreground });
      for (const direction of ['below', 'above']) {
        await trigger.scrollIntoViewIfNeeded();
        await page.evaluate(direction => {
          const rect = document.getElementById('klaviyoAccountTrigger').getBoundingClientRect();
          const desiredTop = direction === 'below' ? 100 : window.innerHeight - rect.height - 12;
          window.scrollBy(0, rect.top - desiredTop);
        }, direction);
        assert(!(await search.isVisible()));
        await trigger.click();
        await waitForRows(81);
        assert.equal(await search.inputValue(), '');
        const box = await popup.boundingBox(), inputBox = await search.boundingBox(), listBox = await page.locator('#klaviyoAccountOptions').boundingBox(), anchor = await trigger.boundingBox();
        assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, 'Dropdown stays inside plugin window');
        assert(inputBox.x >= box.x && inputBox.y >= box.y && inputBox.x + inputBox.width <= box.x + box.width && inputBox.y + inputBox.height <= listBox.y, 'Search remains inside top of panel');
        if (direction === 'below') assert(box.y >= anchor.y + anchor.height, 'Dropdown opens below selector with room');
        else assert(box.y + box.height <= anchor.y, 'Dropdown opens above selector near bottom');
        assert(await page.locator('#klaviyoAccountOptions').evaluate(el => el.scrollHeight > el.clientHeight), '81 results scroll within popup');
        await search.press('Escape');
        assert(!(await search.isVisible()));
      }
    }

    accountResult = { accounts: [] };
    await refresh.click();
    await page.waitForFunction(() => document.getElementById('klaviyoAccountValue').textContent === 'No active accounts found');
    assert(!(await search.isVisible()));
    assert(await trigger.isDisabled());
    accountStatus = 500; accountResult = { error: 'Fixture error' };
    await refresh.click();
    await page.waitForFunction(() => document.getElementById('klaviyoAccountValue').textContent === 'Could not load accounts');
    assert(!(await search.isVisible()), 'Failed API load leaves the dropdown closed');
    assert(await trigger.isDisabled());
    assert.deepEqual(errors, []);
    console.log(`PASS: rendered ${manifest.ui} has one Step 4 selector with search only inside the opened dropdown; 81-account instant filtering, IDs, reset/checkmark, keyboard/dismissal, Refresh, template payload, themes, and both viewport opening directions verified.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
