# 🗺️ 旅行规划器 — 智能规划，说走就走

基于腾讯地图 GL JS SDK 的智能旅行规划 Web 应用，支持 **实时 POI 搜索**，覆盖 32 个国内热门城市。

![preview](https://img.shields.io/badge/preview-live-blue)

## ✨ 核心功能

- **实时 POI 数据** — 通过腾讯地图 WebService API 实时搜索景点和酒店，获取真实名称、地址、电话等信息
- **32 城市覆盖** — 北京、上海、广州、成都、西安、杭州、丽江、三亚、拉萨等热门旅游城市
- **智能行程规划** — 选择城市、天数、预算档位，一键生成每日行程安排
- **地图可视化** — 景点/酒店标记、路线分段绘制、点击高亮联动
- **费用估算** — 住宿、餐饮、交通、门票分项统计
- **响应式设计** — 支持桌面端和移动端（768px 以下自动切换底部面板）

## 🚀 快速开始

### 1. 申请腾讯地图 API Key

> ⚠️ **重要**：项目内置的是腾讯地图公用 Demo Key，有严格的 QPS 限制，**强烈建议替换为你自己申请的 Key**。

1. 前往 [腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine) 注册并创建应用
2. 创建 Key 时，启用 **JavaScript API GL** 和 **WebServiceAPI** 两项服务
3. 在 `index.html` 中替换 `key=` 参数：

```html
<script src="https://map.qq.com/api/gljs?v=1.exp&key=你的KEY&libraries=service"></script>
```

### 2. 部署运行

```bash
# 方式一：本地 HTTP 服务器
python3 -m http.server 8080
# 然后打开 http://localhost:8080

# 方式二：直接双击 index.html 打开（部分浏览器可能限制 JSONP 请求）
```

也可直接部署到 GitHub Pages / Vercel / Netlify 等静态托管平台。

## 📁 项目结构

```
├── index.html   # 页面结构
├── style.css    # 样式（含移动端适配 + 打印样式）
├── data.js      # 城市数据（坐标、到达点、预算配置）
├── app.js       # 主逻辑（POI 搜索、规划、地图交互）
└── README.md    # 本文件
```

## 🔧 技术栈

- **地图** — [腾讯地图 GL JS SDK](https://lbs.qq.com/javascript_gl/doc/index.html) + WebService API (JSONP)
- **POI 搜索** — 腾讯位置服务 [地点搜索 API](https://lbs.qq.com/webservice_v1/guide-search.html) 实时获取景点和酒店数据
- **前端** — 纯原生 HTML/CSS/JavaScript，无框架依赖
- **样式** — CSS Grid/Flexbox 布局，CSS 变量主题，focus-visible 键盘导航

## 📝 API 限流说明

腾讯地图 WebService API 有 QPS 限制（免费 Key 通常 5次/秒，公用 Demo Key 限制更严）。本项目已内置：

- **请求队列** — 串行发送搜索请求，避免并发触限
- **指数退避重试** — 遇到限流自动等待后重试（最多 3 次）
- **结果缓存** — 同一城市的 POI 只搜索一次，切换回来直接使用缓存

如果仍然遇到限流提示，请申请自己的 Key（个人开发者免费额度足够使用）。

## 📄 License

MIT
