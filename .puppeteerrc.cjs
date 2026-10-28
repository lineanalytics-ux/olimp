const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Указываем скачивать Firefox вместо Chrome
  browser: 'firefox',
  // Указываем директорию кэша, доступную на Render
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
