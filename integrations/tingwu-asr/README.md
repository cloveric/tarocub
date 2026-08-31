# Official TaroCub adapter for Aliyun Tingwu

This is TaroCub's reference adapter for long-media cloud transcription. **Do not build a separate adapter per bot.** One machine uses one shared adapter directory; every TaroCub instance points to it with `TINGWU_ASR_DIR`.

## Architecture

- TaroCub owns media download, duration probing, routing, cancellation, local fallback, and transcript injection before engine dispatch.
- Media at or above the configured threshold (900 seconds by default) invokes this adapter.
- The adapter owns OSS upload, signed URL creation, Tingwu offline-task creation and polling, result download, and temporary-object cleanup.
- Tingwu has no local daemon or port. Port `8412` belongs to the optional local Qwen ASR used for short media and cloud fallback.
- Credentials remain in this adapter's `.env.local`; TaroCub never reads or copies them.

## Install

From the TaroCub repository:

```bash
bash scripts/install-tingwu-asr.sh
```

The default target is `~/.tarocub-secrets/tingwu_asr`. The installer copies this official adapter, creates its virtualenv, and installs pinned dependencies. It deliberately does not create `.env.local`, and never overwrites an existing credential file; only the explicit configuration step below writes credentials.

Configure credentials:

```bash
bash ~/.tarocub-secrets/tingwu_asr/configure_env.sh
```

Use a least-privilege RAM user, a Tingwu AppKey, and a dedicated OSS bucket/prefix. Never use a root-account AccessKey or send `.env.local` through chat.
The configurator refuses to overwrite an existing non-empty file. Use `--force` only when you intentionally rotate or replace all values.

Then add this to each Lark instance's `~/.cctb/<instance>/lark.env`:

```bash
TINGWU_ASR_DIR="/absolute/path/to/.tarocub-secrets/tingwu_asr"
ASR_CLOUD_THRESHOLD_SECONDS="900"
ASR_CLOUD_JOB_RETENTION_DAYS="7"
```

Run `node dist/src/index.js lark doctor`, restart the Lark fleet, and test with a real media file. Doctor verifies the non-secret adapter contract and credential-file boundary, not the credential values or cloud authentication; only a non-empty `transcription.txt` from a real smoke test proves the cloud route works. See [README.zh-CN.md](README.zh-CN.md) for the full Chinese workflow.
