// ==UserScript==
// @name         Pepper.ru — актуальная цена в Беларуси
// @namespace    local.pepper.by-price
// @version      2.0.1
// @description  Показывает актуальную цену Ozon и Wildberries в российских рублях прямо на Pepper.ru
// @author       Codex
// @homepageURL  https://github.com/dykomenko/pepper-by-price
// @supportURL   https://github.com/dykomenko/pepper-by-price/issues
// @updateURL    https://raw.githubusercontent.com/dykomenko/pepper-by-price/main/pepper-by-price.user.js
// @downloadURL  https://raw.githubusercontent.com/dykomenko/pepper-by-price/main/pepper-by-price.user.js
// @match        https://pepper.ru/*
// @match        https://www.pepper.ru/*
// @match        https://ozon.ru/*
// @match        https://www.ozon.ru/*
// @match        https://ozon.by/*
// @match        https://www.ozon.by/*
// @match        https://wildberries.ru/*
// @match        https://www.wildberries.ru/*
// @match        https://wildberries.by/*
// @match        https://www.wildberries.by/*
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const PREFIX = 'pepper_by_price_';
  const PENDING_KEY = `${PREFIX}pending_jobs`;
  const CACHE_PREFIX = `${PREFIX}cache_`;
  const RESULT_PREFIX = `${PREFIX}result_`;
  const AUTO_DETAIL_KEY = `${PREFIX}auto_detail`;
  const TAB_FALLBACK_KEY = `${PREFIX}tab_fallback`;
  const RATE_KEY = `${PREFIX}nbrb_rub_rate`;
  const CACHE_TTL = 10 * 60 * 1000;
  const RATE_TTL = 12 * 60 * 60 * 1000;
  const JOB_TTL = 90 * 1000;
  const WORKER_TIMEOUT = 28 * 1000;
  const REQUEST_TIMEOUT = 15 * 1000;
  const PRICE_RE =
    /(\d[\d ]*(?:[,.]\d{1,2})?)\s*(BYN|Br|бел\.?\s*руб\.?|р\.|₽|RUB|рос\.?\s*руб\.?|руб\.?)(?![\p{L}\p{N}])/iu;
  const OUT_OF_STOCK_RE =
    /нет в наличии|товар закончился|распродан|сообщить о поступлении|узнать о поступлении|доставка недоступна|временно недоступен/i;
  const autoStartedDeals = new Set();
  let wbApiLastAttemptAt = 0;
  let wbApiLastError = '';
  let outOfStockHits = 0;

  const host = location.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'pepper.ru') {
    runPepper();
  } else if (host === 'ozon.ru' || host === 'ozon.by') {
    runMarketplaceWorker('ozon');
  } else if (host === 'wildberries.ru' || host === 'wildberries.by') {
    runMarketplaceWorker('wb');
  }

  // ───────────────────────── Pepper ─────────────────────────

  function runPepper() {
    injectStyles();
    registerMenu();
    cleanOldJobs();

    let scanTimer = 0;
    const scheduleScan = () => {
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(scanPepperPage, 180);
    };

    scanPepperPage();
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function registerMenu() {
    const enabled = GM_getValue(AUTO_DETAIL_KEY, true);
    GM_registerMenuCommand(
      `Автопроверка в карточке: ${enabled ? 'включена' : 'выключена'}`,
      () => {
        GM_setValue(AUTO_DETAIL_KEY, !enabled);
        location.reload();
      }
    );

    const tabFallback = GM_getValue(TAB_FALLBACK_KEY, false);
    GM_registerMenuCommand(
      `Если фоновая проверка не сработала, открывать вкладку: ${tabFallback ? 'автоматически' : 'только по кнопке'}`,
      () => {
        GM_setValue(TAB_FALLBACK_KEY, !tabFallback);
        location.reload();
      }
    );

    GM_registerMenuCommand('Очистить сохранённые цены', () => {
      const cards = document.querySelectorAll('[data-pepper-by-deal]');
      for (const card of cards) {
        const id = card.getAttribute('data-pepper-by-deal');
        if (id) GM_deleteValue(`${CACHE_PREFIX}${id}`);
      }
      location.reload();
    });
  }

  function scanPepperPage() {
    enhanceListCards();
    enhanceDealPage();
  }

  function enhanceListCards() {
    const cards = document.querySelectorAll('article[data-gtm-deal-id][data-gtm-store]');

    for (const card of cards) {
      const store = normalizeStore(card.getAttribute('data-gtm-store'));
      if (!store) continue;

      const dealId = card.getAttribute('data-gtm-deal-id');
      if (!dealId) continue;
      if (card.querySelector(`.pby-wrap[data-pepper-by-deal="${dealId}"]`)) continue;

      const wrap = createPriceWidget({ dealId, store, detail: false });
      placeNextToPepperPrice(card, wrap, false);
    }
  }

  function enhanceDealPage() {
    if (document.querySelector('.pby-detail')) return;

    const match = location.pathname.match(/\/(?:deals|coupons)\/[^/]*-(\d+)\/?$/);
    const heading = document.querySelector('h1');
    if (!match || !heading) return;

    const store = detectDetailStore();
    if (!store) return;

    const dealId = match[1];
    const wrap = createPriceWidget({ dealId, store, detail: true });
    placeNextToPepperPrice(heading.parentElement, wrap, true, heading);

    if (
      GM_getValue(AUTO_DETAIL_KEY, true) &&
      !autoStartedDeals.has(dealId) &&
      wrap.querySelector('.pby-button')
    ) {
      autoStartedDeals.add(dealId);
      window.setTimeout(() => startCheck({ dealId, store, wrap }), 350);
    }
  }

  function detectDetailStore() {
    const heading = document.querySelector('h1');
    if (!heading) return null;

    const selector =
      'a[href*="/coupons/ozon.ru"], a[href*="/coupons/wildberries.ru"]';
    let container = heading.parentElement;

    // Ищем магазин только в ближайшем блоке самой скидки. Ссылки из
    // рекомендаций ниже страницы намеренно не учитываем.
    for (let depth = 0; container && depth < 7; depth += 1) {
      const stores = new Set(
        [...container.querySelectorAll(selector)]
          .map((link) => normalizeStore(link.href))
          .filter(Boolean)
      );
      if (stores.size === 1) return [...stores][0];
      if (stores.size > 1) return null;
      container = container.parentElement;
    }

    return null;
  }

  function normalizeStore(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('ozon')) return 'ozon';
    if (text.includes('wildberries') || text.includes('вайлдберриз')) return 'wb';
    return null;
  }

  function placeNextToPepperPrice(root, wrap, detail, fallbackHeading = null) {
    const primaryPrice = [...root.querySelectorAll('div.font-bold')].find((element) => {
      const text = String(element.textContent || '')
        .replace(/[    ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return /^\d[\d ]*(?:[,.]\d{1,2})?\s*(?:₽|RUB|руб\.?)$/iu.test(text);
    });

    const priceRow = primaryPrice?.parentElement;
    if (primaryPrice && priceRow) {
      priceRow.classList.add('pby-host-price-row');
      wrap.classList.add('pby-inline');
      primaryPrice.insertAdjacentElement('afterend', wrap);
      return;
    }

    if (fallbackHeading) {
      fallbackHeading.insertAdjacentElement('afterend', wrap);
    } else {
      root.append(wrap);
    }
  }

  function createPriceWidget({ dealId, store, detail }) {
    const wrap = document.createElement('div');
    wrap.className = `pby-wrap${detail ? ' pby-detail' : ''}`;
    wrap.dataset.pepperByDeal = dealId;
    wrap.dataset.store = store;

    const cached = GM_getValue(`${CACHE_PREFIX}${dealId}`, null);
    if (isFreshResult(cached)) {
      renderResult(wrap, cached);
      return wrap;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pby-button';
    button.textContent = detail ? '🇧🇾 Проверить цену в Беларуси' : '🇧🇾 Цена в Беларуси';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      startCheck({ dealId, store, wrap });
    });
    wrap.append(button);

    return wrap;
  }

  // Сначала пробуем получить цену фоновыми запросами — без вкладок. Вкладка
  // магазина открывается только если фон не сработал и это разрешено
  // (настройка в меню) либо пользователь нажал «Через вкладку».
  async function startCheck({ dealId, store, wrap, viaTab = false }) {
    if (wrap.dataset.pbyLoading === '1') return;
    wrap.dataset.pbyLoading = '1';
    renderLoading(wrap, store);

    let result = null;
    let failure = '';

    if (!viaTab) {
      try {
        result = await checkInBackground({ dealId, store });
      } catch (error) {
        failure = error?.message || String(error);
      }
    }

    if (!result && (viaTab || GM_getValue(TAB_FALLBACK_KEY, false))) {
      result = await checkViaTab({ dealId, store });
    }

    if (!result) {
      result = {
        ok: false,
        checkedAt: Date.now(),
        store,
        message: failure || 'Не удалось получить цену в фоне',
      };
    }

    wrap.dataset.pbyLoading = '0';
    if (result.ok) GM_setValue(`${CACHE_PREFIX}${dealId}`, result);

    const widgets = document.querySelectorAll(`[data-pepper-by-deal="${dealId}"]`);
    if (widgets.length) {
      for (const widget of widgets) renderResult(widget, result);
    } else {
      renderResult(wrap, result);
    }
  }

  function findVisitUrl(dealId) {
    const links = [...document.querySelectorAll(`a[href*="/visit/"][href$="/${dealId}"]`)];
    const buyLink = links.find((link) => /к скидке|купить|применить/i.test(link.textContent || ''));
    return buyLink?.href || `https://www.pepper.ru/visit/home-get-deals-1/${dealId}`;
  }

  // ───────────────── Фоновая проверка (без вкладок) ─────────────────

  async function checkInBackground({ dealId, store }) {
    const product = await resolveProduct(dealId);

    let result;
    if (product.store === 'ozon') {
      result = await fetchOzonApi(product);
    } else {
      result = await fetchWildberriesBackground(product);
    }

    if (result.ok && result.currency === 'BYN') {
      result = await convertResultToRub(result);
    }
    result.store = product.store;
    result.checkedAt = Date.now();
    result.url = product.url;
    return result;
  }

  // Идём по цепочке редиректов вручную и останавливаемся, как только в
  // Location появился адрес товара: сам магазин при этом не запрашивается,
  // поэтому его недоступность или антибот на этом шаге не мешают.
  async function resolveProduct(dealId) {
    const headers = { Accept: 'text/html' };
    let current = findVisitUrl(dealId);
    let lastError = null;

    for (let hop = 0; hop < 8; hop += 1) {
      let response;
      try {
        response = await gmRequest(current, { headers, redirect: 'manual' });
        lastError = null;
      } catch (_) {
        // Не все менеджеры скриптов умеют redirect: 'manual' — пробуем обычный режим.
        try {
          response = await gmRequest(current, { headers });
          lastError = null;
        } catch (error) {
          lastError = error;
          break;
        }
      }

      const location = readLocation(response, current);
      const candidates = [response.finalUrl, location].filter(Boolean);

      // Короткие страницы-заглушки трекеров редиректят через meta/JS.
      const body = String(response.responseText || '');
      if (response.status === 200 && body.length < 5000) candidates.push(body);

      for (const value of candidates) {
        const product = parseProductUrl(value) || parseProductUrl(safeDecode(value));
        if (product) return product;
      }

      if (!location || location === current) break;
      current = location;
    }

    throw new Error(
      lastError
        ? `Не удалось перейти по ссылке скидки: ${lastError.message}`
        : 'Не удалось определить товар по ссылке скидки'
    );
  }

  function readLocation(response, baseUrl) {
    const raw = String(response?.responseHeaders || '').match(/^location:\s*(.+)$/im)?.[1]?.trim();
    if (!raw) return null;
    try {
      return new URL(raw, baseUrl).href;
    } catch (_) {
      return null;
    }
  }

  function parseProductUrl(value) {
    const text = String(value || '').trim();
    let url = null;
    try {
      url = new URL(text);
    } catch (_) {
      url = null;
    }

    const fromUrl = url ? productFromUrl(url) : null;
    if (fromUrl) return fromUrl;

    // Партнёрские ссылки иногда несут адрес товара в параметре (?ulp=…).
    const embedded = text.match(
      /https?:\/\/(?:www\.)?(?:ozon\.(?:ru|by)\/product\/[^\s"'&?#<>]+|wildberries\.(?:ru|by)\/catalog\/\d+\/[^\s"'&?#<>]*)/i
    );
    if (embedded) {
      try {
        return productFromUrl(new URL(embedded[0]));
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function productFromUrl(url) {
    const hostName = url.hostname.replace(/^www\./, '').toLowerCase();

    if (/^ozon\.(?:ru|by)$/.test(hostName)) {
      const match = url.pathname.match(/\/product\/(?:[^/]*-)?(\d+)\/?/);
      if (match) {
        const path = url.pathname.replace(/\/?$/, '/');
        return {
          store: 'ozon',
          id: match[1],
          path,
          url: `https://www.ozon.by${path}`,
        };
      }
    }

    if (/^wildberries\.(?:ru|by)$/.test(hostName)) {
      const match = url.pathname.match(/\/catalog\/(\d+)\//);
      if (match) {
        return {
          store: 'wb',
          id: match[1],
          url: `https://www.wildberries.by/catalog/${match[1]}/detail.aspx`,
        };
      }
    }

    return null;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  async function fetchOzonApi(product) {
    const apiUrl =
      `https://www.ozon.by/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(product.path)}`;

    let response;
    try {
      response = await gmRequest(apiUrl, { headers: { Accept: 'application/json' } });
    } catch (error) {
      throw new Error(`Ozon не ответил: ${error.message}`);
    }

    if (response.status === 404) {
      return outOfStockResult('товара нет на Ozon.by');
    }
    if (response.status !== 200) {
      throw new Error(`Ozon вернул HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(response.responseText);
    } catch (_) {
      throw new Error('Ozon прислал проверку браузера вместо цены');
    }

    const states = payload?.widgetStates || {};
    const readWidget = (prefix) => {
      const key = Object.keys(states).find((name) => name.startsWith(prefix));
      if (!key) return null;
      try {
        return JSON.parse(states[key]);
      } catch (_) {
        return null;
      }
    };

    const priceWidget = readWidget('webPrice-');
    const stockWidget = readWidget('webOutOfStock-');

    const priceText = priceWidget?.price || priceWidget?.finalPrice || null;
    const parsed = priceText ? parsePriceText(priceText) : null;

    if (parsed) {
      const unavailable = priceWidget.isAvailable === false || Boolean(stockWidget);
      return {
        ok: true,
        price: parsed.normalized,
        currency: parsed.currency,
        valueByn: parsed.currency === 'BYN' ? parsed.value : null,
        valueRub: parsed.currency === 'RUB' ? parsed.value : null,
        available: unavailable ? false : true,
        note: null,
        sourceText: `Ozon API: ${priceText}`,
      };
    }

    if (stockWidget || priceWidget?.isAvailable === false) {
      return outOfStockResult('закончился на Ozon.by');
    }

    throw new Error('Ozon не вернул данные о цене');
  }

  async function fetchWildberriesBackground(product) {
    const apiUrl =
      `https://www.wildberries.by/__internal/card/cards/v4/detail?appType=1&nm=${product.id}&locale=by`;

    let response;
    try {
      response = await gmRequest(apiUrl, { headers: { Accept: 'application/json' } });
    } catch (error) {
      throw new Error(`Wildberries не ответил: ${error.message}`);
    }

    if (response.status !== 200) {
      throw new Error(`Wildberries вернул HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(response.responseText);
    } catch (_) {
      throw new Error('Wildberries прислал проверку браузера вместо цены');
    }

    return parseWildberriesPayload(payload, Number(product.id), apiUrl, 'BYN');
  }

  function outOfStockResult(note) {
    return {
      ok: true,
      outOfStock: true,
      available: false,
      price: null,
      currency: 'RUB',
      note,
    };
  }

  function gmRequest(url, options = {}) {
    const where = (() => {
      try {
        return new URL(url).hostname;
      } catch (_) {
        return url;
      }
    })();

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: options.headers,
        timeout: options.timeout || REQUEST_TIMEOUT,
        anonymous: false,
        ...(options.redirect ? { redirect: options.redirect } : {}),
        onload: resolve,
        onerror: (response) => reject(new Error(
          `сеть недоступна (${where}${response?.error ? `: ${response.error}` : ''})`
        )),
        ontimeout: () => reject(new Error(`превышено время ожидания (${where})`)),
        onabort: () => reject(new Error(`запрос прерван (${where})`)),
      });
    });
  }

  // ───────────── Резерв: проверка через вкладку магазина ─────────────

  function checkViaTab({ dealId, store }) {
    return new Promise((resolve) => {
      const jobId = `${dealId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const resultKey = `${RESULT_PREFIX}${jobId}`;
      addPendingJob({ jobId, dealId, store, startedAt: Date.now() });

      let settled = false;
      let workerTab = null;
      let pollTimer = 0;
      let timeoutTimer = 0;
      let listenerId = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        if (listenerId !== null) GM_removeValueChangeListener(listenerId);
        GM_deleteValue(resultKey);
        removePendingJob(jobId);
        try {
          workerTab?.close();
        } catch (_) {
          // Вкладка могла уже закрыться сама.
        }
        resolve(result || {
          ok: false,
          checkedAt: Date.now(),
          store,
          message: 'Не удалось получить ответ магазина',
        });
      };

      listenerId = GM_addValueChangeListener(resultKey, (_key, _oldValue, newValue) => {
        if (newValue) finish(newValue);
      });

      pollTimer = window.setInterval(() => {
        const value = GM_getValue(resultKey, null);
        if (value) finish(value);
      }, 350);

      timeoutTimer = window.setTimeout(() => {
        finish({
          ok: false,
          checkedAt: Date.now(),
          store,
          message: 'Магазин не отдал цену. Нажмите ещё раз или сначала откройте его сайт.',
        });
      }, WORKER_TIMEOUT + 5000);

      const visitUrl = findVisitUrl(dealId);
      const marker = new URLSearchParams({
        'pepper-by-job': jobId,
        'pepper-by-deal': dealId,
        'pepper-by-store': store,
      });
      const separator = visitUrl.includes('#') ? '&' : '#';

      try {
        workerTab = GM_openInTab(`${visitUrl}${separator}${marker}`, {
          active: false,
          insert: true,
          setParent: true,
        });
      } catch (error) {
        finish({
          ok: false,
          checkedAt: Date.now(),
          store,
          message: `Не удалось открыть магазин в фоне: ${error?.message || error}`,
        });
      }
    });
  }

  // ───────────────────────── Отрисовка ─────────────────────────

  function renderLoading(wrap, store) {
    wrap.className = `${wrap.className.replace(/\s+pby-(?:loading|ok|warn|error)/g, '')} pby-loading`;
    wrap.replaceChildren();

    const spinner = document.createElement('span');
    spinner.className = 'pby-spinner';

    const text = document.createElement('span');
    text.textContent = `Проверяю ${store === 'ozon' ? 'Ozon.by' : 'Wildberries.by'}…`;

    wrap.append(spinner, text);
  }

  function renderResult(wrap, result) {
    wrap.className = wrap.className.replace(/\s+pby-(?:loading|ok|warn|error)/g, '');
    wrap.replaceChildren();

    if (!result?.ok) {
      wrap.classList.add('pby-error');
      const message = document.createElement('span');
      message.textContent = `🇧🇾 ${result?.message || 'Цена не найдена'}`;
      wrap.append(message);

      const retryWith = (label, title, viaTab) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pby-retry';
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          startCheck({
            dealId: wrap.dataset.pepperByDeal,
            store: wrap.dataset.store,
            wrap,
            viaTab,
          });
        });
        wrap.append(button);
      };

      retryWith('Повторить', 'Проверить ещё раз в фоне', false);
      retryWith('Через вкладку', 'Открыть магазин во вкладке и считать цену оттуда', true);
      return;
    }

    wrap.classList.add(result.available === false ? 'pby-warn' : 'pby-ok');

    const noPrice = !result.price;
    const price = document.createElement(result.url && !noPrice ? 'a' : 'span');
    price.className = 'pby-price';
    price.textContent = noPrice ? '🇧🇾 Нет в наличии' : `🇧🇾 ${result.price}`;
    if (result.url && !noPrice) {
      price.href = result.url;
      price.target = '_blank';
      price.rel = 'noopener noreferrer';
      price.addEventListener('click', (event) => event.stopPropagation());
    }
    wrap.append(price);

    const metaParts = [];
    if (result.note) metaParts.push(result.note);
    if (result.available === false && !noPrice) metaParts.push('нет доставки / закончился');
    if (result.checkedAt) {
      metaParts.push(new Date(result.checkedAt).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      }));
    }

    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.className = 'pby-meta';
      meta.textContent = metaParts.join(' · ');
      wrap.append(meta);
    }

    wrap.title = result.sourceText || '';
  }

  function isFreshResult(result) {
    return Boolean(
      result &&
      result.ok &&
      result.checkedAt &&
      result.currency === 'RUB' &&
      Date.now() - result.checkedAt < CACHE_TTL
    );
  }

  // ───────────────── Вкладка магазина (резервный путь) ─────────────────

  async function runMarketplaceWorker(expectedStore) {
    const marker = readMarker();
    const job = marker || claimPendingJob(expectedStore);
    if (!job || job.store !== expectedStore) return;

    const targetHost = expectedStore === 'ozon' ? 'ozon.by' : null;
    if (
      targetHost &&
      location.hostname.replace(/^www\./, '') !== targetHost.replace(/^www\./, '')
    ) {
      const url = new URL(location.href);
      url.hostname = targetHost;
      if (!marker) url.hash = createMarker(job);
      location.replace(url.href);
      return;
    }

    const resultKey = `${RESULT_PREFIX}${job.jobId}`;

    try {
      let result = await waitForMarketplaceResult(expectedStore);
      if (result.ok && result.currency === 'BYN') {
        result = await convertResultToRub(result);
      }
      result.store = expectedStore;
      result.checkedAt = Date.now();
      result.url = cleanWorkerUrl(location.href);
      GM_setValue(resultKey, result);
    } catch (error) {
      GM_setValue(resultKey, {
        ok: false,
        checkedAt: Date.now(),
        store: expectedStore,
        url: cleanWorkerUrl(location.href),
        message: error?.message || String(error),
      });
    }

    removePendingJob(job.jobId);
    window.setTimeout(() => window.close(), 300);
  }

  function readMarker() {
    const raw = location.hash.replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const jobId = params.get('pepper-by-job');
    const dealId = params.get('pepper-by-deal');
    const store = params.get('pepper-by-store');
    if (!jobId || !dealId || !store) return null;
    return { jobId, dealId, store, startedAt: Date.now() };
  }

  function createMarker(job) {
    return new URLSearchParams({
      'pepper-by-job': job.jobId,
      'pepper-by-deal': job.dealId,
      'pepper-by-store': job.store,
    }).toString();
  }

  function cleanWorkerUrl(value) {
    const url = new URL(value);
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    for (const key of [...params.keys()]) {
      if (key.startsWith('pepper-by-')) params.delete(key);
    }
    url.hash = params.toString() ? `#${params}` : '';
    return url.href;
  }

  async function waitForMarketplaceResult(store) {
    const startedAt = Date.now();
    let lastResult = null;

    while (Date.now() - startedAt < WORKER_TIMEOUT) {
      if (store === 'wb') {
        const apiResult = await extractWildberriesApi();
        if (apiResult?.ok) return apiResult;
      }

      lastResult = store === 'ozon' ? extractOzon() : extractWildberries();
      if (lastResult?.ok) return lastResult;
      if (lastResult?.terminal) {
        return {
          ok: false,
          message: lastResult.message,
        };
      }
      await delay(450);
    }

    if (lastResult?.message) {
      return { ok: false, message: lastResult.message };
    }
    return {
      ok: false,
      message: `Цена не появилась за ${Math.round(WORKER_TIMEOUT / 1000)} секунд`,
    };
  }

  function extractOzon() {
    const pageText = document.body?.innerText || '';
    const blocked = detectBlockPage(pageText);
    if (blocked) return blocked;

    const widget =
      document.querySelector('[data-widget="webPrice"]') ||
      document.querySelector('[data-widget="webOutOfStock"]');

    if (widget) {
      const candidates = collectPriceCandidates(widget);
      if (candidates.length) {
        const selected = candidates.find((item) => item.currency === 'RUB') || candidates[0];
        const unavailable = OUT_OF_STOCK_RE.test(widget.innerText);
        return {
          ok: true,
          price: selected.normalized,
          currency: selected.currency,
          valueByn: selected.currency === 'BYN' ? selected.value : null,
          valueRub: selected.currency === 'RUB' ? selected.value : null,
          sourceText: candidates.map((item) => item.text).join(' | '),
          available: unavailable
            ? false
            : (hasVisibleTextButton(/в корзину|купить сейчас/i) ? true : null),
          note: selected.note,
        };
      }
    }

    // Товар закончился: виджета с ценой нет, есть только заглушка.
    const stockWidget = document.querySelector('[data-widget="webOutOfStock"]');
    if (stockWidget && OUT_OF_STOCK_RE.test(stockWidget.innerText || '')) {
      return outOfStockResult('закончился на Ozon.by');
    }

    if (/по вашему запросу ничего не найдено|товар не найден|такой страницы не существует/i.test(pageText)) {
      return {
        terminal: true,
        message: 'Этого товара нет на Ozon.by',
      };
    }

    return {
      ok: false,
      message: 'Ozon пока не показал цену',
    };
  }

  function extractWildberries() {
    const pageText = document.body?.innerText || '';
    const blocked = detectBlockPage(pageText);
    if (blocked) return blocked;

    if (/по вашему запросу ничего не найдено|такой страницы нет|товар не найден/i.test(pageText)) {
      return {
        terminal: true,
        message: 'Этого товара нет на Wildberries.by',
      };
    }

    const walletRoot = firstVisible([
      '[class*="wallet-price"]',
      '[class*="walletPrice"]',
      '[data-testid*="wallet"][data-testid*="price"]',
    ]);
    if (walletRoot) {
      const walletPrices = collectPriceCandidates(walletRoot);
      if (walletPrices.length) {
        const selected = walletPrices.find((item) => item.currency === 'RUB') || walletPrices[0];
        return {
          ok: true,
          price: selected.normalized,
          currency: selected.currency,
          valueByn: selected.currency === 'BYN' ? selected.value : null,
          valueRub: selected.currency === 'RUB' ? selected.value : null,
          sourceText: walletRoot.innerText,
          available: !OUT_OF_STOCK_RE.test(pageText),
          note: 'с WB Кошельком',
        };
      }
    }

    const priceRoot = firstVisible([
      '[data-testid="product-price"]',
      '[data-testid="price-current"]',
      'ins.price-block__final-price',
      '.price-block__final-price',
      '[class*="price-block"]',
      '[class*="priceBlock"]',
    ]);

    if (priceRoot) {
      const prices = collectPriceCandidates(priceRoot);
      if (prices.length) {
        const selected = prices.find((item) => item.currency === 'RUB') || prices[0];
        return {
          ok: true,
          price: selected.normalized,
          currency: selected.currency,
          valueByn: selected.currency === 'BYN' ? selected.value : null,
          valueRub: selected.currency === 'RUB' ? selected.value : null,
          sourceText: priceRoot.innerText,
          available: !OUT_OF_STOCK_RE.test(pageText),
          note: null,
        };
      }
    }

    // Нет цены, но в блоке товара есть признаки «нет в наличии». Требуем два
    // совпадения подряд, чтобы не принять за них ещё не догрузившуюся страницу.
    const productArea =
      document.querySelector('.product-page, [class*="productPage"], [class*="product-page"], main');
    if (productArea && OUT_OF_STOCK_RE.test((productArea.innerText || '').slice(0, 4000))) {
      outOfStockHits += 1;
      if (outOfStockHits >= 2) return outOfStockResult('нет в наличии на Wildberries.by');
    } else {
      outOfStockHits = 0;
    }

    const genericPrices = collectPriceCandidates(
      document.querySelector('main') || document.body,
      { generic: true }
    );
    if (genericPrices.length) {
      const selected = genericPrices.find((item) => item.currency === 'RUB') || genericPrices[0];
      return {
        ok: true,
        price: selected.normalized,
        currency: selected.currency,
        valueByn: selected.currency === 'BYN' ? selected.value : null,
        valueRub: selected.currency === 'RUB' ? selected.value : null,
        sourceText: genericPrices.slice(0, 3).map((item) => item.text).join(' | '),
        available: !OUT_OF_STOCK_RE.test(pageText),
        note: null,
      };
    }

    return {
      ok: false,
      message: wbApiLastError
        ? `Wildberries не отдал цену: ${wbApiLastError}`
        : 'Wildberries пока не показал цену',
    };
  }

  async function extractWildberriesApi() {
    if (Date.now() - wbApiLastAttemptAt < 3000) return null;

    const articleMatch = location.pathname.match(/\/catalog\/(\d+)\//);
    if (!articleMatch) {
      wbApiLastError = 'не найден артикул в адресе карточки';
      return null;
    }

    const articleId = Number(articleMatch[1]);
    const resourceUrls = (globalThis.performance?.getEntriesByType?.('resource') || [])
      .map((entry) => entry.name)
      .filter((url) => /\/(?:__internal\/card\/)?cards\/v4\/detail/i.test(url));

    const matchingUrl = resourceUrls.find((url) => {
      try {
        const parsed = new URL(url);
        const ids = String(parsed.searchParams.get('nm') || '').split(';');
        return ids.includes(String(articleId));
      } catch (_) {
        return false;
      }
    });

    const fallbackUrl = (() => {
      const fallback = new URL('/__internal/card/cards/v4/detail', location.origin);
      fallback.searchParams.set('nm', String(articleId));
      fallback.searchParams.set('locale', 'ru');
      return fallback.href;
    })();
    const apiUrls = [...new Set([matchingUrl, fallbackUrl].filter(Boolean))];
    const defaultCurrency = location.hostname.endsWith('.by') ? 'BYN' : 'RUB';

    wbApiLastAttemptAt = Date.now();

    for (const apiUrl of apiUrls) {
      try {
        const response = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          wbApiLastError = `внутренний запрос вернул HTTP ${response.status}`;
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        if (!/json/i.test(contentType)) {
          wbApiLastError = 'вместо цены пришла проверка браузера';
          continue;
        }

        const payload = await response.json();
        const result = parseWildberriesPayload(payload, articleId, apiUrl, defaultCurrency);
        wbApiLastError = '';
        return result;
      } catch (error) {
        wbApiLastError = error?.message || String(error);
      }
    }

    return null;
  }

  // Разбирает ответ cards/v4/detail. Бросает ошибку, если цену прочитать
  // нельзя; «товар закончился» — это штатный результат, а не ошибка.
  function parseWildberriesPayload(payload, articleId, apiUrl, defaultCurrency) {
    const products = payload?.products || payload?.data?.products || [];
    const product =
      products.find((item) => Number(item?.id) === articleId) ||
      (products.length === 1 ? products[0] : null);

    if (!product) {
      return outOfStockResult('нет в наличии или снят с продажи');
    }

    const inStock =
      Number(product.totalQuantity || 0) > 0 ||
      (product.sizes || []).some((size) =>
        (size.stocks || []).some((stock) => Number(stock.qty || 0) > 0)
      );

    const selected = selectWildberriesApiPrice(product);
    if (!selected) {
      if (!inStock) return outOfStockResult('нет в наличии на Wildberries.by');
      throw new Error('в ответе нет поля текущей цены');
    }

    const currency = detectWildberriesApiCurrency(apiUrl, payload, product, defaultCurrency);
    const value = selected.raw / 100;
    const normalized = currency === 'RUB'
      ? `${formatMoney(value)} ₽`
      : `${formatMoney(value)} BYN`;

    return {
      ok: true,
      price: normalized,
      currency,
      valueRub: currency === 'RUB' ? value : null,
      valueByn: currency === 'BYN' ? value : null,
      available: inStock,
      note: /wallet|club/i.test(selected.key) ? 'с WB Кошельком' : null,
      sourceText: `WB API: ${selected.path}=${selected.raw}; ${apiUrl}`,
    };
  }

  function selectWildberriesApiPrice(product) {
    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const priceObjects = sizes
      .map((size, index) => ({
        value: size?.price,
        path: `sizes[${index}].price`,
      }))
      .filter((item) => item.value && typeof item.value === 'object');

    const priorities = [
      'wallet',
      'walletPrice',
      'club',
      'clubPrice',
      'clubDiscountedPrice',
      'product',
      'salePrice',
      'sale',
      'final',
      'total',
    ];

    for (const key of priorities) {
      const values = priceObjects
        .map((item) => ({
          key,
          path: `${item.path}.${key}`,
          raw: Number(item.value[key]),
        }))
        .filter((item) => Number.isFinite(item.raw) && item.raw > 0);
      if (values.length) return values.sort((a, b) => a.raw - b.raw)[0];
    }

    const legacyPriorities = ['walletPriceU', 'clubPriceU', 'salePriceU', 'priceU'];
    for (const key of legacyPriorities) {
      const raw = Number(product[key]);
      if (Number.isFinite(raw) && raw > 0) {
        return { key, path: key, raw };
      }
    }

    const basicValues = priceObjects
      .map((item) => ({
        key: 'basic',
        path: `${item.path}.basic`,
        raw: Number(item.value.basic),
      }))
      .filter((item) => Number.isFinite(item.raw) && item.raw > 0);
    return basicValues.sort((a, b) => a.raw - b.raw)[0] || null;
  }

  function detectWildberriesApiCurrency(apiUrl, payload, product, defaultCurrency) {
    const urlCurrency = (() => {
      try {
        return new URL(apiUrl).searchParams.get('curr');
      } catch (_) {
        return null;
      }
    })();
    const explicit = [
      urlCurrency,
      product?.currency,
      product?.currencyCode,
      product?.currencyIsoCode4217,
      payload?.currency,
    ]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();

    if (explicit.includes('RUB')) return 'RUB';
    if (explicit.includes('BYN') || explicit.includes('BYR')) return 'BYN';
    return defaultCurrency;
  }

  // ───────────────────── Цены и курс ─────────────────────

  function formatMoney(value) {
    return new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  function parsePriceText(raw) {
    const text = String(raw || '')
      .replace(/[    ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const match = text.match(PRICE_RE);
    if (!match) return null;

    // «бел. руб.» содержит «руб», поэтому белорусский рубль проверяем первым.
    const currency = /BYN|Br|бел/iu.test(match[2])
      ? 'BYN'
      : (/₽|RUB|рос\.?\s*руб|руб\.?/iu.test(match[2]) ? 'RUB' : 'BYN');
    const numberText = match[1].replace(/\s+/g, ' ').trim().replace('.', ',');

    return {
      text,
      currency,
      value: Number.parseFloat(match[1].replace(/\s+/g, '').replace(',', '.')),
      normalized: `${numberText} ${currency === 'RUB' ? '₽' : 'BYN'}`,
    };
  }

  function collectPriceCandidates(root, options = {}) {
    if (!root) return [];

    const all = [root, ...root.querySelectorAll('*')];
    const seen = new Set();
    const candidates = [];

    for (const element of all) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      if (element.children.length > 2) continue;

      const text = String(element.innerText || element.textContent || '')
        .replace(/[    ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text || text.length > 80) continue;

      const parsed = parsePriceText(text);
      if (!parsed) continue;

      const uniqueKey = `${parsed.currency}:${parsed.normalized}`;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);

      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      let score = fontSize;
      if (element.matches('ins, [class*="final"], [class*="current"]')) score += 35;
      if (element.closest('[data-widget="webPrice"], [data-widget="webOutOfStock"]')) score += 45;
      if (/wallet/i.test(element.className || '') || element.closest('[class*="wallet"]')) score += 30;
      if (style.textDecorationLine.includes('line-through') || element.matches('del, s')) score -= 80;
      if (options.generic) {
        const rect = element.getBoundingClientRect();
        if (rect.top > 0 && rect.top < 1400) score += 8;
      }

      candidates.push({
        text,
        normalized: parsed.normalized,
        currency: parsed.currency,
        value: parsed.value,
        score,
        note: /wallet|кошел/i.test(`${element.className} ${element.parentElement?.className || ''}`)
          ? 'с WB Кошельком'
          : null,
      });
    }

    return candidates.sort((a, b) => b.score - a.score);
  }

  async function convertResultToRub(result) {
    const valueByn = result.valueByn || extractBynNumber(result.price);
    if (!Number.isFinite(valueByn) || valueByn <= 0) {
      throw new Error('Цена найдена, но её не удалось пересчитать в российские рубли');
    }

    const rate = await getRubRate();
    const valueRub = Math.round((valueByn / rate.officialRate) * rate.scale);

    return {
      ...result,
      price: `${new Intl.NumberFormat('ru-RU').format(valueRub)} ₽`,
      currency: 'RUB',
      valueRub,
      valueByn,
      note: [result.note, 'по курсу НБРБ'].filter(Boolean).join(' · '),
    };
  }

  function extractBynNumber(value) {
    const match = String(value || '')
      .replace(/[    ]/g, ' ')
      .match(/\d[\d ]*(?:[,.]\d{1,2})?/);
    return match
      ? Number.parseFloat(match[0].replace(/\s+/g, '').replace(',', '.'))
      : Number.NaN;
  }

  function getRubRate() {
    const cached = GM_getValue(RATE_KEY, null);
    if (
      cached &&
      Number.isFinite(cached.officialRate) &&
      Number.isFinite(cached.scale) &&
      Date.now() - cached.checkedAt < RATE_TTL
    ) {
      return Promise.resolve(cached);
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://api.nbrb.by/exrates/rates/RUB?parammode=2',
        timeout: 10000,
        responseType: 'json',
        onload: (response) => {
          let data = response.response;
          if (!data) {
            try {
              data = JSON.parse(response.responseText);
            } catch (_) {
              data = null;
            }
          }

          const rate = {
            officialRate: Number(data?.Cur_OfficialRate),
            scale: Number(data?.Cur_Scale),
            rateDate: data?.Date || null,
            checkedAt: Date.now(),
          };

          if (!Number.isFinite(rate.officialRate) || !Number.isFinite(rate.scale)) {
            reject(new Error('НБРБ не вернул курс российского рубля'));
            return;
          }

          GM_setValue(RATE_KEY, rate);
          resolve(rate);
        },
        onerror: () => reject(new Error('Не удалось загрузить курс российского рубля НБРБ')),
        ontimeout: () => reject(new Error('НБРБ не ответил вовремя')),
      });
    });
  }

  // ───────────────────── DOM-утилиты ─────────────────────

  function firstVisible(selectors) {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (element instanceof HTMLElement && isVisible(element)) return element;
      }
    }
    return null;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number.parseFloat(style.opacity || '1') > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function hasVisibleTextButton(pattern) {
    for (const element of document.querySelectorAll('button, a')) {
      if (isVisible(element) && pattern.test(element.textContent || '')) return true;
    }
    return false;
  }

  function detectBlockPage(pageText) {
    if (/проверяем браузер|checking your browser/i.test(pageText)) {
      return {
        ok: false,
        message: 'Магазин проверяет браузер — ждём',
      };
    }
    if (/captcha|подтвердите, что вы не робот|слишком много запросов/i.test(pageText)) {
      return {
        terminal: true,
        message: 'Магазин запросил проверку. Откройте его вручную один раз и повторите.',
      };
    }
    return null;
  }

  function addPendingJob(job) {
    const jobs = getPendingJobs().filter((item) => item.jobId !== job.jobId);
    jobs.push(job);
    GM_setValue(PENDING_KEY, jobs);
  }

  function claimPendingJob(store) {
    const jobs = getPendingJobs();
    const index = jobs.findIndex((job) => job.store === store);
    if (index < 0) return null;
    const [job] = jobs.splice(index, 1);
    GM_setValue(PENDING_KEY, jobs);
    return job;
  }

  function removePendingJob(jobId) {
    const jobs = getPendingJobs().filter((job) => job.jobId !== jobId);
    GM_setValue(PENDING_KEY, jobs);
  }

  function cleanOldJobs() {
    GM_setValue(PENDING_KEY, getPendingJobs());
  }

  function getPendingJobs() {
    const now = Date.now();
    const jobs = GM_getValue(PENDING_KEY, []);
    if (!Array.isArray(jobs)) return [];
    return jobs.filter((job) => job && now - job.startedAt < JOB_TTL);
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .pby-wrap {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
        width: fit-content;
        max-width: calc(100% - 24px);
        margin: 8px 12px 12px;
        padding: 7px 10px;
        border: 1px solid #b9c8d6;
        border-radius: 10px;
        background: #f3f7fa;
        color: #283746;
        font: 600 13px/1.25 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: default;
        position: relative;
        z-index: 2;
      }
      .pby-detail {
        margin: 8px 0 14px;
        padding: 9px 12px;
        font-size: 14px;
      }
      .pby-host-price-row {
        height: auto !important;
        min-height: 30px;
        overflow: visible !important;
        white-space: normal !important;
        flex-wrap: wrap !important;
        gap: 5px 0;
      }
      .pby-host-price-row::after {
        display: none !important;
      }
      .pby-wrap.pby-inline {
        grid-column: auto;
        flex: 0 0 auto;
        width: fit-content;
        max-width: 100%;
        margin: 0 6px 0 1px;
        padding: 5px 8px;
        font-size: 12px;
      }
      .pby-wrap.pby-inline.pby-detail {
        margin: 0 6px 0 2px;
        padding: 6px 10px;
        font-size: 13px;
      }
      .pby-button,
      .pby-retry {
        appearance: none;
        border: 0;
        padding: 0;
        background: transparent;
        color: #1769aa;
        font: inherit;
        cursor: pointer;
      }
      .pby-button:hover,
      .pby-retry:hover,
      .pby-price:hover {
        text-decoration: underline;
      }
      .pby-loading {
        border-color: #9db8d2;
        background: #edf5fc;
        color: #315b7e;
      }
      .pby-ok {
        border-color: #9bd3af;
        background: #edfbf2;
        color: #116334;
      }
      .pby-warn {
        border-color: #e4c175;
        background: #fff8e8;
        color: #7b5100;
      }
      .pby-error {
        border-color: #e1a6a6;
        background: #fff1f1;
        color: #8a2929;
      }
      .pby-price {
        color: inherit;
        font-weight: 750;
        text-decoration: none;
      }
      .pby-meta {
        font-size: 11px;
        font-weight: 500;
        opacity: .8;
      }
      .pby-retry {
        margin-left: 4px;
        color: inherit;
      }
      .pby-spinner {
        width: 13px;
        height: 13px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: pby-spin .7s linear infinite;
      }
      @keyframes pby-spin {
        to { transform: rotate(360deg); }
      }
      @media (prefers-color-scheme: dark) {
        .pby-wrap {
          background: #252a31;
          border-color: #48535f;
          color: #e4eaf0;
        }
        .pby-loading { background: #1e3446; color: #b9ddfb; }
        .pby-ok { background: #173b29; color: #b7efd0; }
        .pby-warn { background: #463719; color: #ffe09a; }
        .pby-error { background: #472424; color: #ffc4c4; }
        .pby-button { color: #8bc8fa; }
      }
    `;
    document.head.append(style);
  }
})();
