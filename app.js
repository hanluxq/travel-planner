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

  // ---- DOM ----
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const citySelect = $('#citySelect');
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
    initMap();
    bindEvents();
    updateBudgetDetail();
    // 延迟加载 POI，等地图 SDK 完全就绪
    setTimeout(() => loadCity(currentCity), 1000);
  }

  function populateCities() {
    ALL_CITIES.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      citySelect.appendChild(opt);
    });
    citySelect.value = currentCity;
  }

  function initMap() {
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
    const cityData = CITY_DATA[cityName];
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

  // ========== 事件绑定 ==========
  function bindEvents() {
    citySelect.addEventListener('change', () => {
      currentCity = citySelect.value;
      closeItinerary();
      loadCity(currentCity);
    });

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
        if (modalOverlay.style.display === 'flex') {
          closeModal();
        } else if (itineraryPanel.style.display === 'flex') {
          closeItinerary();
        }
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

  // ========== 预算详情 ==========
  function updateBudgetDetail() {
    const b = BUDGET_CONFIG[budget];
    budgetDetail.innerHTML =
      `住宿 ≈ ¥${b.hotel}/晚 · 餐饮 ≈ ¥${b.food}/天<br>交通 ≈ ¥${b.transport}/天 · 门票 ≈ ¥${b.ticket}/天`;
  }

  // ========== 加载城市 ==========
  function loadCity(name) {
    const city = CITY_DATA[name];
    if (!city || !map) return;

    map.setCenter(new TMap.LatLng(city.center[1], city.center[0]));
    map.setZoom(12);

    arrivalSelect.innerHTML = '';
    city.arrivals.forEach((a, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${a.name}（${a.type}）`;
      arrivalSelect.appendChild(opt);
    });

    clearAllMarkers();

    // 异步加载 POI 并绘制标记
    fetchCityPOI(name).then(poiData => {
      if (currentCity !== name) return; // 城市已切换
      drawMarkers(city, poiData);
    });
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
      const city = CITY_DATA[currentCity];
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

    shuffleArray(sights);

    const schedule = [];
    let sightIdx = 0;
    const spotsPerDay = Math.max(2, Math.ceil(sights.length / days));

    for (let d = 0; d < days; d++) {
      const dayPlan = { day: d + 1, items: [] };

      if (d === 0) {
        dayPlan.items.push({ time: '09:00', name: arrival.name, desc: `抵达${currentCity}，${arrival.type}`, tag: '到达', lat: arrival.lat, lng: arrival.lng });
        dayPlan.items.push({ time: '10:30', name: hotel.name, desc: `办理入住 · ¥${hotel.price}/晚`, tag: '住宿', lat: hotel.lat, lng: hotel.lng });
      }

      const startHour = d === 0 ? 13 : 9;
      const daySpots = Math.min(spotsPerDay, sights.length - sightIdx);

      for (let s = 0; s < daySpots && sightIdx < sights.length; s++) {
        const sight = sights[sightIdx++];
        const hour = startHour + s * 2;
        if (hour >= 20) break;
        dayPlan.items.push({
          time: `${String(hour).padStart(2, '0')}:00`,
          name: sight.name,
          desc: `${sight.type} · ${sight.duration || '2小时'} · ${sight.price === 0 ? '免费' : '¥' + sight.price}`,
          tag: sight.type, lat: sight.lat, lng: sight.lng
        });
      }

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
        ticket: sights.slice(0, sightIdx).reduce((sum, s) => sum + (s.price || 0), 0)
      }
    };
  }

  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
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
