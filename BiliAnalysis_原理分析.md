# 哔哩哔哩右键解析插件原理分析

## 目标

这个插件的目标很直接：

- 当鼠标移动到哔哩哔哩视频链接上时，识别出该链接对应的视频。
- 在右键菜单里动态加入“复制解析地址”。
- 用户点击后，请求 B 站接口拿到实际播放地址。
- 把解析出的直链复制到剪贴板，并弹出“解析成功”通知。

它本质上是一个 **Chrome 扩展 + 页面内容监听 + B 站接口调用** 的组合，不是本地解码，也不是抓包播放器内部逻辑。

---

## 文件分工

### `manifest.json`

这个文件定义了扩展的基础能力：

- `manifest_version: 2`
  - 使用的是老版 Chrome 扩展清单格式。
- `permissions`
  - `activeTab`：允许访问当前页面。
  - `contextMenus`：允许创建右键菜单。
- `background`
  - 后台脚本是 `background.js`，并且 `persistent: false`，表示事件驱动，不常驻。
- `content_scripts`
  - 在所有 `http/https` 页面注入 `content.js`。

这意味着扩展会先进入网页环境监听元素，再通过消息传递把结果交给后台脚本处理。

---

## 总体工作流

整体流程可以概括为 5 步：

1. `content.js` 监听鼠标移动到哪个元素上。
2. 如果目标元素对应的是 B 站视频链接，并且链接里带有 `BV` 号，就把链接发给后台。
3. `background.js` 收到链接后，创建右键菜单“复制解析地址”。
4. 用户点击菜单后，后台从链接中提取 `BV` 和分 P 信息，请求 B 站接口。
5. 后台拿到视频真实播放地址后复制到剪贴板，并弹出通知。

---

## `content.js` 的原理

### 1. 监听页面鼠标悬停

脚本在不同的 B 站页面注册 `mouseover` 事件：

- `https://www.bilibili.com/`
- `https://space.bilibili.com/`
- `https://search.bilibili.com/`
- `https://t.bilibili.com/`

这样做的原因是，不同页面的视频卡片 DOM 结构不同，不能用一套选择器统一处理。

### 2. 从页面元素中找出视频链接

它针对不同页面写了不同逻辑：

- 普通站内页 / 用户空间页
  - 如果鼠标正好停在 `<a>` 标签上，就直接取 `target.href`。
- 搜索页
  - 如果鼠标停在标题元素 `.bili-video-card__info--tit` 上，就向上找最近的 `<a>` 标签。
- 动态页
  - 针对封面蒙层 `.bili-dyn-card-video__cover__mask` 和标题 `.bili-dyn-card-video__title`，向上回溯父元素，再找最近的 `<a>`。

### 3. 判断是否是视频

判断条件非常简单：

- 只要链接中包含 `BV`，就认为这是一个 B 站视频链接。

然后通过：

```js
chrome.runtime.sendMessage({ action: "getLink", link: link });
```

把链接发给后台脚本。

如果当前鼠标位置没有命中视频链接，就发送：

```js
chrome.runtime.sendMessage({ action: "notgetLink" });
```

通知后台清理右键菜单。

### 4. 这一层的本质

`content.js` 的职责只有两个：

- 感知“鼠标现在指向的是不是一个 B 站视频链接”
- 把这个链接交给后台

它本身不负责解析视频地址。

---

## `background.js` 的原理

### 1. 保存当前命中的链接

后台通过 `chrome.runtime.onMessage.addListener(messageListener)` 接收消息。

当收到：

```js
{ action: "getLink", link: xxx }
```

时，会把链接存进全局变量 `link`，然后创建右键菜单：

```js
chrome.contextMenus.create({
  id: "myContextMenu",
  title: "复制解析地址",
  contexts: ["all"],
});
```

如果收到的不是 `getLink`，就执行：

```js
chrome.contextMenus.removeAll();
```

也就是鼠标离开目标链接时把菜单删掉。

### 2. 点击右键菜单后开始解析

当用户点击 `myContextMenu` 时，触发：

```js
BiliAnalysis(link);
```

真正的解析流程在 `BiliAnalysis(url)` 中。

---

## `BiliAnalysis(url)` 的解析流程

### 1. 从链接里提取视频标识

函数先从 URL 中提取：

- `BV` 号
- 分 P 参数 `p`

主要用到两个正则：

```js
var BV = /BV[0-9A-Za-z]{0,99}/;
var P = /(?<=p=).*?(?=&vd)/;
```

逻辑大致是：

- 如果 URL 里有 `BV...`，直接匹配出来。
- 如果没匹配到，再尝试从 `bvid=...` 参数中提取。
- 如果没匹配到分 P，就默认 `P1 = 1`，即第一页。

### 2. 先查分页列表，拿到 `cid`

第一步请求的是：

```text
https://api.bilibili.com/x/player/pagelist?bvid=BV号
```

这个接口返回视频各分 P 的信息，其中每一 P 都会有一个 `cid`。

插件从结果里取：

```js
var cid = json.data[P1 - 1].cid;
```

说明它的思路是：

- 先定位到用户要的第几 P
- 再取出这一个分 P 对应的 `cid`

### 3. 再查播放地址

拿到 `cid` 后，第二次请求：

```text
https://api.bilibili.com/x/player/playurl?bvid=BV号&cid=cid&qn=116&type=&otype=json&platform=html5&high_quality=1
```

这个接口返回视频播放信息。

代码最终取的是：

```js
json.data.durl[0].url
```

也就是第一段播放地址。

这说明插件利用的是 B 站接口直接返回的播放链接，而不是自己拼接地址。

### 4. 复制到剪贴板

获得直链后，会调用：

```js
copyToClipboard(json.data.durl[0].url);
```

复制逻辑是经典做法：

1. 动态创建一个 `textarea`
2. 把文本写进去
3. 选中内容
4. 执行 `document.execCommand("copy")`
5. 删除临时节点

### 5. 显示通知

函数最后调用 `showNotification()`。

如果浏览器通知权限已经允许，就弹出“解析成功”。

---

## 这个插件为什么能“解析”

它能工作的关键不是本地算法，而是 **调用了哔哩哔哩的公开接口**：

- `x/player/pagelist`
- `x/player/playurl`

也就是说：

- `BV` 是视频唯一标识
- `cid` 是具体分 P / 分段的内容标识
- 拿到 `bvid + cid` 后，就能请求播放地址

所以它所谓的“解析”，实质上是：

**从页面链接中提取视频 ID，再借助 B 站接口换取真实播放 URL。**

---

## 原理总结

一句话总结：

**内容脚本负责发现视频链接，后台脚本负责创建右键菜单并调用 B 站 API，最终把返回的播放直链复制到剪贴板。**

更细一点可以分成三层：

- 页面感知层
  - `content.js` 识别鼠标悬停的元素是不是 B 站视频链接。
- 扩展交互层
  - `background.js` 通过消息机制保存链接、创建右键菜单、响应点击事件。
- 数据解析层
  - 调用 B 站接口，先拿 `cid`，再拿 `playurl`，最后提取 `durl[0].url`。

---

## 存在的问题和局限

从代码实现看，这个插件还能工作，但有一些明显局限：

### 1. 依赖旧版扩展规范

- 使用的是 `manifest_version: 2`
- 现在 Chrome 已逐步转向 Manifest V3

后续兼容性可能会有问题。

### 2. 分 P 正则不稳

```js
var P = /(?<=p=).*?(?=&vd)/;
```

这个写法假设 `p=` 后面一定跟着 `&vd`，但真实 URL 参数不一定总是这样，容易匹配失败。

### 3. 只取 `durl[0].url`

- 如果返回的是多段视频，只拿第一段。
- 没处理更复杂的 DASH 音视频分离结构。

### 4. 右键菜单创建和删除比较粗糙

- 鼠标一移动就不断发消息。
- 菜单反复创建、删除，效率一般。

### 5. 剪贴板方案偏旧

- 用的是 `document.execCommand("copy")`
- 这属于旧式 API，现代写法通常更推荐 Clipboard API。

### 6. 接口可用性受平台策略影响

如果 B 站后续调整接口权限、登录校验、签名逻辑或返回格式，这个插件就可能失效。

---

## 结论

这个扩展的核心原理并不复杂：

它不是去“破解”播放器，而是通过鼠标悬停识别视频链接，提取 `BV` 和分 P，再调用 B 站播放器接口获取对应的真实播放地址，最后把地址复制出来。

所以从技术本质上看，它更像是一个：

**“页面链接识别 + 浏览器扩展右键交互 + B 站接口转直链” 的小工具。**
