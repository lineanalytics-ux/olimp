const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

app.all('/auth', async (req, res) => {
  const login = req.body?.login || req.query?.login;
  const password = req.body?.password || req.query?.password;

  if (!login || !password) {
    return res.status(400).json({ error: 'Параметры login и password обязательны' });
  }

  let browser = null;

  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Блокируем загрузку картинок, медиа и шрифтов для ускорения в 3-5 раз
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1366, height: 768 });

    // 1. Быстрый переход на страницу без ожидания всех асинхронных запросов
    await page.goto('https://0limpbk-0nline.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Ожидаем появление хотя бы одной формы/поля ввода
    await page.waitForSelector('input[name="login"]', { timeout: 15000 });

    // 2. Вводим логин и пароль
    await page.type('input[name="login"]', login, { delay: 20 });
    await page.type('input[name="passw"]', password, { delay: 20 });

    // 3. Отправляем форму
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    // Небольшая пауза для простановки Set-Cookie
    await new Promise(r => setTimeout(r, 2000));

    // 4. Сбор кук
    const rawCookies = await page.cookies();
    const cookiesObj = {};
    rawCookies.forEach(c => { cookiesObj[c.name] = c.value; });

    const cookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const isSuccess = Boolean(cookiesObj['ussid'] && cookiesObj['ussid'] !== 'deleted');

    await browser.close();

    return res.json({
      success: isSuccess,
      ussid: cookiesObj['ussid'] || null,
      cookies: cookiesObj,
      cookie_string: cookieString
    });

  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
