const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

puppeteer.use(StealthPlugin());

const app = express();

// Поддержка JSON и URL-encoded данных
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Данные SOCKS5 прокси
const PROXY_HOST = process.env.PROXY_HOST || '194.67.199.219';
const PROXY_PORT = process.env.PROXY_PORT || '33129';
const PROXY_USER = process.env.PROXY_USER || 'security';
const PROXY_PASS = process.env.PROXY_PASS || 'xLKmvUg7652eTPVIs7nr';

// SOCKS5 Агент для Axios
const socksAgent = new SocksProxyAgent(`socks5://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`);

// In-Memory кэш сессий
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

/**
 * Валидация сессии из кэша через прокси
 */
async function isSessionValid(domain, cookieString) {
  if (!cookieString || !cookieString.includes('ussid=')) {
    return false;
  }

  try {
    const response = await axios.get(`https://${domain}/ajax_basket_index.php?_r=${Math.random()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        'Cookie': cookieString,
        'X-Requested-With': 'XMLHttpRequest'
      },
      httpsAgent: socksAgent,
      httpAgent: socksAgent,
      maxRedirects: 0,
      timeout: 5000,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const setCookie = response.headers['set-cookie'] || [];
    const isDeleted = setCookie.some(header => header.includes('ussid=deleted'));

    if (isDeleted) return false;
    return Boolean(response.data && typeof response.data === 'object');
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------
// АВТОРИЗАЦИЯ ПУППЕТИРА (С ПОДДКЛЮЧЕНИЕМ SOCKS5 ПРОКСИ)
// ---------------------------------------------------------------------
async function performPuppeteerAuth(domain, login, password) {
  let browser = null;
  const targetUrl = `https://${domain}/`;

  try {
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
        `--proxy-server=socks5://${PROXY_HOST}:${PROXY_PORT}`
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Авторизация на SOCKS5 прокси
    await page.authenticate({
      username: PROXY_USER,
      password: PROXY_PASS
    });

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

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('input[name="login"]', { timeout: 20000 });

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

    if (!isSuccess) throw new Error('Авторизация не удалась (ussid не получен)');

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

// ---------------------------------------------------------------------
// ФУНКЦИЯ КОРЗИНЫ (ЧЕРЕЗ SOCKS5 PROXY)
// ---------------------------------------------------------------------
async function fetchBetFromBasket(domain, cookieString, outcome, matchId) {
  const clearUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;
  const addUrl = `https://${domain}/ajax_basket_index.php?_r=${Math.random()}`;

  const originalId = String(outcome.originalId || '').trim();
  const basketId = String(outcome.basketId || '').trim();

  let fullId = `${originalId}:${basketId}`;
  if (!fullId.endsWith(':140612801')) {
    fullId += ':140612801';
  }

  const matchParam = basketId.split(':')[0] || matchId;

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
    await axios.post(clearUrl, 'action=clearbasket&currpage=line', { 
      headers,
      httpsAgent: socksAgent,
      httpAgent: socksAgent 
    }).catch(() => {});

    const encodedId = encodeURIComponent(fullId);
    const prob = outcome.probability;
    const payload = `action=addkef&typenav=1&TypeBet=1&currpage=line&text=${prob}&id=${encodedId}&v1=${prob}&v2=1&v3=1&match=${matchParam}`;

    console.log(`[Basket Req] Payload: ${payload}`);

    const response = await axios.post(addUrl, payload, { 
      headers,
      httpsAgent: socksAgent,
      httpAgent: socksAgent 
    });

    const betslip = response.data?.betslip;

    if (!betslip) {
      console.log(`[Basket Fail] Поле betslip не получено. Ответ: ${JSON.stringify(response.data)}`);
      return null;
    }

    const keys = Object.keys(betslip);
    if (keys.length === 0) return null;

    return betslip[keys[0]];
  } catch (e) {
    console.log(`[Basket Exception] ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// МАРШРУТЫ И ЭНДПОИНТЫ API
// ---------------------------------------------------------------------

app.get('/', (req, res) => {
  res.send('Auth & Basket Service is Live');
});

const handleAuth = async (req, res) => {
  const login = req.query?.login || req.body?.login;
  const password = req.query?.password || req.body?.password;

  let domain = req.query?.domain || req.body?.domain || '0limpbk-0nline.com';
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  if (!login || !password) {
    return res.status(400).json({ error: 'Параметры login и password обязательны' });
  }

  const cacheKey = `${domain}_${login}`;
  const forceRefresh = req.query?.force === 'true' || req.body?.force === 'true';

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
};

app.get('/auth', handleAuth);
app.post('/auth', handleAuth);

const handleGetMaxInfo = async (req, res) => {
  const login = req.query?.login || req.body?.login || '77088167661';
  const password = req.query?.password || req.body?.password || 'Almaty2026';
  let domain = req.query?.domain || req.body?.domain || '0limpbk-0nline.com';
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();

  const outcomes = req.body?.outcomes || (req.query?.outcomes ? JSON.parse(req.query.outcomes) : null);
  const matchId = req.body?.matchId || req.query?.matchId;

  if (!outcomes || !Array.isArray(outcomes) || outcomes.length < 2 || !matchId) {
    return res.status(400).json({ error: 'Требуется массив outcomes (2 исхода) и matchId' });
  }

  const cacheKey = `${domain}_${login}`;

  try {
    let session = sessionCache[cacheKey];
    if (!session || !(await isSessionValid(domain, session.cookie_string))) {
      console.log('[Auth] Запуск авторизации Puppeteer...');
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
        debug: {
          bet1_ok: Boolean(betjson1),
          bet2_ok: Boolean(betjson2)
        },
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
};

app.get('/getmaxinfo', handleGetMaxInfo);
app.post('/getmaxinfo', handleGetMaxInfo);

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
