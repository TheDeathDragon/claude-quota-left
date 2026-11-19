# quota-left

[English](README.md)

一个 Claude Code 插件（mod），在输入框下方显示剩余的订阅额度、上下文窗口、提示词缓存有效期，以及按 API 计费时本次会话的费用。

```
5h    ██░░░░░░░░  23% resets in 2h13m      7d    ██████░░░░  60% resets in 3d4h
ctx   ████░░░░░░  38% 62% left (124k)      cache ███████░░░   1h expires in 42m
```

## 显示内容

| 行 | 含义 |
| --- | --- |
| `5h`、`7d` | 5 小时和每周订阅额度的已用比例，以及各自的重置时间。仅 Pro 和 Max 套餐有。用到 90% 时弹出提示。 |
| `ctx` | 上下文已用比例，以及距离自动压缩还剩的百分比和 token 数。按自动压缩窗口扣除缓冲区计算，与 `/context` 一致。 |
| `cache` | Claude 模型：主线程提示词缓存的有效期档位（`5m` 或 `1h`）和距离过期的时间，进度条是有效期剩余的比例，显示 `expired` 后下一条消息会重新写入缓存。自动缓存且不回报有效期的服务商（DeepSeek）：上一次请求的输入中缓存命中的比例。 |
| `cost` | 本次会话的估算费用，仅在按 API 计费时显示（见下文）。价格分时段时，`peak` 或 `off` 表示当前是高峰价还是空闲价。 |

`/quota` 命令以文字形式输出同样的数据。

### 缓存倒计时的原理

Claude Code 没有直接提供缓存过期时间，插件根据每次响应回报的数据自己算。主线程每次发出请求时记下时间，缓存有效期就从这一刻开始算。响应里有缓存读取或写入时，倒计时从这次请求的发出时间重新开始。有效期档位取自响应里 `ephemeral_5m` 和 `ephemeral_1h` 的写入量；只读不写的响应沿用上次的档位。后台生成摘要时也可能悄悄续期缓存，所以倒计时只会偏短，不会偏长。子代理的缓存不统计。如果响应里只有缓存命中、从来没有缓存写入和有效期（DeepSeek 就是这样），就没有过期时间可算，这一行改为显示命中率。

## 安装

```
claude plugin marketplace add TheDeathDragon/claude-quota-left
claude plugin install quota-left@quota-left
```

重启 Claude Code。第一条回复之后会出现额度和上下文的显示。

需要支持 hooks 模块插件的 Claude Code 版本（已在 2.1.316 及以上测试）。

## 按 API 计费时的费用

使用 Pro 或 Max 订阅时显示额度，不显示费用。其他情况下，插件按回答每次请求的模型选择价格：

1. 在配置项里设置了价格，所有模型都按设置的价格算。
2. 模型 ID 匹配内置预设。DeepSeek flash 系列模型（`deepseek-v4-flash`，带 `cs/` 之类的网关前缀也能匹配）按每百万 token 缓存命中输入 0.04 元、缓存未命中输入 2 元、输出 8 元计价；北京时间工作日 9:00 到 12:00、14:00 到 18:00 以外的时段半价。
3. 都不匹配时，用 Claude Code 自己的估算（即 `/cost` 显示的数），单位美元。Claude Code 给不认识的模型估价时，这个数不显示。

要用自己的价格，按每百万 token 填高峰价；缓存写入按缓存未命中价计算。可以在 `/config` 里设置，也可以写进 `~/.claude/settings.json`：

```json
{
  "pluginConfigs": {
    "quota-left@quota-left": {
      "options": {
        "currency": "$",
        "priceCacheHit": 0.3,
        "priceCacheMiss": 3,
        "priceOutput": 15
      }
    }
  }
}
```

如果服务商有分时价格，再加上空闲时段比例、工作日高峰时段和它所在的时区。下面的例子就是 DeepSeek 预设的完整写法：北京时间（UTC+8）周一至周五 9:00 到 12:00、14:00 到 18:00 为高峰，其余时段半价，周末全天为空闲时段：

```json
"options": {
  "currency": "¥",
  "priceCacheHit": 0.04,
  "priceCacheMiss": 2,
  "priceOutput": 8,
  "offPeakRatio": 0.5,
  "peakHours": "9-12,14-18",
  "peakUtcOffset": 8
}
```

每次请求按发出时所在的时段计价，子代理的请求也计入。不同币种的请求分别显示金额。金额只是本次会话的估算，不是账单。

| 配置项 | 默认值 | |
| --- | --- | --- |
| `cost` | `true` | 是否显示费用行 |
| `currency` | `$` | 金额前的货币符号 |
| `priceCacheHit` | `0` | 缓存命中的输入价，每百万 token；任一价格大于 0 时替代内置预设 |
| `priceCacheMiss` | `0` | 缓存未命中的输入价（缓存写入同价），每百万 token |
| `priceOutput` | `0` | 输出价，每百万 token |
| `offPeakRatio` | `1` | 空闲价占高峰价的比例；`1` 表示不分时段 |
| `peakHours` | 空 | 工作日高峰时段，例如 `9-12,14-18` |
| `peakUtcOffset` | `8` | `peakHours` 所在时区，相对 UTC 的小时数 |

## 开发

```
claude plugin validate .
claude plugin test .
```

在本地开发时，把仓库目录添加为 marketplace（`claude plugin marketplace add <目录>`）并从它安装，每次修改后运行 `/reload-plugins`。Claude Code 加载插件时会把 API 类型写到 `.claude-plugin/types/`，`tsconfig.json` 继承自那里。

## 许可证

[MIT](LICENSE)
