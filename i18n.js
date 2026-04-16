// ========== 国际化基础架构（i18n） ==========
// 当前版本仅支持中文，但语言包结构已就绪，添加新语言只需新增语言对象

(function () {
  'use strict';

  // 当前语言
  let currentLang = 'zh-CN';

  // 语言包
  const LANG = {
    'zh-CN': {
      // ---- 页面标题与描述 ----
      'app.title': '旅行规划器 — 智能规划，说走就走',
      'app.name': '🗺️ 旅行规划器',
      'app.subtitle': '智能规划，说走就走',
      'app.description': '智能旅行规划器 — 选择城市、天数和预算，一键生成专属行程路线，支持地图可视化与费用估算',

      // ---- 侧边栏配置 ----
      'config.destination': '🏙️ 目的地',
      'config.days': '📅 行程天数',
      'config.budget': '💰 预算档位',
      'config.arrival': '🚉 到达方式',
      'config.layers': '🗂️ 图层控制',
      'config.cityPlaceholder': '输入城市名或任意地点...',
      'config.dayUnit': '天',

      // ---- 预算档位 ----
      'budget.comfort': '舒适',
      'budget.standard': '标准',
      'budget.economy': '经济',

      // ---- 图层 ----
      'layer.sights': '景点',
      'layer.hotels': '酒店',

      // ---- 按钮 ----
      'btn.plan': '🚀 开始智能规划',
      'btn.save': '保存行程',
      'btn.share': '分享行程',
      'btn.exportPdf': '导出PDF',
      'btn.optimize': '🔄 一键优化路线',
      'btn.addSight': '+ 添加景点',

      // ---- 费用统计 ----
      'cost.title': '💰 费用估算',
      'cost.hotel': '住宿',
      'cost.food': '餐饮',
      'cost.transport': '交通',
      'cost.ticket': '门票',
      'cost.total': '总计',
      'cost.disclaimer': '⚠️ 以上为估算费用，实际费用以现场为准',

      // ---- 行程面板 ----
      'panel.title': '📋 行程安排',
      'panel.empty': '点击「🚀 开始智能规划」<br>生成您的专属行程',
      'panel.dayBadge': '第 {day} 天',

      // ---- POI 弹窗 ----
      'modal.rating': '⭐ 评分',
      'modal.price': '💰 价格',
      'modal.duration': '⏱️ 游览',
      'modal.stars': '🌟 星级',
      'modal.tel': '📞 电话',
      'modal.address': '📍 地址',
      'modal.noRating': '暂无评分',
      'modal.free': '免费',
      'modal.estimated': '(估算)',

      // ---- 行程标签 ----
      'tag.arrive': '到达',
      'tag.hotel': '住宿',
      'tag.food': '餐饮',
      'tag.transit': '交通',
      'tag.return': '返程',

      // ---- 加载与状态 ----
      'loading.planning': '正在智能规划路线...',
      'loading.searchPOI': '正在搜索真实 POI 数据...',
      'loading.identifyCity': '正在智能识别所在城市...',

      // ---- Toast 消息 ----
      'toast.planFail': '规划失败：{msg}。请检查网络连接后重试',
      'toast.noSights': '未能搜索到景点数据。可能是 API 请求量超限或网络问题，请稍后重试',
      'toast.sightRemoved': '已移除景点',
      'toast.sightAdded': '已添加「{name}」到第 {day} 天',
      'toast.orderChanged': '行程顺序已调整',
      'toast.optimizing': '正在重新优化路线...',
      'toast.saved': '行程已保存',
      'toast.linkCopied': '分享链接已复制到剪贴板',
      'toast.offline': '当前处于离线状态，部分功能可能不可用',
      'toast.online': '网络已恢复',
      'toast.noSightsToAdd': '所有景点已在行程中',
      'toast.noSightData': '暂无可添加的景点数据',
      'toast.cityIdentified': '已识别城市：{city}',
      'toast.poiLocated': '已定位到「{name}」，所在城市：{city}',

      // ---- 行程描述模板 ----
      'itinerary.arrive': '抵达{city}，{type}',
      'itinerary.checkIn': '办理入住 · ≈¥{price}/晚',
      'itinerary.backHotel': '返回酒店休息',
      'itinerary.toStation': '前往{type}，预留充足时间',
      'itinerary.endTrip': '抵达{type}，结束愉快旅程',
      'itinerary.defaultFood': '推荐品尝当地特色美食',
      'itinerary.foodBudget': '餐饮预算 ≈ ¥{amount}',
      'itinerary.transitDesc': '{mode} · 约{min}分钟 · {dist}km',

      // ---- 城市搜索 ----
      'search.hotCities': '🔥 热门城市',
      'search.noMatch': '😕 未找到匹配城市，按回车可搜索任意地点',
      'search.searchPOI': '🔍 搜索 "{keyword}" 并规划所在城市',

      // ---- 预算详情模板 ----
      'budgetDetail.template': '住宿 ≈ ¥{hotel}/晚 · 餐饮 ≈ ¥{food}/天<br>交通 ≈ ¥{transport}/天 · 门票 ≈ ¥{ticket}/天',

      // ---- 地图错误 ----
      'map.loadFail': '地图加载失败，请刷新页面重试',

      // ---- 新手引导 ----
      'guide.step1': '选择目的地城市或搜索任意地点',
      'guide.step2': '设置行程天数和预算档位',
      'guide.step3': '点击开始智能规划，生成专属行程',
      'guide.step4': '在行程面板中查看、编辑和分享行程',
      'guide.skip': '跳过引导',
      'guide.next': '下一步',
      'guide.done': '开始使用'
    }
  };

  // 翻译函数：从语言包中查找对应文本，支持 {key} 占位符替换
  function t(key, params) {
    const pack = LANG[currentLang] || LANG['zh-CN'];
    let text = pack[key];
    if (text === undefined) {
      console.warn('[i18n] 缺少翻译 key:', key);
      return key;
    }
    if (params) {
      Object.keys(params).forEach(function (k) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
      });
    }
    return text;
  }

  // 统一货币格式化函数
  function formatCurrency(amount, options) {
    options = options || {};
    const symbol = options.symbol || '¥';
    const approximate = options.approximate || false;
    const prefix = approximate ? '≈' : '';
    if (typeof amount !== 'number' || isNaN(amount)) return '-';
    return prefix + symbol + amount.toLocaleString();
  }

  // 切换语言
  function setLang(lang) {
    if (LANG[lang]) {
      currentLang = lang;
    }
  }

  // 获取当前语言
  function getLang() {
    return currentLang;
  }

  // 获取所有支持的语言列表
  function getSupportedLangs() {
    return Object.keys(LANG);
  }

  // 导出到全局
  window.I18n = {
    t: t,
    formatCurrency: formatCurrency,
    setLang: setLang,
    getLang: getLang,
    getSupportedLangs: getSupportedLangs,
    LANG: LANG
  };

})();
