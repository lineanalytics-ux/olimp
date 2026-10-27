const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// Основной эндпоинт авторизации
app.all('/auth', async (req, res) => {
  // Получаем параметры из POST (JSON) или GET (query string)
  const login = req.body?.login || req.query?.login;
  const password = req.body?.password || req.query?.password;

  if (!login || !password) {
    return res.status(400).json({ error: 'Параметры login и password обязательны' });
  }

  let browser = null;

  try {
    // Оптимизированный запуск Chromium для лимитов Render (512MB RAM)
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    
    // Эмулируем разрешение экрана
    await page.setViewport({ width: 1366, height: 768 });

    // 1. Открываем главную страницу
    await page.goto('https://0limpbk-0nline.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // 2. Вводим учетные данные
    await page.type('input[name="login"]', login, { delay: 50 });
    await page.type('input[name="passw"]', password, { delay: 50 });

    // 3. Нажимаем Enter или кликаем по форме и ждем завершения редиректа
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    // 4. Забираем куки
    const rawCookies = await page.cookies();
    const cookiesObj = {};

    rawCookies.forEach(c => {
      cookiesObj[c.name] = c.value;
    });

    // Формируем готовый заHeader Cookie
    const cookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Проверяем наличие ключевой куки сессии
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
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Простой эндпоинт проверки работоспособности (Health Check)
app.get('/', (req, res) => {
  res.send('Auth Server is Running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});