#!/usr/bin/env python3
"""
Submit an offline Tongyi Tingwu transcription task and optionally wait for results.

The audio must be reachable by Tongyi Tingwu as an HTTP(S) URL, for example an OSS
signed URL. Local files need to be uploaded first.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import signal
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from aliyunsdkcore.auth.credentials import AccessKeyCredential
from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest


DOMAIN = "tingwu.cn-beijing.aliyuncs.com"
VERSION = "2023-09-30"
REGION = "cn-beijing"


class TerminationRequested(Exception):
    """Raised by a soft process signal so OSS cleanup can run."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"received signal {signum}")
        self.signum = signum


def install_termination_handlers() -> None:
    def request_termination(signum: int, _frame: Any) -> None:
        raise TerminationRequested(signum)

    for name in ("SIGTERM", "SIGINT"):
        signum = getattr(signal, name, None)
        if signum is not None:
            signal.signal(signum, request_termination)


def protect_cleanup_from_soft_signals() -> None:
    """Let cleanup finish; the bridge still escalates to SIGKILL after 10s."""
    for name in ("SIGTERM", "SIGINT"):
        signum = getattr(signal, name, None)
        if signum is not None:
            signal.signal(signum, signal.SIG_IGN)


def load_env_file() -> None:
    env_path = Path(__file__).with_name(".env.local")
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"missing env var: {name}")
    return value


def optional_env(name: str, default: str | None = None) -> str | None:
    return os.getenv(name) or default


def make_client() -> AcsClient:
    credentials = AccessKeyCredential(
        require_env("ALIBABA_CLOUD_ACCESS_KEY_ID"),
        require_env("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
    )
    return AcsClient(region_id=REGION, credential=credentials)


def common_request(method: str, uri: str) -> CommonRequest:
    request = CommonRequest()
    request.set_accept_format("json")
    request.set_domain(DOMAIN)
    request.set_version(VERSION)
    request.set_protocol_type("https")
    request.set_method(method)
    request.set_uri_pattern(uri)
    request.add_header("Content-Type", "application/json")
    return request


def do_json(client: AcsClient, request: CommonRequest) -> dict[str, Any]:
    raw = client.do_action_with_exception(request)
    return json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)


def build_body(args: argparse.Namespace, file_url: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "AppKey": args.app_key or require_env("TINGWU_APP_KEY"),
        "Input": {
            "SourceLanguage": args.source_language,
            "FileUrl": file_url,
            "TaskKey": args.task_key
            or "tingwu_" + dt.datetime.now().strftime("%Y%m%d_%H%M%S"),
        },
        "Parameters": {
            "Transcription": {
                "DiarizationEnabled": args.diarization,
            },
        },
    }

    if args.diarization and args.speaker_count is not None:
        body["Parameters"]["Transcription"]["Diarization"] = {
            "SpeakerCount": args.speaker_count
        }

    if args.text_polish:
        body["Parameters"]["TextPolishEnabled"] = True

    if args.summarize:
        body["Parameters"]["SummarizationEnabled"] = True
        body["Parameters"]["Summarization"] = {
            "Types": ["Paragraph", "Conversational", "QuestionsAnswering"]
        }

    if args.meeting_assistance:
        body["Parameters"]["MeetingAssistanceEnabled"] = True
        body["Parameters"]["MeetingAssistance"] = {
            "Types": ["Actions", "KeyInformation"]
        }

    if args.output_mp3:
        body["Parameters"]["Transcoding"] = {"TargetAudioFormat": "mp3"}

    return body


def normalize_oss_endpoint(endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        return endpoint
    return "https://" + endpoint


def make_oss_bucket(args: argparse.Namespace) -> Any:
    try:
        import oss2
    except ImportError as exc:
        raise SystemExit(
            "missing dependency: oss2. Run: "
            "tingwu_asr/.venv/bin/python -m pip install -r tingwu_asr/requirements.txt"
        ) from exc

    bucket_name = args.oss_bucket or require_env("OSS_BUCKET")
    endpoint = normalize_oss_endpoint(args.oss_endpoint or require_env("OSS_ENDPOINT"))
    auth = oss2.Auth(
        require_env("ALIBABA_CLOUD_ACCESS_KEY_ID"),
        require_env("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
    )
    return oss2.Bucket(auth, endpoint, bucket_name), bucket_name


def upload_local_file(args: argparse.Namespace, out_dir: Path) -> tuple[str, dict[str, Any]]:
    source_path = Path(args.file).expanduser()
    if not source_path.exists() or not source_path.is_file():
        raise SystemExit(f"local file not found: {source_path}")

    bucket, bucket_name = make_oss_bucket(args)
    prefix = args.oss_prefix or optional_env("OSS_PREFIX", "tingwu-upload/") or ""
    prefix = prefix.strip("/")
    key_prefix = f"{prefix}/" if prefix else ""
    object_key = (
        key_prefix
        + "local-"
        + dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        + "-"
        + uuid.uuid4().hex
        + source_path.suffix.lower()
    )

    expires = args.oss_url_expires
    upload_info = {
        "bucket": bucket_name,
        "object_key": object_key,
        "source_file": str(source_path),
        "signed_url_expires_seconds": expires,
        "uploaded_at": dt.datetime.now().isoformat(timespec="seconds"),
        "deleted": False,
    }
    try:
        bucket.put_object_from_file(object_key, str(source_path))
        signed_url = bucket.sign_url("GET", object_key, expires)
        write_json(out_dir / "upload.json", upload_info)
        print(f"uploaded: oss://{bucket_name}/{object_key}", file=sys.stderr)
        return signed_url, upload_info
    except TerminationRequested:
        # The signal may arrive after OSS accepted the object but before this
        # function can return upload_info to main(). Deleting the key is safe
        # even when the upload never completed and closes that cleanup gap.
        protect_cleanup_from_soft_signals()
        try:
            bucket.delete_object(object_key)
            upload_info["deleted"] = True
            upload_info["deleted_at"] = dt.datetime.now().isoformat(timespec="seconds")
            write_json(out_dir / "upload.json", upload_info)
            print(f"deleted interrupted upload: oss://{bucket_name}/{object_key}", file=sys.stderr)
        except Exception as cleanup_error:
            print(
                f"warning: failed to delete interrupted OSS upload: {cleanup_error}",
                file=sys.stderr,
            )
        raise


def delete_uploaded_file(args: argparse.Namespace, upload_info: dict[str, Any], out_dir: Path) -> None:
    bucket, _bucket_name = make_oss_bucket(args)
    object_key = upload_info.get("object_key")
    if not object_key:
        return
    bucket.delete_object(object_key)
    upload_info["deleted"] = True
    upload_info["deleted_at"] = dt.datetime.now().isoformat(timespec="seconds")
    write_json(out_dir / "upload.json", upload_info)
    print(f"deleted upload: oss://{upload_info.get('bucket')}/{object_key}", file=sys.stderr)


def create_offline_task(client: AcsClient, body: dict[str, Any]) -> dict[str, Any]:
    request = common_request("PUT", "/openapi/tingwu/v2/tasks")
    request.add_query_param("type", "offline")
    request.set_content(json.dumps(body, ensure_ascii=False).encode("utf-8"))
    return do_json(client, request)


def get_task_info(client: AcsClient, task_id: str) -> dict[str, Any]:
    request = common_request("GET", f"/openapi/tingwu/v2/tasks/{task_id}")
    return do_json(client, request)


def wait_for_task(
    client: AcsClient, task_id: str, interval: float, timeout: float
) -> dict[str, Any]:
    started = time.monotonic()
    while True:
        info = get_task_info(client, task_id)
        data = info.get("Data") or {}
        status = data.get("TaskStatus")
        print(f"TaskStatus={status}", file=sys.stderr)
        if status in {"COMPLETED", "FAILED", "INVALID"}:
            return info
        if time.monotonic() - started > timeout:
            raise TimeoutError(f"timed out waiting for task {task_id}")
        time.sleep(interval)


def download_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = response.read()
    return json.loads(payload.decode("utf-8"))


def extract_text(value: Any) -> list[str]:
    """Best-effort text extraction across Tingwu result variants."""
    lines: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key in ("Text", "text", "Sentence", "sentence", "Content", "content"):
                item = node.get(key)
                if isinstance(item, str) and item.strip():
                    lines.append(item.strip())
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)

    deduped: list[str] = []
    seen: set[str] = set()
    for line in lines:
        if line not in seen:
            seen.add(line)
            deduped.append(line)
    return deduped


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    path.chmod(0o600)


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tongyi Tingwu offline ASR")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file-url", help="public HTTP(S) audio URL")
    source.add_argument("--file", help="local audio/video file; uploaded to OSS first")
    parser.add_argument("--app-key", help="Tingwu AppKey; defaults to TINGWU_APP_KEY")
    parser.add_argument(
        "--source-language",
        default="cn",
        choices=["cn", "en", "fspk", "ja", "ko", "yue", "auto", "multilingual"],
        help="cn=中文, auto=自动语种识别, fspk=中英文自由说",
    )
    parser.add_argument("--task-key", help="custom task key")
    parser.add_argument("--wait", action="store_true", help="poll until finished")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--timeout", type=float, default=1800.0)
    parser.add_argument("--out-dir", default="tingwu_asr/output")
    parser.add_argument("--oss-bucket", help="OSS bucket for --file uploads")
    parser.add_argument("--oss-endpoint", help="OSS endpoint, e.g. https://oss-cn-beijing.aliyuncs.com")
    parser.add_argument("--oss-prefix", help="OSS object prefix for temporary uploads")
    parser.add_argument("--oss-url-expires", type=int, default=3600)
    parser.add_argument(
        "--keep-upload",
        action="store_true",
        help="keep uploaded OSS object after a waited task finishes",
    )
    parser.add_argument("--diarization", action="store_true", help="enable speakers")
    parser.add_argument("--speaker-count", type=int, help="0 means unknown speakers")
    parser.add_argument("--summarize", action="store_true")
    parser.add_argument("--meeting-assistance", action="store_true")
    parser.add_argument("--text-polish", action="store_true")
    parser.add_argument("--output-mp3", action="store_true")
    return parser.parse_args()


def main() -> int:
    load_env_file()
    args = parse_args()
    install_termination_handlers()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    out_dir.chmod(0o700)

    upload_info: dict[str, Any] | None = None
    file_url = args.file_url
    try:
        if args.file:
            file_url, upload_info = upload_local_file(args, out_dir)
        client = make_client()
        body = build_body(args, file_url)
        task = create_offline_task(client, body)
        write_json(out_dir / "task.json", task)
        print(json.dumps(task, ensure_ascii=False, indent=2))

        task_id = ((task.get("Data") or {}).get("TaskId"))
        if not task_id:
            return 1

        if not args.wait:
            print(f"TaskId={task_id}")
            if upload_info and not args.keep_upload:
                print(
                    "local upload is kept because --wait was not set; "
                    "delete it manually or rerun with --wait for automatic cleanup",
                    file=sys.stderr,
                )
            return 0

        info = wait_for_task(client, task_id, args.poll_interval, args.timeout)
        write_json(out_dir / "task_info.json", info)

        data = info.get("Data") or {}
        result = data.get("Result") or {}
        transcription_url = result.get("Transcription")
        if not transcription_url:
            print("No transcription result URL found in task_info.json", file=sys.stderr)
            return 2

        transcription = download_json(transcription_url)
        write_json(out_dir / "transcription.json", transcription)
        lines = extract_text(transcription)
        write_text(out_dir / "transcription.txt", "\n".join(lines))
        print(f"saved: {out_dir / 'transcription.txt'}")
        return 0
    except TerminationRequested as error:
        print(f"termination requested by signal {error.signum}; cleaning up", file=sys.stderr)
        return 128 + error.signum
    finally:
        if upload_info and args.wait and not args.keep_upload and not upload_info.get("deleted"):
            protect_cleanup_from_soft_signals()
            try:
                delete_uploaded_file(args, upload_info, out_dir)
            except Exception as error:
                print(f"warning: failed to delete temporary OSS upload: {error}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
