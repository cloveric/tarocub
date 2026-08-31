# TaroCub 官方通义听悟适配器

这是 TaroCub 长音频云端转写的官方参考适配器。**不要给每个 Bot 分别开发适配器。** 一台机器只维护一个共享目录，各 Bot 实例通过 `TINGWU_ASR_DIR` 指向它。

## 职责边界

- TaroCub 负责下载媒体、探测时长、选择云端或本地路线、取消任务、失败回退，以及在进入 Codex、Claude、Kimi、DeepSeek 或 Antigravity 前注入转写文本。
- 达到阈值（默认 900 秒）后，TaroCub 执行本目录的 Python 适配器。
- 适配器负责 OSS 临时上传、签名 URL、听悟离线任务创建与轮询、结果下载及临时对象清理。
- TaroCub 只向子进程传递最小化的系统、证书和代理环境，不透传 Bot、引擎或云端凭据；适配器只从自己的 `.env.local` 加载阿里云凭据。
- 收到 `SIGTERM`/`SIGINT` 取消信号时，适配器会先清理临时 OSS 对象再退出；若清理卡住，TaroCub 仍会在有界宽限期后升级为 `SIGKILL`。
- 通义听悟没有本地常驻端口。`8412` 是本地 Qwen ASR 的端口，只用于短音频和云端失败回退。
- 阿里云凭据只保存在本目录的 `.env.local`；TaroCub 不读取、不复制、不记录它。

## 安装

在 TaroCub 仓库运行：

```bash
bash scripts/install-tingwu-asr.sh
```

默认安装到 `~/.tarocub-secrets/tingwu_asr`。安装器会复制官方适配器、创建虚拟环境并安装锁定版本的依赖，但会刻意留到下一步才创建 `.env.local`；绝不会覆盖已有凭据。

填写配置：

```bash
bash ~/.tarocub-secrets/tingwu_asr/configure_env.sh
```

需要：最小权限 RAM 用户的 AccessKey、听悟项目 AppKey、专用 OSS Bucket/Endpoint/Prefix。不要使用主账号 AccessKey，也不要通过聊天发送 `.env.local`。
配置向导默认拒绝覆盖已有的非空文件；只有确实要整体轮换或替换凭据时才使用 `--force`。

先独立验证：

```bash
cd ~/.tarocub-secrets/tingwu_asr
out_dir="$(mktemp -d /tmp/tingwu-smoke.XXXXXX)"
.venv/bin/python tingwu_transcribe.py \
  --file "/绝对路径/测试音频.m4a" \
  --source-language auto \
  --wait \
  --out-dir "$out_dir"
test -s "$out_dir/transcription.txt" && echo "Tingwu OK: $out_dir"
```

必须验证 `transcription.txt` 非空，不能只看退出码。`lark doctor` 只验证不含密钥的适配器协议、凭据文件边界和权限，不读取凭据值，也不能代替这一步真实认证烟测。

## 接入 TaroCub

在每个 Lark 实例的 `~/.cctb/<实例>/lark.env` 添加：

```bash
TINGWU_ASR_DIR="/Users/你的用户名/.tarocub-secrets/tingwu_asr"
ASR_CLOUD_THRESHOLD_SECONDS="900"
ASR_CLOUD_JOB_RETENTION_DAYS="7"
```

路径必须是该机器的真实绝对路径。多个 Bot 只重复这几行，不复制适配器和凭据目录。

```bash
npm run build
node dist/src/index.js lark doctor
node dist/src/index.js lark service restart --all
```

端到端测试时，发送超过 15 分钟的音频/视频；也可把“强制云端转写”和音频放在同一条消息或同一批发送。事后单独发送关键词不能改变已经启动的转写路线。
