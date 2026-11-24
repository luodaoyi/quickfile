# Quickfile

简体中文 | [English](README.en.md)

[![Build and publish](https://github.com/luodaoyi/quickfile/actions/workflows/build.yml/badge.svg)](https://github.com/luodaoyi/quickfile/actions/workflows/build.yml)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

拖入文件，立即复制链接。后台继续上传，对方可以在上传完成前开始接收。

Quickfile 是一个内嵌前端的 Go 文件分享服务。一个可执行文件、一个数据目录即可运行，支持 WebRTC 直连和服务器暂存，自动选择传输路径。

**[立即使用在线站点 → file.011f.com](https://file.011f.com/)**

无需安装或注册。打开网页，选择文件，把链接发给对方即可。也可以[下载二进制](https://github.com/luodaoyi/quickfile/releases/latest)或使用容器自行部署。

![Quickfile 桌面界面：银河背景、半透明上传面板与文件分享入口](docs/images/desktop.png)

<details>
<summary>查看手机界面</summary>

<img src="docs/images/mobile.png" width="320" alt="Quickfile 手机界面，支持文件选择与语言切换">

</details>

## 能做什么

| 功能 | 说明 |
| --- | --- |
| 即时分享 | 选好文件就生成链接，支持单文件和多文件 |
| 边传边下 | 接收方可以读取已经上传的数据，继续等待后续分片 |
| 自动直连 | 发送方在线时尝试 WebRTC P2P，直连不可用时使用 HTTPS 暂存路径 |
| 稍后领取 | 文件上传完成后，发送方可以关闭网页 |
| 分片与续传 | 4 MiB 上传分片，支持恢复上传、HTTP Range 和断点下载 |
| 并行下载 | 支持文件写入接口的浏览器使用四路分片保存单文件 |
| 多文件打包 | “下载全部”由服务器实时生成 ZIP，支持 ZIP64 |
| 自动删除 | 默认 24 小时或 100 次领取，先满足的条件生效 |
| 简单界面 | 银河动画、半透明面板、中英文切换和浏览器本地空间列表 |
| 单文件部署 | 前端随 Go 二进制分发，无数据库，无需 Node.js 运行时 |

**单文件上限为 10 GiB。** 多个文件分别受此限制，服务器需要有足够的剩余磁盘空间。

## 怎么使用

1. 打开 [file.011f.com](https://file.011f.com/)，拖入一个或多个文件。
2. 点击“复制链接”，发送给接收方。此时文件会继续上传。
3. 接收方打开链接即可下载，无需等待整个文件上传完成。

上传过程中请保留发送页面。右侧显示上传完成后，即使关闭网页，接收方仍可在有效期内领取。上传中断时，在“最近的空间”中重新选择原文件即可继续。

## 自行部署

### 使用二进制

从 [Releases](https://github.com/luodaoyi/quickfile/releases/latest) 下载对应文件。每个平台均提供 SHA-256 校验文件。

| 系统 | x86-64 / amd64 | ARM64 |
| --- | --- | --- |
| Linux | [下载](https://github.com/luodaoyi/quickfile/releases/latest/download/quickfile-linux-amd64) | [下载](https://github.com/luodaoyi/quickfile/releases/latest/download/quickfile-linux-arm64) |
| macOS | [下载](https://github.com/luodaoyi/quickfile/releases/latest/download/quickfile-darwin-amd64) | [下载](https://github.com/luodaoyi/quickfile/releases/latest/download/quickfile-darwin-arm64) |
| Windows | [下载](https://github.com/luodaoyi/quickfile/releases/latest/download/quickfile-windows-amd64.exe) | [下载](https://github.com/luodaoyi/quickfile/releases/latest/download/quickfile-windows-arm64.exe) |

Linux / macOS 示例，将下载的文件重命名为 `quickfile` 后运行。

```sh
chmod +x quickfile
./quickfile --listen :8080 --data ./data
```

Windows 可直接运行下载的 EXE，或在 PowerShell 中指定目录。

```powershell
.\quickfile-windows-amd64.exe --listen :8080 --data .\data
```

本机访问 [http://localhost:8080](http://localhost:8080)。公网部署请配置 HTTPS，以启用直连、剪贴板和浏览器文件保存功能。

### Docker Compose

镜像为 `ghcr.io/luodaoyi/quickfile:latest`，支持 Linux amd64 和 arm64。以下示例适用于 Linux Docker。

```sh
git clone https://github.com/luodaoyi/quickfile.git
cd quickfile
mkdir -p data
sudo chown 10001:10001 data
docker compose up -d
```

仓库内的 [compose.yaml](compose.yaml) 将 `./data` 挂载到 `/data`，以 UID/GID `10001:10001` 运行，并将端口绑定到 `127.0.0.1:8080`。数据目录必须可由该用户写入。

### Podman Compose

同一份 Compose 配置也可使用 `podman-compose` 运行。Rootful Podman 沿用上面的数据目录权限设置。

```sh
podman-compose up -d
```

使用 Rootless Podman 时，在首次启动前，创建由当前用户拥有的数据目录并设置 UID/GID 映射。

```sh
mkdir -p data
podman unshare chown 10001:10001 data
podman-compose up -d
```

更新镜像时可使用以下命令。

```sh
podman pull ghcr.io/luodaoyi/quickfile:latest
podman-compose up -d --no-deps --force-recreate quickfile
```

### HTTPS 和 Cloudflare

可以使用自己的 HTTPS 反向代理。仓库也提供了 [Caddyfile](deploy/Caddyfile) 和 [Compose 扩展](deploy/compose.public.yaml)，包含证书自动申请、流式转发和 Cloudflare 来源地址限制。

自行部署时，将示例中的 `file.011f.com` 换为自己的域名，再将两个文件复制到 `compose.yaml` 所在目录。

```sh
docker compose -f compose.yaml -f compose.public.yaml up -d
# Podman 使用 podman-compose 替换 docker compose
```

该示例需要将 DNS 设为指向源站的已代理 A 记录，Cloudflare SSL/TLS 使用 **Full (strict)**。保持 WebSocket 可用，禁用 `/api/*` 缓存，反向代理关闭响应缓冲，并允许至少 4 MiB 的请求正文。Cloudflare 官方地址段变化时，需要同步 Caddyfile。

## 配置与数据

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--listen` | `QUICKFILE_LISTEN` | `:8080` |
| `--data` | `QUICKFILE_DATA` | `./data`，容器内为 `/data` |
| `--version` | — | 输出构建版本并退出 |

每个空间在数据目录中保存一份 `meta.json` 和各文件的数据。一个数据目录只允许一个 Quickfile 实例写入。

分享设置支持以下选项。

| 项目 | 可选值 | 默认值 |
| --- | --- | --- |
| 保留时间 | 60 分钟、2、6、12、24 小时 | 24 小时 |
| 最多领取 | 1、5、10、20、50、100 次 | 100 次 |

- 有效期从空间创建时起算。到期后停止传输并清理，包括未完成上传的空间。
- 点击下载时预留一次领取。分片、重试和传输路径切换共用凭据，不重复计数。中途取消仍占一次领取。
- 最后一次领取完成后允许清理。领取凭据在两分钟无活动后失效，后台每 15 秒扫描一次，程序启动时也会清理。
- 最近空间和上传凭据保存在当前浏览器的本地存储中。清除站点数据会丢失本地记录和继续上传的凭据。

## 传输与隐私

单文件下载自动使用 WebRTC 直连或 HTTPS。P2P 通过公开 STUN 服务发现路径，无需自建 TURN。发送方会同时把文件上传到服务器，以便之后离线领取。多文件 ZIP 由服务器生成并传输。

WebRTC 使用 DTLS，公网访问通过 HTTPS。**暂存文件以原始数据保存在服务器磁盘上，当前版本没有客户端端到端加密。** 分享链接应只交给预期的接收方。

支持 File System Access 的浏览器可四路分段写入磁盘，其他浏览器使用原生下载器。具体的文件保存和续传体验取决于浏览器支持。

## 构建与发布

源码构建需要 Go 1.26 或更新版本。

```sh
go build -trimpath -o quickfile .
```

[GitHub Actions](https://github.com/luodaoyi/quickfile/actions/workflows/build.yml) 在推送 `main` 时构建六个平台的二进制，以及 Linux amd64/arm64 容器镜像。二进制和校验文件保存在 Actions Artifacts 中。推送 `v*` 标签时，自动发布 GitHub Release 和对应版本的容器镜像。

健康接口为 `GET /healthz`，返回服务状态和构建版本。

## API

| 请求 | 用途 |
| --- | --- |
| `POST /api/spaces` | 提交 `{files:[{name,size}],hours,maxDownloads}`，立即获取空间和上传凭据 |
| `GET /api/spaces/{id}` | 获取文件列表和已上传偏移 |
| `PATCH /api/spaces/{id}/files/{index}` | 使用上传凭据和 `Upload-Offset` 追加分片 |
| `POST /api/spaces/{id}/claims` | 提交随机的 48 位十六进制 `{token}`，预留领取次数，同 token 重试幂等 |
| `POST /api/spaces/{id}/heartbeat` | 延长当前领取的活动时间 |
| `GET /api/spaces/{id}/files/{index}` | 下载完整文件或 `Range` 指定的部分，等待尚未上传的数据 |
| `GET /api/spaces/{id}/archive` | 实时下载 ZIP |
| `POST /api/spaces/{id}/complete` | 完成领取 |
| `GET /api/spaces/{id}/ws` | WebSocket P2P 信令 |

上传和领取凭据通常使用 `Authorization: Bearer <token>`，浏览器原生下载使用 `?claim=<token>`。服务端元数据保存凭据的 SHA-256 摘要。分享请求和响应禁止缓存，页面禁用 Referrer，并只加载随程序提供的脚本。

## 协议与致谢

本项目代码和自行编写的文档采用 [MIT 协议](LICENSE)。

界面参考 [Wormhole](https://wormhole.app/)。银河纹理与标记来自其公开页面，这些素材的权利归原作者，项目的 MIT 授权不覆盖这些第三方素材。背景使用 Three.js r135 绘制，保留其 [MIT 许可证](web/THREE-LICENSE.txt)。
