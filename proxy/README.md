# 段位代理服务（官方 API）

静态网页拿不到官方段位，原因是厂商密钥不能进前端包。所以段位要走一个单独的
只读代理：密钥放在那里，网页只调用它。

**没有这个代理，本站仍然可用**——段位会退回「自报」，并且页面上如实标注为自报。
本站不会假装能拉到官方数据。

## 为什么必须单独部署

| 厂商 | 密钥情况 |
|---|---|
| Riot（英雄联盟 / 瓦洛兰特） | 生产密钥 24 小时过期，绑定开发者账号 |
| Steam | 长期密钥，同样属于机密 |
| FACEIT | 需要开发者账号申请 |
| 王者荣耀（腾讯） | **没有公开接口**，只能企业合作获取 |

密钥一旦写进静态 JS，每个访客都能读到，几分钟内就会被爬走。所以它必须在服务端。

## 部署（Cloudflare Worker）

```bash
cd proxy
npx wrangler init fanverify-rank --type module
cd fanverify-rank
cp ../worker.js src/index.js

# 设置密钥（变成 Worker 的 secret，不会出现在代码里）
npx wrangler secret put RIOT_API_KEY
npx wrangler secret put ALLOWED_ORIGIN   # 填你站点的域名

npx wrangler deploy
```

部署完会得到一个地址，例如 `https://fanverify-rank.<sub>.workers.dev`。

## 接进站点

拿到地址后，在站点里设置一次即可（存在浏览器本地）：

```js
localStorage.setItem('fanverify.v2.proxyUrl', 'https://fanverify-rank.<sub>.workers.dev');
```

或者直接改 `web/js/store.js` 里 `proxyUrl` 的默认值。

接上之后，报段位页面的「从官方接口拉取」按钮会启用，拉到的记录来源标为
**官方接口**；没接上时只能自报，标为 **自报**。两种都不会被混为一谈。

## 接口约定

```
POST /rank
{ "gameId": "league-of-legends", "accountId": "riot-7788" }

200
{ "tier": "璀璨钻石", "queue": "单双排", "provider": "riot", "capturedAtMs": 1760000000000 }
```

`GET /health` 返回当前是否已配置密钥。

`proxy/worker.js` 里留了 Riot 账号查询的位置和说明。真实实现需要粉丝先通过
Riot Sign On 完成授权，代理拿授权令牌换取段位，**且绝不把令牌返回给浏览器**。

## 顺带一提：时间锚

同一个代理也可以承担时间锚（`core/anchor.js` 里的 `serverAnchor`），
让「是否赛前」不再依赖用户本机时钟。那需要一个会单调递增的写入端点。
OpenTimestamps（比特币）则不需要任何服务器，代价是确认要等几分钟到几小时。
