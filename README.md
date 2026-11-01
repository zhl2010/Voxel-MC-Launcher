# Voxel Launcher

一个用 **HTML / CSS / JavaScript** 编写界面、由 **Electron 主进程 + [eml-lib](https://github.com/Electron-Minecraft-Launcher/EML-Lib)** 完成下载与启动的 Minecraft: Java Edition 启动器。界面采用灰白工业风：直角面板、点阵网格、等宽字标注和单色像素头像，并提供深色、亮色两套外观。

| 深色模式（默认） | 亮色模式 |
| --- | --- |
| ![深色模式](docs/screenshot-home.png) | ![亮色模式](docs/screenshot-light.png) |

## 功能

- **硬朗工业风界面**：以石墨黑、钢灰和骨白为主，使用直角、细边框、工业网格和无柔光的组件；失败提示保留少量暗红语义色。
- **深色 / 亮色模式**：默认深色工业主题，可在「启动设置 → 界面与主题」切换到亮色模式；工作区、面板、表单、版本库、模组工坊和登录弹窗都会切换为亮色表面与深色文字。
- **Minecraft 版本库**：从 Mojang 官方清单同步正式版、快照和远古版本，支持搜索、筛选、已安装标记。
- **模组加载器**：Vanilla、Fabric、Quilt、Forge、NeoForge。自动从各加载器官网选择对应 Minecraft 版本的最新稳定构建。
- **模组工坊**：通过 Modrinth 搜索适配当前版本与加载器的模组，一键下载到实例的 `mods` 文件夹，并列出已安装文件。
- **自定义游戏目录 / 本地版本**：通过「启动设置 → 存储位置」浏览或输入任意绝对路径，版本、模组、存档、资源包、光影、日志、崩溃报告和 Java 运行时都会跟随新目录；会扫描 `versions` 下的本地自定义版本（如 PCL 的 `1.21.1-Fabric 0.20.0`、`RLCraft`）并支持直接启动。也可以把只读 PCL 的某个版本导入到可写实例目录。
- **真正可用的下载与启动**：由 eml-lib 校验文件、下载游戏资源、安装加载器、自动安装匹配的 Java 运行时，并启动游戏。
- **账户**：离线账户、Microsoft 正版账户，以及 LittleSkin / 其他 Yggdrasil 兼容服务器登录。LittleSkin 默认地址为 `https://littleskin.cn/api/yggdrasil/authserver`；登录会话通过 Electron `safeStorage` 保存在本机（系统支持时加密），重启自动恢复，退出账户会清除。
- **启动进度**：实时展示阶段、当前文件组、已下载大小、速度与百分比；可以折叠，不阻塞浏览版本库。启动过程中可以点击「取消启动」中断下载和启动流程。
- **启动设置**：内存上下限、游戏窗口尺寸、全屏、Java 自动/手动、JVM 参数。
- **网络与镜像**：可配置 HTTP / HTTPS 代理（同时作用于启动器元数据与 eml-lib 下载），并可分别开关 Mojang、Fabric、Forge、NeoForge 的 BMCLAPI 镜像；请求超时 10 秒并自动重试 2 次，镜像失败自动回退官方源。
- **本地实例解析**：实例的原版版本从 `version.json` / `*_instance.json` / PCL `PCL\Setup.ini` / `inheritsFrom` 读取，不再根据文件夹名猜版本；解析不到时会明确提示「无法解析本地实例的原版版本」。
- **强制本地启动**：开启后，带本地元数据的实例跳过官方清单查询，直接用本地 JSON 和已有文件启动（适合 1.7.10 Forge / OptiFine 整合包）。
- **日志脱敏**：访问令牌、`accessToken` / `clientToken` / `refreshToken` 和 JWT 在写入日志前会被替换为 `[REDACTED]`。
- **运行日志**：下载、Java 检测、游戏 stdout/stderr 实时汇入会话控制台，可复制或打开 `latest.log`。
- **桌面体验**：无边框窗口、自定义标题栏、单实例锁、原生目录选择器、游戏目录快捷入口。
- **安全边界**：`contextIsolation` + 沙箱 preload + 白名单 IPC + CSP，渲染进程没有 Node.js 权限，也不会拿到账户令牌。
- **可调主题**：默认骨白工业风，可在设置中选择黄铜、冰蓝、赤铜、苔绿、紫灰，或用取色器自定义强调色；亮色模式会自动把强调色加深到对比安全的深色变体。
- **界面缩放**：页面缩放通过 Electron 原生 zoom 调整整个窗口；字体大小通过 rem 根字号独立缩放，不改变面板尺寸。

| 版本库 | 模组工坊 |
| --- | --- |
| ![版本库](docs/screenshot-versions.png) | ![模组工坊](docs/screenshot-mods.png) |

![界面与主题设置](docs/screenshot-settings.png)

## 快速开始

需要 **Node.js 22.12+**（推荐 Node.js 24）和 Windows 10/11、macOS 10.15+ 或主流 Linux 桌面。

```bash
npm install
npm start
```

Windows 用户也可以直接双击项目根目录的 `start.bat`：它会检查依赖并启动启动器。

**启动方法**：直接双击 `start.bat` 启动。若启动不了版本，先关掉启动器，再右键 `start.bat` 选择「以管理员身份运行」。

开发模式：

```bash
npm run dev
npm run devtools
```

`npm run devtools` 会打开 Electron DevTools。

### start.bat 启动说明

`start.bat` 现在会保留控制台窗口并显示退出码，不会再一闪而过。如果 Electron 在某些受限 Windows 会话中立即退出，启动包装脚本会自动重试兼容模式：

- 使用 `--no-sandbox --disable-gpu` 规避 Chromium 沙箱/图形环境导致的启动失败；
- 使用项目下的 `.launcher-user-data` 作为本地配置目录，避免无法写入 `%APPDATA%\Voxel Launcher` 时反复失败。

兼容模式只在普通启动失败后使用。界面本身仍启用 `contextIsolation`、沙箱 preload、CSP 和 Node 权限隔离。如果兼容模式仍失败，控制台会保留错误码和日志，请把输出发回以便继续排查。

> 在中国大陆网络下载 Electron 二进制较慢时，可以先设置镜像：
>
> ```bash
> npm config set electron_mirror https://npmmirror.com/mirrors/electron/
> npm install
> ```

## 使用说明

1. 在游戏大厅点击账户卡片。可以输入 3–16 位离线用户名，使用 Microsoft 正版账户，或切换到「LittleSkin / 第三方」填写 Yggdrasil 服务器、账号和密码。
2. 点击「切换版本」进入版本库，选择 Minecraft 版本与加载器（Vanilla、Fabric、Quilt、Forge、NeoForge）。
3. 打开「模组工坊」：选择带模组加载器的版本后，搜索 Modrinth，点击「安装」即可把文件下载到当前实例的 `mods` 文件夹。
4. 回到大厅，点击「开始游戏」。首次启动会下载 Java 运行时、运行库和游戏资源，耗时取决于网络。
5. 下载进度会显示在右下角。下载完成后 eml-lib 会安装加载器、校验 Java 并启动游戏。
6. 在「启动设置 → 界面与主题」中切换深色 / 亮色模式，调整页面缩放、字体大小和主题强调色；所有改动自动保存。
7. 在「启动设置 → 存储位置」中可以修改游戏目录，并直接打开版本、模组、存档、资源包、光影、日志、崩溃报告和启动器配置目录。PCL 版本可以用「导入 PCL 版本」复制到可写实例目录；启动过程中如果想停止，点击「取消启动」。

### 数据位置

默认情况下，游戏安装在应用数据目录下名为 `VoxelLauncher` 的根目录中：

- Windows：`%APPDATA%\.minecraft`
- macOS：`~/Library/Application Support/minecraft`
- Linux：`~/.minecraft`

- 默认模组文件夹：`%APPDATA%\.minecraft\mods`（macOS / Linux 对应游戏目录下的 `mods`）

启动器自己的配置和版本清单缓存位于 Electron 的 `userData` 目录，这个目录不随游戏目录移动。登录会话保存在 `userData/account-session.json`，优先使用 Electron `safeStorage` 加密（Windows 使用 DPAPI）；离线用户名、设置项、游戏目录和 Java 路径也都会持久化。导入的 PCL 实例默认放在 `userData/instances/` 下。可在「启动设置 → 存储位置」直接打开游戏目录、模组目录或日志目录。

> 默认使用独立目录是为了不污染官方启动器的 `.minecraft`。现在也可以主动把游戏目录改为现有的 `.minecraft`。eml-lib 的文件清理已关闭，避免误删玩家自行放入的模组、存档或资源包。Modrinth 安装器会在 `mods/.voxel-mods.json` 记录项目与文件的对应关系，便于在列表中显示“已安装”。

修改游戏目录不会自动搬移旧目录里的文件。切换后新目录可以是一个空文件夹，启动游戏时会重新下载所需资源；也可以指向已有的游戏目录。正在启动、运行游戏或安装模组时不能切换目录。

### 使用 PCL 或其他启动器的游戏目录

可以把之前 PCL、官方启动器或其他启动器的**游戏目录**直接填进「修改游戏目录」：

- 应该选择包含 `versions`、`assets`、`libraries`（通常还有 `mods`、`saves`）的目录，例如 `%APPDATA%\.minecraft`，或 PCL 文件夹里的 `.minecraft`。
- 不要选择只包含 `PCL.exe`、PCL 配置或 Java 运行时的 PCL 安装目录；那不是 Minecraft 游戏目录。
- 不要直接选择 `Program Files` 下的游戏目录：普通用户通常只有读取权限，启动器无法写日志、存档或下载文件。请先把 `.minecraft` 复制到 `D:\PCL2\.minecraft` 等可写位置；或者给当前用户授予该目录的“修改”权限（不建议直接改 Program Files）。
- 版本库会扫描 `gameDir/versions` 下的本地 JSON；PCL 的 `1.21.1-Fabric 0.20.0`、`26.2-NeoForge_...`、`RLCraft` 等自定义版本名会作为「本地」版本显示，并可通过本地 manifest 直接启动。需要 `versions` 目录可写，才能写日志、存档和下载文件；`Program Files` 下的只读目录仍然不能直接启动。
- 原版版本号来自实例元数据，而不是文件夹名：依次读取 `versions\<实例>\version.json`、`<实例>_instance.json`、版本 JSON 的 `inheritsFrom`，以及 PCL 的 `PCL\Setup.ini`（`VersionVanillaName` / `VersionForge` / `VersionFabric` / `VersionNeoForge` / `VersionQuilt`）。Forge / Fabric / OptiFine 的库与主类直接使用本地 JSON，不再远程匹配。都读不到时会显示「无法解析本地实例的原版版本」。
- PCL 开启「版本隔离」时，某个版本的 `mods`、`saves`、`options.txt` 可能位于 `.minecraft\versions\<版本名>\` 下。选择整个 `.minecraft` 时，启动器的游戏目录是根目录，只会读取根部的 `mods` / `saves`；如果版本库里的本地版本能启动但存档/模组不对，请使用导入功能或把该版本目录作为游戏目录。
- 如果只想使用某一个 PCL 隔离实例，推荐点击「导入 PCL 版本」：选择 PCL 的 `versions\<版本名>` 文件夹，启动器会把它复制到 `userData/instances/` 下的可写实例目录，把版本 JSON/JAR 放入新实例的 `versions\<版本名>\`，并把 `mods`、`saves`、`config` 等留在实例根目录。导入完成后版本库会直接出现该本地版本，选择即可启动。
- PCL 的账户不会被导入，需要在 Voxel 里重新登录。若不想重新下载 Java，可在「Java 运行时」选择手动模式，指向 PCL 的 `java.exe`。
- 不要让 PCL 和 Voxel 同时对同一个游戏目录执行启动/安装操作；切换前先关闭正在运行的游戏。本地版本会直接使用其 JSON 中记录的加载器和库；如果改用“基础版本 + 加载器”方式，精确版本可能与自动选择的最新稳定版不同，使用前请备份实例。

### 网络、代理与镜像

「启动设置 → 网络与镜像」提供：

- **HTTP / HTTPS 代理**：例如 `http://127.0.0.1:7890`。代理会通过 undici `ProxyAgent` 同时作用于启动器元数据请求和 eml-lib 的游戏资源下载；留空为直连。
- **镜像开关**：Mojang 资源、Fabric、Forge、NeoForge 分别开关，默认全部启用 BMCLAPI（`bmclapi2.bangbang93.com`）。镜像按域名映射：Mojang 资源 → `/assets`，运行库 → `/maven`，Fabric Meta → `/fabric-meta`，Forge / NeoForge Maven → `/maven`。
- **兜底策略**：每个请求先走镜像（GET 和 HEAD 都覆盖），遇到网络错误、超时或 404 / 5xx 自动回退官方源；版本清单这类小文件则优先官方、镜像兜底。响应头等待上限 15 秒，`fetchJson` 超时 10 秒并自动重试 2 次。
- **eml-lib 的 HEAD 探测**：eml-lib 的 `getRemoteFileSize()` / `getRemoteFileSha1()` 会发出不带超时的 HEAD 请求，直连 Maven 时可能卡住 1 分多钟。启动器通过 `src/main/eml-runtime.js` 给这两个函数加了 10 秒硬超时，并在超时后改用镜像探测（日志里会打印 `PROBE HEAD ... [mirror of ...]`）。实测 Fabric Maven 直连 HEAD 10 秒超时，镜像 HEAD 约 0.3 秒。
- **强制本地启动**：勾选后，带本地元数据（PCL `Setup.ini`、`*_instance.json` 或非原版加载器）的实例不再请求官方清单，直接用本地 JSON 启动。缓存中已有的官方版本仍走正常流程。

> 镜像的 JSON 文档（版本清单、资源索引）会重定向到签名下载节点，响应体是分块传输且没有 `Content-Length`，eml-lib 之后的重放请求容易超时；启动器会把这类 JSON 先缓冲再交给 eml-lib，并记住实际命中的镜像地址供后续 `fetch(new Request(url))` 复用。

### 本地实例如何被启动

eml-lib 2.7.4 有三处会直接导致本地版本启动失败的行为，启动器在 `src/main/eml-runtime.js` 里对它们做了补丁（不修改 `node_modules`，通过绝对 file URL 拿到 eml-lib 已加载的同一批模块再打补丁）：

1. **丢弃 `manifestUrl`**：`Launcher.setMinecraft()` 与 `loader.updateMinecraftConfig()` 对 vanilla 加载器会丢掉 `manifestUrl`，随后 `getMinecraftManifestUrl()` 拿实例名（如 `1.12.2-Forge_14.23.5`）去查 Mojang 清单，报 `not found in manifest`。补丁让它们保留 `manifestUrl`，并让 `getMinecraftManifestUrl()` 对任意加载器优先返回它；Forge / NeoForge 在使用本地 manifest 时跳过 installer 读取。
2. **无超时的 HEAD 探测**：`getRemoteFileSize()` / `getRemoteFileSha1()` 没有超时，直连 Maven 时会长时间卡住。补丁加 10 秒硬超时并改用镜像探测。
3. **缺少 `--userProperties`**：eml-lib 用账户的 `userProperties` 渲染 `${user_properties}`，离线账户为空时该参数会被丢掉，而 1.7.10–1.12.2 的 `Main` 要求它是必填项，游戏会以 `MissingRequiredOptionException` 退出。补丁在参数里补齐 `--userProperties {}`。
4. **版本缓存写入失败会中断启动**：`FileManager.getLibraries()` / `getLoaderLibraries()` 每次都往 `<root>/versions/<id>/<id>.json` 写一份副本，写不进去就抛 `Failed to write Minecraft manifest: EPERM ...`。isolated 实例的 `root` 会解析到启动器配置目录（`%APPDATA%\.minecraft`），该写入可能被锁或被安全软件拦截。处理方式：
   - `FileManager` 打补丁：写入失败只记一条 WARN（`版本缓存写入失败，已跳过并继续启动：...`），启动继续；
   - isolated 启动时把 `root` 重定向到 `<gameDir>/cache`，版本副本写到 `<gameDir>/cache/versions/`，不再碰系统 AppData。

另外还处理了两个 Windows / 国内网络相关的问题：

- **命令行过长**：PCL 的 `libraries` 目录包含其他版本的库，classpath 可达约 115 000 字符，超过 Windows 32 767 的限制，`spawn` 会报 `ENAMETOOLONG`。Java 8 **不支持** `@argfile`（实测 `java @file -version` 直接报找不到主类），所以超过 30 000 字符时改用 **classpath 清单 jar**：启动器在 `<gameDir>/libraries/voxel-classpath.jar` 里写入 `Class-Path:` 清单，classpath 只保留前 200 个条目加这个 jar，Java 8 启动时会展开清单里的全部路径。`-javaagent`（authlib-injector）和 `-D` 参数始终位于 `-cp` 之前。
- **镜像的 JSON 文档**：BMCL 会把清单/资源索引重定向到分块传输的下载节点，eml-lib 之后用 `fetch(new Request(url))` 重试会丢失镜像地址并超时；启动器会先缓冲这类 JSON 并复用实际命中的镜像地址。
- **authlib-injector 不能直接当 `-javaagent`**：eml-lib 用 `yazl` 下载 injector（zip 容器），但把文件路径直接写进 `-javaagent`，Java 会报 `Error opening zip file or JAR manifest missing`。Yggdrasil（LittleSkin）启动时，启动器把 zip 解包到 `<gameDir>/cache/authlib-injector/<token>/`，并把 `-javaagent` 指向该目录（Java 9+ 支持目录形式的 agent），日志会打印「-javaagent 已指向解包目录」。

另外，PCL 的 1.7.10 / LiteLoader 版本 JSON 里有 `serverreq: true`、没有 `downloads` 的库（launchwrapper、lzma、asm-all、Forge universal 等）。eml-lib 的 `formatLibraries()` 会直接 `return null` 丢掉它们，导致 Forge 在游戏窗口出现前崩溃。启动器在把 JSON 交给 eml-lib 之前（以及服务给 eml-lib 的本地 manifest 里）统一做兼容处理：

- 给这些在 `<gameDir>/libraries` 里真实存在的 jar 补上 `downloads.artifact`（日志：「已补全 N 个本地运行库」）；
- guava 统一到 17.0：本地 JSON 同时写了 15.0（官方）和 17.0（`serverreq`），eml-lib 只会保留其中一个，因此只留下 17.0（日志：「guava 已统一为 17.0（移除 15.0）」）。缺少 17.0 的 jar 时会在日志里明确提示。

启动日志会打印最终命令：`Java 可执行文件`、`classpath 共 N 个条目`、逐条 `cp[i] 路径`，以及 `关键运行库`（forge / launchwrapper / asm-all / lzma / guava）命中的条目，方便直接确认 classpath 内容。

需要知道的行为：

- 启动时 eml-lib 会把本地 JSON 写回 `versions/<实例>/<实例>.json`（内容就是合并后的版本 JSON），并按其内容校验运行库与资源。
- 本地实例缺少的加载器文件需要先由 PCL 装好；启动器不会自动下载 Forge installer（eml-lib 的 Forge `meta.json` 依赖官网地址，1.7.10 的 Maven 路径还需要 `-1.7.10` 后缀）。
- 1.7.10 / 1.12.2 这类 LaunchWrapper 版本需要 **Java 8**：Java 9+ 会在 `launchwrapper.Launch` 初始化时抛出 `AppClassLoader cannot be cast to URLClassLoader`。请在「Java 运行时 → 手动指定」里选择 `jre1.8.x\bin\java.exe`。

### 日志脱敏

启动日志（包括错误详情、IPC 错误和未处理异常）会先把 `accessToken`、`clientToken`、`refreshToken`、`password`、`Authorization: Bearer ...`、JWT 和 `eyJ...` 令牌替换为 `[REDACTED]` 再输出。公开日志或提交 issue 前仍然建议再检查一遍。

## 项目结构

```text
.
├─ src/
│  ├─ main.js                  Electron 入口、窗口、IPC、目录白名单
│  ├─ preload.cjs              contextBridge 白名单 API
│  ├─ main/
│  │  ├─ config-store.js       设置持久化与参数校验
│  │  ├─ session-store.js      账户会话加密持久化
│  │  ├─ instance-metadata.js  本地实例元数据（version.json / PCL Setup.ini / inheritsFrom）
│  │  ├─ version-service.js    Mojang 版本清单、本地版本扫描、磁盘缓存
│  │  ├─ loader-service.js     Fabric / Quilt / Forge / NeoForge 元数据
│  │  ├─ mod-service.js        Modrinth 搜索、兼容文件下载、mods 扫描
│  │  ├─ game-service.js       eml-lib Launcher、账户、进度事件
│  │  ├─ network.js            代理、BMCLAPI 镜像映射与官方源兜底
│  │  ├─ redact.js             日志与错误中的令牌脱敏
│  │  └─ fetcher.js            带超时/重试的 JSON / XML 请求与友好错误
│  └─ renderer/
│     ├─ index.html            界面结构
│     ├─ styles.css            视觉与动画
│     └─ app.js                页面状态、IPC 调用、进度与日志
├─ assets/                     应用图标
├─ docs/                       README 截图
├─ scripts/start.mjs           跨环境 Electron 启动包装
├─ scripts/make-icon.py        图标生成脚本（Pillow）
├─ start.bat                   Windows 双击启动
└─ package.json
```

## 实现原理

```text
HTML 界面（渲染进程）
    │  只发送白名单动作，不接触 Node.js
    ▼
preload.cjs（contextBridge / IPC）
    ▼
Electron 主进程
    ├─ Mojang version_manifest_v2.json  → 版本选择器
    ├─ Fabric / Quilt / Forge / NeoForge 元数据 → 加载器版本
    ├─ Modrinth API v2                 → 模组搜索、兼容文件下载
    ├─ eml-lib Launcher                → 校验、下载、Java、启动
    └─ YggdrasilAuth / MicrosoftAuth   → 第三方账户 / 正版账户
```

- 版本选择器读取 Mojang 官方清单，并缓存到磁盘；断网时使用最后一次缓存。
- Fabric、Forge、NeoForge 元数据优先访问官方源，失败时会回退到 BMCLAPI 镜像（仅元数据查询，不改变 eml-lib 的下载地址）。
- 渲染进程不会直接访问网络：`connect-src 'none'`，所有远程请求都在主进程完成。
- 点击启动后，主进程构造 `new Launcher({...})` 并调用 `launcher.launch()`。`launch()` 会一直等到游戏退出，因此启动请求本身立即返回，后续状态通过 `launch_*`、`download_progress`、`launch_data` 等事件推送给界面。
- 离线账户由 `CrackAuth` 生成，Microsoft 登录由 `MicrosoftAuth` 完成，LittleSkin / 自定义服务器由 `YggdrasilAuth` 完成；`eml-lib` 负责 Xbox Live、Minecraft Services 和 authlib-injector 链路。
- Modrinth 下载走主进程：先查询匹配当前版本和加载器的项目版本，选择主文件、校验哈希，再写入 `mods` 文件夹。当前所有版本共享这个 `mods` 目录，切换版本前请移除不兼容的模组。
- 页面缩放使用 `webContents.setZoomFactor`；字体缩放把 CSS 字号统一为 rem，并通过根字号变量独立缩放。
- 游戏进程以 detached 方式运行；关闭启动器不会杀掉游戏。

## 第三方 / LittleSkin 登录

账户中心默认提供 LittleSkin 的 Yggdrasil 基础地址：

```text
https://littleskin.cn/api/yggdrasil/authserver
```

也可以把「Yggdrasil 服务器」改成其他兼容 Yggdrasil 协议的服务地址（例如自建的 Blessing Skin / Drasl）。启动器会：

1. 在主进程向该地址请求会话，不把密码写入配置或日志。
2. 若账户有多个角色，自动选择第一个角色（当前界面暂未提供角色选择器）。
3. 启动时由 eml-lib 自动注入 authlib-injector，使皮肤和验证走第三方服务器。
4. 会话只保留在内存中，关闭启动器后失效。

## 自定义 Microsoft 登录

eml-lib 内置了一个公共 Microsoft OAuth Client ID。若要使用自己的 Azure 应用，可在启动前设置：

```powershell
$env:VOXEL_MSA_CLIENT_ID = "你的 Azure Application (client) ID"
npm start
```

```bash
VOXEL_MSA_CLIENT_ID=你的ClientID npm start
```

## 说明与限制

- 这是非官方启动器，与 Mojang Studios、Microsoft 或 Electron 无关。Minecraft 是 Mojang Studios 的商标。
- 离线模式仅适用于离线服务器和本地测试，不提供正版验证。
- Microsoft 账户需要拥有 Minecraft: Java Edition；Microsoft 和 LittleSkin / Yggdrasil 登录令牌仅在本次运行期间保留，重启后需要重新登录。
- LittleSkin 账户有多个角色时，当前版本会自动选择第一个角色。
- 版本库 UI 提供 Vanilla、Fabric、Quilt、Forge、NeoForge。各加载器的版本列表来自对应服务；如果 Fabric Meta、MinecraftForge 或 NeoForged Maven 无法访问，对应选项会暂时隐藏。
- Modrinth 安装器下载的是所选模组的主文件，不会自动解析并安装所有依赖。例如 Fabric 下使用大多数模组仍需要手动安装 Fabric API，Forge/NeoForge 下也请按模组说明补齐前置。
- 当前所有 Minecraft 版本共享同一个 `mods` 文件夹；切换版本或加载器前，请移除不兼容的模组文件。
- Modrinth 返回的项目可能包含服务端专用模组；当前启动器安装的是客户端实例文件，请根据项目说明自行判断是否需要。
- 首次安装必须联网。如果 Mojang、加载器官网或 Modrinth 不可达，启动器会显示错误并在日志中保留详情。
- 内存上限会根据物理内存给出建议，但不会阻止你手动调高。
- 主题颜色和界面缩放保存在启动器配置中；页面缩放是 Electron 原生 zoom，可能与系统 DPI 缩放叠加。
- 本项目使用 eml-lib 2.7.4，遵循其 MIT 许可；Minecraft 游戏文件仍受 Mojang 最终用户许可协议约束。

## 验证情况

已在 Windows 10 22H2 x64 上完成实际端到端验证：同步 Mojang 版本清单 → 离线登录 → 下载 Java 运行时 / 运行库 / 资源（约 740 MB）→ 安装校验 → 启动 Minecraft 26.3 → 正常检测游戏退出。

新增功能也进行了实际验证：版本库加载、Modrinth 搜索与真实模组下载（文件写入 `mods`）、已安装列表、Yggdrasil 登录成功/多角色自动选择（使用本地 mock Yggdrasil 服务）、LittleSkin 真实错误响应映射、页面缩放、字体缩放、主题色切换，以及深色 / 亮色模式切换和持久化。还验证了自定义游戏目录的切换、重启持久化、无效路径拒绝、模组 / 日志路径跟随、PCL 版本导入、登录会话加密持久化 / 退出清除，以及启动取消。NeoForge 版本解析器已接入，但测试环境无法访问 NeoForged Maven，因此没有完成 NeoForge 下载验证；没有使用真实 LittleSkin 凭据进行登录。PCL / 现有 `.minecraft` 的本地版本扫描、`inheritsFrom` 合并、版本选择、本地 manifest 服务和 eml-lib 对本地 manifest 的读取都已验证；没有在真实 PCL 实例上完成完整游戏进程启动（需要实际下载资源和 Java）。

本轮新增能力的验证：用真实的 PCL `versions` 目录（`1.7.10-Forge_10.13.4.1614-OptiFine_E7`、`1.12.2-Forge_14.23.5.2864-LiteLoader`、`RLCraft`、`1.21.1-Fabric 0.20.0`）验证了从 `PCL\Setup.ini` 解析原版版本与加载器（1.7.10+Forge 10.13.4.1614、1.12.2+Forge、1.21.1+Fabric 0.20.0）；用一个没有元数据的 `CustomPack` 验证了「无法解析本地实例的原版版本」提示；PCL 导入会写入 `<实例>_instance.json` 并被识别；`forceLocal` 开关可持久化；代理与镜像在界面中可切换并保存，坏代理会回退到清单缓存，清除代理后恢复网络同步；BMCLAPI 镜像的 Mojang / Fabric / Forge 地址返回 200，镜像不可用时自动回退官方源；日志脱敏对 `accessToken`、Bearer 头和 JWT 生效。

启动链路方面：修复前，用真实 `GameService` 启动 PCL 的 1.7.10 Forge 实例会在 `getMinecraftManifestUrl()` 抛 `not found in manifest`；随后又先后卡在缺少 launchwrapper / LZMA、guava 15.0 过旧、缺少 `--userProperties`。当前代码在一次完整的 `GameService.launch()` 中依次经过「读取版本清单 → 计算所需文件 → 下载游戏文件 → 安装模组加载器 → 应用加载器补丁 → 解压本地库 → 整理游戏资源 → 清理临时文件 → 检查 Java 运行时（1.8.0_511）→ 启动游戏」，classpath 共 45 条，逐条日志确认包含 `forge-1.7.10-10.13.4.1614-1.7.10.jar`、`launchwrapper-1.12.jar`、`asm-all-5.0.3.jar`、`lzma-0.0.1.jar` 和 `guava-17.0.jar`（不含 `guava-15.0.jar`），进程状态为 running，游戏输出中出现 `LWJGL Version: 2.9.1`、Forge 初始化、`OpenAL initialized`、`Sound engine started`。

仍需说明的限制：
- 本轮验证在 Node 脚本里直接驱动 `GameService`，没有通过 Electron 界面点一遍。
- `D:\Program Files\PCL2\.minecraft` 只读，测试使用可写克隆 + 目录联接（`libraries` 指向 PCL 的库目录）；正式使用时请先把实例导入到可写目录。
- 1.7.10 / 1.12.2 需要 Java 8；「Java 运行时 → 手动指定」指向 `jre1.8.0_511\bin\java.exe`。这也是「强制本地启动」之外必须注意的一点。
- classpath 清单 jar 只有在命令行超过 30 000 字符时才生成；普通实例仍使用原生命令行。

截图来自实际运行的界面。

## License

MIT
