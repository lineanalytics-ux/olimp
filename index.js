const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
 * Быстрая проверка валидности кук в кэше
 */
async function isSessionValid(domain, cookieString) {
  if (!cookieString || !cookieString.includes('ussid=')) {
    return false;
  }

  try {
    const response = await axios.get(`https://${domain}/ajax_basket_index.php?_r=${Math.random()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookieString,
        'X-Requested-With': 'XMLHttpRequest'
      },
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

/**
 * Исправленная авторизация с прохождением Client Challenge
 */
async function performPuppeteerAuth(domain, login, password) {
  let browser = null;
  const targetUrl = `https://${domain}/`;
  const debugLogs = [];

  const log = (msg) => {
    console.log(msg);
    debugLogs.push(msg);
  };

  try {
    log(`[Auth Start] Запуск авторизации для домена: ${domain}`);
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    log(`[Auth Step 1] Переход на ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Проверяем, не попали ли на Client Challenge
    let currentTitle = await page.title();
    log(`[Auth Step 1] Заголовок страницы: "${currentTitle}"`);

    if (currentTitle.includes('Client Challenge') || currentTitle.includes('Just a moment')) {
      log(`[Auth Challenge] Обнаружен защитный челлендж. Ожидаем прохождения JS...`);
      // Даем времени фронтенд-скриптам решить челлендж
      await new Promise(r => setTimeout(r, 6000));
      currentTitle = await page.title();
      log(`[Auth Challenge] Заголовок после ожидания: "${currentTitle}"`);
    }

    // Ожидаем инпут логина
    log(`[Auth Step 2] Ожидание инпута login...`);
    const loginInput = await page.waitForSelector('input[name="login"]', { timeout: 25000 }).catch(() => null);

    if (!loginInput) {
      const pageSnippet = (await page.content()).substring(0, 500);
      log(`[Auth Error] Инпут login не найден! Сниппет HTML:\n${pageSnippet}`);
      throw new Error('Инпут login не найден на странице');
    }

    log(`[Auth Step 3] Ввод логина и пароля...`);
    await page.type('input[name="login"]', login, { delay: 30 });
    await page.type('input[name="passw"]', password, { delay: 30 });

    log(`[Auth Step 4] Отправка формы авторизации через JS...`);
    
    // Выполняем сабмит формы прямо из страницы с захватом скрытых полей asid и psid
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => log(`[Auth Nav Warning] ${e.message}`)),
      page.evaluate(() => {
        const loginInp = document.querySelector('input[name="login"]');
        if (loginInp) {
          const form = loginInp.closest('form');
          if (form) {
            form.submit();
            return;
          }
        }
        // Запасной способ — клик по кнопке
        const enterBtn = document.querySelector('.enterBtn, .enterLinkBtn');
        if (enterBtn) enterBtn.click();
      })
    ]);

    await new Promise(r => setTimeout(r, 4000));

    const finalUrl = page.url();
    const finalTitle = await page.title();
    log(`[Auth Step 5] Итоговый URL: ${finalUrl}`);
    log(`[Auth Step 5] Итоговый Title: "${finalTitle}"`);

    const rawCookies = await page.cookies();
    const cookiesObj = {};
    rawCookies.forEach(c => { cookiesObj[c.name] = c.value; });

    const cookieString = rawCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const ussidVal = cookiesObj['ussid'];

    log(`[Auth Step 6] Получено кук: ${Object.keys(cookiesObj).length}`);
    log(`[Auth Step 6] ussid: "${ussidVal || 'НЕ ПОЛУЧЕН'}"`);

    const isSuccess = Boolean(ussidVal && ussidVal !== 'deleted');

    await browser.close();

    if (!isSuccess) {
      throw new Error(`Авторизация не удалась (ussid=${ussidVal || 'null'}). Title: "${finalTitle}"`);
    }

    return {
      success: true,
      ussid: ussidVal,
      cookies: cookiesObj,
      cookie_string: cookieString,
      logs: debugLogs
    };

  } catch (err) {
    if (browser) await browser.close();
    return {
      success: false,
      error: err.message,
      logs: debugLogs
    };
  }
}

/**
 * Функция работы с корзиной
 */
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
    'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest'
  };

  try {
    await axios.post(clearUrl, 'action=clearbasket&currpage=line', { headers }).catch(() => {});

    const encodedId = encodeURIComponent(fullId);
    const prob = outcome.probability;
    const payload = `action=addkef&typenav=1&TypeBet=1&currpage=line&text=${prob}&id=${encodedId}&v1=${prob}&v2=1&v3=1&match=${matchParam}`;

    const response = await axios.post(addUrl, payload, { headers });
    const betslip = response.data?.betslip;

    if (!betslip) return null;

    const keys = Object.keys(betslip);
    if (keys.length === 0) return null;

    return betslip[keys[0]];
  } catch (e) {
    console.log(`[Basket Exception] ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------
// МАРШРУТЫ API
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

    if (!authResult.success) {
      return res.status(500).json({
        success: false,
        domain: domain,
        error: authResult.error,
        debug_logs: authResult.logs
      });
    }

    sessionCache[cacheKey] = {
      success: true,
      ussid: authResult.ussid,
      cookies: authResult.cookies,
      cookie_string: authResult.cookie_string,
      updatedAt: new Date().toISOString()
    };

    return res.json({
      from_cache: false,
      domain: domain,
      ...sessionCache[cacheKey],
      debug_logs: authResult.logs
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
      const authResult = await performPuppeteerAuth(domain, login, password);
      if (!authResult.success) {
        return res.json({
          success: false,
          error: `Ошибка авторизации: ${authResult.error}`,
          logs: authResult.logs
        });
      }
      sessionCache[cacheKey] = {
        success: true,
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
