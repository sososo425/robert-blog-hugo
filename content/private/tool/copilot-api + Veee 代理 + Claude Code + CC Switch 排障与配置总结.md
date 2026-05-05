本文档整理自一次完整排障过程，便于日后复现或给同事参考。

---

## 一、架构关系（先建立心智模型）

| 组件 | 作用 |
|------|------|
| **GitHub Copilot** | 云端真实服务：鉴权、配额、模型路由、prompt 上限等均由 GitHub 控制。 |
| **本机 copilot-api** | 本地兼容代理：用 Copilot 登录态请求 GitHub，对外伪装成 OpenAI（`/v1/chat/completions`）或 Anthropic（`/v1/messages`）。 |
| **Claude Code** | 通过 `ANTHROPIC_BASE_URL` 指向本机 copilot-api，走 Anthropic 形态 API。 |
| **CC Switch** | 管理 `~/.claude/settings.json` 等配置，切换 Provider。 |

**重要**：模型能否使用、列表里有哪些名字、136000 token 上限等，**首先是 GitHub Copilot 侧限制**；copilot-api 主要负责协议转换与转发。

---

## 二、CC Switch 配置 copilot-api（Claude Code）

### 2.1 推荐配置要点

- **请求地址 / `ANTHROPIC_BASE_URL`**：`http://127.0.0.1:4141` 或 `http://localhost:4141`
- **不要**末尾带 `/`，避免拼出 `//v1/messages` 等问题。
- **API 格式**：Anthropic Messages（原生）。
- **API Key / Token**：`dummy`（占位即可，真实鉴权在 copilot-api 与 GitHub 侧）。
- **公司 Copilot Business**：若适用，启动 copilot-api 时使用 `--account-type business`（见后文）。

### 2.2 CC Switch「检测失败 HTTP 503」但 Claude Code 能用

- **现象**：点击测试报 503，本机 copilot-api **没有**新访问日志；终端 `curl http://127.0.0.1:4141/v1/models` 正常。
- **原因**：CC Switch 健康检查用自带 HTTP 客户端；在**未显式走本机代理**时，请求可能未到达 `localhost:4141`（与系统/全局代理、绕过规则有关）。
- **结论**：以 **copilot-api 日志** 与 **Claude Code 实际对话** 为准；检测失败可为假阴性。若希望检测也变绿，需让 CC Switch 进程所在环境能直连或通过代理正确访问本机服务（见第四节代理）。

---

## 三、模型选择与 GitHub 侧限制

### 3.1 Anthropic 路径与 `chat/completions`

Claude Code → copilot-api 的 `POST /v1/messages` 在内部仍会落到 GitHub Copilot 的 **`/chat/completions`** 一类能力上。若 GitHub 返回：

`model "xxx" is not accessible via the /chat/completions endpoint`（`unsupported_api_for_model`）

则 **换 CC Switch 或换 Claude Code 都不能绕过**，除非换上游（例如官方 OpenAI/Anthropic API）或日后 GitHub 开放该模型。

### 3.2 实测可参考（以本机 copilot-api 为准，账号差异可能导致略有不同）

- **易失败（400）**：如 `gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.2-codex`、`gpt-5.1-codex*`、`gpt-41-copilot` 等。
- **较易成功（200）**：如 `gpt-4.1`、`gpt-4o` 系列、`gpt-5.2`、`gpt-5.1`、`gpt-5-mini`、`gemini-3.1-pro-preview` 等、`grok-code-fast-1` 等。

**`/v1/models` 里列出某 id ≠ 该 id 一定可走当前链路**；以 `POST /v1/messages` 实测或实际对话为准。

### 3.3 Prompt 上限约 136000

- 报错：`prompt token count of ... exceeds the limit of 136000`（`model_max_prompt_tokens_exceeded`）。
- 这是 **Copilot 对该路径的 prompt 上限**（约 136K），**不能**在 Copilot 设置里自行改成 1M；与 Gemini 在 Google 侧标称的大上下文不是同一回事。
- **规避**：减少 `@` 文件数量、拆会话、压缩历史、精简 `CLAUDE.md` 等。

### 3.4 模型列表里有没有「Claude / Opus / Sonnet」

- 列表由 **GitHub 按账号、组织策略、套餐、灰度** 等返回；**同事有而自己没有**时，优先对齐 **同一 Org、Copilot Business 策略**，而不是只换 IP。
- 换新加坡代理 + 重登可能仍不够：还有 **缓存 token、账单地区、组织策略** 等因素。

---

## 四、Mac + Veee：终端与系统代理

### 4.1 现象

- 浏览器访问 ip111.cn 等显示 **新加坡 IP**（全局代理正常）。
- 终端 `curl https://ipinfo.io/json` 仍显示 **国内**（如广州移动）。

### 4.2 原因

- Veee 在 Mac 上会在 **系统网络** 里为 **Wi‑Fi** 写入 **HTTP/HTTPS 代理**：常见为 **`127.0.0.1:15236`**（以 `lsof -nP -iTCP:15236` 可见进程名为 **Veee**）。
- **macOS 自带 `curl` 不保证自动使用「系统设置里的网页代理」**，因此会出现浏览器出国、终端仍直连。

### 4.3 解决：在 shell 中显式声明代理

```bash
export http_proxy=http://127.0.0.1:15236
export https_proxy=http://127.0.0.1:15236
export ALL_PROXY=http://127.0.0.1:15236
export HTTP_PROXY=http://127.0.0.1:15236
export HTTPS_PROXY=http://127.0.0.1:15236

# 本机服务建议不走代理（如 copilot-api 4141）
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
```

验证：
```bash
curl -sS https://ipinfo.io/json
```

应与浏览器出口一致（如新加坡）。

可将上述 `export` 写入 `~/.zshrc`，**新开终端**或 `source ~/.zshrc` 后生效。**Veee 未连接时** `15236` 可能不可用，需临时 `unset` 代理变量。

### 4.4 与 Tailscale 等 VPN 并存

系统「VPN」列表里可能同时有 **Tailscale** 等；与 **Wi‑Fi 上的 HTTP 代理** 是不同层。若异常，可临时关闭 Tailscale 做对比。

---

## 五、copilot-api 认证失败：`github.com:443` Connect Timeout

### 5.1 现象

- `curl -x http://127.0.0.1:15236 https://github.com` 返回 **200**。
- `copilot-api auth` 报 **`fetch failed` / Connect Timeout**（Node undici 直连 `github.com`）。

### 5.2 原因

Node 内 **`fetch` 默认不会**像 `curl -x` 那样使用你在 zsh 里设的代理；README 中 **`--proxy-env` 仅明确写在 `start` 子命令**上，`auth` 帮助中通常**没有** `--proxy-env`。

### 5.3 解决（推荐）

在已设置 `HTTP_PROXY`/`HTTPS_PROXY`（及小写形式）且 Veee 已连接的前提下：

```bash
copilot-api start --proxy-env --account-type business
```

（个人版用 `individual`，企业按文档使用 `enterprise`。）

未登录时 **`start` 会触发登录流程**，且会通过 `--proxy-env` 走代理访问 GitHub。认证完成后再保持服务运行即可。

### 5.4 重置本地 token

- 数据目录（以 `copilot-api debug` 为准）：通常为 **`~/.local/share/copilot-api`**。
- Token 文件：**`github_token`**（路径见 `GITHUB_TOKEN_PATH`）。
- 删除 `github_token` 后重新走登录；操作前**停止**正在运行的 `copilot-api` 进程。

```bash
copilot-api debug
# 确认 APP_DIR、GITHUB_TOKEN_PATH、Token exists
```

---

## 六、网页 GitHub 登录与 CLI 的关系

- **不需要**为了 copilot-api 刻意退出网页 GitHub；浏览器会话与 CLI 设备授权/token 文件是不同机制。
- 授权时确保使用 **公司已开通 Copilot Business 且已分配席位** 的账号完成设备授权即可。

---

## 七、快速检查清单

| 检查项 | 命令或操作 |
|--------|------------|
| 终端是否走代理 | `curl -sS https://ipinfo.io/json` |
| 谁监听 15236 | `lsof -nP -iTCP:15236 -sTCP:LISTEN` |
| copilot-api 路径与 token | `copilot-api debug` |
| 经代理访问 GitHub | `curl -sS -o /dev/null -w '%{http_code}\n' -x http://127.0.0.1:15236 https://github.com` |
| API 是否活 | `curl -sS http://127.0.0.1:4141/v1/models` |

---

## 八、参考链接

- [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)（README、免责声明、`--proxy-env`、`--account-type`）
- [CC Switch](https://github.com/farion1231/cc-switch)（Provider 与本地检测行为）
- GitHub Copilot 条款与使用政策（见 copilot-api README 中的链接）

---

*文档为实践总结，具体端口、套餐与 GitHub 策略以你当前环境及官方说明为准。*
