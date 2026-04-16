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
    initOfflineDetection();
    // 延迟加载 POI，等地图 SDK 完全就绪
    setTimeout(() => {
      // 优先从 URL 恢复行程
      if (!restoreFromUrl()) {
        loadCity(currentCity);
        // 检查是否有已保存的行程
        setTimeout(() => promptRestoreItinerary(), 2000);
      }
    }, 1000);
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
    // 检测腾讯地图 SDK 是否加载成功
    if (typeof TMap === 'undefined') {
      console.error('腾讯地图 SDK 未加载');
      mapContainer.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:16px;gap:12px;padding:20px;text-align:center;">
        <span style="font-size:48px;">🗺️</span>
        <p style="font-weight:700;font-size:18px;color:#0f172a;">地图加载失败</p>
        <p>腾讯地图 SDK 未能加载，可能是网络问题。</p>
        <button onclick="location.reload()" style="padding:10px 24px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">刷新重试</button>
      </div>`;
      return;
    }

    const cityData = CITY_DATA[currentCity];
    try {
      map = new TMap.Map('mapContainer', {
        center: new TMap.LatLng(cityData.center[1], cityData.center[0]),
        zoom: 12,
        viewMode: '2D'
      });
    } catch (e) {
      console.error('地图初始化失败:', e);
      mapContainer.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:16px;gap:12px;padding:20px;text-align:center;">
        <span style="font-size:48px;">⚠️</span>
        <p style="font-weight:700;font-size:18px;color:#0f172a;">地图初始化失败</p>
        <p>${e.message || '请刷新页面重试'}</p>
        <button onclick="location.reload()" style="padding:10px 24px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">刷新重试</button>
      </div>`;
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
          type: category,
          // 保留 API 原始扩展字段，用于提取真实数据
          _raw_id: poi.id || '',
          _raw_category: poi.category || '',
          _raw_type: poi.type || 0
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

      // 新增：搜索餐厅 POI
      await delay(1200);
      const restaurantsRaw = await enqueueRequest(() => searchPOI(cityName, '美食餐厅', '餐厅'));

      // 去重 + 转换景点数据（基于真实 API 数据推断，不使用随机值）
      const seenNames = new Set();
      const sights = sightsRaw.filter(s => {
        if (seenNames.has(s.name)) return false;
        seenNames.add(s.name);
        return true;
      }).slice(0, 15).map(s => {
        const sightType = inferSightType(s._raw_category, s.name);
        const durationInfo = estimateVisitDuration(sightType, s.name);
        const priceInfo = estimateSightPrice(sightType, s.name);
        return {
          ...s,
          rating: null, // 暂无评分 — 腾讯地图 POI 搜索不返回评分
          ratingSource: 'none',
          price: priceInfo.price,
          priceSource: priceInfo.source, // 'estimated'
          duration: durationInfo.text,
          durationMinutes: durationInfo.minutes, // 用于行程时间计算
          type: sightType
        };
      });

      // 转换酒店数据：根据名称关键词推断价格等级，标注为估算价格
      const hotelNames = new Set();
      const hotels = hotelsRaw.filter(h => {
        if (hotelNames.has(h.name)) return false;
        hotelNames.add(h.name);
        return true;
      }).slice(0, 10).map((h, i) => {
        const tier = getHotelTier(h.name, i, h._raw_category);
        return {
          ...h,
          rating: null, // 暂无评分 — 腾讯地图 POI 搜索不返回评分
          ratingSource: 'none',
          price: tier.price,
          priceSource: 'estimated', // 所有酒店价格均为估算
          type: tier.type,
          stars: tier.stars
        };
      });

      // 转换餐厅数据：去重 + 推断人均消费
      const restNames = new Set();
      const restaurants = restaurantsRaw.filter(r => {
        if (restNames.has(r.name)) return false;
        restNames.add(r.name);
        return true;
      }).slice(0, 15).map(r => {
        const avgPrice = estimateRestaurantPrice(r.name, r._raw_category);
        return {
          ...r,
          rating: null,
          ratingSource: 'none',
          price: avgPrice,
          priceSource: 'estimated',
          type: '餐厅'
        };
      });

      const data = { sights, hotels, restaurants };

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

  // ========== 景点数据智能推断（消除随机数据） ==========

  // 根据 API 返回的 category 和名称推断景点类型
  function inferSightType(rawCategory, name) {
    const cat = (rawCategory || '').toLowerCase();
    const n = name || '';

    // 按关键词匹配景点类型
    const typeRules = [
      { type: '博物馆', keywords: ['博物', '纪念馆', '展览', '美术馆', '科技馆', '天文馆', '艺术馆'] },
      { type: '寺庙', keywords: ['寺', '庙', '观', '庵', '祠', '教堂', '清真'] },
      { type: '公园', keywords: ['公园', '花园', '植物园', '动物园', '湿地', '森林', '绿地'] },
      { type: '古镇', keywords: ['古镇', '古城', '古村', '老街', '古街', '水乡'] },
      { type: '山岳', keywords: ['山', '峰', '岭', '崖', '峡谷', '峡', '岩'] },
      { type: '湖泊', keywords: ['湖', '海', '江', '河', '溪', '泉', '瀑布', '水库'] },
      { type: '主题乐园', keywords: ['乐园', '游乐', '欢乐谷', '迪士尼', '环球', '方特', '海洋世界'] },
      { type: '历史遗迹', keywords: ['遗址', '故居', '陵', '墓', '城墙', '长城', '故宫', '皇宫', '王府'] },
      { type: '商业街区', keywords: ['步行街', '商业街', '夜市', '美食街', '购物'] },
      { type: '自然风景', keywords: ['风景', '景区', '名胜', '地质', '草原', '沙漠', '冰川'] }
    ];

    // 先匹配 category 字段
    for (const rule of typeRules) {
      if (rule.keywords.some(k => cat.includes(k))) return rule.type;
    }
    // 再匹配名称
    for (const rule of typeRules) {
      if (rule.keywords.some(k => n.includes(k))) return rule.type;
    }

    return '景点'; // 默认类型
  }

  // 根据景点类型估算合理的游览时长（分钟）
  function estimateVisitDuration(sightType, name) {
    const durationMap = {
      '博物馆': { min: 120, max: 180, text: '2-3小时' },
      '寺庙': { min: 60, max: 120, text: '1-2小时' },
      '公园': { min: 90, max: 150, text: '1.5-2.5小时' },
      '古镇': { min: 180, max: 240, text: '3-4小时' },
      '山岳': { min: 180, max: 300, text: '3-5小时' },
      '湖泊': { min: 90, max: 150, text: '1.5-2.5小时' },
      '主题乐园': { min: 240, max: 360, text: '4-6小时' },
      '历史遗迹': { min: 120, max: 180, text: '2-3小时' },
      '商业街区': { min: 90, max: 150, text: '1.5-2.5小时' },
      '自然风景': { min: 120, max: 240, text: '2-4小时' },
      '景点': { min: 90, max: 150, text: '1.5-2.5小时' }
    };

    const info = durationMap[sightType] || durationMap['景点'];
    // 使用中位数作为计算用时长
    const minutes = Math.round((info.min + info.max) / 2);
    return { text: info.text, minutes };
  }

  // 根据景点类型估算门票价格区间
  function estimateSightPrice(sightType, name) {
    const priceMap = {
      '博物馆': { price: 0, note: '多数免费' },
      '寺庙': { price: 30, note: '' },
      '公园': { price: 0, note: '多数免费' },
      '古镇': { price: 80, note: '' },
      '山岳': { price: 120, note: '' },
      '湖泊': { price: 50, note: '' },
      '主题乐园': { price: 280, note: '' },
      '历史遗迹': { price: 60, note: '' },
      '商业街区': { price: 0, note: '免费' },
      '自然风景': { price: 80, note: '' },
      '景点': { price: 40, note: '' }
    };

    // 特殊景点名称匹配（知名免费景点）
    const freeKeywords = ['广场', '步行街', '外滩', '天安门', '鼓楼', '钟楼'];
    if (freeKeywords.some(k => name.includes(k))) {
      return { price: 0, source: 'estimated' };
    }

    const info = priceMap[sightType] || priceMap['景点'];
    return { price: info.price, source: 'estimated' };
  }

  // 根据餐厅名称和类别估算人均消费
  function estimateRestaurantPrice(name, rawCategory) {
    const cat = (rawCategory || '').toLowerCase();
    const n = name || '';

    // 高档餐厅关键词
    const highEnd = ['米其林', '私房', '会所', '料理', '法餐', '意大利', '铁板烧', '怀石', '鲍鱼', '海鲜大餐'];
    if (highEnd.some(k => n.includes(k) || cat.includes(k))) return 300;

    // 中档餐厅关键词
    const midRange = ['火锅', '烤肉', '日料', '西餐', '牛排', '海鲜', '粤菜', '川菜', '湘菜', '东北菜', '本帮菜'];
    if (midRange.some(k => n.includes(k) || cat.includes(k))) return 100;

    // 快餐/小吃关键词
    const budget = ['面馆', '粉', '小吃', '快餐', '麦当劳', '肯德基', '饺子', '包子', '煎饼', '拉面', '米线', '沙县'];
    if (budget.some(k => n.includes(k) || cat.includes(k))) return 30;

    // 默认中等消费
    return 70;
  }

  // 从餐厅列表中找到距离参考点最近且未使用过的餐厅
  function findNearestRestaurant(restaurants, refPoint, usedSet) {
    if (!restaurants || restaurants.length === 0 || !refPoint) return null;
    let best = null;
    let bestDist = Infinity;
    for (const r of restaurants) {
      if (usedSet && usedSet.has(r.name)) continue;
      const dist = geoDistance(refPoint.lat, refPoint.lng, r.lat, r.lng);
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    }
    return best;
  }

  // 根据酒店名称关键词、排序位和 API 类别推断等级（价格为固定估算值，不使用随机数）
  function getHotelTier(name, index, rawCategory) {
    const luxuryKeywords = ['丽思', '万豪', '希尔顿', '洲际', '香格里拉', '华尔道夫', '柏悦', '安缦', '四季', '半岛', '文华东方', '瑰丽', '费尔蒙', '宝格丽', '丽晶', '君悦', 'W酒店', '维景', '威斯汀', '奥菱'];
    const comfortKeywords = ['喜来登', '威斯汀', '凯悦', '皇冠假日', '索菲特', '铂尔曼', '诺富特', '雅高', '假日', '嘉里大', '华美达', '维也纳', '开元', '满堂红', '建国饭店', '嘉实多'];
    const budgetKeywords = ['如家', '7天', '汉庭', '速8', '格林豪泰', '锦江之星', '莫泰', '尚客优', '维也纳好睡', '全季', '首旅', '尚客优品', '尚客优选', '久久鸿基'];

    if (luxuryKeywords.some(k => name.includes(k))) {
      return { type: '豪华', price: 1500, stars: 5 };
    }
    if (comfortKeywords.some(k => name.includes(k))) {
      return { type: '舒适', price: 600, stars: 4 };
    }
    if (budgetKeywords.some(k => name.includes(k))) {
      return { type: '经济', price: 200, stars: 2 };
    }

    // 根据 API 返回的 category 字段推断
    const cat = (rawCategory || '').toLowerCase();
    if (cat.includes('五星') || cat.includes('豪华') || cat.includes('高档')) {
      return { type: '豪华', price: 1200, stars: 5 };
    }
    if (cat.includes('四星') || cat.includes('舒适')) {
      return { type: '舒适', price: 500, stars: 4 };
    }
    if (cat.includes('经济') || cat.includes('快捷') || cat.includes('青年旅舍')) {
      return { type: '经济', price: 180, stars: 2 };
    }

    // 根据搜索结果排名推断（固定价格，不用随机数）
    if (index < 3) return { type: '豪华', price: 1000, stars: 5 };
    if (index < 6) return { type: '标准', price: 400, stars: 3 };
    return { type: '经济', price: 200, stars: 2 };
  }

  // ========== Toast 通知系统 ==========
  const toastIcons = { success: '✅', warning: '⚠️', error: '❌', info: 'ℹ️' };

  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${toastIcons[type] || toastIcons.info}</span>` +
      `<span class="toast-msg">${message}</span>` +
      `<button class="toast-close" aria-label="关闭">&times;</button>`;

    container.appendChild(toast);

    // 关闭按钮
    toast.querySelector('.toast-close').addEventListener('click', () => removeToast(toast));

    // 自动消失
    const timer = setTimeout(() => removeToast(toast), duration);
    toast._timer = timer;

    // 最多同时显示 5 条
    while (container.children.length > 5) {
      removeToast(container.children[0]);
    }

    return toast;
  }

  function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    if (toast._timer) clearTimeout(toast._timer);
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    });
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
        // 切换预算档位时，在地图上只显示对应价位的酒店
        filterHotelMarkersByBudget();
      });
    });

    layerSights.addEventListener('change', () => toggleMarkers('sight', layerSights.checked));
    layerHotels.addEventListener('change', () => toggleMarkers('hotel', layerHotels.checked));

    planBtn.addEventListener('click', startPlanning);
    panelClose.addEventListener('click', closeItinerary);

    // 行程保存/分享/导出按钮
    const saveBtn = $('#saveItineraryBtn');
    const shareBtn = $('#shareItineraryBtn');
    const exportBtn = $('#exportPdfBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveItinerary);
    if (shareBtn) shareBtn.addEventListener('click', shareItinerary);
    if (exportBtn) exportBtn.addEventListener('click', exportPdf);

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

    // ========== 移动端底部抽屉手势 ==========
    initMobileDrawer();
  }

  // ========== 离线检测与缓存降级 ==========
  let isOffline = false;
  let offlineBanner = null;

  function initOfflineDetection() {
    // 初始状态检测
    if (!navigator.onLine) {
      handleOffline();
    }

    // 监听在线/离线事件
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }

  function handleOffline() {
    if (isOffline) return;
    isOffline = true;
    showToast('⚠️ 网络已断开，将使用缓存数据提供服务', 'warning', 6000);
    showOfflineBanner();
  }

  function handleOnline() {
    if (!isOffline) return;
    isOffline = false;
    showToast('✅ 网络已恢复', 'success', 3000);
    hideOfflineBanner();
  }

  function showOfflineBanner() {
    if (offlineBanner) return;
    offlineBanner = document.createElement('div');
    offlineBanner.className = 'offline-banner';
    offlineBanner.innerHTML = '📡 离线模式 — 部分功能受限，使用缓存数据';
    document.body.appendChild(offlineBanner);
  }

  function hideOfflineBanner() {
    if (offlineBanner) {
      offlineBanner.remove();
      offlineBanner = null;
    }
  }

  // ========== 移动端底部抽屉 ==========
  function initMobileDrawer() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const isMobile = () => window.innerWidth <= 768;
    let touchStartY = 0;
    let touchCurrentY = 0;
    let drawerOpen = false;

    // 点击头部切换抽屉
    const header = sidebar.querySelector('.sidebar-header');
    if (header) {
      header.addEventListener('click', () => {
        if (!isMobile()) return;
        drawerOpen = !drawerOpen;
        sidebar.classList.toggle('drawer-open', drawerOpen);
      });
    }

    // 触摸手势：上滑展开，下滑收起
    sidebar.addEventListener('touchstart', (e) => {
      if (!isMobile()) return;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    sidebar.addEventListener('touchmove', (e) => {
      if (!isMobile()) return;
      touchCurrentY = e.touches[0].clientY;
    }, { passive: true });

    sidebar.addEventListener('touchend', () => {
      if (!isMobile()) return;
      const deltaY = touchStartY - touchCurrentY;
      if (Math.abs(deltaY) > 40) {
        if (deltaY > 0) {
          // 上滑 → 展开
          drawerOpen = true;
          sidebar.classList.add('drawer-open');
        } else {
          // 下滑 → 收起
          drawerOpen = false;
          sidebar.classList.remove('drawer-open');
        }
      }
      touchStartY = 0;
      touchCurrentY = 0;
    }, { passive: true });

    // 点击地图区域时收起抽屉
    mapContainer.addEventListener('touchstart', () => {
      if (!isMobile() || !drawerOpen) return;
      drawerOpen = false;
      sidebar.classList.remove('drawer-open');
    }, { passive: true });
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

  // 酒店档位颜色映射：不同价位用不同颜色区分
  const hotelColorMap = {
    '豪华': '#a855f7', // 紫色
    '舒适': '#f59e0b', // 琥珀色
    '标准': '#ef4444', // 红色
    '经济': '#22c55e'  // 绿色
  };

  function createMarker(poi, category) {
    const pos = new TMap.LatLng(poi.lat, poi.lng);
    const defaultColorMap = { sight: '#3b82f6', hotel: '#ef4444', arrival: '#10b981' };
    const iconMap = { sight: '🏛️', hotel: '🏨', arrival: '📍' };

    // 酒店根据档位用不同颜色
    const markerColor = category === 'hotel' && poi.type && hotelColorMap[poi.type]
      ? hotelColorMap[poi.type]
      : defaultColorMap[category];

    const marker = new TMap.MultiMarker({
      map: map,
      styles: {
        'default': new TMap.MarkerStyle({
          width: 30, height: 40,
          anchor: { x: 15, y: 40 },
          src: createMarkerIcon(markerColor, iconMap[category])
        })
      },
      geometries: [{
        id: `${category}_${poi.name}`,
        position: pos,
        properties: { ...poi, category }
      }]
    });

    marker.on('click', (e) => openModal(e.geometry.properties));

    // 酒店标签显示名称 + 价格
    const labelContent = category === 'hotel' && poi.price
      ? `${poi.name} ¥${poi.price}`
      : poi.name;

    const label = new TMap.MultiLabel({
      map: map,
      styles: {
        'default': new TMap.LabelStyle({
          color: markerColor,
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
        content: labelContent
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
    if (type === 'hotel') {
      // 酒店标记受预算档位过滤控制
      if (visible) {
        filterHotelMarkersByBudget();
      } else {
        hotelMarkers.forEach(m => m.setMap(null));
        hotelLabels.forEach(l => l.setMap(null));
      }
      return;
    }
    const markers = sightMarkers;
    const labels = sightLabels;
    markers.forEach(m => visible ? m.setMap(map) : m.setMap(null));
    labels.forEach(l => visible ? l.setMap(map) : l.setMap(null));
  }

  // 根据当前预算档位过滤显示酒店标记
  // 舒适档 → 显示豪华/舒适酒店，标准档 → 显示标准/舒适酒店，经济档 → 显示经济酒店
  function filterHotelMarkersByBudget() {
    if (!layerHotels.checked) return; // 酒店图层关闭时不处理

    const budgetToTypes = {
      '舒适': ['豪华', '舒适'],
      '标准': ['标准', '舒适'],
      '经济': ['经济']
    };
    const allowedTypes = budgetToTypes[budget] || ['标准', '舒适'];

    hotelMarkers.forEach((m, i) => {
      // 从 marker 的 geometry properties 中获取酒店类型
      const geom = m.getGeometries()[0];
      const hotelType = geom && geom.properties ? geom.properties.type : '';
      const match = allowedTypes.includes(hotelType);
      m.setMap(match ? map : null);
      if (hotelLabels[i]) {
        hotelLabels[i].setMap(match ? map : null);
      }
    });
  }

  // ========== POI 弹窗 ==========
  function openModal(poi) {
    $('#modalName').textContent = poi.name;
    $('#modalTag').textContent = poi.type || poi.category || '-';
    // 评分：区分真实数据和无数据
    if (poi.rating !== null && poi.rating !== undefined) {
      $('#modalRating').textContent = `${poi.rating} 分`;
    } else {
      $('#modalRating').textContent = '暂无评分';
    }
    // 价格：标注数据来源
    if (poi.price !== undefined && poi.price !== null) {
      const priceText = poi.price === 0 ? '免费' : `¥${poi.price}`;
      const sourceTag = poi.priceSource === 'estimated' ? ' (估算)' : '';
      $('#modalPrice').textContent = priceText + sourceTag;
    } else {
      $('#modalPrice').textContent = '-';
    }
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
        showToast(`未能搜索到 ${currentCity} 的景点数据。可能是 API 请求量超限或网络问题，请稍后重试`, 'warning', 6000);
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
      showToast('规划失败：' + e.message + '。请检查网络连接后重试', 'error', 5000);
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

    // 用于聚类阶段的临时酒店（取候选列表第一个，仅作为聚类参考点）
    const hotelCandidates = filterHotelsByBudget(hotels, budget);
    const tempHotel = hotelCandidates[0] || hotels[0] || { lat: arrival.lat, lng: arrival.lng, price: 0, name: '默认住宿' };

    // ========== 智能路线规划：Supercluster 聚类 + 最近邻 + 2-opt 优化 ==========
    // 1. 确定每天可用时间（分钟）
    const DAY_START_FIRST = 13 * 60;  // 第一天下午 13:00 开始
    const DAY_START_NORMAL = 9 * 60;  // 其他天 09:00 开始
    const DAY_END = 20 * 60;          // 每天 20:00 结束游览
    const DAY_END_LAST = 18 * 60;     // 最后一天 18:00 结束（预留返程时间）
    const MAX_DAY_MINUTES = 12 * 60;  // 每天最多游览 12 小时

    // 初步估算每天可容纳的景点数
    const maxSpotsPerDay = (d) => d === 0 ? 3 : 4;
    let totalSlots = 0;
    for (let d = 0; d < days; d++) totalSlots += maxSpotsPerDay(d);
    const usableSights = sights.slice(0, Math.min(sights.length, totalSlots));

    // 2. 地理聚类：按实际坐标距离将景点分成 N 天的组
    let dailySights = clusterSightsByDay(usableSights, days, tempHotel, arrival);

    // 2.5 为每天独立选择酒店（基于景点聚类质心）
    const dailyHotels = selectDailyHotels(dailySights, hotels, budget, days);

    // 3. 每天内部用最近邻 + 2-opt 优化排序，确保最短路线
    for (let d = 0; d < dailySights.length; d++) {
      const dayHotel = dailyHotels[d] || tempHotel;
      const startPoint = d === 0 ? arrival : dayHotel;
      dailySights[d] = sortByNearestNeighbor(dailySights[d], startPoint);
    }

    // 4. 时间校验：检查每天行程是否超时，超时的景点移到下一天
    for (let d = 0; d < dailySights.length; d++) {
      const dayStart = d === 0 ? DAY_START_FIRST : DAY_START_NORMAL;
      const dayEnd = d === days - 1 ? DAY_END_LAST : DAY_END;
      let currentMinute = dayStart;
      const dayHotel = dailyHotels[d] || tempHotel;
      let prevPoint = d === 0 ? arrival : dayHotel;
      const kept = [];
      const overflow = [];

      for (const sight of dailySights[d]) {
        const transit = estimateTransitTime(prevPoint.lat, prevPoint.lng, sight.lat, sight.lng);
        const visitMin = sight.durationMinutes || 120;
        const needed = transit.minutes + visitMin;

        if (currentMinute + needed <= dayEnd && currentMinute + needed - dayStart <= MAX_DAY_MINUTES) {
          currentMinute += needed;
          prevPoint = sight;
          kept.push(sight);
        } else {
          overflow.push(sight);
        }
      }

      dailySights[d] = kept;
      // 将溢出景点追加到下一天
      if (overflow.length > 0 && d + 1 < dailySights.length) {
        dailySights[d + 1] = [...overflow, ...dailySights[d + 1]];
      }
    }

    // 5. 生成行程（使用真实时间计算）
    const schedule = [];
    let totalTicket = 0;
    const usedRestaurants = new Set(); // 已使用的餐厅，避免重复推荐

    for (let d = 0; d < days; d++) {
      const dayPlan = { day: d + 1, items: [] };
      const daySights = dailySights[d] || [];
      const isFirstDay = d === 0;
      const isLastDay = d === days - 1;
      const todayHotel = dailyHotels[d]; // 当天酒店（最后一天为 null）
      const prevDayHotel = d > 0 ? dailyHotels[d - 1] : null;

      let currentMinute = 9 * 60; // 时间轴从 09:00 开始
      let prevPoint = isFirstDay ? arrival : (prevDayHotel || tempHotel);

      if (isFirstDay) {
        dayPlan.items.push({ time: '09:00', name: arrival.name, desc: `抵达${currentCity}，${arrival.type}`, tag: '到达', lat: arrival.lat, lng: arrival.lng });
        // 到达后前往当天酒店
        if (todayHotel) {
          const toHotel = estimateTransitTime(arrival.lat, arrival.lng, todayHotel.lat, todayHotel.lng);
          currentMinute = 9 * 60 + toHotel.minutes;
          dayPlan.items.push({ time: minutesToTime(currentMinute), name: todayHotel.name, desc: `办理入住 · ≈¥${todayHotel.price}/晚`, tag: '住宿', lat: todayHotel.lat, lng: todayHotel.lng });
          currentMinute += 90; // 入住+休整 1.5 小时
          prevPoint = todayHotel;
        }
      } else if (!isLastDay && todayHotel && prevDayHotel) {
        // 非首日非末日：检查是否需要换酒店
        const isSameHotel = todayHotel.name === prevDayHotel.name && todayHotel.lat === prevDayHotel.lat;
        if (!isSameHotel) {
          // 需要换酒店：退房 → 前往新酒店 → 寄存行李
          dayPlan.items.push({ time: minutesToTime(currentMinute), name: prevDayHotel.name, desc: '退房，携带行李出发', tag: '住宿', lat: prevDayHotel.lat, lng: prevDayHotel.lng });
          currentMinute += 30; // 退房 30 分钟
          const toNewHotel = estimateTransitTime(prevDayHotel.lat, prevDayHotel.lng, todayHotel.lat, todayHotel.lng);
          if (toNewHotel.minutes > 5) {
            dayPlan.items.push({
              time: minutesToTime(currentMinute),
              name: `🚗 前往${todayHotel.name}`,
              desc: `${toNewHotel.mode} · 约${toNewHotel.minutes}分钟 · ${toNewHotel.distance.toFixed(1)}km`,
              tag: '交通'
            });
          }
          currentMinute += toNewHotel.minutes;
          dayPlan.items.push({ time: minutesToTime(currentMinute), name: todayHotel.name, desc: `寄存行李 · ≈¥${todayHotel.price}/晚`, tag: '住宿', lat: todayHotel.lat, lng: todayHotel.lng });
          currentMinute += 20; // 寄存行李 20 分钟
          prevPoint = todayHotel;
        }
      }

      daySights.forEach((sight) => {
        // 交通时间
        const transit = estimateTransitTime(prevPoint.lat, prevPoint.lng, sight.lat, sight.lng);
        if (transit.minutes > 5) {
          dayPlan.items.push({
            time: minutesToTime(currentMinute),
            name: `🚗 前往${sight.name}`,
            desc: `${transit.mode} · 约${transit.minutes}分钟 · ${transit.distance.toFixed(1)}km`,
            tag: '交通'
          });
        }
        currentMinute += transit.minutes;

        // 游览
        totalTicket += (sight.price || 0);
        const visitMin = sight.durationMinutes || 120;
        const priceLabel = sight.price === 0 ? '免费' : (sight.priceSource === 'estimated' ? '≈¥' + sight.price : '¥' + sight.price);
        dayPlan.items.push({
          time: minutesToTime(currentMinute),
          name: sight.name,
          desc: `${sight.type} · ${sight.duration || '1.5-2.5小时'} · ${priceLabel}`,
          tag: sight.type, lat: sight.lat, lng: sight.lng
        });
        currentMinute += visitMin;
        prevPoint = sight;
      });

      // 晚餐：从餐厅列表中选择距离当天最后一个景点最近的餐厅
      const dinnerTime = Math.max(currentMinute, 18 * 60 + 30);
      const restaurants = (poiData.restaurants || []);
      const nearestRest = findNearestRestaurant(restaurants, prevPoint, usedRestaurants);
      if (nearestRest) {
        usedRestaurants.add(nearestRest.name);
        dayPlan.items.push({
          time: minutesToTime(dinnerTime),
          name: nearestRest.name,
          desc: `🍽️ 人均 ≈¥${nearestRest.price} · ${nearestRest.address || ''}`,
          tag: '餐饮',
          lat: nearestRest.lat,
          lng: nearestRest.lng
        });
      } else {
        dayPlan.items.push({ time: minutesToTime(dinnerTime), name: `推荐品尝${currentCity}特色美食`, desc: `餐饮预算 ≈ ¥${budgetCfg.food}`, tag: '餐饮' });
      }

      if (!isLastDay && todayHotel) {
        dayPlan.items.push({ time: minutesToTime(dinnerTime + 90), name: todayHotel.name, desc: '返回酒店休息', tag: '住宿', lat: todayHotel.lat, lng: todayHotel.lng });
      } else if (isLastDay) {
        // 最后一天：返程
        const toArrival = estimateTransitTime(prevPoint.lat, prevPoint.lng, arrival.lat, arrival.lng);
        const departTime = dinnerTime + 60;
        dayPlan.items.push({
          time: minutesToTime(departTime),
          name: `🚗 前往${arrival.name}`,
          desc: `${toArrival.mode} · 约${toArrival.minutes}分钟，预留充足时间`,
          tag: '交通'
        });
        dayPlan.items.push({
          time: minutesToTime(departTime + toArrival.minutes),
          name: arrival.name,
          desc: `抵达${arrival.type}，结束愉快旅程`,
          tag: '返程', lat: arrival.lat, lng: arrival.lng
        });
      }

      schedule.push(dayPlan);
    }

    // 累加每天酒店价格
    let totalHotelCost = 0;
    for (const h of dailyHotels) {
      if (h) totalHotelCost += h.price;
    }
    // 至少保证 1 晚的费用（单日行程特殊处理）
    if (totalHotelCost === 0 && days === 1 && tempHotel) {
      totalHotelCost = 0; // 单日行程不住宿，费用为 0
    }

    return {
      schedule, dailyHotels,
      cost: {
        hotel: totalHotelCost,
        food: budgetCfg.food * days,
        transport: budgetCfg.transport * days,
        ticket: totalTicket
      }
    };
  }

  // ========== 按预算筛选酒店候选列表 ==========
  function filterHotelsByBudget(hotels, budgetLevel) {
    if (!hotels || hotels.length === 0) return [];
    const sortedByPrice = [...hotels].sort((a, b) => a.price - b.price);
    const sortedByPriceDesc = [...hotels].sort((a, b) => b.price - a.price);

    let candidates = [];
    if (budgetLevel === '舒适') {
      // 舒适档：优先选 ≥800 的酒店，按价格降序
      candidates = hotels.filter(h => h.price >= 800).sort((a, b) => b.price - a.price);
      if (candidates.length === 0) candidates = sortedByPriceDesc;
    } else if (budgetLevel === '标准') {
      // 标准档：优先选 300-700 区间，按评分降序
      candidates = hotels.filter(h => h.price >= 300 && h.price <= 700).sort((a, b) => b.rating - a.rating);
      if (candidates.length === 0) {
        // 没有 300-700 区间的，按距离 500 的偏差排序
        candidates = [...hotels].sort((a, b) => Math.abs(a.price - 500) - Math.abs(b.price - 500));
      }
    } else {
      // 经济档：优先选 ≤300 的酒店，按价格升序
      candidates = hotels.filter(h => h.price <= 300).sort((a, b) => a.price - b.price);
      if (candidates.length === 0) candidates = sortedByPrice;
    }
    return candidates;
  }

  // ========== 计算景点地理质心 ==========
  function computeCentroid(sights) {
    if (!sights || sights.length === 0) return null;
    let sumLat = 0, sumLng = 0;
    for (const s of sights) {
      sumLat += s.lat;
      sumLng += s.lng;
    }
    return { lat: sumLat / sights.length, lng: sumLng / sights.length };
  }

  // ========== 从候选酒店中选择距离质心最近的酒店 ==========
  function selectNearestHotel(candidates, centroid) {
    if (!candidates || candidates.length === 0 || !centroid) return null;
    let best = candidates[0];
    let bestDist = geoDistance(centroid.lat, centroid.lng, best.lat, best.lng);
    for (let i = 1; i < candidates.length; i++) {
      const d = geoDistance(centroid.lat, centroid.lng, candidates[i].lat, candidates[i].lng);
      if (d < bestDist) {
        bestDist = d;
        best = candidates[i];
      }
    }
    return best;
  }

  // ========== 为每天独立选择酒店 ==========
  function selectDailyHotels(dailySights, hotels, budgetLevel, numDays) {
    const candidates = filterHotelsByBudget(hotels, budgetLevel);
    const allHotelsFallback = [...hotels].sort((a, b) => a.price - b.price);
    const dailyHotels = [];

    for (let d = 0; d < numDays; d++) {
      // 最后一天不住宿
      if (d === numDays - 1) {
        dailyHotels.push(null);
        continue;
      }

      const daySights = dailySights[d] || [];
      if (daySights.length === 0) {
        // 当天无景点，使用候选列表第一个酒店
        dailyHotels.push(candidates[0] || allHotelsFallback[0] || null);
        continue;
      }

      const centroid = computeCentroid(daySights);
      let hotel = selectNearestHotel(candidates, centroid);
      // 降级方案：如果候选列表为空，从全部酒店中选最近的
      if (!hotel) {
        hotel = selectNearestHotel(allHotelsFallback, centroid);
      }
      dailyHotels.push(hotel);
    }

    return dailyHotels;
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

  // 基于地理距离估算交通时间（分钟）和交通方式
  function estimateTransitTime(lat1, lng1, lat2, lng2) {
    const dist = geoDistance(lat1, lng1, lat2, lng2);
    if (dist < 1.5) {
      return { minutes: Math.max(10, Math.round(dist / 4 * 60)), mode: '步行', distance: dist };
    } else if (dist < 8) {
      return { minutes: Math.max(15, Math.round(dist / 15 * 60 + 10)), mode: '公交', distance: dist };
    } else {
      return { minutes: Math.max(20, Math.round(dist / 30 * 60 + 10)), mode: '打车', distance: dist };
    }
  }

  // 将分钟数转为 HH:MM 格式
  function minutesToTime(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // ========== Supercluster 地理聚类：基于 Mapbox 开源的层级贪心聚类算法 ==========
  // Supercluster 使用基于 KD-Tree 的层级网格聚类，比 K-Means 更适合地理 POI：
  // 1. 不假设簇形状（K-Means 假设球形簇）
  // 2. 基于密度和距离的自然聚类
  // 3. 确定性结果（不依赖随机初始化）
  // 4. 通过 zoom level 精确控制簇的数量和粒度

  // 使用 Supercluster 将景点聚成 targetK 个簇
  // 通过遍历不同 radius 和 zoom level 来找到最接近 targetK 个簇的聚类结果
  function superclusterGroup(points, targetK) {
    if (points.length <= targetK) {
      return points.map(p => [p]);
    }

    // 将景点转为 GeoJSON Feature 格式（Supercluster 要求）
    const features = points.map((p, i) => ({
      type: 'Feature',
      properties: { _origIndex: i },
      geometry: {
        type: 'Point',
        coordinates: [p.lng, p.lat] // GeoJSON 是 [lng, lat]
      }
    }));

    // 计算景点的地理范围（用于 getClusters 的 bbox）
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    points.forEach(p => {
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    });
    const pad = 0.01;
    const bbox = [minLng - pad, minLat - pad, maxLng + pad, maxLat + pad];

    // 遍历不同 radius × zoom 组合，找到簇数最接近 targetK 的最佳参数
    const radiusCandidates = [40, 60, 80, 100, 120, 150, 200, 250];
    let bestIndex = null;
    let bestClusters = null;
    let bestDiff = Infinity;

    for (const r of radiusCandidates) {
      const idx = new Supercluster({
        radius: r,
        maxZoom: 20,
        minZoom: 0,
        minPoints: 1
      });
      idx.load(features);

      for (let z = 0; z <= 20; z++) {
        const cls = idx.getClusters(bbox, z);
        const diff = Math.abs(cls.length - targetK);
        if (diff < bestDiff || (diff === bestDiff && cls.length >= targetK)) {
          bestDiff = diff;
          bestIndex = idx;
          bestClusters = cls;
        }
        if (diff === 0) break;
      }
      if (bestDiff === 0) break;
    }

    // 降级：如果完全没有结果
    if (!bestClusters || bestClusters.length === 0) {
      return points.map(p => [p]);
    }

    // 将 Supercluster 的聚类结果转回原始景点数组
    const result = [];
    bestClusters.forEach(cluster => {
      const group = [];
      if (cluster.properties.cluster) {
        // 这是一个聚类簇，获取其中的所有叶子节点
        const clusterId = cluster.properties.cluster_id;
        const leaves = bestIndex.getLeaves(clusterId, Infinity);
        leaves.forEach(leaf => {
          const origIdx = leaf.properties._origIndex;
          if (origIdx !== undefined && points[origIdx]) {
            group.push(points[origIdx]);
          }
        });
      } else {
        // 这是一个单独的点
        const origIdx = cluster.properties._origIndex;
        if (origIdx !== undefined && points[origIdx]) {
          group.push(points[origIdx]);
        }
      }
      if (group.length > 0) {
        result.push(group);
      }
    });

    return result;
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
  // 使用 Supercluster 层级聚类 + 簇间最近邻排序 + 容量均衡
  function clusterSightsByDay(sights, numDays, hotel, arrival) {
    if (sights.length === 0) return Array.from({ length: numDays }, () => []);
    if (numDays === 1) return [sights];

    // 每天的最大景点数
    const maxPerDay = (d) => d === 0 ? 3 : 4;

    // 第一步：Supercluster 聚类
    let clusters = superclusterGroup(sights, numDays);

    // 处理簇数与天数不匹配的情况
    // 如果簇太少，拆分最大的簇
    while (clusters.length < numDays && clusters.some(c => c.length > 1)) {
      let maxIdx = 0;
      for (let i = 1; i < clusters.length; i++) {
        if (clusters[i].length > clusters[maxIdx].length) maxIdx = i;
      }
      const big = clusters.splice(maxIdx, 1)[0];
      // 对大簇再次用 Supercluster 拆分成 2 组
      const sub = superclusterGroup(big, 2);
      clusters.push(...sub.filter(c => c.length > 0));
    }

    // 如果簇太多，合并最近的两个簇
    while (clusters.length > numDays) {
      let bestI = 0, bestJ = 1, bestDist = Infinity;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const ci = clusterCentroid(clusters[i]);
          const cj = clusterCentroid(clusters[j]);
          const d = geoDistance(ci.lat, ci.lng, cj.lat, cj.lng);
          if (d < bestDist) { bestDist = d; bestI = i; bestJ = j; }
        }
      }
      // 合并 j 到 i
      clusters[bestI] = clusters[bestI].concat(clusters[bestJ]);
      clusters.splice(bestJ, 1);
    }

    // 第二步：按簇质心到到达点的距离排序（最近邻法）
    // 第一天从到达点出发，所以离到达点最近的簇排第一天
    const clusterOrder = [];
    const remainingClusters = clusters.map((c, i) => i);
    let curPoint = { lat: arrival.lat, lng: arrival.lng };

    while (remainingClusters.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remainingClusters.length; i++) {
        const ci = remainingClusters[i];
        const cent = clusterCentroid(clusters[ci]);
        const d = geoDistance(curPoint.lat, curPoint.lng, cent.lat, cent.lng);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      const chosen = remainingClusters.splice(bestIdx, 1)[0];
      clusterOrder.push(chosen);
      curPoint = clusterCentroid(clusters[chosen]);
    }

    // 第三步：将排序后的簇分配到每天
    const dailySights = Array.from({ length: numDays }, () => []);

    if (clusterOrder.length === numDays) {
      clusterOrder.forEach((ci, d) => {
        dailySights[d] = [...clusters[ci]];
      });
    } else if (clusterOrder.length < numDays) {
      clusterOrder.forEach((ci, d) => {
        dailySights[d] = [...clusters[ci]];
      });
    } else {
      const perDay = Math.ceil(clusterOrder.length / numDays);
      for (let d = 0; d < numDays; d++) {
        const start = d * perDay;
        const end = Math.min(start + perDay, clusterOrder.length);
        for (let i = start; i < end; i++) {
          dailySights[d].push(...clusters[clusterOrder[i]]);
        }
      }
    }

    // 第四步：容量均衡 — 如果某天景点过多，将最远的景点移到地理上最近的有空位的天
    let balanced = false;
    let balanceRounds = 20;
    while (!balanced && balanceRounds-- > 0) {
      balanced = true;
      for (let d = 0; d < numDays; d++) {
        const max = maxPerDay(d);
        while (dailySights[d].length > max) {
          balanced = false;
          const centroid = clusterCentroid(dailySights[d]);
          let farthestIdx = 0;
          let farthestDist = 0;
          dailySights[d].forEach((s, i) => {
            const dist = geoDistance(s.lat, s.lng, centroid.lat, centroid.lng);
            if (dist > farthestDist) { farthestDist = dist; farthestIdx = i; }
          });
          const overflow = dailySights[d].splice(farthestIdx, 1)[0];

          let bestDay = -1;
          let bestDayDist = Infinity;
          for (let dd = 0; dd < numDays; dd++) {
            if (dd === d) continue;
            if (dailySights[dd].length < maxPerDay(dd)) {
              const ddCentroid = dailySights[dd].length > 0
                ? clusterCentroid(dailySights[dd])
                : { lat: hotel.lat, lng: hotel.lng };
              const dist = geoDistance(overflow.lat, overflow.lng, ddCentroid.lat, ddCentroid.lng);
              if (dist < bestDayDist) { bestDayDist = dist; bestDay = dd; }
            }
          }
          if (bestDay >= 0) {
            dailySights[bestDay].push(overflow);
          } else {
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

  // 辅助函数：计算一组点的质心
  function clusterCentroid(points) {
    if (points.length === 0) return { lat: 0, lng: 0 };
    const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const avgLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
    return { lat: avgLat, lng: avgLng };
  }

  // ========== 渲染行程 ==========
  function renderItinerary(data) {
    let globalIdx = 0;
    let html = '';

    data.schedule.forEach((day, dayIdx) => {
      html += `<div class="day-card" data-day="${dayIdx}">
        <div class="day-header">
          <span class="day-badge">第 ${day.day} 天</span>
        </div>
        <div class="timeline" data-day="${dayIdx}">`;

      day.items.forEach((item, itemIdx) => {
        const hasCoord = item.lat && item.lng;
        const isTransit = item.tag === '交通';
        const isSight = hasCoord && !isTransit && !['到达', '住宿', '返程', '餐饮'].includes(item.tag);
        const dataAttr = hasCoord ? `data-seg-idx="${globalIdx}" data-lat="${item.lat}" data-lng="${item.lng}"` : '';
        const tabIndex = hasCoord ? 'tabindex="0"' : '';
        if (hasCoord) globalIdx++;

        const extraClass = isTransit ? ' transit-item' : '';
        // 景点项添加删除按钮
        const deleteBtn = isSight ? `<button class="itinerary-delete-btn" data-day="${dayIdx}" data-item="${itemIdx}" title="移除此景点" aria-label="移除${item.name}">✕</button>` : '';

        html += `<div class="timeline-item ${hasCoord ? 'clickable' : ''}${extraClass}" ${dataAttr} ${tabIndex} ${hasCoord ? 'role="button"' : ''} data-day="${dayIdx}" data-item="${itemIdx}">
          <div class="timeline-dot"></div>
          ${deleteBtn}
          <div class="timeline-time">${item.time}</div>
          <div class="timeline-name">${item.name}</div>
          <div class="timeline-desc">${item.desc}</div>
          <span class="timeline-tag">${item.tag}</span>
        </div>`;
      });

      // 添加景点按钮
      html += `</div>
        <button class="itinerary-add-btn" data-day="${dayIdx}">+ 添加景点</button>
      </div>`;
    });

    // 一键优化路线按钮
    html += `<div class="itinerary-actions">
      <button class="itinerary-optimize-btn" id="optimizeRouteBtn">🔄 一键优化路线</button>
    </div>`;

    panelBody.innerHTML = html;

    // 绑定景点点击事件
    panelBody.querySelectorAll('.timeline-item.clickable').forEach(el => {
      const handler = (e) => {
        // 如果点击的是删除按钮，不触发高亮
        if (e.target.closest('.itinerary-delete-btn')) return;
        const idx = parseInt(el.dataset.segIdx);
        const lat = parseFloat(el.dataset.lat);
        const lng = parseFloat(el.dataset.lng);
        highlightSegment(idx, lat, lng, el);
      };
      el.addEventListener('click', handler);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(e); }
      });
    });

    // 绑定删除按钮事件
    panelBody.querySelectorAll('.itinerary-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dayIdx = parseInt(btn.dataset.day);
        const itemIdx = parseInt(btn.dataset.item);
        removeItineraryItem(dayIdx, itemIdx);
      });
    });

    // 绑定添加景点按钮事件
    panelBody.querySelectorAll('.itinerary-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dayIdx = parseInt(btn.dataset.day);
        showAddSightPanel(dayIdx);
      });
    });

    // 绑定一键优化路线按钮
    const optimizeBtn = panelBody.querySelector('#optimizeRouteBtn');
    if (optimizeBtn) {
      optimizeBtn.addEventListener('click', () => {
        if (!itineraryData) return;
        showToast('正在重新优化路线...', 'info', 2000);
        // 重新规划
        startPlanning();
      });
    }

    // 初始化拖拽排序（SortableJS）
    if (typeof Sortable !== 'undefined') {
      panelBody.querySelectorAll('.timeline').forEach(timeline => {
        new Sortable(timeline, {
          animation: 200,
          handle: '.timeline-item:not(.transit-item)',
          draggable: '.timeline-item:not(.transit-item)',
          ghostClass: 'sortable-ghost',
          chosenClass: 'sortable-chosen',
          onEnd: function (evt) {
            const dayIdx = parseInt(timeline.dataset.day);
            if (isNaN(dayIdx) || !itineraryData || !itineraryData.schedule[dayIdx]) return;
            const day = itineraryData.schedule[dayIdx];
            // 重新排列 items 数组
            const oldIdx = evt.oldIndex;
            const newIdx = evt.newIndex;
            if (oldIdx === newIdx) return;
            const movedItem = day.items.splice(oldIdx, 1)[0];
            day.items.splice(newIdx, 0, movedItem);
            // 重新渲染
            renderItinerary(itineraryData);
            drawRouteSegments(itineraryData);
            showToast('行程顺序已调整', 'success', 1500);
          }
        });
      });
    }
  }

  // ========== 行程编辑功能 ==========

  // 删除行程中的景点项
  function removeItineraryItem(dayIdx, itemIdx) {
    if (!itineraryData || !itineraryData.schedule[dayIdx]) return;

    const day = itineraryData.schedule[dayIdx];
    const item = day.items[itemIdx];
    if (!item) return;

    // 同时删除该景点前面的交通项（如果有）
    if (itemIdx > 0 && day.items[itemIdx - 1] && day.items[itemIdx - 1].tag === '交通') {
      day.items.splice(itemIdx - 1, 2);
    } else {
      day.items.splice(itemIdx, 1);
    }

    // 重新计算费用
    recalculateCost();

    // 重新渲染
    renderItinerary(itineraryData);
    renderCostSummary(itineraryData);
    drawRouteSegments(itineraryData);

    showToast('已移除景点', 'success', 2000);
  }

  // 重新计算费用
  function recalculateCost() {
    if (!itineraryData) return;
    const budgetCfg = BUDGET_CONFIG[budget];
    let totalTicket = 0;
    let totalHotel = 0;
    itineraryData.schedule.forEach(day => {
      day.items.forEach(item => {
        // 从描述中提取门票价格
        if (item.tag && !['到达', '住宿', '返程', '餐饮', '交通'].includes(item.tag)) {
          const match = item.desc.match(/[≈¥](\d+)/);
          if (match) totalTicket += parseInt(match[1]);
        }
        // 从住宿项中提取酒店价格（匹配"办理入住"或"寄存行李"描述中的价格）
        if (item.tag === '住宿' && item.desc) {
          const hotelMatch = item.desc.match(/≈¥(\d+)\/晚/);
          if (hotelMatch) totalHotel += parseInt(hotelMatch[1]);
        }
      });
    });
    itineraryData.cost.ticket = totalTicket;
    itineraryData.cost.hotel = totalHotel;
    itineraryData.cost.food = budgetCfg.food * days;
    itineraryData.cost.transport = budgetCfg.transport * days;
  }

  // 显示添加景点面板
  function showAddSightPanel(dayIdx) {
    const poiData = poiCache[currentCity];
    if (!poiData || !poiData.sights) {
      showToast('暂无可添加的景点数据', 'warning');
      return;
    }

    // 获取已在行程中的景点名称
    const usedNames = new Set();
    if (itineraryData) {
      itineraryData.schedule.forEach(day => {
        day.items.forEach(item => {
          if (item.lat && item.lng && !['到达', '住宿', '返程', '餐饮', '交通'].includes(item.tag)) {
            usedNames.add(item.name);
          }
        });
      });
    }

    // 过滤出未使用的景点
    const available = poiData.sights.filter(s => !usedNames.has(s.name));
    if (available.length === 0) {
      showToast('所有景点已在行程中', 'info');
      return;
    }

    // 创建选择弹窗
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `<div class="poi-modal" style="max-height:70vh;overflow-y:auto;">
      <button class="modal-close" aria-label="关闭">✕</button>
      <div class="modal-header"><h3>添加景点到第 ${dayIdx + 1} 天</h3></div>
      <div class="modal-body" style="padding:12px 24px 24px;">
        ${available.map((s, i) => `
          <div class="add-sight-item" data-idx="${i}" style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #f1f5f9;cursor:pointer;border-radius:8px;transition:background .15s;">
            <div>
              <div style="font-weight:600;font-size:14px;">${s.name}</div>
              <div style="font-size:12px;color:#64748b;">${s.type} · ${s.duration || '1.5-2.5小时'} · ${s.price === 0 ? '免费' : '≈¥' + s.price}</div>
            </div>
            <span style="color:#2563eb;font-size:20px;font-weight:700;">+</span>
          </div>
        `).join('')}
      </div>
    </div>`;

    document.body.appendChild(overlay);

    // 关闭
    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // 选择景点
    overlay.querySelectorAll('.add-sight-item').forEach(el => {
      el.addEventListener('mouseenter', () => el.style.background = '#eff6ff');
      el.addEventListener('mouseleave', () => el.style.background = '');
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const sight = available[idx];
        addSightToDay(dayIdx, sight);
        overlay.remove();
      });
    });
  }

  // 将景点添加到指定天的行程中
  function addSightToDay(dayIdx, sight) {
    if (!itineraryData || !itineraryData.schedule[dayIdx]) return;

    const day = itineraryData.schedule[dayIdx];
    // 在餐饮项之前插入
    let insertIdx = day.items.length - 2; // 餐饮和住宿/返程之前
    if (insertIdx < 0) insertIdx = day.items.length;

    const priceLabel = sight.price === 0 ? '免费' : (sight.priceSource === 'estimated' ? '≈¥' + sight.price : '¥' + sight.price);
    const newItem = {
      time: '--:--',
      name: sight.name,
      desc: `${sight.type} · ${sight.duration || '1.5-2.5小时'} · ${priceLabel}`,
      tag: sight.type,
      lat: sight.lat,
      lng: sight.lng
    };

    day.items.splice(insertIdx, 0, newItem);

    // 重新计算费用和渲染
    recalculateCost();
    renderItinerary(itineraryData);
    renderCostSummary(itineraryData);
    drawRouteSegments(itineraryData);

    showToast(`已添加「${sight.name}」到第 ${dayIdx + 1} 天`, 'success', 2000);
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
    $('#costHotel').textContent = `≈¥${c.hotel.toLocaleString()}`;
    $('#costFood').textContent = `≈¥${c.food.toLocaleString()}`;
    $('#costTransport').textContent = `≈¥${c.transport.toLocaleString()}`;
    $('#costTicket').textContent = `≈¥${c.ticket.toLocaleString()}`;
    const total = c.hotel + c.food + c.transport + c.ticket;
    $('#costTotal').textContent = `≈¥${total.toLocaleString()}`;
    costSummary.style.display = 'block';
    // 显示免责声明
    const disclaimer = $('#costDisclaimer');
    if (disclaimer) disclaimer.style.display = 'block';
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

  // ========== 行程保存与分享 ==========
  const ITINERARY_SAVE_KEY = 'travel_saved_itinerary';

  function saveItinerary() {
    if (!itineraryData) {
      showToast('暂无行程可保存', 'warning');
      return;
    }
    try {
      const saveData = {
        city: currentCity,
        days: days,
        budget: budget,
        itinerary: itineraryData,
        savedAt: Date.now()
      };
      localStorage.setItem(ITINERARY_SAVE_KEY, JSON.stringify(saveData));
      showToast('行程已保存，下次访问可恢复', 'success');
    } catch (e) {
      showToast('保存失败：' + e.message, 'error');
    }
  }

  function loadSavedItinerary() {
    try {
      const raw = localStorage.getItem(ITINERARY_SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // 检查是否过期（7天）
      if (Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(ITINERARY_SAVE_KEY);
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function promptRestoreItinerary() {
    const saved = loadSavedItinerary();
    if (!saved) return;

    const restoreBar = document.createElement('div');
    restoreBar.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#fff;border:1.5px solid #2563eb;border-radius:12px;padding:12px 20px;box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:40000;display:flex;align-items:center;gap:12px;font-size:14px;';
    restoreBar.innerHTML = `
      <span>📋 发现上次保存的 <strong>${saved.city}</strong> ${saved.days}天行程</span>
      <button id="restoreYes" style="padding:6px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;">恢复</button>
      <button id="restoreNo" style="padding:6px 16px;background:#f1f5f9;color:#64748b;border:none;border-radius:6px;font-weight:600;cursor:pointer;">忽略</button>
    `;
    document.body.appendChild(restoreBar);

    restoreBar.querySelector('#restoreYes').addEventListener('click', () => {
      currentCity = saved.city;
      days = saved.days;
      budget = saved.budget;
      daysValue.textContent = days;
      budgetTabs.forEach(t => {
        t.classList.toggle('active', t.dataset.budget === budget);
      });
      updateBudgetDetail();

      itineraryData = saved.itinerary;
      renderItinerary(itineraryData);
      renderCostSummary(itineraryData);
      drawRouteSegments(itineraryData);
      itineraryPanel.style.display = 'flex';
      itineraryPanel.classList.add('open');

      restoreBar.remove();
      showToast('行程已恢复', 'success');
    });

    restoreBar.querySelector('#restoreNo').addEventListener('click', () => {
      restoreBar.remove();
    });

    // 10 秒后自动消失
    setTimeout(() => { if (restoreBar.parentNode) restoreBar.remove(); }, 10000);
  }

  // URL 分享功能
  function shareItinerary() {
    if (!itineraryData) {
      showToast('暂无行程可分享', 'warning');
      return;
    }
    try {
      const shareData = {
        c: currentCity,
        d: days,
        b: budget,
        // 只保存核心数据，减小 URL 长度
        s: itineraryData.schedule.map(day => ({
          day: day.day,
          items: day.items.map(item => ({
            t: item.time, n: item.name, d: item.desc, g: item.tag,
            ...(item.lat ? { la: item.lat, ln: item.lng } : {})
          }))
        }))
      };
      const encoded = btoa(encodeURIComponent(JSON.stringify(shareData)));
      const url = window.location.origin + window.location.pathname + '?plan=' + encoded;

      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          showToast('分享链接已复制到剪贴板', 'success');
        });
      } else {
        // 降级方案
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        showToast('分享链接已复制到剪贴板', 'success');
      }
    } catch (e) {
      showToast('生成分享链接失败：' + e.message, 'error');
    }
  }

  // 从 URL 参数恢复行程
  function restoreFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const planData = params.get('plan');
    if (!planData) return false;

    try {
      const decoded = JSON.parse(decodeURIComponent(atob(planData)));
      currentCity = decoded.c;
      days = decoded.d;
      budget = decoded.b;
      daysValue.textContent = days;
      budgetTabs.forEach(t => {
        t.classList.toggle('active', t.dataset.budget === budget);
      });
      updateBudgetDetail();

      itineraryData = {
        schedule: decoded.s.map(day => ({
          day: day.day,
          items: day.items.map(item => ({
            time: item.t, name: item.n, desc: item.d, tag: item.g,
            ...(item.la ? { lat: item.la, lng: item.ln } : {})
          }))
        })),
        cost: { hotel: 0, food: 0, transport: 0, ticket: 0 }
      };
      recalculateCost();

      setTimeout(() => {
        renderItinerary(itineraryData);
        renderCostSummary(itineraryData);
        drawRouteSegments(itineraryData);
        itineraryPanel.style.display = 'flex';
        itineraryPanel.classList.add('open');
        showToast('已从分享链接恢复行程', 'success');
      }, 1500);

      // 清除 URL 参数
      window.history.replaceState({}, '', window.location.pathname);
      return true;
    } catch (e) {
      console.warn('URL 行程恢复失败:', e);
      return false;
    }
  }

  // PDF 导出
  function exportPdf() {
    if (!itineraryData) {
      showToast('暂无行程可导出', 'warning');
      return;
    }
    showToast('正在准备打印...', 'info', 2000);
    setTimeout(() => window.print(), 500);
  }

  document.addEventListener('DOMContentLoaded', init);

})();
