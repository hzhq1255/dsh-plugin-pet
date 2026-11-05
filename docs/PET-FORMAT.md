# 宠物包格式（Codex Pet 兼容）

本插件读取的是 **Codex Pet 的格式**，不是 Codex 的目录。宠物放在
`${DSH_HOME:-~/.dsh}/pets/<id>/`，布局与 `pet.json` 字段和 Codex 保持一致，
所以现成的 Codex pet 包可以直接拷进来。

## 目录

```text
$DSH_HOME/pets/<id>/
├── pet.json          # 可选
└── spritesheet.webp  # 必需（或 pet.json 里 spritesheetPath 指向的图）
```

- `<id>` 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，**目录名就是身份**；
  `pet.json` 里的 `id` 会被忽略（与 Codex 的"folder name is the identity"一致）。
- 只有图片、没有 `pet.json` 的目录也是合法宠物（全部走默认值）。

## pet.json

```json
{
  "displayName": "蓝鲸女仆",
  "description": "任务有动静时会换动作的桌宠。",
  "spritesheetPath": "spritesheet.webp",
  "spriteVersionNumber": 2,
  "kind": "person"
}
```

| 字段 | 类型 | 缺省 | 说明 |
| --- | --- | --- | --- |
| `displayName` | string | 目录名 | ≤ 80 字符 |
| `description` | string | `""` | ≤ 280 字符 |
| `spritesheetPath` | string | `spritesheet.webp` | 相对路径；`..`、绝对路径、盘符、控制字符一律拒绝（整个宠物判为损坏） |
| `spriteVersionNumber` | `1` \| `2` | `1` | `2` 使用 11 行图集 |
| `kind` | string | `""` | 展示用，如 `person` |

## 图集

- 单元格 **192×208**，**8 列**，行优先；未使用的单元格必须全透明。
- v1：**9 行** → `1536×1872`，`spriteVersionNumber` 省略或为 `1`。
- v2：**11 行** → `1536×2288`，`spriteVersionNumber: 2`。
- 尺寸不符时浏览器端只 `console.warn`，不阻塞其他宠物。
- 单文件 ≤ 8MB；只接受 `webp` / `png` / `gif`。

### 行语义与逐帧时长（ms）

| 行 | 状态 | 帧 | 时长 |
| ---: | --- | ---: | --- |
| 0 | `idle` | 6 | 280, 110, 110, 140, 140, 320 |
| 1 | `running-right` | 8 | 120 ×7, 220 |
| 2 | `running-left` | 8 | 120 ×7, 220 |
| 3 | `waving`（单次） | 4 | 140, 140, 140, 280 |
| 4 | `jumping`（单次） | 5 | 140 ×4, 280 |
| 5 | `failed`（单次） | 8 | 140 ×7, 240 |
| 6 | `waiting` | 6 | 150 ×5, 260 |
| 7 | `running` | 6 | 120 ×5, 220 |
| 8 | `review` | 6 | 150 ×5, 280 |
| 9 | `look A`（v2） | 8 | 0°, 22.5°, …, 157.5° |
| 10 | `look B`（v2） | 8 | 180°, 202.5°, …, 337.5° |

`look` 行是 16 向顺时针注视循环（0° = 正上方）；本插件当前只用 0–8 行，
`look` 行留给后续的视线跟随。

## 状态怎么映射

| 会话状态 | 动作 |
| --- | --- |
| 任一**非空**会话 `pendingInteraction` | `waiting` + 气泡 +「去看看 →」 |
| 任一非空会话 `running` | `running` |
| 运行结束（曾持续 > 2s） | 回到 `idle` + 中性「这一轮结束了」 |
| 其余 | `idle`（随机间隔的 `review`/呼吸感由前端节奏控制） |
| 单击 | `waving` |
| 双击 | `jumping` |

DSH 的会话列表只暴露"在跑/在等"，不暴露"成功/失败"，所以插件不会替你判断结果——
失败动作只在明确观察到失败信号时才用（当前版本不使用）。

## 自己做一只

1. 按上表画 11 行图集，或直接用 Codex 的 `create-pet` 流水线生成。
2. 导出 `spritesheet.webp` + `pet.json`，放进 `$DSH_HOME/pets/<id>/`。
3. 刷新 Web 界面；`GET /plugins/dsh-plugin-pet/pets` 能看到它即加载成功。
