const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// In-Memory кэш сессий: sessionCache[cacheKey] = { cookiesObj, cookie_string, ussid, updatedAt }
const sessionCache = {};

/**
 * Вспомогательная функция очистки значения коэффициента (аналог kAsFloat)
 */
function parseKef(value) {
  if (typeof value === 'string') {
    value = value.replace(/<[^>]*>/g, '')
                 .replace(/&nbsp;/g, '')
                 .replace(/\s+/g, '')
                 .replace(',', '.');
  }
  return parseFloat(value) || 0;
}

/**
 * Быстрая проверка валидности сессии (без запуска Puppeteer)
 */
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

    const setCookie = response.headers['set-cookie'] || [];
    const isDeleted = setCookie.some(header => header.includes('ussid=deleted'));

    return !isDeleted;
  } catch (err) {
    return false;
  }
}

/**
 * Авторизация через Puppeteer (с прохождением JS-челленджа)
 */
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

    // Отключаем загрузку тяжелых ресурсов
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

    // 1. Переход на страницу
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

/**
 * Вспомогательная функция работы с корзиной сайта
 */
async function fetchBetFromBasket(domain, cookieString, probability, id, match) {
  const clearUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;
  const addUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;
  const targetFullId = id + ':42462';

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Cookie': cookieString,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://${domain}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'
  };

  // 1. Очистка корзины
  await axios.post(clearUrl, 'action=clearbasket&currpage=line', { headers }).catch(() => {});

  // 2. Добавление коэффицента в корзину
  const payload = `action=addkef&typenav=1&TypeBet=1&currpage=line&text=${probability}&id=${id}:42462&v1=${probability}&v2=1&v3=1&match=${match}`;
  const response = await axios.post(addUrl, payload, { headers });

  const betslip = response.data?.betslip;
  if (betslip) {
    for (let key in betslip) {
      if (betslip.hasOwnProperty(key)) {
        const bet = betslip[key];
        const currentFullId = bet.eventid_added + ':' + bet.market_data;
        if (bet.market_data && currentFullId === targetFullId) {
          return bet;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// ЭНДПОИНТЫ API
// ---------------------------------------------------------------------

// Главная страница (для пинга / health-check)
app.get('/', (req, res) => {
  res.send('Auth & Basket Service is Live');
});

// 1. Получение кук авторизации
app.all('/auth', async (req, res) => {
  const login = req.body?.login || req.query?.login;
  const password = req.body?.password || req.query?.password;

  let domain = req.body?.domain || req.query?.domain || '0limpbk-0nline.com';
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  if (!login || !password) {
    return res.status(400).json({ error: 'Параметры login и password обязательны' });
  }

  const cacheKey = `${domain}_${login}`;
  const forceRefresh = req.body?.force === 'true' || req.query?.force === 'true';

  try {
    if (!forceRefresh && sessionCache[cacheKey]) {
      const cachedSession = sessionCache[cacheKey];
      const valid = await isSessionValid(domain, cachedSession.cookie_string);
      if (valid) {
        return res.json({
          from_cache: true,
          domain: domain,
          ...cachedSession
        });
      }
    }

    const authResult = await performPuppeteerAuth(domain, login, password);

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

// 2. Вычисление getmaxinfo для события
app.all('/getmaxinfo', async (req, res) => {
  const login = req.body?.login || req.query?.login || '77088167661';
  const password = req.body?.password || req.query?.password || 'Almaty2026';
  let domain = req.body?.domain || req.query?.domain || '0limpbk-0nline.com';
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const outcomes = req.body?.outcomes || req.query?.outcomes;
  const matchId = req.body?.matchId || req.query?.matchId;

  if (!outcomes || !Array.isArray(outcomes) || outcomes.length < 2 || !matchId) {
    return res.status(400).json({ error: 'Требуется массив outcomes (минимум 2 исхода) и matchId' });
  }

  const cacheKey = `${domain}_${login}`;

  try {
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

    const cookieString = session.cookie_string;

    const id1 = `${outcomes[0].originalId}:${outcomes[0].basketId}`;
    const id2 = `${outcomes[1].originalId}:${outcomes[1].basketId}`;

    const betjson1 = await fetchBetFromBasket(domain, cookieString, outcomes[0].probability, id1, matchId);
    const betjson2 = await fetchBetFromBasket(domain, cookieString, outcomes[1].probability, id2, matchId);

    if (!betjson1 || !betjson2) {
      return res.json({
        success: false,
        maxBet: 0,
        maxPay: false,
        error: 'Не удалось получить данные корзины для одного из исходов'
      });
    }

    const bet1 = parseFloat(betjson1.new_max_bet) || 0;
    const bet2 = parseFloat(betjson2.new_max_bet) || 0;
    const k1 = parseKef(betjson1.value);
    const k2 = parseKef(betjson2.value);

    let result = {
      maxBet: 0,
      maxPay: false
    };

    if (bet1 === bet2) {
      result.maxBet = bet1;
      result.maxPay = false;
    } else {
      const calc1 = bet1 * (k1 - 1);
      const calc2 = bet2 * (k2 - 1);
      const max_diff = Math.abs(calc1 - calc2);

      if (max_diff < 1000) {
        result.maxBet = calc1;
        result.maxPay = true;
      }
    }

    return res.json({
      success: true,
      maxBet: result.maxBet,
      maxPay: result.maxPay,
      bet1: bet1,
      bet2: bet2,
      k1: k1,
      k2: k2
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
