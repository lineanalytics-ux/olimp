const { join } = require('path');

module.exports = {
  browser: 'firefox',
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
