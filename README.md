# Quickfile

拖入文件，立即复制链接。后台继续上传，接收方可以立即开始下载。

一个 Go 可执行文件，内嵌原生 HTML/CSS/JavaScript。无数据库，文件和 `meta.json` 全部保存在数据目录中。WebRTC 直连与 HTTPS 暂存传输自动协调。分享者持续上传到服务器，因此上传完成后可以关闭网页。

## 运行

从 GitHub Actions 下载适合操作系统的二进制，或自行构建。

```sh
go build -trimpath -o quickfile .
./quickfile --listen :8080 --data ./data
```

支持 `QUICKFILE_LISTEN`、`QUICKFILE_DATA` 环境变量。浏览器端的 P2P、剪贴板和高级文件保存功能需要 HTTPS 或 localhost 安全上下文。

```sh
mkdir -p data
sudo chown 10001:10001 data
docker compose up -d
```

默认 Compose 将端口绑定到 `127.0.0.1:8080`。使用 HTTPS 反向代理发布服务。数据挂载到 `/data`，程序以 UID/GID `10001:10001` 运行。一个数据目录只允许一个 Quickfile 实例写入。

## 分享与领取

- 单文件最大 **10 GiB**。磁盘必须有足够空间，多个文件分别受此限制。
- 默认保留 **24 小时**，最多 **100 次领取**。可以选择 1、2、6、12、24 小时，以及 1、5、10、20、50、100 次。
- 到期时间从创建空间起算，时间和领取次数任一先满足就停止新领取。最后一次领取完成后清理，硬性到期会终止尚未完成的传输。
- 点击下载时预留一次领取。并行分片、网络重试及传输路径切换共用领取凭据，不重复计数。凭据在两分钟无活动后失效，中途放弃的领取仍占次数。
- 后台每 15 秒清理目录，启动时也会清理。未完成上传的空间同样到期删除。
- 上传使用最大 4 MiB 分片。上传暂停后可在最近空间中重新选择原文件，按服务器确认的偏移继续。
- 支持 File System Access 的浏览器以四路请求分段保存单文件，P2P 可用时直接接收，其他分片从服务器取得。网络中断自动重试，取消后可以重新领取下载。
- 其他浏览器交由原生下载器保存，接口支持 HTTP Range。多文件“下载全部”由服务器实时生成 ZIP，支持 ZIP64，不等待整个空间上传完成。
- 最近空间和上传凭据保存在当前浏览器的本地存储中。清除站点数据会丢失本地历史和继续上传的凭据，已分享链接在到期前仍有效。

P2P 使用公开 STUN 服务发现直连路径，不需要自建 TURN。直连失败或中途断开时自动使用已获授权的 HTTPS 数据路径。WebRTC 使用 DTLS，HTTPS 在反向代理终止。暂存文件以原始数据写入服务器磁盘，本版本没有客户端端到端加密。

## API

| 请求 | 用途 |
| --- | --- |
| `POST /api/spaces` | 提交 `{files:[{name,size}],hours,maxDownloads}`，立即获取空间和上传凭据 |
| `GET /api/spaces/{id}` | 获取文件列表及已上传偏移 |
| `PATCH /api/spaces/{id}/files/{index}` | 使用 `Authorization: Bearer <owner>`、`Upload-Offset` 追加分片 |
| `POST /api/spaces/{id}/claims` | 提交客户端随机生成的 48 位十六进制 `{token}`，原子预留领取次数，同 token 重试幂等 |
| `POST /api/spaces/{id}/heartbeat` | 使用领取凭据延长当前领取活动时间 |
| `GET /api/spaces/{id}/files/{index}` | 使用领取凭据及可选 `Range` 获取完整或部分文件，等待尚未上传的数据 |
| `GET /api/spaces/{id}/archive` | 使用领取凭据实时下载 ZIP |
| `POST /api/spaces/{id}/complete` | 完成领取，允许后台回收最后一次领取的文件 |
| `GET /api/spaces/{id}/ws` | 自动 P2P 的 WebSocket 信令 |
| `GET /healthz` | 健康状态和构建版本 |

下载凭据通常放在 `Authorization` 中，浏览器原生下载使用 `?claim=<token>`。请求和响应禁止缓存，页面禁止第三方脚本及 Referrer。上传和领取凭据在服务器元数据中保存 SHA-256 摘要。

## 发布

推送 `main` 时，GitHub Actions 构建 Linux/macOS/Windows 的 amd64、arm64 二进制，并发布 Linux amd64/arm64 Docker 镜像到 `ghcr.io/luodaoyi/quickfile`。二进制和 SHA-256 校验文件保存在 Actions Artifacts 中。推送 `v*` 标签时另行发布 GitHub Release。

镜像包含 `latest`、提交 SHA 和版本标签。GHCR 首次发布后，仓库所有者需要确保容器包可见性为 Public，才能匿名拉取。

界面按 Wormhole 的银河背景、半透明面板、上传框和按钮布局制作。银河纹理及标记来自其公开页面资源，背景使用随程序内嵌的 Three.js r135 绘制，其 MIT 许可证保存在 `web/THREE-LICENSE.txt`。

## Cloudflare

小分片上传用于兼容 Cloudflare 的单次请求大小限制。保持 WebSocket 可用并禁用 `/api/*` 缓存。反向代理必须关闭响应缓冲，上传大小至少允许 4 MiB。仓库提供 `deploy/Caddyfile` 和 `deploy/compose.public.yaml`，复制到 Compose 所在目录，运行 `docker compose -f compose.yaml -f compose.public.yaml up -d` 即可启用 `file.011f.com` 的 HTTPS 入口。该入口自动申请并续期证书，只允许 Cloudflare 官方地址段回源。DNS 应使用已代理的 A 记录指向源站，SSL/TLS 使用 Full (strict)。Cloudflare 官方地址段变化时需同步 Caddyfile。

当前部署位置为 `ssh ccs` 的 `/opt/quickfile`，数据为 `/opt/quickfile/data`。服务器由用户迁移为 Podman，使用 `podman-compose -f compose.yaml -f compose.public.yaml up -d --no-deps --force-recreate quickfile` 更新应用容器。保留已运行的 Caddy 容器及其证书卷。源站系统盘为 20 GiB，迁移后剩余约 13 GiB，实际可用容量随暂存文件变化。
