# 下一步改动总览（未执行）

用户一次性提出了 8 个功能需求。这是一次涉及主进程、渲染进程和多个服务的大改动，先列出实施计划，确认后按顺序落地。

## 需求清单与涉及文件

| # | 需求 | 主要文件 |
| --- | --- | --- |
| 1 | 取消「导入 PCL 版本」功能 | `src/main.js`、`src/preload.cjs`、`src/renderer/app.js`、`src/renderer/index.html` |
| 2 | 版本库增加「删除版本」「打开版本文件夹」按钮 | `src/main/version-service.js`、`src/main.js`、`src/preload.cjs`、`src/renderer/app.js`、`index.html` |
| 3 | 模组工坊显示模组中文名与图标 | `src/main/mod-service.js`（Modrinth `title`/`icon_url`，可加 Zh-CN 翻译）、`app.js`、`styles.css` |
| 4 | 大厅头像显示玩家皮肤头像 | `src/main/game-service.js`（皮肤接口/本地皮肤缓存）、`app.js`（`renderAccount`）、`styles.css` |
| 5 | 离线模式上传皮肤 | 新增 `src/main/skin-service.js`；`preload.cjs`、`app.js`、`index.html` |
| 6 | 模组下载到**当前实例**的 mods 目录（参考 PCL） | `src/main/mod-service.js`（按实例解析 modsDir）、`game-service.js`、`main.js` |
| 7 | 设置增加「版本隔离」开关，每个版本独立 mods/存档/配置 | `src/main/config-store.js`、`game-service.js`、`mod-service.js`、`main.js` |
| 8 | 加载器/模组支持查看历史版本（不只最新稳定版） | `src/main/loader-service.js`（返回完整列表）、`mod-service.js`（Modrinth versions 接口）、`app.js`、`index.html` |

## 关键设计决定（需要你确认）

1. **版本隔离**：开启后，`mods`/`saves`/`config`/`options.txt` 等放在
   `<gameDir>/versions/<版本名>/`（PCL 的做法），启动参数 `--gameDir` 指向该目录；
   关闭时沿用现在的共享 `gameDir`。模组安装路径跟随同一规则。
2. **删除版本**：只删除 `versions/<id>` 目录，并阻止删除正在运行/启动中的版本；
   默认版本被删后自动回退到最新正式版。
3. **皮肤**：离线模式上传 PNG（64×64），保存到 `gameDir/skin/<uuid>.png`；
   大厅头像优先用本地皮肤，其次用 LittleSkin/官方皮肤接口。
4. **历史版本**：加载器列表改为完整列表 + 折叠面板；模组下载增加「选择版本」弹窗。

## 实施顺序

1. 版本库（删除/打开文件夹、移除 PCL 导入）
2. 版本隔离 + 模组目录修正
3. 加载器/模组历史版本
4. 模组中文名与图标
5. 皮肤头像与离线皮肤上传

确认后我从第 1 项开始逐项实现并分别验证。
