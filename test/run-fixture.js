// Drives test/fixture.html: performs the real clicks it queues (teach mode ignores synthetic ones)
// and returns its results. Run after opening the page:
//   playwright-cli run-code --filename test/run-fixture.js
async (page) => {
  const chat = page.frameLocator('iframe').frameLocator('iframe');
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const job = await page.evaluate(() => (window.__done ? { done: window.__done } : { click: window.__realClicks[0] }));
    if (job.done) return job.done;
    if (job.click) {
      await chat.locator(job.click).click();
      await page.evaluate((s) => window.__realClicks.splice(window.__realClicks.indexOf(s), 1), job.click);
    }
    await page.waitForTimeout(100);
  }
  return 'TIMEOUT';
}
