# dsh-plugin-pet

给 DeepSeek Harness Web 界面加一只**会跟着会话状态换动作**的桌宠 —— 兼容
[Codex Pet](https://github.com/nexu-io/open-design/blob/main/docs/codex-pets.md)
的图集规范，但宠物的位置、目录和分发都由 DSH 自己管。

- 会话在跑 → `running`；有任务等你确认 → `waiting` + 气泡 + 「去看看 →」
- 一轮结束 → 中性提示「这一轮结束了」（**不**宣称成功）
- 拖拽换位置（刷新后保持）、单击挥手、双击跳起、右键换宠物
- 支持 Codex Pet **v1（8×9）与 v2（8×11）** 两种图集
- 零运行时依赖，**仓库不含任何美术资产**

## 安装

桌面 App 拥有自己的 profile（`$DSH_HOME/profiles/desktop`），**npm 版 `dsh` 改不了它**。
桌面端请用 App 自带的 CLI；CLI 用户用 `web` profile 即可。

```bash
# 桌面端（先启动一次 App 初始化 profile，然后完全退出）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:hzhq1255/dsh-plugin-pet

# 命令行 dsh web
dsh plugin --profile web add github:hzhq1255/dsh-plugin-pet

# 本地开发副本
dsh plugin --profile web add /absolute/path/to/dsh-plugin-pet
```

装完重启对应入口。桌面的 profile 只在启动时装配，**热装不会生效**；
启动后 `GET /plugins/dsh-plugin-pet/pets` 能返回目录即加载成功。

> 本地目录安装会走 pnpm `link:`，peer 依赖不会被路由（
> [官方讨论 #9494](https://github.com/deepseek-ai/deepseek-harness/discussions/9494)）；
> 本插件运行时只依赖 node 内置与 `ctx.webServer`，不受影响。

## 放一只宠物

宠物包放在 `${DSH_HOME:-~/.dsh}/pets/<id>/`：

```text
~/.dsh/pets/blue-whale-maid/
├── pet.json
└── spritesheet.webp
```

`pet.json` 字段（全部可选，目录名即 id，必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`）：

| 字段 | 说明 |
| --- | --- |
| `displayName` | 气泡/无障碍标签里的名字，缺省用目录名 |
| `description` | 一句话描述 |
| `spritesheetPath` | 相对路径，缺省 `spritesheet.webp`；不允许 `..`、绝对路径 |
| `spriteVersionNumber` | `2` = 11 行图集；省略 = v1 9 行 |
| `kind` | 自由文本（如 `person`），仅作展示信息 |

图集：8 列 × 192×208 单元格；v1 = `1536×1872`，v2 = `1536×2288`，背景透明。
行语义与逐帧时长见 [docs/PET-FORMAT.md](docs/PET-FORMAT.md)。

## 蓝鲸女仆

本仓库**不附带**女仆美术。她来自
[`yuxino/dsh-blue-whale-maid`](https://github.com/yuxino/dsh-blue-whale-maid)：
代码 MIT，**角色美术与元数据不在 MIT 内，仅限个人/学习/非商业使用**，原作者署名
**simashui**（[codex-pets.net](https://codex-pets.net/#/pets/blue-whale-maid)）。

本地自用可以这样放（不会进本仓库）：

```bash
git clone --depth 1 https://github.com/yuxino/dsh-blue-whale-maid /tmp/maid
mkdir -p ~/.dsh/pets/blue-whale-maid
cp /tmp/maid/assets/pet.json /tmp/maid/assets/spritesheet.webp ~/.dsh/pets/blue-whale-maid/
```

## 配置

```yaml
- id: pet
  name: dsh-plugin-pet
  config:
    defaultPet: blue-whale-maid   # 缺省选中的宠物 id
    dir: ~/.dsh/pets              # 覆盖宠物根目录（默认 $DSH_HOME/pets）
```

浏览器端也会记住上次右键切换的宠物（`localStorage: dsh-plugin-pet:pet`）。

## 交互

| 操作 | 效果 |
| --- | --- |
| 拖拽 | 移动位置，松手即存（`localStorage: dsh-plugin-pet:pos`） |
| 单击 / Enter | 挥手 |
| 双击 | 跳一下 |
| 右键 | 轮换到下一只宠物 |
| 气泡按钮 | 打开对应的会话 |

`prefers-reduced-motion: reduce` 下只显示当前动作的首帧，不播动画。

## 网络与安全

- 只注册两条 **仅 loopback** 的 GET 路由：
  `GET /plugins/dsh-plugin-pet/pets` 与
  `GET /plugins/dsh-plugin-pet/pets/:id/spritesheet`。
- 宠物 id 白名单正则、`realpath` 级目录约束、只允许 `webp/png/gif`、单文件 ≤ 8MB；
  非 loopback `Host` 一律 403。
- 不读 `~/.codex`、不读凭据、不发外部请求。

## 兼容性

| 组件 | 范围 |
| --- | --- |
| DSH | `>=0.1.2-rc.1`（依赖 `shell.overlay` 槽与 `useSessions` 根 hook） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| Profile | 任意带 Web 客户端的 profile（`desktop` / `web`） |

## 开发

```bash
npm test          # node:test：pet-store / host / client 三组
npm run check     # 语法 + 全部测试
```

- `lib/pet-store.js` — 纯函数：manifest 校验、图集规格、路径守卫、目录扫描
- `lib/index.js` — 宿主半：两条 HTTP 路由（可脱离 `ctx` 单测）
- `lib/client.js` — 浏览器半：手写的 ModuleLoader 包（无 bundler），注册 `shell.overlay`

## 参考与致谢

- **Codex Pet 规范**（图集、行语义、manifest）：
  [codex-pet-contract](https://github.com/nexu-io/open-design/blob/main/skills/hatch-pet/references/codex-pet-contract.md) ·
  [V2 Animation Rows](https://github.com/asgeirtj/system_prompts_leaks/blob/main/OpenAI/Codex/plugins/work-pets/skills/create-pet/references/animation-rows.md) ·
  [IchenDEV/petx](https://github.com/IchenDEV/petx)（双版本图集渲染库）
- **客户端引擎**：改写自 [`yuxino/dsh-blue-whale-maid`](https://github.com/yuxino/dsh-blue-whale-maid)（MIT）—
  帧调度、气泡控制、拖拽与「只报可确认状态」的文案口径；本仓库去掉了它的余额/费用面板、
  内嵌图集与 Codex 目录扫描，并补上 v1/v2 双版本与换宠物。
- **角色美术**：蓝鲸女仆 © simashui / codex-pets.net，个人使用需遵守其授权。

## License

代码 MIT（见 [LICENSE](LICENSE)，包含上游 MIT 版权行）。**美术不在 MIT 范围内**，
由使用者自行提供并自负授权。
