const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const axios = require('axios'); // Используется для быстрой проверки живых кук

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// In-Memory кэш сессий для разных доменов и логинов
// Структура: cacheStore[cacheKey] = { cookiesObj, cookieString, ussid, updatedAt }
const sessionCache = {};

// Функция быстрой проверки валидности сессии (без запуска Puppeteer)
async function isSessionValid(domain, cookieString) {
  try {
    const response = await axios.get(`https://${domain}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
        'Cookie': cookieString
      },
      maxRedirects: 0,
      timeout: 5000,
      validateStatus: (status) => status >= 200 && status < 400
    });

    // Проверяем заголовки ответа — если сервер не пытается сбросить ussid
    const setCookie = response.headers['set-cookie'] || [];
    const isDeleted = setCookie.some(header => header.includes('ussid=deleted'));

    return !isDeleted;
  } catch (err) {
    return false;
  }
}

// Функция прохождения авторизации через Puppeteer
async function performPuppeteerAuth(domain, login, password) {
  let browser = null;
  const targetUrl = `https://${domain}/`;

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

    // Блокировка тяжелых ресурсов
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

    // 1. Загрузка страницы
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForSelector('input[name="login"]', { timeout: 15000 });

    // 2. Ввод данных
    await page.type('input[name="login"]', login, { delay: 20 });
    await page.type('input[name="passw"]', password, { delay: 20 });

    // 3. Отправка формы
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    await new Promise(r => setTimeout(r, 2000));

    // 4. Забор кук
    const rawCookies = await page.cookies();
    const cookiesObj = {};
    rawCookies.forEach(c => { cookiesObj[c.name] = c.value; });

    const cookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const isSuccess = Boolean(cookiesObj['ussid'] && cookiesObj['ussid'] !== 'deleted');

    await browser.close();

    if (!isSuccess) {
      throw new Error('Авторизация не удалась (ussid не получен)');
    }

    return {
      success: true,
      ussid: cookiesObj['ussid'],
      cookies: cookiesObj,
      cookie_string: cookieString
    };

  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

// Эндпоинт получения кук
app.all('/auth', async (req, res) => {
  const login = req.body?.login || req.query?.login;
  const password = req.body?.password || req.query?.password;

  // Динамический домен (по умолчанию: 0limpbk-0nline.com)
  let domain = req.body?.domain || req.query?.domain || '0limpbk-0nline.com';
  
  // Очистка доменного имени от https:// и слешей, если передали полный URL
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  if (!login || !password) {
    return res.status(400).json({ error: 'Параметры login и password обязательны' });
  }

  const cacheKey = `${domain}_${login}`;
  const forceRefresh = req.body?.force === 'true' || req.query?.force === 'true';

  try {
    // ПРОВЕРКА КЭША: Если FORCE не передан и в кэше есть куки
    if (!forceRefresh && sessionCache[cacheKey]) {
      const cachedSession = sessionCache[cacheKey];
      
      // Проверяем жива ли сессия быстрой HTTP-проверкой
      const valid = await isSessionValid(domain, cachedSession.cookie_string);
      
      if (valid) {
        return res.json({
          from_cache: true,
          domain: domain,
          ...cachedSession
        });
      }
    }

    // ЕСЛИ КЭША НЕТ ИЛИ СЕССИЯ СЛЕТЕЛА: Запускаем авторизацию
    const authResult = await performPuppeteerAuth(domain, login, password);

    // Сохраняем свежие куки в кэш
    sessionCache[cacheKey] = {
      success: authResult.success,
      ussid: authResult.ussid,
      cookies: authResult.cookies,
      cookie_string: authResult.cookie_string,
      updatedAt: new Date().toISOString()
    };

    return res.json({
      from_cache: false,
      domain: domain,
      ...sessionCache[cacheKey]
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      domain: domain,
      error: err.message
    });
  }
});
// Эндпоинт добавления исхода в корзину и получения new_max_bet
app.all('/basket', async (req, res) => {
  const login = req.body?.login || req.query?.login || '77088167661';
  const password = req.body?.password || req.query?.password || 'Almaty2026';
  let domain = req.body?.domain || req.query?.domain || '0limpbk-0nline.com';
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const probability = req.body?.probability || req.query?.probability;
  const id = req.body?.id || req.query?.id;
  const match = req.body?.match || req.query?.match;

  if (!probability || !id || !match) {
    return res.status(400).json({ error: 'Параметры probability, id и match обязательны' });
  }

  const cacheKey = `${domain}_${login}`;

  try {
    // 1. Получаем живые куки (из кэша или через Puppeteer)
    let session = sessionCache[cacheKey];
    if (!session || !(await isSessionValid(domain, session.cookie_string))) {
      const authResult = await performPuppeteerAuth(domain, login, password);
      sessionCache[cacheKey] = {
        success: authResult.success,
        ussid: authResult.ussid,
        cookies: authResult.cookies,
        cookie_string: authResult.cookie_string,
        updatedAt: new Date().toISOString()
      };
      session = sessionCache[cacheKey];
    }

    // 2. Сначала очищаем корзину
    const clearUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;
    await axios.post(clearUrl, 'action=clearbasket&currpage=line', {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': session.cookie_string,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${domain}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'
      }
    });

    // 3. Отправляем запрос на добавление коэффициента
    const addUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;
    const payload = `action=addkef&typenav=1&TypeBet=1&currpage=line&text=${probability}&id=${id}:42462&v1=${probability}&v2=1&v3=1&match=${match}`;

    const response = await axios.post(addUrl, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': session.cookie_string,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${domain}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'
      }
    });

    const betslip = response.data?.betslip;
    const targetFullId = id + ':42462';
    let targetBet = null;

    if (betslip) {
      for (let key in betslip) {
        if (betslip.hasOwnProperty(key)) {
          const bet = betslip[key];
          const currentFullId = bet.eventid_added + ':' + bet.market_data;
          if (bet.market_data && currentFullId === targetFullId) {
            targetBet = bet;
            break;
          }
        }
      }
    }

    return res.json({
      success: true,
      bet: targetBet,
      raw_response: response.data
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
// Доп. зависимости (axios)
// Не забудьте убедиться, что axios прописан в package.json

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
