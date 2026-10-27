const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

const sessionCache = {};

function parseKef(value) {
  if (typeof value === 'string') {
    value = value.replace(/<[^>]*>/g, '')
                 .replace(/&nbsp;/g, '')
                 .replace(/\s+/g, '')
                 .replace(',', '.');
  }
  return parseFloat(value) || 0;
}

async function isSessionValid(domain, cookieString) {
  try {
    const response = await axios.get(`https://${domain}/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        'Cookie': cookieString
      },
      maxRedirects: 0,
      timeout: 5000,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const setCookie = response.headers['set-cookie'] || [];
    return !setCookie.some(header => header.includes('ussid=deleted'));
  } catch (err) {
    return false;
  }
}

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

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[name="login"]', { timeout: 15000 });

    await page.type('input[name="login"]', login, { delay: 20 });
    await page.type('input[name="passw"]', password, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.keyboard.press('Enter')
    ]);

    await new Promise(r => setTimeout(r, 2000));

    const rawCookies = await page.cookies();
    const cookiesObj = {};
    rawCookies.forEach(c => { cookiesObj[c.name] = c.value; });

    const cookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const isSuccess = Boolean(cookiesObj['ussid'] && cookiesObj['ussid'] !== 'deleted');

    await browser.close();

    if (!isSuccess) throw new Error('Авторизация не удалась');

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
 * Точный вызов корзины по структуре curl-запроса
 */
async function fetchBetFromBasket(domain, cookieString, outcome, matchId) {
  const clearUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;
  const addUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;

  // Формируем составной ID исхода точно как в curl: originalId:basketId
  // Если basketId содержит доп. дефисы или параметры, используем полную цепочку
  let fullBasketId = outcome.basketId;
  if (!fullBasketId.includes(':')) {
    fullBasketId = `${outcome.originalId}:${outcome.basketId}`;
  }

  // Извлекаем чистый matchId (например, 86173165 из basketId)
  const matchParam = outcome.basketId.split(':')[0] || matchId;

  const headers = {
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'ru,en-US;q=0.9,en;q=0.8',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'cookie': cookieString,
    'origin': `https://${domain}`,
    'referer': `https://${domain}/betting/index.php?page=line&action=2`,
    'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest'
  };

  try {
    // 1. Очистка корзины
    await axios.post(clearUrl, 'action=clearbasket&currpage=line', { headers }).catch(() => {});

    // 2. Добавление коэффицента в форматеcurl
    const payload = `action=addkef&typenav=1&TypeBet=1&currpage=line&text=${outcome.probability}&id=${encodeURIComponent(fullBasketId)}&v1=${outcome.probability}&v2=1&v3=1&match=${matchParam}`;

    const response = await axios.post(addUrl, payload, { headers });
    const betslip = response.data?.betslip;

    if (!betslip) return null;

    const keys = Object.keys(betslip);
    if (keys.length === 0) return null;

    // Возвращаем объект добавленного ставки
    return betslip[keys[0]];
  } catch (e) {
    console.log(`[Basket Exception] ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// ЭНДПОИНТ /getmaxinfo
// ---------------------------------------------------------------------
app.all('/getmaxinfo', async (req, res) => {
  const login = req.body?.login || req.query?.login || '77088167661';
  const password = req.body?.password || req.query?.password || 'Almaty2026';
  let domain = req.body?.domain || req.query?.domain || '0limpbk-0nline.com';
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const outcomes = req.body?.outcomes || req.query?.outcomes;
  const matchId = req.body?.matchId || req.query?.matchId;

  if (!outcomes || !Array.isArray(outcomes) || outcomes.length < 2 || !matchId) {
    return res.status(400).json({ error: 'Требуется массив outcomes (2 исхода) и matchId' });
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

    const betjson1 = await fetchBetFromBasket(domain, cookieString, outcomes[0], matchId);
    const betjson2 = await fetchBetFromBasket(domain, cookieString, outcomes[1], matchId);

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

    let result = { maxBet: 0, maxPay: false };

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

app.get('/', (req, res) => res.send('Auth & Basket Service Live'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
