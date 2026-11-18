"""Download CC0 Poly Haven assets (1k) into <dest>/<asset>/.

Models: the .blend plus the textures it references. Textures: diffuse / normal / roughness JPGs.
"""
import json
import pathlib
import sys
import urllib.request

API = "https://api.polyhaven.com"
UA = {"User-Agent": "bookshelf-template-builder"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def download(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return path.stat().st_size
    data = get(url)
    path.write_bytes(data)
    return len(data)


def fetch_model(asset, dest, res="1k"):
    files = json.loads(get(f"{API}/files/{asset}"))
    entry = files["blend"][res]["blend"]
    total = download(entry["url"], dest / asset / f"{asset}.blend")
    for rel, inc in entry.get("include", {}).items():
        total += download(inc["url"], dest / asset / rel)
    return total


def fetch_texture(asset, dest, res="1k"):
    files = json.loads(get(f"{API}/files/{asset}"))
    total = 0
    for key, name in (("Diffuse", "diff"), ("nor_gl", "nor"), ("Rough", "rough")):
        if key not in files:
            continue
        url = files[key][res]["jpg"]["url"]
        total += download(url, dest / asset / f"{asset}_{name}.jpg")
    return total


if __name__ == "__main__":
    dest = pathlib.Path(sys.argv[1])
    kind = sys.argv[2]
    for asset in sys.argv[3:]:
        size = fetch_model(asset, dest) if kind == "models" else fetch_texture(asset, dest)
        print(f"{asset}: {size / 1e6:.2f} MB")
