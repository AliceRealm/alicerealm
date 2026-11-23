from __future__ import annotations

import argparse
import hashlib
import mimetypes
import re
import time
import urllib.request
from pathlib import Path

import boto3
from botocore.exceptions import ClientError


VERSION_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def content_type(path: Path) -> str:
    overrides = {
        ".ps1": "text/plain; charset=utf-8",
        ".sha256": "text/plain; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".zip": "application/zip",
    }
    return overrides.get(path.suffix.lower(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")


def object_digest(client, bucket: str, key: str) -> str | None:
    try:
        response = client.get_object(Bucket=bucket, Key=key)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "")
        if code in {"NoSuchKey", "404"}:
            return None
        raise
    digest = hashlib.sha256()
    for chunk in iter(lambda: response["Body"].read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def put_immutable(client, bucket: str, path: Path, key: str) -> None:
    local_digest = sha256(path)
    remote_digest = object_digest(client, bucket, key)
    if remote_digest is not None:
        if remote_digest != local_digest:
            raise RuntimeError(f"immutable object differs: {key}")
        print(f"UNCHANGED {key} sha256={local_digest}")
        return
    client.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": content_type(path),
            "CacheControl": "public, max-age=31536000, immutable",
        },
    )
    if object_digest(client, bucket, key) != local_digest:
        raise RuntimeError(f"R2 verification failed: {key}")
    print(f"UPLOADED {key} sha256={local_digest}")


def put_mutable(client, bucket: str, path: Path, key: str) -> None:
    local_digest = sha256(path)
    extra_args = {"ContentType": content_type(path), "CacheControl": "no-store"}
    if path.suffix.lower() == ".ps1":
        extra_args["ContentDisposition"] = 'attachment; filename="AliceRealm-App-Installer.ps1"'
    client.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs=extra_args,
    )
    if object_digest(client, bucket, key) != local_digest:
        raise RuntimeError(f"R2 verification failed: {key}")
    print(f"PROMOTED {key} sha256={local_digest}")


def public_digest(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "AliceRealmAppReleaseVerifier/1.0"})
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=180) as response:
        if response.status != 200:
            raise RuntimeError(f"public verification status {response.status}: {url}")
        for chunk in iter(lambda: response.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_public(public_url: str, files: list[tuple[str, Path]]) -> None:
    nonce = str(int(time.time()))
    for key, path in files:
        expected = sha256(path)
        url = f"{public_url.rstrip('/')}/{key}?release={nonce}"
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                actual = public_digest(url)
                if actual != expected:
                    raise RuntimeError(f"public digest mismatch: {key}")
                print(f"PUBLIC_OK {key} sha256={actual}")
                break
            except Exception as error:  # CDN propagation is retried, then fails closed.
                last_error = error
                if attempt == 3:
                    raise
                time.sleep(5)
        if last_error is not None and attempt == 3:
            raise last_error


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish the AliceRealm Windows App release to R2")
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--secrets-dir", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--installer-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    release_root = args.release_root.resolve()
    version_file = release_root / "latest" / "version.txt"
    installer = release_root / "install.ps1"
    version = version_file.read_text(encoding="ascii").strip()
    if not VERSION_RE.fullmatch(version):
        raise RuntimeError("invalid Windows App version pointer")

    immutable: list[tuple[str, Path]] = []
    for arch in ("x64", "arm64"):
        archive = release_root / version / f"alicerealm-app-windows-{arch}.zip"
        sidecar = Path(f"{archive}.sha256")
        for path in (archive, sidecar):
            if not path.is_file():
                raise RuntimeError(f"missing release file: {path}")
        expected = sidecar.read_text(encoding="ascii").strip().split()[0].lower()
        actual = sha256(archive)
        if expected != actual:
            raise RuntimeError(f"checksum mismatch: {archive.name}")
        immutable.extend(
            [
                (f"app/windows/{version}/{archive.name}", archive),
                (f"app/windows/{version}/{sidecar.name}", sidecar),
            ]
        )
    if not installer.is_file():
        raise RuntimeError(f"missing release file: {installer}")

    access_key = (args.secrets_dir / "r2_access_key_id.txt").read_text(encoding="utf-8").strip()
    secret_key = (args.secrets_dir / "r2_secret_access_key.txt").read_text(encoding="utf-8").strip()
    if not access_key or not secret_key:
        raise RuntimeError("R2 credentials are empty")
    client = boto3.client(
        "s3",
        endpoint_url=args.endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )

    installer_key = "app/windows/install.ps1"
    if args.installer_only:
        put_mutable(client, args.bucket, installer, installer_key)
        verify_public(args.public_url, [(installer_key, installer)])
        print("PROMOTED Windows App installer metadata")
        return

    for key, path in immutable:
        put_immutable(client, args.bucket, path, key)
    pointer_key = "app/windows/latest/version.txt"
    put_mutable(client, args.bucket, installer, installer_key)
    put_mutable(client, args.bucket, version_file, pointer_key)

    verify_public(
        args.public_url,
        immutable + [(installer_key, installer), (pointer_key, version_file)],
    )
    print(f"PUBLISHED Windows App {version}")


if __name__ == "__main__":
    main()
