#!/usr/bin/env python3
"""
Turn whatever lands in images/ into Instagram-ready files in ready/ and write
manifest.json for the scheduler worker (worker/index.js).

  images/<anything>.jpg|png|heic|webp|mp4|mov   →  ready/<stem>.jpg | ready/<stem>.mp4
  images/<stem>.txt                              →  caption for that file (optional)
  images/<folder>/ with 2 to 10 images           →  one carousel post, slides in filename order
                                                    (caption: <folder>/caption.txt or images/<folder>.txt)
  plan.json  {"posts":[{"file":"<stem>","date":"YYYY-MM-DD","caption":"…"}]}   (optional overrides)
  captions.txt                                   →  rotating captions for files without one
  A filename that starts with YYYY-MM-DD__ pins that date, e.g. 2026-09-20__glass.jpg

Runs in GitHub Actions on every push (see .github/workflows/prepare.yml) and
can be run locally: python3 scripts/prepare.py
"""
import hashlib, json, os, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGES, READY = ROOT / "images", ROOT / "ready"
REPO = os.environ.get("GITHUB_REPOSITORY", "your-user/your-repo")
BRANCH = os.environ.get("GITHUB_REF_NAME", "main")
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/ready/"
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}
MIN_RATIO, MAX_RATIO, MAX_WIDTH = 0.8, 1.91, 1440       # Instagram feed image bounds (4:5 … 1.91:1)
DATE_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2})__(.+)$")


def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-") or "post"


def parse_name(path: Path):
    stem = path.stem
    m = DATE_PREFIX.match(stem)
    date = m.group(1) if m else None
    return slug(stem), date


def captions_pool():
    f = ROOT / "captions.txt"
    if not f.exists():
        return []
    blocks, cur = [], []
    for line in f.read_text(encoding="utf-8").splitlines():
        if line.startswith("# ") or line.strip() == "#":
            continue
        if not line.strip():
            if cur:
                blocks.append("\n".join(cur).strip()); cur = []
            continue
        cur.append(line)
    if cur:
        blocks.append("\n".join(cur).strip())
    return blocks


def overrides():
    f = ROOT / "plan.json"
    if not f.exists():
        return {}
    try:
        posts = json.loads(f.read_text(encoding="utf-8")).get("posts", [])
    except json.JSONDecodeError as e:
        sys.exit(f"plan.json is not valid JSON: {e}")
    return {slug(Path(p.get("file", "")).stem): p for p in posts if p.get("file")}


def file_hash(path: Path):
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def prepare_image(src: Path, out: Path):
    from PIL import Image, ImageOps
    try:
        import pillow_heif; pillow_heif.register_heif_opener()
    except ImportError:
        pass
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    w, h = im.size
    ratio = w / h
    if ratio < MIN_RATIO:
        nh = int(w / MIN_RATIO); top = (h - nh) // 2; im = im.crop((0, top, w, top + nh))
    elif ratio > MAX_RATIO:
        nw = int(h * MAX_RATIO); left = (w - nw) // 2; im = im.crop((left, 0, left + nw, h))
    if im.width > MAX_WIDTH:
        im = im.resize((MAX_WIDTH, int(im.height * MAX_WIDTH / im.width)), Image.LANCZOS)
    im.save(out, "JPEG", quality=90, optimize=True)


def prepare_video(src: Path, out: Path):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                    "-vf", "scale='min(1080,iw)':-2", "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
                    "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "21", "-r", "30",
                    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", str(out)], check=True)


def main():
    READY.mkdir(exist_ok=True)
    state_file = READY / ".prepared.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    sources = sorted(p for p in IMAGES.iterdir() if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in IMAGE_EXT | VIDEO_EXT)
    ov = overrides()
    pool = captions_pool()
    items, seen, pool_i = [], set(), 0
    for folder in sorted(p for p in IMAGES.iterdir() if p.is_dir() and not p.name.startswith(".")):
        stem, date = parse_name(folder)
        if stem in seen:
            print(f"skip duplicate stem {stem} ({folder.name})"); continue
        slides = sorted(p for p in folder.iterdir() if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in IMAGE_EXT)
        if not 2 <= len(slides) <= 10:
            print(f"skip carousel {folder.name}: needs 2 to 10 images, has {len(slides)}"); continue
        seen.add(stem)
        outdir = READY / stem
        outdir.mkdir(exist_ok=True)
        children = []
        for n, src in enumerate(slides, 1):
            out = outdir / f"{n:02d}.jpg"
            key = f"{stem}/{n:02d}"
            digest = file_hash(src)
            if state.get(key) != digest or not out.exists():
                print(f"prepare {folder.name}/{src.name} → {stem}/{out.name}")
                prepare_image(src, out)
                state[key] = digest
            children.append(RAW + f"{stem}/{out.name}")
        for old in outdir.iterdir():
            if old.name.endswith(".jpg") and int(old.stem) > len(slides):
                old.unlink(); state.pop(f"{stem}/{old.stem}", None)
        o = ov.get(stem, {})
        cap_file = folder / "caption.txt"
        side = IMAGES / f"{folder.name}.txt"
        caption = (cap_file.read_text(encoding="utf-8").strip() if cap_file.exists() else "") or (side.read_text(encoding="utf-8").strip() if side.exists() else "") or o.get("caption", "")
        if not caption and pool:
            caption = pool[pool_i % len(pool)]; pool_i += 1
        items.append({
            "stem": stem, "file": f"ready/{stem}/01.jpg", "url": children[0],
            "type": "CAROUSEL", "children": children, "caption": caption,
            "date": o.get("date") or date, "source": f"images/{folder.name}/",
            "bytes": sum((outdir / f"{n:02d}.jpg").stat().st_size for n in range(1, len(slides) + 1)),
        })
    for src in sources:
        stem, date = parse_name(src)
        if stem in seen:
            print(f"skip duplicate stem {stem} ({src.name})"); continue
        seen.add(stem)
        is_video = src.suffix.lower() in VIDEO_EXT
        out = READY / f"{stem}.{'mp4' if is_video else 'jpg'}"
        digest = file_hash(src)
        if state.get(stem) != digest or not out.exists():
            print(f"prepare {src.name} → {out.name}")
            (prepare_video if is_video else prepare_image)(src, out)
            state[stem] = digest
        o = ov.get(stem, {})
        sidecar = src.with_suffix(".txt")
        caption = (sidecar.read_text(encoding="utf-8").strip() if sidecar.exists() else "") or o.get("caption", "")
        if not caption and pool:
            caption = pool[pool_i % len(pool)]; pool_i += 1
        items.append({
            "stem": stem, "file": f"ready/{out.name}", "url": RAW + out.name,
            "type": "REEL" if is_video else "IMAGE", "caption": caption,
            "date": o.get("date") or date, "source": f"images/{src.name}",
            "bytes": out.stat().st_size,
        })
    # clean up ready files whose source is gone
    for old in READY.iterdir():
        if old.is_file() and not old.name.startswith(".") and old.stem not in seen:
            print(f"remove {old.name} (source deleted)"); old.unlink(); state.pop(old.stem, None)
        elif old.is_dir() and old.name not in seen:
            import shutil
            print(f"remove {old.name}/ (carousel deleted)"); shutil.rmtree(old)
            for k in [k for k in state if k.startswith(old.name + "/")]: state.pop(k)
    items.sort(key=lambda it: ((it["date"] or "9999"), it["stem"]))
    manifest = {"platform": "instagram", "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "count": len(items), "items": items}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    state_file.write_text(json.dumps(state, indent=2) + "\n")
    print(f"manifest.json: {len(items)} item(s)")


if __name__ == "__main__":
    main()
