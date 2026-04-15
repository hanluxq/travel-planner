// ========== 旅行规划器 - 主逻辑（腾讯地图 POI 实时搜索版） ==========

(function () {
  'use strict';

  // ---- 状态 ----
  let map = null;
  let currentCity = '北京';
  let days = 3;
  let budget = '标准';
  let sightMarkers = [];
  let hotelMarkers = [];
  let arrivalMarkers = [];
  let sightLabels = [];
  let hotelLabels = [];
  let arrivalLabels = [];
  let itineraryData = null;

  // POI 搜索缓存 { cityName: { sights: [...], hotels: [...] } }
  let poiCache = {};

  // 路线分段
  let segmentPolylines = [];
  let segmentPoints = [];
  let highlightMarker = null;
  let activeSegmentIdx = -1;

  // 拖拽检测
  let mapMouseDownPos = null;

  // API 限流保护
  let consecutiveFailures = 0;       // 连续失败计数
  let apiSuspended = false;           // API 是否暂停
  let cityLoadVersion = 0;            // 城市加载版本号（用于取消旧请求）
  let lastRequestTime = 0;            // 上次请求时间戳

  // ========== localStorage 缓存管理模块 ==========
  const CACHE_KEY = 'travel_city_cache';
  const CACHE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

  const CityCache = {
    // 读取全部缓存
    _readAll() {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
          localStorage.removeItem(CACHE_KEY);
          return {};
        }
        return parsed;
      } catch (e) {
        console.warn('缓存数据损坏，已清除:', e);
        localStorage.removeItem(CACHE_KEY);
        return {};
      }
    },

    // 写入全部缓存
    _writeAll(data) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch (e) {
        if (e.name === 'QuotaExceededError' || e.code === 22) {
          // 存储空间不足，清除最早的缓存
          this._evictOldest(data);
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
          } catch (e2) {
            console.warn('缓存写入失败（空间不足）:', e2);
          }
        } else {
          console.warn('缓存写入失败:', e);
        }
      }
    },

    // 清除最早的缓存条目
    _evictOldest(data) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, val] of Object.entries(data)) {
        if (val.timestamp && val.timestamp < oldestTime) {
          oldestTime = val.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        delete data[oldestKey];
        console.log('已清除最早缓存:', oldestKey);
      }
    },

    // 获取城市缓存（检查过期）
    get(cityName) {
      const all = this._readAll();
      const entry = all[cityName];
      if (!entry) return null;

      // 检查数据完整性
      if (!entry.center || !Array.isArray(entry.center) || !entry.arrivals) {
        delete all[cityName];
        this._writeAll(all);
        return null;
      }

      // 检查过期
      if (!entry.timestamp || (Date.now() - entry.timestamp > CACHE_EXPIRE_MS)) {
        delete all[cityName];
        this._writeAll(all);
        return null;
      }

      return { center: entry.center, arrivals: entry.arrivals };
    },

    // 写入城市缓存
    set(cityName, data) {
      const all = this._readAll();
      all[cityName] = {
        center: data.center,
        arrivals: data.arrivals,
        timestamp: Date.now()
      };
      this._writeAll(all);
    },

    // 获取所有已缓存的城市名列表
    getCachedCityNames() {
      const all = this._readAll();
      return Object.keys(all).filter(name => {
        const entry = all[name];
        return entry.timestamp && (Date.now() - entry.timestamp <= CACHE_EXPIRE_MS);
      });
    }
  };

  // ---- DOM ----
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const citySelect = $('#citySelect');
  const cityInput = $('#cityInput');
  const citySuggestions = $('#citySuggestions');
  const daysValue = $('#daysValue');
  const daysDown = $('#daysDown');
  const daysUp = $('#daysUp');
  const budgetTabs = $$('.budget-tab');
  const budgetDetail = $('#budgetDetail');
  const arrivalSelect = $('#arrivalSelect');
  const layerSights = $('#layerSights');
  const layerHotels = $('#layerHotels');
  const planBtn = $('#planBtn');
  const loadingOverlay = $('#loadingOverlay');
  const itineraryPanel = $('#itineraryPanel');
  const panelBody = $('#panelBody');
  const panelClose = $('#panelClose');
  const costSummary = $('#costSummary');
  const modalOverlay = $('#modalOverlay');
  const modalClose = $('#modalClose');
  const mapContainer = $('#mapContainer');

  // ========== 初始化 ==========
  function init() {
    populateCities();
    initCitySearch();
    initMap();
    bindEvents();
    updateBudgetDetail();
    // 延迟加载 POI，等地图 SDK 完全就绪
    setTimeout(() => loadCity(currentCity), 1000);
  }

  // 填充城市下拉菜单（全部预设城市）
  function populateCities() {
    ALL_CITIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      citySelect.appendChild(opt);
    });
    citySelect.value = currentCity;
  }

  // 初始化城市搜索输入框
  function initCitySearch() {
    cityInput.value = '';
  }

  function initMap() {
    // 默认城市（北京）一定在预设数据中，直接使用
    const cityData = CITY_DATA[currentCity];
    try {
      map = new TMap.Map('mapContainer', {
        center: new TMap.LatLng(cityData.center[1], cityData.center[0]),
        zoom: 12,
        viewMode: '2D'
      });
    } catch (e) {
      console.error('地图初始化失败:', e);
      mapContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:16px;">地图加载失败，请刷新页面重试</div>';
    }
  }

  // ========== POI 搜索（WebService API JSONP + 限流队列） ==========

  // 从 HTML 中提取 API key
  const API_KEY = (function () {
    const script = document.querySelector('script[src*="gljs"]');
    if (script) {
      const m = script.src.match(/key=([^&]+)/);
      if (m) return m[1];
    }
    return 'GGHBZ-ELU6A-A5YKL-C3ITZ-4UEBF-PKBDJ';
  })();

  // JSONP 请求
  let jsonpId = 0;
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cbName = '__qqmap_cb_' + (++jsonpId) + '_' + Date.now();
      const script = document.createElement('script');
      const cleanup = () => {
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, 10000);
      window[cbName] = (data) => {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      script.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cbName;
      script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('网络错误')); };
      document.head.appendChild(script);
    });
  }

  // 请求队列：串行发出请求避免 QPS 限制
  let requestQueue = Promise.resolve();
  function enqueueRequest(fn) {
    const p = requestQueue.then(() => fn(), () => fn());
    requestQueue = p.catch(() => {});
    return p;
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 带重试的 POI 搜索（WebService API）
  async function searchPOI(cityName, keyword, category, retries) {
    if (retries === undefined) retries = 3;
    const url = 'https://apis.map.qq.com/ws/place/v1/search/?keyword=' +
      encodeURIComponent(keyword) +
      '&boundary=region(' + encodeURIComponent(cityName) + ',0)' +
      '&page_size=20&page_index=1&key=' + API_KEY;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await jsonp(url);

        if (!result || result.status !== 0 || !result.data || result.data.length === 0) {
          if (result && result.message && result.message.includes('上限') && attempt < retries) {
            await delay(2000 * (attempt + 1));
            continue;
          }
          return [];
        }

        return result.data.map(poi => ({
          name: poi.title,
          lat: poi.location.lat,
          lng: poi.location.lng,
          address: poi.address || '',
          category: poi.category || category,
          tel: poi.tel || '',
          type: category
        }));
      } catch (e) {
        if (attempt < retries) {
          await delay(2000 * (attempt + 1));
          continue;
        }
        console.warn(`POI 搜索失败 [${keyword}@${cityName}]:`, e.message);
        return [];
      }
    }
    return [];
  }

  // 搜索城市的景点和酒店（带缓存 + 串行请求）
  async function fetchCityPOI(cityName) {
    if (poiCache[cityName]) return poiCache[cityName];

    const loadingEl = showSearchStatus('正在搜索真实 POI 数据...');

    try {
      // 串行搜索避免 QPS 限制
      const sightsRaw = await enqueueRequest(() => searchPOI(cityName, '景点', '景点'));
      await delay(1200);
      const hotelsRaw = await enqueueRequest(() => searchPOI(cityName, '酒店', '酒店'));

      // 去重 + 转换景点数据
      const seenNames = new Set();
      const sights = sightsRaw.filter(s => {
        if (seenNames.has(s.name)) return false;
        seenNames.add(s.name);
        return true;
      }).slice(0, 15).map(s => ({
        ...s,
        rating: +(4 + Math.random() * 0.9).toFixed(1),
        price: Math.floor(Math.random() * 120),
        duration: `${1 + Math.floor(Math.random() * 3)}-${3 + Math.floor(Math.random() * 2)}小时`,
        type: s.category || '景点'
      }));

      // 转换酒店数据：根据名称关键词推断价格等级
      const hotelNames = new Set();
      const hotels = hotelsRaw.filter(h => {
        if (hotelNames.has(h.name)) return false;
        hotelNames.add(h.name);
        return true;
      }).slice(0, 10).map((h, i) => {
        const tier = getHotelTier(h.name, i);
        return {
          ...h,
          rating: +(3.8 + Math.random() * 1.1).toFixed(1),
          price: tier.price,
          type: tier.type,
          stars: tier.stars
        };
      });

      const data = { sights, hotels };

      if (sights.length === 0 && hotels.length === 0) {
        showSearchStatus('⚠️ POI 搜索无结果，可能是 API Key 限流，请稍后重试或更换 Key');
        setTimeout(() => {
          const tip = document.querySelector('.search-status');
          if (tip) tip.remove();
        }, 5000);
      } else {
        poiCache[cityName] = data;
      }

      return data;
    } catch (e) {
      console.error('POI 搜索失败:', e);
      return { sights: [], hotels: [] };
    } finally {
      if (loadingEl) loadingEl.remove();
    }
  }

  // 根据酒店名称关键词和排序位推断等级
  function getHotelTier(name, index) {
    const luxuryKeywords = ['丽思', '万豪', '希尔顿', '洲际', '香格里拉', '华尔道夫', '柏悦', '安缦', '四季', '半岛', '文华东方', '瑰丽', '费尔蒙', '宝格丽', '丽晶'];
    const comfortKeywords = ['喜来登', '威斯汀', '凯悦', '皇冠假日', '索菲特', '铂尔曼', '诺富特', '雅高', '假日'];
    const budgetKeywords = ['如家', '7天', '汉庭', '速8', '格林豪泰', '锦江之星', '莫泰'];

    if (luxuryKeywords.some(k => name.includes(k))) {
      return { type: '豪华', price: 1200 + Math.floor(Math.random() * 1500), stars: 5 };
    }
    if (comfortKeywords.some(k => name.includes(k))) {
      return { type: '舒适', price: 500 + Math.floor(Math.random() * 500), stars: 4 };
    }
    if (budgetKeywords.some(k => name.includes(k))) {
      return { type: '经济', price: 150 + Math.floor(Math.random() * 150), stars: 2 };
    }
    // 搜索结果排名靠前的通常是较知名酒店
    if (index < 3) return { type: '豪华', price: 800 + Math.floor(Math.random() * 1000), stars: 5 };
    if (index < 6) return { type: '标准', price: 350 + Math.floor(Math.random() * 250), stars: 3 };
    return { type: '经济', price: 150 + Math.floor(Math.random() * 150), stars: 2 };
  }

  function showSearchStatus(msg) {
    const el = document.createElement('div');
    el.className = 'search-status';
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#2563eb;color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;font-weight:600;z-index:30000;box-shadow:0 4px 16px rgba(37,99,235,.3);';
    document.body.appendChild(el);
    return el;
  }

  // ========== 城市数据线上获取 ==========

  // 通过地理编码 API 获取地点中心坐标
  // 智能处理：依次尝试多种候选地址，只要能定位到坐标就返回
  async function geocodeCity(cityName) {
    // 构建候选地址列表：优先带"市"后缀，再尝试原名
    const candidates = [];
    if (!cityName.endsWith('市') && !cityName.endsWith('省') && !cityName.endsWith('区') && !cityName.endsWith('县') && !cityName.endsWith('州')) {
      candidates.push(cityName + '市');
    }
    candidates.push(cityName);

    let lastError = '';
    for (const addr of candidates) {
      try {
        const url = 'https://apis.map.qq.com/ws/geocoder/v1/?address=' +
          encodeURIComponent(addr) +
          '&key=' + API_KEY;

        const result = await jsonp(url);
        if (result && result.status === 0 && result.result && result.result.location) {
          return {
            lat: result.result.location.lat,
            lng: result.result.location.lng
          };
        }
        lastError = (result && result.message) || '未知错误';
      } catch (e) {
        lastError = e.message;
      }
    }

    throw new Error('无法定位"' + cityName + '"的坐标: ' + lastError);
  }

  // 通过坐标逆地理编码获取所在城市名
  async function reverseGeocode(lat, lng) {
    await throttleRequest();
    const url = 'https://apis.map.qq.com/ws/geocoder/v1/?location=' +
      lat + ',' + lng + '&key=' + API_KEY;

    try {
      const result = await jsonp(url);
      if (result && result.status === 0 && result.result && result.result.address_component) {
        const comp = result.result.address_component;
        // 返回城市名（去掉"市"后缀以匹配预设数据）
        const city = (comp.city || '').replace(/市$/, '');
        const district = comp.district || '';
        const province = (comp.province || '').replace(/省$/, '');
        return {
          city: city,
          district: district,
          province: province,
          fullAddress: result.result.address || ''
        };
      }
    } catch (e) {
      console.warn('逆地理编码失败:', e.message);
    }
    return null;
  }

  // 通过 POI 搜索定位任意地点，返回 { lat, lng, name, city, address }
  async function searchPOILocation(keyword) {
    await throttleRequest();
    // 全国范围搜索该 POI
    const url = 'https://apis.map.qq.com/ws/place/v1/search/?keyword=' +
      encodeURIComponent(keyword) +
      '&boundary=region(全国,0)' +
      '&page_size=5&page_index=1&key=' + API_KEY;

    try {
      const result = await jsonp(url);
      if (result && result.status === 0 && result.data && result.data.length > 0) {
        const poi = result.data[0];
        return {
          lat: poi.location.lat,
          lng: poi.location.lng,
          name: poi.title,
          address: poi.address || '',
          city: poi.ad_info ? (poi.ad_info.city || '').replace(/市$/, '') : ''
        };
      }
    } catch (e) {
      console.warn('POI 搜索定位失败:', e.message);
    }
    return null;
  }

  // 智能解析用户输入：可能是城市名、也可能是任意 POI
  // 返回 { cityName, poiInfo? } — cityName 是最终要规划的城市
  async function resolveUserInput(input) {
    input = input.trim();
    if (!input) return null;

    // 1. 先检查是否直接匹配预设城市
    if (CITY_DATA[input] || ALL_CITIES.includes(input)) {
      return { cityName: input };
    }

    // 2. 检查是否匹配缓存城市
    const cachedNames = CityCache.getCachedCityNames();
    if (cachedNames.includes(input)) {
      return { cityName: input };
    }

    // 3. 尝试 POI 搜索 — 用户可能输入了具体地点
    const loadingEl = showSearchStatus('正在搜索 "' + input + '"...');
    try {
      const poiResult = await searchPOILocation(input);

      if (poiResult && poiResult.lat && poiResult.lng) {
        // POI 搜索成功，获取到坐标
        let cityName = poiResult.city;

        // 如果 POI 搜索结果没有城市信息，通过逆地理编码获取
        if (!cityName) {
          const geoInfo = await reverseGeocode(poiResult.lat, poiResult.lng);
          if (geoInfo && geoInfo.city) {
            cityName = geoInfo.city;
          }
        }

        if (cityName) {
          return {
            cityName: cityName,
            poiInfo: poiResult
          };
        }
      }

      // 4. POI 搜索无结果，尝试当作城市名进行地理编码
      try {
        await throttleRequest();
        const location = await geocodeCity(input);
        // 地理编码成功，通过逆地理编码确认城市名
        const geoInfo = await reverseGeocode(location.lat, location.lng);
        if (geoInfo && geoInfo.city) {
          return { cityName: geoInfo.city };
        }
        // 逆地理编码失败，直接用输入作为城市名
        return { cityName: input };
      } catch (e) {
        // 完全无法识别
        return null;
      }
    } finally {
      if (loadingEl) loadingEl.remove();
    }
  }

  // 搜索城市交通枢纽（机场、高铁站、火车站）
  async function fetchTransportHubs(cityName) {
    const hubTypes = [
      { keyword: '机场', type: '机场' },
      { keyword: '高铁站', type: '高铁站' },
      { keyword: '火车站', type: '火车站' }
    ];

    const arrivals = [];

    for (const hub of hubTypes) {
      // 确保请求间隔
      await throttleRequest();
      const url = 'https://apis.map.qq.com/ws/place/v1/search/?keyword=' +
        encodeURIComponent(hub.keyword) +
        '&boundary=region(' + encodeURIComponent(cityName) + ',0)' +
        '&page_size=5&page_index=1&key=' + API_KEY;

      try {
        const result = await jsonp(url);
        if (result && result.status === 0 && result.data && result.data.length > 0) {
          // 过滤出真正属于该城市的交通枢纽
          result.data.forEach(poi => {
            // 避免重复
            if (!arrivals.some(a => a.name === poi.title)) {
              arrivals.push({
                name: poi.title,
                lat: poi.location.lat,
                lng: poi.location.lng,
                type: hub.type
              });
            }
          });
        }
      } catch (e) {
        console.warn(`搜索${cityName}${hub.keyword}失败:`, e.message);
        recordApiFailure();
      }
    }

    return arrivals;
  }

  // 完整的城市数据线上获取
  async function fetchCityDataOnline(cityName) {
    const loadingEl = showSearchStatus('正在获取城市数据...');

    try {
      // 1. 获取城市中心坐标
      await throttleRequest();
      const location = await geocodeCity(cityName);
      resetApiFailures();

      // 2. 获取交通枢纽
      const arrivals = await fetchTransportHubs(cityName);

      // 3. 组装数据
      const cityData = {
        center: [location.lng, location.lat],
        arrivals: arrivals
      };

      // 4. 如果没有交通枢纽，添加城市中心作为默认到达点
      if (arrivals.length === 0) {
        cityData.arrivals = [{
          name: cityName + '市中心',
          lat: location.lat,
          lng: location.lng,
          type: '城市中心'
        }];
        showSearchStatus('⚠️ 未找到该城市的交通枢纽信息，已使用城市中心作为到达点');
        setTimeout(() => {
          const tip = document.querySelector('.search-status');
          if (tip) tip.remove();
        }, 4000);
      }

      // 5. 写入缓存
      CityCache.set(cityName, cityData);

      return cityData;
    } catch (e) {
      recordApiFailure();
      throw e;
    } finally {
      if (loadingEl) loadingEl.remove();
    }
  }

  // ========== 三级数据源查询 ==========
  async function getCityData(cityName) {
    // 第一级：预设数据
    if (CITY_DATA[cityName]) {
      return CITY_DATA[cityName];
    }

    // 第二级：本地缓存
    const cached = CityCache.get(cityName);
    if (cached) {
      return cached;
    }

    // 检查 API 是否暂停
    if (apiSuspended) {
      throw new Error('API 服务暂时不可用，请稍后重试，或选择预设的热门城市');
    }

    // 第三级：线上获取
    try {
      return await fetchCityDataOnline(cityName);
    } catch (e) {
      // 最终降级：只要能获取到坐标就构造最小可用数据
      try {
        await throttleRequest();
        const location = await geocodeCity(cityName);
        const fallbackData = {
          center: [location.lng, location.lat],
          arrivals: [{
            name: cityName + '中心',
            lat: location.lat,
            lng: location.lng,
            type: '城市中心'
          }]
        };
        CityCache.set(cityName, fallbackData);
        return fallbackData;
      } catch (e2) {
        throw new Error('无法定位"' + cityName + '"，请尝试输入更具体的地名（如城市名）');
      }
    }
  }

  // ========== API 限流保护 ==========

  // 请求节流：确保每次请求间隔不少于 1 秒
  async function throttleRequest() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < 1000) {
      await delay(1000 - elapsed);
    }
    lastRequestTime = Date.now();
  }

  // 记录 API 失败
  function recordApiFailure() {
    consecutiveFailures++;
    if (consecutiveFailures >= 5) {
      apiSuspended = true;
      showSearchStatus('⚠️ API 服务暂时不可用，请稍后重试');
      setTimeout(() => {
        const tip = document.querySelector('.search-status');
        if (tip) tip.remove();
      }, 5000);
      // 30 秒后自动恢复
      setTimeout(() => {
        apiSuspended = false;
        consecutiveFailures = 0;
      }, 30000);
    }
  }

  // 重置失败计数
  function resetApiFailures() {
    consecutiveFailures = 0;
    apiSuspended = false;
  }

  // ========== 城市搜索建议 ==========

  // 通过行政区划 API 搜索城市（同时支持 POI 搜索提示）
  async function searchCitySuggestions(keyword) {
    if (!keyword || keyword.length === 0) return [];

    // 先从预设城市和缓存中匹配
    const localResults = [];
    const cachedNames = CityCache.getCachedCityNames();
    const allKnownCities = [...new Set([...ALL_CITIES, ...cachedNames])];

    allKnownCities.forEach(name => {
      if (name.includes(keyword)) {
        localResults.push({
          name: name,
          isPreset: ALL_CITIES.includes(name),
          isCached: cachedNames.includes(name),
          isPOI: false
        });
      }
    });

    // 预设城市排在前面
    localResults.sort((a, b) => {
      if (a.isPreset && !b.isPreset) return -1;
      if (!a.isPreset && b.isPreset) return 1;
      return 0;
    });

    // 如果本地结果足够多，不发起 API 请求（但仍添加"搜索此地点"选项）
    if (localResults.length >= 5 || apiSuspended) {
      // 如果输入不完全匹配已知城市，添加一个"搜索此地点"选项
      if (!allKnownCities.includes(keyword)) {
        localResults.push({
          name: keyword,
          isPreset: false,
          isCached: false,
          isPOI: true,
          displayName: '🔍 搜索 "' + keyword + '" 并规划所在城市'
        });
      }
      return localResults.slice(0, 10);
    }

    // 线上搜索补充
    try {
      await throttleRequest();
      const url = 'https://apis.map.qq.com/ws/district/v1/search?keyword=' +
        encodeURIComponent(keyword) +
        '&key=' + API_KEY;

      const result = await jsonp(url);
      resetApiFailures();

      if (result && result.status === 0 && result.result && result.result[0]) {
        const districts = result.result[0];
        districts.forEach(d => {
          const cityName = d.fullname.replace(/市$/, '');
          if (!localResults.some(r => r.name === cityName) && !localResults.some(r => r.name === d.fullname)) {
            const name = ALL_CITIES.includes(cityName) ? cityName : (ALL_CITIES.includes(d.fullname) ? d.fullname : cityName);
            localResults.push({
              name: name,
              isPreset: ALL_CITIES.includes(name),
              isCached: false,
              isPOI: false
            });
          }
        });
      }
    } catch (e) {
      console.warn('城市搜索建议 API 失败:', e.message);
      recordApiFailure();
    }

    // 始终在末尾添加"搜索此地点"选项（如果输入不完全匹配已知城市）
    const allNames = localResults.map(r => r.name);
    if (!allNames.includes(keyword)) {
      localResults.push({
        name: keyword,
        isPreset: false,
        isCached: false,
        isPOI: true,
        displayName: '🔍 搜索 "' + keyword + '" 并规划所在城市'
      });
    }

    return localResults.slice(0, 10);
  }

  // ========== 事件绑定 ==========
  let searchDebounceTimer = null;
  let suggestionsVisible = false;

  function bindEvents() {
    // 城市下拉菜单事件
    citySelect.addEventListener('change', () => {
      const name = citySelect.value;
      if (name && name !== currentCity) {
        currentCity = name;
        cityInput.value = '';
        closeItinerary();
        loadCity(currentCity);
      }
    });

    // 城市搜索输入框事件
    bindCitySearchEvents();

    daysDown.addEventListener('click', () => {
      if (days > 1) { days--; daysValue.textContent = days; }
    });
    daysUp.addEventListener('click', () => {
      if (days < 14) { days++; daysValue.textContent = days; }
    });

    budgetTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        budgetTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        budget = tab.dataset.budget;
        updateBudgetDetail();
      });
    });

    layerSights.addEventListener('change', () => toggleMarkers('sight', layerSights.checked));
    layerHotels.addEventListener('change', () => toggleMarkers('hotel', layerHotels.checked));

    planBtn.addEventListener('click', startPlanning);
    panelClose.addEventListener('click', closeItinerary);

    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (suggestionsVisible) {
          hideSuggestions();
        } else if (modalOverlay.style.display === 'flex') {
          closeModal();
        } else if (itineraryPanel.style.display === 'flex') {
          closeItinerary();
        }
      }
    });

    // 点击外部关闭建议列表
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#citySearchWrapper')) {
        hideSuggestions();
      }
    });

    mapContainer.addEventListener('mousedown', (e) => {
      mapMouseDownPos = { x: e.clientX, y: e.clientY };
    });
    mapContainer.addEventListener('click', (e) => {
      if (!mapMouseDownPos) return;
      const dx = e.clientX - mapMouseDownPos.x;
      const dy = e.clientY - mapMouseDownPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      mapMouseDownPos = null;
      if (dist < 5 && activeSegmentIdx >= 0) {
        resetHighlight();
      }
    });
  }

  // 城市搜索输入框事件绑定
  function bindCitySearchEvents() {
    // 输入事件（带防抖）
    cityInput.addEventListener('input', () => {
      const keyword = cityInput.value.trim();
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

      if (!keyword) {
        // 空输入时显示热门城市
        showHotCities();
        return;
      }

      searchDebounceTimer = setTimeout(async () => {
        const suggestions = await searchCitySuggestions(keyword);
        renderSuggestions(suggestions, keyword);
      }, 300);
    });

    // 聚焦时显示建议
    cityInput.addEventListener('focus', () => {
      const keyword = cityInput.value.trim();
      if (!keyword) {
        showHotCities();
      } else {
        // 触发一次搜索
        cityInput.dispatchEvent(new Event('input'));
      }
    });

    // 失焦时清空搜索框
    cityInput.addEventListener('blur', (e) => {
      // 延迟关闭，以便点击建议项时能先触发
      setTimeout(() => {
        if (suggestionsVisible) {
          hideSuggestions();
        }
        // 清空搜索框
        cityInput.value = '';
      }, 200);
    });

    // 键盘导航
    cityInput.addEventListener('keydown', (e) => {
      if (!suggestionsVisible) return;

      const items = citySuggestions.querySelectorAll('.city-suggestion-item');
      const activeItem = citySuggestions.querySelector('.city-suggestion-item.active');
      let activeIdx = -1;
      items.forEach((item, i) => { if (item === activeItem) activeIdx = i; });

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = activeIdx < items.length - 1 ? activeIdx + 1 : 0;
        items.forEach(item => item.classList.remove('active'));
        items[nextIdx].classList.add('active');
        items[nextIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = activeIdx > 0 ? activeIdx - 1 : items.length - 1;
        items.forEach(item => item.classList.remove('active'));
        items[prevIdx].classList.add('active');
        items[prevIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeItem) {
          if (activeItem.dataset.isPoi === 'true') {
            handlePOIInput(activeItem.dataset.city);
          } else {
            selectCity(activeItem.dataset.city);
          }
        } else {
          // 没有选中项时，直接将输入作为 POI 搜索
          const inputVal = cityInput.value.trim();
          if (inputVal) {
            handlePOIInput(inputVal);
          } else if (items.length > 0) {
            selectCity(items[0].dataset.city);
          }
        }
      }
    });
  }

  // 显示热门城市推荐
  function showHotCities() {
    const suggestions = ALL_CITIES.map(name => ({
      name: name,
      isPreset: true,
      isCached: false
    }));
    renderSuggestions(suggestions, '', '🔥 热门城市');
  }

  // 渲染建议列表
  function renderSuggestions(suggestions, keyword, headerText) {
    citySuggestions.innerHTML = '';

    if (suggestions.length === 0) {
      citySuggestions.innerHTML = '<div class="city-suggestion-empty">😕 未找到匹配城市，按回车可搜索任意地点</div>';
      citySuggestions.classList.add('visible');
      suggestionsVisible = true;
      return;
    }

    if (headerText) {
      const header = document.createElement('div');
      header.className = 'city-suggestion-header';
      header.textContent = headerText;
      citySuggestions.appendChild(header);
    }

    suggestions.forEach(s => {
      const item = document.createElement('div');
      item.className = 'city-suggestion-item';
      item.dataset.city = s.name;
      if (s.isPOI) item.dataset.isPoi = 'true';

      if (s.isPOI) {
        // POI 搜索选项，特殊样式
        item.innerHTML = '<span style="color:var(--c-primary);font-weight:600">' + (s.displayName || s.name) + '</span>';
        item.style.borderTop = '1px solid #e2e8f0';
        item.style.marginTop = '4px';
        item.style.paddingTop = '10px';
      } else {
        // 高亮匹配文字
        let nameHtml = s.name;
        if (keyword) {
          const idx = s.name.indexOf(keyword);
          if (idx >= 0) {
            nameHtml = s.name.substring(0, idx) +
              '<strong style="color:var(--c-primary)">' + keyword + '</strong>' +
              s.name.substring(idx + keyword.length);
          }
        }

        let tagHtml = '';
        if (s.isPreset) {
          tagHtml = '<span class="city-tag preset">推荐</span>';
        } else if (s.isCached) {
          tagHtml = '<span class="city-tag cached">已缓存</span>';
        }

        item.innerHTML = '<span>' + nameHtml + '</span>' + tagHtml;
      }

      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 阻止 blur 事件
        if (s.isPOI) {
          handlePOIInput(s.name);
        } else {
          selectCity(s.name);
        }
      });

      citySuggestions.appendChild(item);
    });

    citySuggestions.classList.add('visible');
    suggestionsVisible = true;
  }

  // 隐藏建议列表
  function hideSuggestions() {
    citySuggestions.classList.remove('visible');
    suggestionsVisible = false;
  }

  // 选择城市
  function selectCity(cityName) {
    hideSuggestions();
    cityInput.value = '';
    if (cityName !== currentCity) {
      currentCity = cityName;
      // 同步更新下拉菜单（如果该城市在预设列表中）
      if (ALL_CITIES.includes(cityName)) {
        citySelect.value = cityName;
      } else {
        // 非预设城市，添加到下拉菜单并选中
        let found = false;
        for (const opt of citySelect.options) {
          if (opt.value === cityName) { found = true; break; }
        }
        if (!found) {
          const opt = document.createElement('option');
          opt.value = cityName;
          opt.textContent = cityName + ' ✨';
          citySelect.appendChild(opt);
        }
        citySelect.value = cityName;
      }
      closeItinerary();
      loadCity(currentCity);
    }
    cityInput.blur();
  }

  // 处理任意 POI 输入：搜索 POI → 逆地理编码 → 定位城市 → 规划
  async function handlePOIInput(input) {
    hideSuggestions();
    cityInput.value = '';
    cityInput.blur();

    const loadingEl = showSearchStatus('正在智能识别 "' + input + '" 所在城市...');

    try {
      const resolved = await resolveUserInput(input);

      if (!resolved) {
        showSearchStatus('⚠️ 无法识别 "' + input + '"，请尝试输入更具体的地名');
        setTimeout(() => {
          const tip = document.querySelector('.search-status');
          if (tip) tip.remove();
        }, 4000);
        return;
      }

      const cityName = resolved.cityName;

      // 显示识别结果
      if (resolved.poiInfo) {
        showSearchStatus('✅ 已定位到 "' + resolved.poiInfo.name + '"，所在城市：' + cityName);
      } else {
        showSearchStatus('✅ 已识别城市：' + cityName);
      }
      setTimeout(() => {
        const tip = document.querySelector('.search-status');
        if (tip) tip.remove();
      }, 3000);

      // 切换到识别出的城市
      if (cityName !== currentCity) {
        currentCity = cityName;
        // 更新下拉菜单
        if (ALL_CITIES.includes(cityName)) {
          citySelect.value = cityName;
        } else {
          let found = false;
          for (const opt of citySelect.options) {
            if (opt.value === cityName) { found = true; break; }
          }
          if (!found) {
            const opt = document.createElement('option');
            opt.value = cityName;
            opt.textContent = cityName + ' ✨';
            citySelect.appendChild(opt);
          }
          citySelect.value = cityName;
        }
        closeItinerary();
        await loadCity(currentCity);
      }
    } catch (e) {
      console.error('POI 输入处理失败:', e);
      showSearchStatus('⚠️ 处理失败: ' + e.message);
      setTimeout(() => {
        const tip = document.querySelector('.search-status');
        if (tip) tip.remove();
      }, 4000);
    } finally {
      if (loadingEl) loadingEl.remove();
    }
  }

  // ========== 预算详情 ==========
  function updateBudgetDetail() {
    const b = BUDGET_CONFIG[budget];
    budgetDetail.innerHTML =
      `住宿 ≈ ¥${b.hotel}/晚 · 餐饮 ≈ ¥${b.food}/天<br>交通 ≈ ¥${b.transport}/天 · 门票 ≈ ¥${b.ticket}/天`;
  }

  // ========== 加载城市（异步版） ==========
  async function loadCity(name) {
    if (!map) return;

    // 城市切换取消机制
    const version = ++cityLoadVersion;

    try {
      const city = await getCityData(name);

      // 检查是否已被更新的请求取代
      if (cityLoadVersion !== version) return;

      map.setCenter(new TMap.LatLng(city.center[1], city.center[0]));
      map.setZoom(12);

      arrivalSelect.innerHTML = '';
      if (city.arrivals && city.arrivals.length > 0) {
        city.arrivals.forEach((a, i) => {
          const opt = document.createElement('option');
          opt.value = i;
          opt.textContent = `${a.name}（${a.type}）`;
          arrivalSelect.appendChild(opt);
        });
      }

      clearAllMarkers();

      // 异步加载 POI 并绘制标记
      fetchCityPOI(name).then(poiData => {
        if (currentCity !== name || cityLoadVersion !== version) return;
        drawMarkers(city, poiData);
      });
    } catch (e) {
      if (cityLoadVersion !== version) return;
      console.error('加载城市失败:', e);
      showSearchStatus('⚠️ ' + e.message);
      setTimeout(() => {
        const tip = document.querySelector('.search-status');
        if (tip) tip.remove();
      }, 5000);
    }
  }

  // ========== 标记管理 ==========
  function clearAllMarkers() {
    [...sightMarkers, ...hotelMarkers, ...arrivalMarkers].forEach(m => m.setMap(null));
    [...sightLabels, ...hotelLabels, ...arrivalLabels].forEach(l => l.setMap(null));
    sightMarkers = []; hotelMarkers = []; arrivalMarkers = [];
    sightLabels = []; hotelLabels = []; arrivalLabels = [];
    clearRouteSegments();
  }

  function clearRouteSegments() {
    if (highlightMarker) { highlightMarker.setMap(null); highlightMarker = null; }
    activeSegmentIdx = -1;
    segmentPolylines.forEach(p => p.setMap(null));
    segmentPolylines = [];
    segmentPoints = [];
  }

  function drawMarkers(cityInfo, poiData) {
    poiData.sights.forEach(s => {
      const { marker, label } = createMarker(s, 'sight');
      sightMarkers.push(marker);
      sightLabels.push(label);
    });

    poiData.hotels.forEach(h => {
      const { marker, label } = createMarker(h, 'hotel');
      hotelMarkers.push(marker);
      hotelLabels.push(label);
    });

    cityInfo.arrivals.forEach(a => {
      const { marker, label } = createMarker(a, 'arrival');
      arrivalMarkers.push(marker);
      arrivalLabels.push(label);
    });

    toggleMarkers('sight', layerSights.checked);
    toggleMarkers('hotel', layerHotels.checked);
  }

  function createMarker(poi, category) {
    const pos = new TMap.LatLng(poi.lat, poi.lng);
    const colorMap = { sight: '#3b82f6', hotel: '#ef4444', arrival: '#10b981' };
    const iconMap = { sight: '🏛️', hotel: '🏨', arrival: '📍' };

    const marker = new TMap.MultiMarker({
      map: map,
      styles: {
        'default': new TMap.MarkerStyle({
          width: 30, height: 40,
          anchor: { x: 15, y: 40 },
          src: createMarkerIcon(colorMap[category], iconMap[category])
        })
      },
      geometries: [{
        id: `${category}_${poi.name}`,
        position: pos,
        properties: { ...poi, category }
      }]
    });

    marker.on('click', (e) => openModal(e.geometry.properties));

    const label = new TMap.MultiLabel({
      map: map,
      styles: {
        'default': new TMap.LabelStyle({
          color: colorMap[category],
          size: 12,
          offset: { x: 0, y: -44 },
          backgroundColor: 'rgba(255,255,255,0.9)',
          borderRadius: 4,
          padding: { top: 2, bottom: 2, left: 6, right: 6 }
        })
      },
      geometries: [{
        id: `label_${category}_${poi.name}`,
        position: pos,
        content: poi.name
      }]
    });

    return { marker, label };
  }

  function createMarkerIcon(color, emoji) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">
      <path d="M15 38C15 38 2 22 2 14a13 13 0 1126 0c0 8-13 24-13 24z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <text x="15" y="18" text-anchor="middle" font-size="14">${emoji}</text>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function createHighlightIcon() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="56" viewBox="0 0 44 56">
      <circle cx="22" cy="20" r="20" fill="rgba(37,99,235,0.15)">
        <animate attributeName="r" values="16;22;16" dur="1.5s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.6;0.2;0.6" dur="1.5s" repeatCount="indefinite"/>
      </circle>
      <path d="M22 52C22 52 6 32 6 20a16 16 0 1132 0c0 12-16 32-16 32z" fill="#2563eb" stroke="#fff" stroke-width="2"/>
      <circle cx="22" cy="20" r="6" fill="#fff"/>
    </svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function toggleMarkers(type, visible) {
    const markers = type === 'sight' ? sightMarkers : hotelMarkers;
    const labels = type === 'sight' ? sightLabels : hotelLabels;
    markers.forEach(m => visible ? m.setMap(map) : m.setMap(null));
    labels.forEach(l => visible ? l.setMap(map) : l.setMap(null));
  }

  // ========== POI 弹窗 ==========
  function openModal(poi) {
    $('#modalName').textContent = poi.name;
    $('#modalTag').textContent = poi.type || poi.category || '-';
    $('#modalRating').textContent = poi.rating ? `${poi.rating} 分` : '-';
    $('#modalPrice').textContent = poi.price !== undefined ? (poi.price === 0 ? '免费' : `¥${poi.price}`) : '-';
    $('#modalAddress').textContent = poi.address || '-';

    const durationRow = $('#modalDurationRow');
    const starsRow = $('#modalStarsRow');

    if (poi.duration) {
      durationRow.style.display = 'flex';
      $('#modalDuration').textContent = poi.duration;
    } else {
      durationRow.style.display = 'none';
    }

    if (poi.stars) {
      starsRow.style.display = 'flex';
      $('#modalStars').textContent = '⭐'.repeat(poi.stars);
    } else {
      starsRow.style.display = 'none';
    }

    // 电话
    const telRow = $('#modalTelRow');
    if (telRow) {
      if (poi.tel) {
        telRow.style.display = 'flex';
        $('#modalTel').textContent = poi.tel;
      } else {
        telRow.style.display = 'none';
      }
    }

    modalOverlay.style.display = 'flex';
  }

  function closeModal() {
    modalOverlay.style.display = 'none';
  }

  // ========== 智能规划（异步版） ==========
  async function startPlanning() {
    if (!map) return;

    planBtn.disabled = true;
    planBtn.style.opacity = '0.7';
    planBtn.style.pointerEvents = 'none';
    loadingOverlay.style.display = 'flex';

    try {
      // 通过三级数据源获取城市数据
      const city = await getCityData(currentCity);
      if (!city) throw new Error('城市数据不存在');

      const poiData = await fetchCityPOI(currentCity);

      if (poiData.sights.length === 0) {
        alert(`未能搜索到 ${currentCity} 的景点数据。\n\n可能原因：\n1. API Key 请求量超限（当前使用公用 Demo Key）\n2. 网络连接问题\n\n建议：在 index.html 中替换为您自己申请的腾讯地图 Key`);
        return;
      }

      clearRouteSegments();

      itineraryData = generateItinerary(city, poiData);
      renderItinerary(itineraryData);
      renderCostSummary(itineraryData);
      drawRouteSegments(itineraryData);

      itineraryPanel.style.display = 'flex';
      itineraryPanel.classList.add('open');
    } catch (e) {
      console.error('规划失败:', e);
      alert('规划失败：' + e.message);
    } finally {
      loadingOverlay.style.display = 'none';
      restorePlanBtn();
    }
  }

  function restorePlanBtn() {
    planBtn.disabled = false;
    planBtn.style.opacity = '';
    planBtn.style.pointerEvents = '';
  }

  function generateItinerary(cityInfo, poiData) {
    const sights = [...poiData.sights];
    const hotels = [...poiData.hotels];
    const budgetCfg = BUDGET_CONFIG[budget];
    const arrival = cityInfo.arrivals[arrivalSelect.value || 0];

    // 根据预算选酒店
    let hotel;
    if (budget === '舒适') {
      hotel = hotels.filter(h => h.price >= 800).sort((a, b) => b.price - a.price)[0] || hotels[0];
    } else if (budget === '标准') {
      hotel = hotels.filter(h => h.price >= 300 && h.price <= 700).sort((a, b) => b.rating - a.rating)[0] || hotels[0];
    } else {
      hotel = hotels.filter(h => h.price <= 300).sort((a, b) => a.price - b.price)[0] || hotels[hotels.length - 1];
    }
    if (!hotel) hotel = hotels[0];

    // ========== 智能路线规划：K-Means 聚类 + 最近邻 + 2-opt 优化 ==========
    // 1. 确定每天可游览的景点数
    const maxSpotsPerDay = (d) => d === 0 ? 3 : 4; // 第一天下午开始，少一些
    let totalSlots = 0;
    for (let d = 0; d < days; d++) totalSlots += maxSpotsPerDay(d);
    const usableSights = sights.slice(0, Math.min(sights.length, totalSlots));

    // 2. K-Means 地理聚类：按实际坐标距离将景点分成 N 天的组
    const dailySights = clusterSightsByDay(usableSights, days, hotel, arrival);

    // 3. 每天内部用最近邻 + 2-opt 优化排序，确保最短路线
    for (let d = 0; d < dailySights.length; d++) {
      const startPoint = d === 0 ? arrival : hotel;
      dailySights[d] = sortByNearestNeighbor(dailySights[d], startPoint);
    }

    // 4. 生成行程
    const schedule = [];
    let totalTicket = 0;

    for (let d = 0; d < days; d++) {
      const dayPlan = { day: d + 1, items: [] };
      const daySights = dailySights[d] || [];

      if (d === 0) {
        dayPlan.items.push({ time: '09:00', name: arrival.name, desc: `抵达${currentCity}，${arrival.type}`, tag: '到达', lat: arrival.lat, lng: arrival.lng });
        dayPlan.items.push({ time: '10:30', name: hotel.name, desc: `办理入住 · ¥${hotel.price}/晚`, tag: '住宿', lat: hotel.lat, lng: hotel.lng });
      }

      const startHour = d === 0 ? 13 : 9;

      daySights.forEach((sight, s) => {
        const hour = startHour + s * 2;
        if (hour >= 20) return;
        totalTicket += (sight.price || 0);
        dayPlan.items.push({
          time: `${String(hour).padStart(2, '0')}:00`,
          name: sight.name,
          desc: `${sight.type} · ${sight.duration || '2小时'} · ${sight.price === 0 ? '免费' : '¥' + sight.price}`,
          tag: sight.type, lat: sight.lat, lng: sight.lng
        });
      });

      dayPlan.items.push({ time: '19:00', name: `${currentCity}特色美食`, desc: `餐饮预算 ≈ ¥${budgetCfg.food}`, tag: '餐饮' });

      if (d < days - 1) {
        dayPlan.items.push({ time: '21:00', name: hotel.name, desc: '返回酒店休息', tag: '住宿', lat: hotel.lat, lng: hotel.lng });
      } else {
        dayPlan.items.push({ time: '21:00', name: arrival.name, desc: `前往${arrival.type}，结束愉快旅程`, tag: '返程', lat: arrival.lat, lng: arrival.lng });
      }

      schedule.push(dayPlan);
    }

    return {
      schedule, hotel,
      cost: {
        hotel: hotel.price * Math.max(days - 1, 1),
        food: budgetCfg.food * days,
        transport: budgetCfg.transport * days,
        ticket: totalTicket
      }
    };
  }

  // ========== 地理距离计算（Haversine 公式） ==========
  function geoDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // 地球半径 km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ========== K-Means 地理聚类：将景点按实际坐标距离分成 K 组 ==========
  // 参考 Google Maps marker clustering 和 Mapbox supercluster 的思路
  // 使用标准 K-Means++ 初始化 + Lloyd 迭代
  function kMeansCluster(points, k, maxIter) {
    if (maxIter === undefined) maxIter = 50;
    if (points.length <= k) {
      // 景点数不超过天数，每天最多一个景点
      return points.map(p => [p]);
    }

    // K-Means++ 初始化：选择彼此尽量远的初始质心
    const centroids = [];
    // 第一个质心随机选
    centroids.push({ lat: points[0].lat, lng: points[0].lng });

    for (let c = 1; c < k; c++) {
      // 计算每个点到最近质心的距离
      const dists = points.map(p => {
        let minD = Infinity;
        centroids.forEach(cen => {
          const d = geoDistance(p.lat, p.lng, cen.lat, cen.lng);
          if (d < minD) minD = d;
        });
        return minD * minD; // 距离平方作为权重
      });
      const totalDist = dists.reduce((s, d) => s + d, 0);
      // 按距离加权随机选择下一个质心
      let r = Math.random() * totalDist;
      let chosen = 0;
      for (let i = 0; i < dists.length; i++) {
        r -= dists[i];
        if (r <= 0) { chosen = i; break; }
      }
      centroids.push({ lat: points[chosen].lat, lng: points[chosen].lng });
    }

    // Lloyd 迭代
    let assignments = new Array(points.length).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;

      // E 步：将每个点分配到最近的质心
      for (let i = 0; i < points.length; i++) {
        let bestC = 0;
        let bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const d = geoDistance(points[i].lat, points[i].lng, centroids[c].lat, centroids[c].lng);
          if (d < bestD) { bestD = d; bestC = c; }
        }
        if (assignments[i] !== bestC) {
          assignments[i] = bestC;
          changed = true;
        }
      }

      if (!changed) break; // 已收敛

      // M 步：更新质心为簇内均值
      for (let c = 0; c < k; c++) {
        let sumLat = 0, sumLng = 0, count = 0;
        for (let i = 0; i < points.length; i++) {
          if (assignments[i] === c) {
            sumLat += points[i].lat;
            sumLng += points[i].lng;
            count++;
          }
        }
        if (count > 0) {
          centroids[c].lat = sumLat / count;
          centroids[c].lng = sumLng / count;
        }
      }
    }

    // 按分配结果分组
    const clusters = Array.from({ length: k }, () => []);
    for (let i = 0; i < points.length; i++) {
      clusters[assignments[i]].push(points[i]);
    }

    return clusters;
  }

  // ========== 最近邻算法 + 2-opt 局部优化 ==========
  // 先用最近邻生成初始路线，再用 2-opt 消除交叉
  function sortByNearestNeighbor(sights, startPoint) {
    if (sights.length <= 1) return sights;

    // 第一步：最近邻贪心构造初始路线
    const sorted = [];
    const remaining = [...sights];
    let curLat = startPoint.lat;
    let curLng = startPoint.lng;

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const d = geoDistance(curLat, curLng, remaining[i].lat, remaining[i].lng);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }

      const nearest = remaining.splice(nearestIdx, 1)[0];
      sorted.push(nearest);
      curLat = nearest.lat;
      curLng = nearest.lng;
    }

    // 第二步：2-opt 局部优化，消除路线交叉
    return twoOptImprove(sorted, startPoint);
  }

  // 2-opt 局部搜索：反复尝试翻转子路径，直到无法改进
  // 这是 TSP（旅行商问题）最经典的局部优化算法
  function twoOptImprove(route, startPoint) {
    if (route.length <= 2) return route;

    // 构建包含起点的完整路径用于距离计算
    const getPathDist = (r) => {
      let total = geoDistance(startPoint.lat, startPoint.lng, r[0].lat, r[0].lng);
      for (let i = 0; i < r.length - 1; i++) {
        total += geoDistance(r[i].lat, r[i].lng, r[i + 1].lat, r[i + 1].lng);
      }
      return total;
    };

    let improved = true;
    let bestDist = getPathDist(route);
    let maxRounds = 100; // 防止极端情况死循环

    while (improved && maxRounds-- > 0) {
      improved = false;
      for (let i = 0; i < route.length - 1; i++) {
        for (let j = i + 1; j < route.length; j++) {
          // 尝试翻转 route[i..j] 这段子路径
          const newRoute = [
            ...route.slice(0, i),
            ...route.slice(i, j + 1).reverse(),
            ...route.slice(j + 1)
          ];
          const newDist = getPathDist(newRoute);
          if (newDist < bestDist - 0.001) { // 0.001km 容差避免浮点抖动
            route = newRoute;
            bestDist = newDist;
            improved = true;
          }
        }
      }
    }

    return route;
  }

  // ========== 地理聚类：将景点按实际地理位置分配到每天 ==========
  // 使用 K-Means 聚类 + 簇间排序 + 容量均衡
  function clusterSightsByDay(sights, numDays, hotel, arrival) {
    if (sights.length === 0) return Array.from({ length: numDays }, () => []);
    if (numDays === 1) return [sights];

    // 每天的最大景点数
    const maxPerDay = (d) => d === 0 ? 3 : 4;

    // 第一步：K-Means 聚类
    let clusters = kMeansCluster(sights, numDays);

    // 移除空簇并重新聚类（K-Means 可能产生空簇）
    clusters = clusters.filter(c => c.length > 0);
    while (clusters.length < numDays && clusters.some(c => c.length > 1)) {
      // 找到最大的簇，拆分它
      let maxIdx = 0;
      for (let i = 1; i < clusters.length; i++) {
        if (clusters[i].length > clusters[maxIdx].length) maxIdx = i;
      }
      const big = clusters.splice(maxIdx, 1)[0];
      const sub = kMeansCluster(big, 2);
      clusters.push(...sub.filter(c => c.length > 0));
    }

    // 第二步：按簇质心到酒店/到达点的距离排序
    // 第一天从到达点出发，所以离到达点最近的簇排第一天
    const clusterCentroids = clusters.map(c => {
      const avgLat = c.reduce((s, p) => s + p.lat, 0) / c.length;
      const avgLng = c.reduce((s, p) => s + p.lng, 0) / c.length;
      return { lat: avgLat, lng: avgLng };
    });

    // 用最近邻法对簇排序：第一天从到达点出发
    const clusterOrder = [];
    const remainingClusters = clusters.map((c, i) => i);
    let curPoint = { lat: arrival.lat, lng: arrival.lng };

    while (remainingClusters.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remainingClusters.length; i++) {
        const ci = remainingClusters[i];
        const d = geoDistance(curPoint.lat, curPoint.lng, clusterCentroids[ci].lat, clusterCentroids[ci].lng);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const chosen = remainingClusters.splice(bestIdx, 1)[0];
      clusterOrder.push(chosen);
      curPoint = clusterCentroids[chosen];
    }

    // 第三步：将排序后的簇分配到每天，并做容量均衡
    const dailySights = Array.from({ length: numDays }, () => []);

    // 如果簇数等于天数，直接一一对应
    if (clusterOrder.length === numDays) {
      clusterOrder.forEach((ci, d) => {
        dailySights[d] = clusters[ci];
      });
    } else if (clusterOrder.length < numDays) {
      // 簇数少于天数，先分配，剩余天留空
      clusterOrder.forEach((ci, d) => {
        dailySights[d] = clusters[ci];
      });
    } else {
      // 簇数多于天数（不太可能但防御性处理），合并相邻簇
      const perDay = Math.ceil(clusterOrder.length / numDays);
      for (let d = 0; d < numDays; d++) {
        const start = d * perDay;
        const end = Math.min(start + perDay, clusterOrder.length);
        for (let i = start; i < end; i++) {
          dailySights[d].push(...clusters[clusterOrder[i]]);
        }
      }
    }

    // 第四步：容量均衡 — 如果某天景点过多，将最远的景点移到最近的有空位的天
    let balanced = false;
    let balanceRounds = 20;
    while (!balanced && balanceRounds-- > 0) {
      balanced = true;
      for (let d = 0; d < numDays; d++) {
        const max = maxPerDay(d);
        while (dailySights[d].length > max) {
          balanced = false;
          // 找到该天中离质心最远的景点
          const centroid = {
            lat: dailySights[d].reduce((s, p) => s + p.lat, 0) / dailySights[d].length,
            lng: dailySights[d].reduce((s, p) => s + p.lng, 0) / dailySights[d].length
          };
          let farthestIdx = 0;
          let farthestDist = 0;
          dailySights[d].forEach((s, i) => {
            const dist = geoDistance(s.lat, s.lng, centroid.lat, centroid.lng);
            if (dist > farthestDist) { farthestDist = dist; farthestIdx = i; }
          });
          const overflow = dailySights[d].splice(farthestIdx, 1)[0];

          // 找到有空位且质心最近的天
          let bestDay = -1;
          let bestDayDist = Infinity;
          for (let dd = 0; dd < numDays; dd++) {
            if (dd === d) continue;
            if (dailySights[dd].length < maxPerDay(dd)) {
              const ddCentroid = dailySights[dd].length > 0 ? {
                lat: dailySights[dd].reduce((s, p) => s + p.lat, 0) / dailySights[dd].length,
                lng: dailySights[dd].reduce((s, p) => s + p.lng, 0) / dailySights[dd].length
              } : { lat: hotel.lat, lng: hotel.lng };
              const dist = geoDistance(overflow.lat, overflow.lng, ddCentroid.lat, ddCentroid.lng);
              if (dist < bestDayDist) { bestDayDist = dist; bestDay = dd; }
            }
          }
          if (bestDay >= 0) {
            dailySights[bestDay].push(overflow);
          } else {
            // 所有天都满了，放回最少的那天
            const minDay = dailySights.reduce((mi, arr, idx) =>
              arr.length < dailySights[mi].length ? idx : mi, 0);
            dailySights[minDay].push(overflow);
            break;
          }
        }
      }
    }

    return dailySights;
  }

  // ========== 渲染行程 ==========
  function renderItinerary(data) {
    let globalIdx = 0;
    let html = '';

    data.schedule.forEach(day => {
      html += `<div class="day-card">
        <div class="day-header">
          <span class="day-badge">第 ${day.day} 天</span>
        </div>
        <div class="timeline">`;

      day.items.forEach(item => {
        const hasCoord = item.lat && item.lng;
        const dataAttr = hasCoord ? `data-seg-idx="${globalIdx}" data-lat="${item.lat}" data-lng="${item.lng}"` : '';
        const tabIndex = hasCoord ? 'tabindex="0"' : '';
        if (hasCoord) globalIdx++;

        html += `<div class="timeline-item ${hasCoord ? 'clickable' : ''}" ${dataAttr} ${tabIndex} ${hasCoord ? 'role="button"' : ''}>
          <div class="timeline-dot"></div>
          <div class="timeline-time">${item.time}</div>
          <div class="timeline-name">${item.name}</div>
          <div class="timeline-desc">${item.desc}</div>
          <span class="timeline-tag">${item.tag}</span>
        </div>`;
      });

      html += `</div></div>`;
    });

    panelBody.innerHTML = html;

    panelBody.querySelectorAll('.timeline-item.clickable').forEach(el => {
      const handler = () => {
        const idx = parseInt(el.dataset.segIdx);
        const lat = parseFloat(el.dataset.lat);
        const lng = parseFloat(el.dataset.lng);
        highlightSegment(idx, lat, lng, el);
      };
      el.addEventListener('click', handler);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
      });
    });
  }

  // ========== 路线分段绘制 ==========
  function drawRouteSegments(data) {
    clearRouteSegments();

    const allPoints = [];
    data.schedule.forEach(day => {
      day.items.forEach(item => {
        if (item.lat && item.lng) {
          allPoints.push(new TMap.LatLng(item.lat, item.lng));
        }
      });
    });

    if (allPoints.length < 2) return;

    for (let i = 0; i < allPoints.length - 1; i++) {
      const from = allPoints[i];
      const to = allPoints[i + 1];
      segmentPoints.push([from, to]);

      const polyline = new TMap.MultiPolyline({
        map: map,
        styles: {
          'default': new TMap.PolylineStyle({
            color: 'rgba(148,163,184,0.5)',
            width: 3,
            lineCap: 'round',
            dashArray: [8, 5]
          })
        },
        geometries: [{ id: `seg_${i}`, paths: [from, to] }]
      });

      segmentPolylines.push(polyline);
    }

    const lats = allPoints.map(p => p.getLat());
    const lngs = allPoints.map(p => p.getLng());
    const sw = new TMap.LatLng(Math.min(...lats) - 0.01, Math.min(...lngs) - 0.01);
    const ne = new TMap.LatLng(Math.max(...lats) + 0.01, Math.max(...lngs) + 0.01);
    map.fitBounds(new TMap.LatLngBounds(sw, ne), { padding: { top: 60, bottom: 60, left: 60, right: 420 } });
  }

  // ========== 高亮 ==========
  function highlightSegment(pointIdx, lat, lng, clickedEl) {
    panelBody.querySelectorAll('.timeline-item').forEach(el => el.classList.remove('active'));
    clickedEl.classList.add('active');
    clickedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    segmentPolylines.forEach(p => {
      p.setStyles({
        'default': new TMap.PolylineStyle({ color: 'rgba(148,163,184,0.25)', width: 2, lineCap: 'round', dashArray: [8, 5] })
      });
    });

    const hlStyle = new TMap.PolylineStyle({ color: '#2563eb', width: 5, lineCap: 'round', dashArray: [0, 0], showArrow: true, arrowOptions: { space: 60 } });
    const inIdx = pointIdx - 1;
    const outIdx = pointIdx;
    if (inIdx >= 0 && inIdx < segmentPolylines.length) segmentPolylines[inIdx].setStyles({ 'default': hlStyle });
    if (outIdx >= 0 && outIdx < segmentPolylines.length) segmentPolylines[outIdx].setStyles({ 'default': hlStyle });

    if (highlightMarker) { highlightMarker.setMap(null); highlightMarker = null; }
    const pos = new TMap.LatLng(lat, lng);
    highlightMarker = new TMap.MultiMarker({
      map: map,
      styles: { 'default': new TMap.MarkerStyle({ width: 44, height: 56, anchor: { x: 22, y: 56 }, src: createHighlightIcon() }) },
      geometries: [{ id: 'highlight_poi', position: pos }]
    });

    map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 13) });
    activeSegmentIdx = pointIdx;
  }

  function resetHighlight() {
    if (highlightMarker) { highlightMarker.setMap(null); highlightMarker = null; }
    activeSegmentIdx = -1;
    segmentPolylines.forEach(p => {
      p.setStyles({
        'default': new TMap.PolylineStyle({ color: 'rgba(148,163,184,0.5)', width: 3, lineCap: 'round', dashArray: [8, 5] })
      });
    });
    panelBody.querySelectorAll('.timeline-item').forEach(el => el.classList.remove('active'));
  }

  function renderCostSummary(data) {
    const c = data.cost;
    $('#costHotel').textContent = `¥${c.hotel.toLocaleString()}`;
    $('#costFood').textContent = `¥${c.food.toLocaleString()}`;
    $('#costTransport').textContent = `¥${c.transport.toLocaleString()}`;
    $('#costTicket').textContent = `¥${c.ticket.toLocaleString()}`;
    const total = c.hotel + c.food + c.transport + c.ticket;
    $('#costTotal').textContent = `¥${total.toLocaleString()}`;
    costSummary.style.display = 'block';
  }

  function hideCostSummary() {
    costSummary.style.display = 'none';
    ['costHotel', 'costFood', 'costTransport', 'costTicket', 'costTotal'].forEach(id => {
      $(`#${id}`).textContent = '-';
    });
  }

  function closeItinerary() {
    itineraryPanel.classList.remove('open');
    itineraryPanel.style.display = 'none';
    resetHighlight();
    clearRouteSegments();
    hideCostSummary();
    itineraryData = null;
  }

  document.addEventListener('DOMContentLoaded', init);

})();
