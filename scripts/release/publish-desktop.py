from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path


VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


@dataclass(frozen=True)
class DesktopRelease:
    version: str
    installer: Path
    signature: Path
    manifest: Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_release(stage: Path) -> DesktopRelease:
    stage = stage.resolve()
    version = (stage / "version.txt").read_text(encoding="ascii").strip()
    if not VERSION_RE.fullmatch(version):
        raise RuntimeError("invalid desktop version pointer")
    installer = stage / f"AliceRealm_{version}_x64-setup.exe"
    signature = Path(f"{installer}.sig")
    manifest = stage / "latest.json"
    for path in (installer, signature, manifest):
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"missing desktop release artifact: {path}")

    metadata = json.loads(manifest.read_text(encoding="utf-8"))
    if metadata.get("version") != version:
        raise RuntimeError("desktop manifest version mismatch")
    platform = metadata.get("platforms", {}).get("windows-x86_64-nsis", {})
    expected_url = (
        f"https://updates.alicerealm.com/desktop/windows/{version}/{installer.name}"
    )
    if platform.get("url") != expected_url:
        raise RuntimeError("desktop manifest updater URL mismatch")
    if platform.get("signature") != signature.read_text(encoding="utf-8").strip():
        raise RuntimeError("desktop manifest signature mismatch")
    return DesktopRelease(version, installer, signature, manifest)


def content_type(path: Path) -> str:
    return {
        ".exe": "application/vnd.microsoft.portable-executable",
        ".json": "application/json; charset=utf-8",
        ".sig": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".zip": "application/zip",
    }.get(path.suffix.lower(), "application/octet-stream")


def object_digest(client, bucket: str, key: str) -> str | None:
    from botocore.exceptions import ClientError

    try:
        response = client.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code", "") in {"NoSuchKey", "404"}:
            return None
        raise
    digest = hashlib.sha256()
    for chunk in iter(lambda: response["Body"].read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def upload(client, bucket: str, path: Path, key: str, *, immutable: bool) -> None:
    digest = sha256(path)
    remote = object_digest(client, bucket, key)
    if immutable and remote is not None:
        if remote != digest:
            raise RuntimeError(f"immutable desktop object differs: {key}")
        print(f"UNCHANGED {key} sha256={digest}")
        return
    client.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": content_type(path),
            "CacheControl": (
                "public, max-age=31536000, immutable" if immutable else "no-store"
            ),
        },
    )
    if object_digest(client, bucket, key) != digest:
        raise RuntimeError(f"R2 desktop verification failed: {key}")
    print(f"UPLOADED {key} sha256={digest}")


def public_digest(url: str) -> str:
    request = urllib.request.Request(
        url, headers={"User-Agent": "AliceRealmDesktopReleaseVerifier/1.0"}
    )
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=180) as response:
        if response.status != 200:
            raise RuntimeError(f"public verification status {response.status}: {url}")
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_public(public_url: str, objects: list[tuple[str, Path]]) -> None:
    nonce = str(int(time.time()))
    for key, path in objects:
        expected = sha256(path)
        url = f"{public_url.rstrip('/')}/{key}?release={nonce}"
        for attempt in range(4):
            try:
                if public_digest(url) != expected:
                    raise RuntimeError(f"public desktop digest mismatch: {key}")
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(5)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish signed AliceRealm Desktop updates")
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--secrets-dir", type=Path)
    parser.add_argument("--endpoint", default=os.environ.get("R2_ENDPOINT"))
    parser.add_argument("--bucket", default=os.environ.get("R2_BUCKET"))
    parser.add_argument("--public-url", default=os.environ.get("R2_PUBLIC_URL"))
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def load_credentials(secrets_dir: Path | None) -> tuple[str, str]:
    if secrets_dir is not None:
        access_key = (secrets_dir / "r2_access_key_id.txt").read_text(
            encoding="utf-8"
        ).strip()
        secret_key = (secrets_dir / "r2_secret_access_key.txt").read_text(
            encoding="utf-8"
        ).strip()
    else:
        access_key = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
        secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    if not access_key or not secret_key:
        raise RuntimeError("R2 credentials are empty")
    return access_key, secret_key


def main() -> None:
    args = parse_args()
    release = load_release(args.stage)
    if args.validate_only:
        print(
            f"VALID signed AliceRealm Desktop {release.version} "
            f"installer_sha256={sha256(release.installer)}"
        )
        return
    if not all((args.endpoint, args.bucket, args.public_url)):
        raise RuntimeError(
            "R2 endpoint, bucket, and public URL are required when publishing"
        )
    access_key, secret_key = load_credentials(args.secrets_dir)

    import boto3

    client = boto3.client(
        "s3",
        endpoint_url=args.endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )
    immutable = [
        (f"desktop/windows/{release.version}/{path.name}", path)
        for path in (release.installer, release.signature)
    ]
    mutable = [
        ("desktop/windows/latest/AliceRealm-x64-setup.exe", release.installer),
        ("desktop/windows/latest/latest.json", release.manifest),
    ]
    for key, path in immutable:
        upload(client, args.bucket, path, key, immutable=True)
    for key, path in mutable:
        upload(client, args.bucket, path, key, immutable=False)
    verify_public(args.public_url, immutable + mutable)
    print(f"PUBLISHED signed AliceRealm Desktop {release.version}")


if __name__ == "__main__":
    main()
