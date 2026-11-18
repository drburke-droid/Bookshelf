# SPDX-License-Identifier: GPL-3.0-or-later
"""Bookshelf Generator: build a 3D bookshelf from a Goodreads (or any) CSV book list.

Use it either way:
  * open the template .blend that ships with this script, or
  * install this file as an add-on (Edit > Preferences > Add-ons > Install from Disk).

Then: 3D Viewport > Sidebar (press N) > "Bookshelf" tab > choose your CSV > Build Bookshelf.
"""

bl_info = {
    "name": "Bookshelf Generator",
    "author": "Bookshelf project",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "3D Viewport > Sidebar (N) > Bookshelf",
    "description": "Build a 3D bookshelf from a Goodreads (or any) CSV book list",
    "category": "Object",
}

import colorsys
import csv
import datetime
import io
import itertools
import math
import os
import random
import re
import zlib

import bpy
from mathutils import Matrix, Vector

# --------------------------------------------------------------------------------------
# Names of the things this script creates or looks for
# --------------------------------------------------------------------------------------

COLL_ROOT = "Bookshelf"
COLL_BOOKS = "Bookshelf Books"
COLL_SHELVES = "Bookshelf Shelves"
COLL_DECOR = "Bookshelf Decor"
COLL_ROOM = "Bookshelf Room"
COLL_PROPS = "Bookshelf Props"      # put your own decorations in here (one collection each)
SAMPLE_TEXT = "sample_books.csv"    # built-in book list used when no CSV is chosen

MAT_COVER = "BS Book Cover"
MAT_PAGES = "BS Book Pages"
MAT_TEXT_LIGHT = "BS Title Light"
MAT_TEXT_GOLD = "BS Title Gold"
MAT_TEXT_DARK = "BS Title Dark"
MAT_WOOD = "BS Shelf Wood"
MAT_WALL = "BS Wallpaper"
MAT_FLOOR = "BS Floor"

# --------------------------------------------------------------------------------------
# Sizes, in metres
# --------------------------------------------------------------------------------------

SHELF_THICK = 0.022
SHELF_DEPTH = 0.20
SHELF_END_MARGIN = 0.025     # bare board left and right of the books
ROW_HEADROOM = 0.05          # air between the tallest book and the shelf above
MAX_BOOK_H = 0.240
BOOK_GAP = 0.0006            # hairline gap between neighbouring books
MIN_SHELF_W = 0.50
ROW_SLACK = 0.07             # share of every shelf kept free for gaps and leaning books
BASE_Z = 0.80                # height of the lowest shelf above the floor
TEXT_LIFT = 0.0005           # how far titles float in front of the spine
MAX_TEXT_SIZE = 0.026

PALETTES = {
    "CLASSIC": ["3d2a55", "5a3a5e", "2e2f5e", "2f4a35", "5b6238", "2c5557", "1f2d4a", "4a4f5c",
                "b59a78", "d9ccb0", "5c4033", "7a4a32", "a4532f", "8c2f2a", "a67f7b", "b58e3a",
                "25232a", "3b5a48", "6b4a6e"],
    "LEATHER": ["4a2c1d", "6b3a22", "3a1f1a", "5a1e1e", "2a3a2a", "1f2a3a", "7a5230", "2b2320",
                "8a6a3a", "40302a", "6e2a2a", "24332b"],
    "VIVID": ["d7263d", "f46036", "f2c14e", "2e9e6b", "1b998b", "2274a5", "3a4fb5", "7b3fa0",
              "e75480", "111111", "f5f1e6", "ff8c42"],
    "PASTEL": ["f4c7c3", "f9dcc4", "fbeec1", "cfe8cf", "bfe3e0", "c5d8f0", "d5c9ee", "efc9e2",
               "e8e4da", "b9c7b2", "d8b9a0", "aebfd0"],
    "MONO": ["111214", "2a2c30", "45484e", "6b6f76", "9a9da3", "c9c9c6", "e9e6de", "f6f3ea",
             "3a3530", "8c857a"],
}


# --------------------------------------------------------------------------------------
# Reading the book list
# --------------------------------------------------------------------------------------

COLUMN_ALIASES = {
    "title": ("title", "book title", "name"),
    "author": ("author", "authors", "author l f"),
    "pages": ("number of pages", "pages", "page count", "num pages"),
    "shelf": ("exclusive shelf", "read status", "status", "shelf"),
    "date_read": ("date read", "last date read", "date finished", "finished"),
    "date_added": ("date added",),
    "rating": ("my rating", "star rating", "rating"),
    "binding": ("binding", "format"),
    "year": ("original publication year", "year published", "year"),
}

SHELF_WORDS = {
    "read": "READ", "finished": "READ",
    "currently reading": "CURRENT", "reading": "CURRENT",
    "to read": "TO_READ", "want to read": "TO_READ", "tbr": "TO_READ",
}

DATE_FORMATS = ("%Y/%m/%d", "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m", "%Y-%m", "%Y")


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _parse_date(text):
    text = (text or "").strip()
    if not text:
        return None
    text = text.split(" ")[0].split("T")[0]
    for fmt in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _parse_number(text):
    match = re.search(r"\d+(?:\.\d+)?", (text or "").replace(",", ""))
    return float(match.group()) if match else None


def clean_title(title, shorten):
    """'A Storm of Swords (A Song of Ice and Fire, #3)' -> 'A Storm of Swords'."""
    title = " ".join(title.split())
    title = re.sub(r"\s*\([^()]*#\s*[\d.,\-–&\s]+[^()]*\)\s*$", "", title)
    if shorten and len(title) > 26:
        for sep in (": ", " - ", " — ", "; "):
            head = title.split(sep)[0].strip()
            if 3 <= len(head) < len(title):
                title = head
                break
        title = re.sub(r"\s*\([^()]*\)\s*$", "", title) or title
    return title


def decode_csv(raw):
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def read_books(text, shelf_filter="READ", year=0, shorten=True):
    """Parse CSV text into a list of book dicts. Raises ValueError with a readable message."""
    sample = text[:4096]
    delimiter = ","
    first_line = sample.split("\n", 1)[0]
    for cand in (";", "\t"):
        if first_line.count(cand) > first_line.count(delimiter):
            delimiter = cand
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        raise ValueError("The CSV file is empty.")

    header = [_norm(h) for h in rows[0]]
    col = {}
    for key, names in COLUMN_ALIASES.items():
        for name in names:
            if name in header:
                col[key] = header.index(name)
                break
    if "title" not in col:
        raise ValueError("No 'Title' column found. The first row of the CSV must name the columns.")

    def cell(row, key):
        idx = col.get(key)
        return row[idx].strip() if idx is not None and idx < len(row) else ""

    books = []
    counts = {"total": 0, "wrong_shelf": 0, "wrong_year": 0}
    for row in rows[1:]:
        raw_title = cell(row, "title")
        if not raw_title:
            continue
        counts["total"] += 1
        shelf = SHELF_WORDS.get(_norm(cell(row, "shelf")), "OTHER") if "shelf" in col else "READ"
        if shelf_filter != "ALL" and shelf != shelf_filter:
            counts["wrong_shelf"] += 1
            continue
        date_read = _parse_date(cell(row, "date_read"))
        if year and (date_read is None or date_read.year != year):
            counts["wrong_year"] += 1
            continue
        pages = _parse_number(cell(row, "pages"))
        author = cell(row, "author")
        if "author" in col and header[col["author"]] == "author l f":      # "Last, First"
            author = " ".join(part.strip() for part in reversed(author.split(",", 1)))
        else:                                                              # first of several authors
            author = re.split(r"[,;&]", author)[0].strip()
        books.append({
            "title": clean_title(raw_title, shorten),
            "full_title": raw_title,
            "author": author,
            "pages": int(pages) if pages and pages > 0 else None,
            "date_read": date_read,
            "date_added": _parse_date(cell(row, "date_added")),
            "rating": _parse_number(cell(row, "rating")) or 0.0,
            "binding": cell(row, "binding").lower(),
            "year": _parse_number(cell(row, "year")),
            "index": len(books),
        })
    return books, counts


# --------------------------------------------------------------------------------------
# Turning a book into a size and a colour
# --------------------------------------------------------------------------------------

def _book_rng(book, seed, salt=0):
    key = f"{book['full_title']}|{book['author']}".encode("utf-8", "replace")
    return random.Random(zlib.crc32(key) ^ (seed * 7919) ^ salt)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(hex_colour):
    return tuple(srgb_to_linear(int(hex_colour[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


def assign_looks(books, opts):
    """Give every book a thickness, height, depth and cover colour."""
    palette = [hex_to_linear(h) for h in PALETTES.get(opts["palette"], PALETTES["CLASSIC"])]
    for book in books:
        rng = _book_rng(book, opts["seed"])
        pages = book["pages"] or rng.randint(180, 420)
        thick = (0.004 + pages * 0.000055) * opts["thickness_scale"]
        book["t"] = min(max(thick, 0.007), 0.075)

        binding = book["binding"]
        if "mass market" in binding:
            kind = "pocket"
        elif "hard" in binding or "leather" in binding or "library" in binding:
            kind = "hard"
        elif "paper" in binding or "soft" in binding:
            kind = "paper"
        else:
            kind = rng.choices(("paper", "hard", "pocket"), weights=(5, 3, 2))[0]
        if kind == "hard":
            book["h"], book["d"] = rng.uniform(0.212, MAX_BOOK_H), rng.uniform(0.148, 0.160)
        elif kind == "pocket":
            book["h"], book["d"] = rng.uniform(0.168, 0.180), rng.uniform(0.104, 0.112)
        else:
            book["h"], book["d"] = rng.uniform(0.192, 0.214), rng.uniform(0.126, 0.140)
        book["hard"] = kind == "hard"

        if opts["color_mode"] == "AUTHOR" and book["author"]:
            pick = random.Random(zlib.crc32(book["author"].encode("utf-8", "replace")) ^ opts["seed"])
        else:
            pick = rng
        r, g, b = pick.choice(palette)
        jitter = 1.0 + rng.uniform(-0.12, 0.12)
        book["color"] = (min(r * jitter, 1.0), min(g * jitter, 1.0), min(b * jitter, 1.0))
        lum = 0.2126 * book["color"][0] + 0.7152 * book["color"][1] + 0.0722 * book["color"][2]
        if lum > 0.16:                       # light cover: dark lettering
            book["text_mat"] = MAT_TEXT_DARK
        elif lum < 0.05 and rng.random() < 0.35:
            book["text_mat"] = MAT_TEXT_GOLD   # gold foil only reads well on dark covers
        else:
            book["text_mat"] = MAT_TEXT_LIGHT
        book["bands"] = rng.random() < 0.35 and book["t"] > 0.012
        book["push"] = rng.uniform(0.0, 0.008)   # how far the book is pushed back on the shelf


def sort_books(books, mode, reverse, seed):
    last = datetime.date.min
    if mode == "DATE_READ":
        books.sort(key=lambda b: (b["date_read"] or b["date_added"] or last, b["index"]))
    elif mode == "AUTHOR":
        books.sort(key=lambda b: ((b["author"].split() or [""])[-1].lower(), b["author"].lower(),
                                  b["year"] or 0, b["title"].lower()))
    elif mode == "TITLE":
        books.sort(key=lambda b: re.sub(r"^(the|a|an)\s+", "", b["title"].lower()))
    elif mode == "PAGES":
        books.sort(key=lambda b: -b["t"])
    elif mode == "RATING":
        books.sort(key=lambda b: (-b["rating"], b["index"]))
    elif mode == "COLOR":
        def hue_key(b):
            h, s, v = colorsys.rgb_to_hsv(*b["color"])
            return (0, v) if s < 0.18 else (1, h, v)
        books.sort(key=hue_key)
    elif mode == "RANDOM":
        random.Random(seed).shuffle(books)
    if reverse:
        books.reverse()


# --------------------------------------------------------------------------------------
# Layout: which book goes where (no Blender calls in this section)
# --------------------------------------------------------------------------------------

def _lean_reach(book, neighbour_h, angle):
    """Horizontal distance between a leaning book's foot and the book it rests on."""
    return min(book["h"] * math.cos(angle), neighbour_h) * math.tan(angle)


def _run_width(run):
    return sum(b["t"] + BOOK_GAP for b in run)


def plan_layout(books, opts, props, aspect):
    """Return a dict describing rows, shelf width and one placement per book / decoration.

    props: list of (name, width, depth, height) for the decorations that may be used.
    aspect: width / height of the rendered image, used to pick the number of shelves.
    """
    rng = random.Random(opts["seed"] * 104729 + 17)
    pitch = MAX_BOOK_H + ROW_HEADROOM + SHELF_THICK
    clear_h = pitch - SHELF_THICK
    total_w = _run_width(books)
    mean_t = total_w / max(len(books), 1)

    # Scale decorations so they fit under the next shelf and on the board.
    fitted = []
    for name, pw, pd, ph in props:
        if min(pw, pd, ph) <= 0:
            continue
        scale = min(1.0, (clear_h - 0.035) / ph, (SHELF_DEPTH - 0.03) / pd, 0.30 / pw)
        fitted.append({"name": name, "scale": scale, "w": pw * scale})
    avg_prop_w = sum(p["w"] for p in fitted) / len(fitted) if fitted else 0.0

    def decor_counts(n):
        n_props = min(int(n * 0.5 + 0.5), n) if (opts["decor"] and fitted) else 0
        n_stacks = int(n * 0.34 + 0.5) if (opts["stacks"] and len(books) >= 14 and n >= 2) else 0
        return n_props, n_stacks

    stack_reserve = max(0.21 - 3 * mean_t, 0.05)

    def shelf_width_for(n):
        n_props, n_stacks = decor_counts(n)
        reserved = n_props * (avg_prop_w + 0.04) + n_stacks * stack_reserve
        return max(MIN_SHELF_W, (total_w + reserved) / n / (1.0 - ROW_SLACK))

    if opts["rows"] > 0:
        n_rows = opts["rows"]
    else:
        # Pick the shelf count that lets the books appear largest in the picture.
        best = None
        for n in range(1, 81):
            width = shelf_width_for(n) + 2 * SHELF_END_MARGIN
            zoom = min(aspect / width, 1.0 / (n * pitch))
            if best is None or zoom > best[0] * 1.001:
                best = (zoom, n)
        n_rows = best[1]
    n_rows = max(1, min(n_rows, max(1, len(books))))

    # Decide which shelves get a decoration or a flat stack of books.
    n_props, n_stacks = decor_counts(n_rows)
    order = list(range(n_rows))
    rng.shuffle(order)
    row_stack = {r: True for r in order[:n_stacks]}
    prop_rows = (order[n_stacks:] + order[:n_stacks])[:n_props]
    prop_cycle = fitted[:]
    rng.shuffle(prop_cycle)
    row_prop = {r: prop_cycle[i % len(prop_cycle)] for i, r in enumerate(prop_rows)}

    reserved = [(row_prop[r]["w"] + 0.04 if r in row_prop else 0.0) +
                (stack_reserve if r in row_stack else 0.0) for r in range(n_rows)]

    # Share the books out so every shelf ends up about equally full.
    rows = [[] for _ in range(n_rows)]
    idx = 0
    remaining = total_w
    for r in range(n_rows):
        if r == n_rows - 1:
            rows[r] = books[idx:]
            break
        target = (remaining + sum(reserved[r:])) / (n_rows - r) - reserved[r]
        acc = 0.0
        must_leave = n_rows - r - 1          # keep at least one book for each later shelf
        while idx < len(books) - must_leave:
            step = books[idx]["t"] + BOOK_GAP
            if rows[r] and acc + step / 2 > target:
                break
            rows[r].append(books[idx])
            acc += step
            idx += 1
        remaining -= acc

    # Build the left-to-right sequence of segments for every shelf.
    row_segments = []
    for r, row_books in enumerate(rows):
        run = list(row_books)
        segs = []
        stack = None
        stack_side = None
        if r in row_stack and len(run) >= 8:
            k = rng.choice((2, 3, 3, 4))
            stack_side = rng.choice("LR")
            taken = run[:k] if stack_side == "L" else run[-k:]
            while taken and sum(b["t"] for b in taken) > clear_h - 0.03:
                taken = taken[:-1]
            if len(taken) >= 2:
                run = run[len(taken):] if stack_side == "L" else run[:len(run) - len(taken)]
                stack = {"kind": "stack", "books": taken, "w": max(b["h"] for b in taken)}
            else:
                stack_side = None
        prop = None
        if r in row_prop:
            prop = dict(row_prop[r], kind="prop")
        end_gap = None
        if prop:
            sides = [s for s in "LRM" if s != stack_side and (s != "M" or len(run) >= 8)]
            side = rng.choice(sides)
            if side == "M":
                cut = rng.randint(int(len(run) * 0.35), int(len(run) * 0.65))
                segs = [{"kind": "run", "books": run[:cut]}, prop, {"kind": "run", "books": run[cut:]}]
            elif side == "L":
                segs = [prop, {"kind": "run", "books": run}]
            else:
                segs = [{"kind": "run", "books": run}, prop]
        elif stack is None and len(run) >= 10 and rng.random() < 0.6:
            cut = rng.randint(int(len(run) * 0.3), int(len(run) * 0.7))
            segs = [{"kind": "run", "books": run[:cut]}, {"kind": "run", "books": run[cut:]}]
        else:
            segs = [{"kind": "run", "books": run}]
            if stack is None:
                end_gap = "R" if rng.random() < 0.7 else "L"
        if stack:
            segs = [stack] + segs if stack_side == "L" else segs + [stack]
        segs = [s for s in segs if s["kind"] != "run" or s["books"]]
        for s in segs:
            if s["kind"] == "run":
                s["w"] = _run_width(s["books"])
        row_segments.append((segs, end_gap))

    content = [sum(s["w"] for s in segs) for segs, _ in row_segments]
    shelf_w = max(MIN_SHELF_W, max(content) / (1.0 - ROW_SLACK))

    # Place everything on its shelf.
    placements = []
    for r, (segs, end_gap) in enumerate(row_segments):
        free = shelf_w - sum(s["w"] for s in segs)
        weights = [0.0] * (len(segs) + 1)
        for j in range(1, len(segs)):
            weights[j] = 1.0
        if segs and segs[0]["kind"] != "run":
            weights[0] = 0.45
        if segs and segs[-1]["kind"] != "run":
            weights[-1] = 0.45
        if end_gap == "L":
            weights[0] = 1.0
        elif end_gap == "R":
            weights[-1] = 1.0
        if sum(weights) == 0:
            weights[-1] = 1.0
        gaps = [free * w / sum(weights) for w in weights]
        for j in range(1, len(segs)):        # no wide holes between two runs of books
            if segs[j - 1]["kind"] == "run" and segs[j]["kind"] == "run" and gaps[j] > 0.11:
                gaps[-1] += gaps[j] - 0.11
                gaps[j] = 0.11

        # Leaning books next to a gap.
        if opts["leaning"]:
            for j in range(len(segs) + 1):
                if gaps[j] < 0.03:
                    continue
                left = segs[j - 1] if j > 0 else None
                right = segs[j] if j < len(segs) else None
                options = []
                if (left and left["kind"] == "run" and len(left["books"]) >= 3
                        and "lean_last" not in left and left["books"][-1]["t"] < 0.045):
                    options.append(("lean_last", left))
                if (right and right["kind"] == "run" and len(right["books"]) >= 3
                        and "lean_first" not in right and right["books"][0]["t"] < 0.045):
                    options.append(("lean_first", right))
                if not options or rng.random() > 0.8:
                    continue
                key, seg = rng.choice(options)
                book = seg["books"][-1] if key == "lean_last" else seg["books"][0]
                neighbour = seg["books"][-2] if key == "lean_last" else seg["books"][1]
                angle = math.radians(rng.uniform(7.0, 17.0))
                extra = book["t"] * math.cos(angle) + _lean_reach(book, neighbour["h"], angle) - book["t"]
                if extra > gaps[j] - 0.012:
                    continue
                seg[key] = angle
                seg["w"] += extra
                gaps[j] -= extra

        x = 0.0
        for j, seg in enumerate(segs):
            x += gaps[j]
            if seg["kind"] == "prop":
                placements.append({"kind": "prop", "row": r, "name": seg["name"], "scale": seg["scale"],
                                   "cx": x + seg["w"] / 2, "rot": math.radians(rng.uniform(-10, 10))})
            elif seg["kind"] == "stack":
                z = 0.0
                for book in sorted(seg["books"], key=lambda b: -b["h"]):
                    placements.append({"kind": "flat", "row": r, "book": book, "z": z,
                                       "cx": x + seg["w"] / 2 + rng.uniform(-0.008, 0.008),
                                       "rot": math.radians(rng.uniform(-5, 5))})
                    z += book["t"] + 0.0003
            else:
                run = seg["books"]
                cursor = x
                for i, book in enumerate(run):
                    if i == 0 and "lean_first" in seg:
                        angle = seg["lean_first"]
                        pivot = cursor + book["t"] * math.cos(angle)
                        placements.append({"kind": "lean", "row": r, "book": book,
                                           "pivot": pivot, "angle": angle})
                        cursor = pivot + _lean_reach(book, run[1]["h"], angle)
                    elif i == len(run) - 1 and "lean_last" in seg:
                        angle = seg["lean_last"]
                        pivot = cursor - BOOK_GAP + _lean_reach(book, run[-2]["h"], angle)
                        placements.append({"kind": "lean", "row": r, "book": book,
                                           "pivot": pivot, "angle": -angle})
                        cursor = pivot + book["t"] * math.cos(angle) + BOOK_GAP
                    else:
                        placements.append({"kind": "up", "row": r, "book": book, "x": cursor})
                        cursor += book["t"] + BOOK_GAP
            x += seg["w"]

    return {"rows": n_rows, "shelf_w": shelf_w, "pitch": pitch, "clear_h": clear_h,
            "placements": placements}


# --------------------------------------------------------------------------------------
# Spine titles
# --------------------------------------------------------------------------------------

def split_lines(words, n):
    """Break words into n lines so the longest line is as short as possible."""
    if n <= 1 or len(words) <= 1:
        return [" ".join(words)]
    n = min(n, len(words))
    best = None
    for cuts in itertools.combinations(range(1, len(words)), n - 1):
        bounds = (0,) + cuts + (len(words),)
        lines = [" ".join(words[a:b]) for a, b in zip(bounds, bounds[1:])]
        longest = max(len(line) for line in lines)
        if best is None or longest < best[0]:
            best = (longest, lines)
    return best[1]


def choose_title_layout(title, width_em, book, flat):
    """Pick line breaks and direction for a title. width_em: width of the one-line title at size 1."""
    words = title.split()
    if len(words) > 9:                      # keep the search small for very long titles
        words = words[:8] + [" ".join(words[8:])]
    chars = max(len(title), 1)
    spine_len = book["h"] * (0.78 if book["bands"] else 0.84)
    spine_w = book["t"] * 0.64
    best = None

    def block_h(lines):
        return (lines - 1) * 0.92 + 0.72

    for n in (1, 2, 3):
        if n > len(words):
            break
        lines = split_lines(words, n)
        longest_em = width_em * max(len(line) for line in lines) / chars * (1.0 if n == 1 else 1.04)
        size = min(spine_len / max(longest_em, 0.01), spine_w / block_h(n), MAX_TEXT_SIZE)
        if best is None or size > best[0] * 1.02:
            best = (size, "V", lines)
    if not flat and len(words) <= 6:
        for n in range(max(1, len(words) - 2), len(words) + 1):
            lines = split_lines(words, n)
            longest_em = width_em * max(len(line) for line in lines) / chars * 1.04
            size = min(book["t"] * 0.80 / max(longest_em, 0.01), book["h"] * 0.80 / block_h(n),
                       MAX_TEXT_SIZE)
            if size * 0.9 > best[0]:
                best = (size * 0.9, "H", lines)
    return best


# --------------------------------------------------------------------------------------
# Blender helpers
# --------------------------------------------------------------------------------------

def ensure_collection(name, parent, exclude=False):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
    if name not in parent.children and not _is_descendant(parent, coll):
        parent.children.link(coll)
    if exclude:
        layer = _find_layer_collection(bpy.context.view_layer.layer_collection, name)
        if layer is not None:
            layer.exclude = True
    return coll


def _is_descendant(parent, coll):
    return any(child == coll or _is_descendant(child, coll) for child in parent.children)


def _find_layer_collection(layer, name):
    if layer.collection.name == name:
        return layer
    for child in layer.children:
        found = _find_layer_collection(child, name)
        if found is not None:
            return found
    return None


def clear_collection(coll):
    objects = list(coll.objects)
    data = {ob.data for ob in objects if ob.data is not None}
    if objects:
        bpy.data.batch_remove(objects)
    orphans = [d for d in data if d.users == 0]
    if orphans:
        bpy.data.batch_remove(orphans)


def new_material(name):
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:  # noqa: BLE001  (always node based in newer Blender versions)
        pass
    mat.node_tree.nodes.clear()
    return mat


def _principled(mat, base=(0.8, 0.8, 0.8), rough=0.5, metallic=0.0):
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (100, 0)
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def material(name):
    """Fetch a material by name, creating a simple procedural version if the file has none."""
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = new_material(name)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links

    if name == MAT_COVER:
        bsdf = _principled(mat, rough=0.62)
        info = nodes.new("ShaderNodeObjectInfo")
        info.location = (-500, 100)
        links.new(info.outputs["Color"], bsdf.inputs["Base Color"])
        noise = nodes.new("ShaderNodeTexNoise")
        noise.location = (-500, -150)
        noise.inputs["Scale"].default_value = 900.0
        noise.inputs["Detail"].default_value = 3.0
        bump = nodes.new("ShaderNodeBump")
        bump.location = (-200, -150)
        bump.inputs["Strength"].default_value = 0.06
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        rough = nodes.new("ShaderNodeMapRange")
        rough.location = (-200, 100)
        rough.inputs["To Min"].default_value = 0.45
        rough.inputs["To Max"].default_value = 0.8
        links.new(info.outputs["Random"], rough.inputs["Value"])
        links.new(rough.outputs["Result"], bsdf.inputs["Roughness"])
    elif name == MAT_PAGES:
        bsdf = _principled(mat, base=(0.86, 0.80, 0.66), rough=0.85)
        coord = nodes.new("ShaderNodeTexCoord")
        coord.location = (-900, 0)
        mapping = nodes.new("ShaderNodeMapping")
        mapping.location = (-700, 0)
        mapping.inputs["Scale"].default_value = (2600.0, 1.0, 1.0)
        noise = nodes.new("ShaderNodeTexNoise")
        noise.location = (-500, 0)
        noise.inputs["Scale"].default_value = 1.0
        ramp = nodes.new("ShaderNodeMapRange")
        ramp.location = (-300, 0)
        ramp.inputs["To Min"].default_value = 0.65
        ramp.inputs["To Max"].default_value = 1.05
        mult = nodes.new("ShaderNodeMix")
        mult.data_type = "RGBA"
        mult.blend_type = "MULTIPLY"
        mult.location = (-100, 0)
        mult.inputs[0].default_value = 1.0
        mult.inputs[6].default_value = (0.86, 0.80, 0.66, 1.0)
        links.new(coord.outputs["Object"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
        links.new(noise.outputs["Fac"], ramp.inputs["Value"])
        links.new(ramp.outputs["Result"], mult.inputs[7])
        links.new(mult.outputs[2], bsdf.inputs["Base Color"])
    elif name == MAT_TEXT_LIGHT:
        _principled(mat, base=(0.87, 0.82, 0.70), rough=0.5)
    elif name == MAT_TEXT_GOLD:
        _principled(mat, base=(0.83, 0.61, 0.22), rough=0.32, metallic=1.0)
    elif name == MAT_TEXT_DARK:
        _principled(mat, base=(0.02, 0.018, 0.016), rough=0.5)
    elif name == MAT_WOOD:
        bsdf = _principled(mat, rough=0.45)
        coord = nodes.new("ShaderNodeTexCoord")
        coord.location = (-900, 0)
        mapping = nodes.new("ShaderNodeMapping")
        mapping.location = (-700, 0)
        mapping.inputs["Scale"].default_value = (0.6, 9.0, 9.0)
        noise = nodes.new("ShaderNodeTexNoise")
        noise.location = (-500, 0)
        noise.inputs["Scale"].default_value = 6.0
        noise.inputs["Detail"].default_value = 6.0
        ramp = nodes.new("ShaderNodeValToRGB")
        ramp.location = (-300, 0)
        ramp.color_ramp.elements[0].color = (0.22, 0.10, 0.045, 1.0)
        ramp.color_ramp.elements[1].color = (0.52, 0.30, 0.15, 1.0)
        links.new(coord.outputs["Object"], mapping.inputs["Vector"])
        links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
        links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
        links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    elif name == MAT_WALL:
        _build_wallpaper(mat)
    elif name == MAT_FLOOR:
        _principled(mat, base=(0.16, 0.10, 0.07), rough=0.4)
    else:
        _principled(mat)
    return mat


def _build_wallpaper(mat):
    """Diamond-lattice wallpaper. The nodes named 'Wall Colour' and 'Pattern' are driven by the panel."""
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = _principled(mat, rough=0.7)

    def math_node(op, x, y, a=None, b=None):
        node = nodes.new("ShaderNodeMath")
        node.operation = op
        node.location = (x, y)
        for idx, val in enumerate((a, b)):
            if val is None:
                continue
            if isinstance(val, (int, float)):
                node.inputs[idx].default_value = val
            else:
                links.new(val, node.inputs[idx])
        return node.outputs[0]

    coord = nodes.new("ShaderNodeTexCoord")
    coord.location = (-1900, 0)
    sep = nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-1700, 0)
    links.new(coord.outputs["Object"], sep.inputs["Vector"])
    cell = 0.11                                   # size of one diamond in metres
    u = math_node("DIVIDE", -1500, 100, sep.outputs["X"], cell)
    v = math_node("DIVIDE", -1500, -100, sep.outputs["Z"], cell * 1.5)
    a = math_node("FRACT", -1100, 100, math_node("ADD", -1300, 100, u, v))
    b = math_node("FRACT", -1100, -100, math_node("SUBTRACT", -1300, -100, u, v))
    da = math_node("ABSOLUTE", -700, 100, math_node("SUBTRACT", -900, 100, a, 0.5))
    db = math_node("ABSOLUTE", -700, -100, math_node("SUBTRACT", -900, -100, b, 0.5))
    lines = math_node("LESS_THAN", -300, 100, math_node("MINIMUM", -500, 100, da, db), 0.011)
    motif = math_node("GREATER_THAN", -300, -100, math_node("MINIMUM", -500, -100, da, db), 0.42)
    mask = math_node("MAXIMUM", -100, 0, lines, motif)

    pattern = nodes.new("ShaderNodeValue")
    pattern.name = pattern.label = "Pattern"
    pattern.location = (-300, -300)
    pattern.outputs[0].default_value = 1.0
    mask = math_node("MULTIPLY", 100, -100, mask, pattern.outputs[0])

    colour = nodes.new("ShaderNodeRGB")
    colour.name = colour.label = "Wall Colour"
    colour.location = (-100, 300)
    colour.outputs[0].default_value = (0.09, 0.02, 0.03, 1.0)
    accent = nodes.new("ShaderNodeRGB")
    accent.name = accent.label = "Pattern Colour"
    accent.location = (-100, 150)
    accent.outputs[0].default_value = (0.55, 0.36, 0.16, 1.0)
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.location = (300, 200)
    links.new(mask, mix.inputs[0])
    links.new(colour.outputs[0], mix.inputs[6])
    links.new(accent.outputs[0], mix.inputs[7])

    bsdf.location = (600, 0)
    nodes["Material Output"].location = (900, 0)
    links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    links.new(math_node("MULTIPLY", 300, -100, mask, 0.85), bsdf.inputs["Metallic"])
    links.new(math_node("SUBTRACT", 300, -300, 0.75, math_node("MULTIPLY", 100, -300, mask, 0.4)),
              bsdf.inputs["Roughness"])


def apply_wall_settings(settings):
    mat = bpy.data.materials.get(MAT_WALL)
    if mat is None or mat.node_tree is None:
        return
    nodes = mat.node_tree.nodes
    if "Wall Colour" in nodes:
        nodes["Wall Colour"].outputs[0].default_value = (*settings.wall_color, 1.0)
    wall = bpy.data.objects.get("BS Wall")
    if wall is not None:
        wall.color = (*settings.wall_color, 1.0)
    if "Pattern" in nodes:
        nodes["Pattern"].outputs[0].default_value = 1.0 if settings.wall_pattern else 0.0


def box_mesh(name, x0, x1, y0, y1, z0, z1):
    verts = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
             (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    return mesh


def book_mesh(name, book):
    """A book standing upright: thickness along X, spine at Y=0 facing -Y, height along Z."""
    t, d, h = book["t"], book["d"], book["h"]
    hard = book["hard"]
    cover = min(0.0025 if hard else 0.0009, t * 0.2)
    radius = min(0.0022 if hard else 0.0010, t * 0.3)
    inset = 0.003 if hard else 0.0003

    profile = []
    steps = 3
    for i in range(steps + 1):
        ang = math.pi + (math.pi / 2) * i / steps
        profile.append((radius + radius * math.cos(ang), radius + radius * math.sin(ang)))
    for i in range(steps + 1):
        ang = 1.5 * math.pi + (math.pi / 2) * i / steps
        profile.append((t - radius + radius * math.cos(ang), radius + radius * math.sin(ang)))
    profile += [(t, d), (t - cover, d), (t - cover, cover), (cover, cover), (cover, d), (0.0, d)]

    n = len(profile)
    verts = [(x, y, 0.0) for x, y in profile] + [(x, y, h) for x, y in profile]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    mat_index = [0] * len(faces)

    # Page block
    eps = 0.0001
    px0, px1 = cover + eps, t - cover - eps
    py0, py1 = cover + eps, d - max(inset, 0.0006)
    pz0, pz1 = inset, h - inset
    base = len(verts)
    verts += [(px0, py0, pz0), (px1, py0, pz0), (px1, py1, pz0), (px0, py1, pz0),
              (px0, py0, pz1), (px1, py0, pz1), (px1, py1, pz1), (px0, py1, pz1)]
    for quad in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        faces.append(tuple(base + i for i in quad))
        mat_index.append(1)

    # Decorative bands across the spine
    if book["bands"]:
        bx0, bx1 = radius + 0.0006, t - radius - 0.0006
        for z_mid, half in ((h * 0.055, 0.0011), (h * 0.075, 0.0005),
                            (h * 0.945, 0.0011), (h * 0.925, 0.0005)):
            base = len(verts)
            verts += [(bx0, -TEXT_LIFT, z_mid - half), (bx1, -TEXT_LIFT, z_mid - half),
                      (bx1, -TEXT_LIFT, z_mid + half), (bx0, -TEXT_LIFT, z_mid + half)]
            faces.append((base, base + 1, base + 2, base + 3))
            mat_index.append(2)

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.polygons.foreach_set("material_index", mat_index)
    mesh.materials.append(material(MAT_COVER))
    mesh.materials.append(material(MAT_PAGES))
    mesh.materials.append(material(book["text_mat"]))
    if hasattr(mesh, "shade_smooth") and hasattr(mesh, "set_sharp_from_angle"):
        mesh.shade_smooth()
        mesh.set_sharp_from_angle(angle=math.radians(40))
    mesh.update()
    return mesh


def book_matrix(place, x_origin, z_row):
    book = place["book"]
    y_spine = -SHELF_DEPTH + 0.012 + book["push"]
    if place["kind"] == "up":
        return Matrix.Translation((x_origin + place["x"], y_spine, z_row))
    if place["kind"] == "lean":
        angle = place["angle"]
        mat = Matrix.Translation((x_origin + place["pivot"], y_spine, z_row)) @ Matrix.Rotation(angle, 4, "Y")
        if angle > 0:        # leaning right: pivots on its bottom-right edge
            mat = mat @ Matrix.Translation((-book["t"], 0.0, 0.0))
        return mat
    # flat: lying down, front cover up, spine towards the viewer
    return (Matrix.Translation((x_origin + place["cx"], -SHELF_DEPTH + 0.014 + book["d"] / 2,
                                z_row + place["z"]))
            @ Matrix.Rotation(place["rot"], 4, "Z")
            @ Matrix.Translation((book["h"] / 2, -book["d"] / 2, 0.0))
            @ Matrix.Rotation(math.radians(-90), 4, "Y"))


def prop_dimensions(coll):
    """Bounding box (width, depth, height) of a decoration collection, with its base at the origin."""
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))

    def world(ob):
        mat = ob.matrix_basis
        if ob.parent is not None:
            mat = world(ob.parent) @ ob.matrix_parent_inverse @ mat
        return mat

    found = False
    for ob in coll.all_objects:
        if ob.type not in {"MESH", "CURVE", "FONT", "SURFACE", "META"}:
            continue
        mat = world(ob)
        for corner in ob.bound_box:
            p = mat @ Vector(corner)
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
        found = True
    if not found:
        return (0.0, 0.0, 0.0)
    return (2 * max(abs(lo.x), abs(hi.x)), 2 * max(abs(lo.y), abs(hi.y)), hi.z)


def available_props():
    root = bpy.data.collections.get(COLL_PROPS)
    if root is None:
        return []
    return [(child.name, *prop_dimensions(child)) for child in root.children]


# --------------------------------------------------------------------------------------
# Building the scene
# --------------------------------------------------------------------------------------

def build_scene(context, books, plan, opts, settings):
    scene = context.scene
    root = ensure_collection(COLL_ROOT, scene.collection)
    c_books = ensure_collection(COLL_BOOKS, root)
    c_shelves = ensure_collection(COLL_SHELVES, root)
    c_decor = ensure_collection(COLL_DECOR, root)
    c_room = ensure_collection(COLL_ROOM, root)
    for coll in (c_books, c_shelves, c_decor):
        clear_collection(coll)

    n_rows, shelf_w, pitch = plan["rows"], plan["shelf_w"], plan["pitch"]
    board_w = shelf_w + 2 * SHELF_END_MARGIN
    x_origin = -shelf_w / 2
    row_z = [BASE_Z + (n_rows - 1 - r) * pitch for r in range(n_rows)]   # top of each board
    top_z = row_z[0] + plan["clear_h"]
    bottom_z = row_z[-1] - SHELF_THICK
    wood = material(MAT_WOOD)

    # Shelves
    def add_board(name, x0, x1, y0, y1, z0, z1, bevel=0.0015):
        ob = bpy.data.objects.new(name, box_mesh(name, x0, x1, y0, y1, z0, z1))
        ob.data.materials.append(wood)
        ob.color = (0.36, 0.20, 0.10, 1.0)          # shown in Solid view with Object colour
        if bevel:
            mod = ob.modifiers.new("Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 2
        c_shelves.objects.link(ob)
        return ob

    bookcase = opts["style"] == "BOOKCASE"
    side = 0.025 if bookcase else 0.0
    for r, z in enumerate(row_z):
        add_board(f"Shelf {r + 1:02d}", -board_w / 2, board_w / 2, -SHELF_DEPTH, 0.0, z - SHELF_THICK, z)
    if bookcase:
        add_board("Bookcase Side L", -board_w / 2 - side, -board_w / 2, -SHELF_DEPTH, 0.0, bottom_z, top_z + side)
        add_board("Bookcase Side R", board_w / 2, board_w / 2 + side, -SHELF_DEPTH, 0.0, bottom_z, top_z + side)
        add_board("Bookcase Top", -board_w / 2, board_w / 2, -SHELF_DEPTH, 0.0, top_z, top_z + side)
        add_board("Bookcase Back", -board_w / 2, board_w / 2, -0.006, 0.0, bottom_z, top_z, bevel=0.0)

    # Books and their (not yet fitted) titles
    font = None
    if settings.font_path:
        try:
            font = bpy.data.fonts.load(bpy.path.abspath(settings.font_path), check_existing=True)
        except Exception:  # noqa: BLE001
            font = None
    titled = []
    for i, place in enumerate(p for p in plan["placements"] if p["kind"] != "prop"):
        book = place["book"]
        name = f"Book {i + 1:04d}"
        ob = bpy.data.objects.new(name, book_mesh(name, book))
        ob.color = (*book["color"], 1.0)
        ob.matrix_world = book_matrix(place, x_origin, row_z[place["row"]])
        ob["title"] = book["full_title"]
        ob["author"] = book["author"]
        c_books.objects.link(ob)
        if not opts["titles"] or not book["title"]:
            continue
        curve = bpy.data.curves.new(f"Title {i + 1:04d}", "FONT")
        curve.body = book["title"]
        curve.align_x = "CENTER"
        curve.align_y = "CENTER"
        curve.size = 1.0
        curve.space_line = 0.92
        if font is not None:
            curve.font = font
        curve.materials.append(material(book["text_mat"]))
        text = bpy.data.objects.new(curve.name, curve)
        text.parent = ob
        c_books.objects.link(text)
        titled.append((text, book, place["kind"] == "flat"))

    # Measure the titles, choose line breaks, measure again, then size and centre them.
    context.view_layer.update()
    layouts = []
    for text, book, flat in titled:
        size, direction, lines = choose_title_layout(book["title"], max(text.dimensions.x, 0.01), book, flat)
        text.data.body = "\n".join(lines)
        layouts.append((size, direction, len(lines)))
    context.view_layer.update()
    for (text, book, flat), (size, direction, n_lines) in zip(titled, layouts):
        box = [Vector(c) for c in text.bound_box]
        lo_x, hi_x = min(c.x for c in box), max(c.x for c in box)
        lo_y, hi_y = min(c.y for c in box), max(c.y for c in box)
        width, height = max(hi_x - lo_x, 0.01), max(hi_y - lo_y, 0.01)
        if direction == "V":
            size = min(size, book["h"] * 0.86 / width, book["t"] * 0.80 / height)
        else:
            size = min(size, book["t"] * 0.86 / width, book["h"] * 0.86 / height)
        text.data.size = size
        cx, cy = (lo_x + hi_x) / 2 * size, (lo_y + hi_y) / 2 * size
        t, h = book["t"], book["h"]
        if direction == "V":      # reads from the top of the spine downwards
            text.matrix_basis = Matrix(((0, 1, 0, t / 2 - cy), (0, 0, -1, -TEXT_LIFT),
                                        (-1, 0, 0, h / 2 + cx), (0, 0, 0, 1)))
        else:                     # upright lines across a thick spine
            text.matrix_basis = Matrix(((1, 0, 0, t / 2 - cx), (0, 0, -1, -TEXT_LIFT),
                                        (0, 1, 0, h / 2 - cy), (0, 0, 0, 1)))

    # Decorations
    props_root = bpy.data.collections.get(COLL_PROPS)
    for place in (p for p in plan["placements"] if p["kind"] == "prop"):
        source = props_root.children.get(place["name"]) if props_root else None
        if source is None:
            continue
        empty = bpy.data.objects.new(f"Decor {place['name']}", None)
        empty.instance_type = "COLLECTION"
        empty.instance_collection = source
        empty.empty_display_size = 0.05
        empty.matrix_world = (Matrix.Translation((x_origin + place["cx"], -SHELF_DEPTH / 2, row_z[place["row"]]))
                              @ Matrix.Rotation(place["rot"], 4, "Z")
                              @ Matrix.Scale(place["scale"], 4))
        c_decor.objects.link(empty)

    # Room, camera and lights
    block_w = board_w + 2 * side
    centre_z = (top_z + bottom_z) / 2
    block_h = top_z - bottom_z
    aspect = (scene.render.resolution_x * scene.render.pixel_aspect_x) / \
             (scene.render.resolution_y * scene.render.pixel_aspect_y)
    cam_ob = bpy.data.objects.get("BS Camera")
    if cam_ob is None:
        cam_ob = bpy.data.objects.new("BS Camera", bpy.data.cameras.new("BS Camera"))
        cam_ob.data.lens = 50.0
        c_room.objects.link(cam_ob)
        new_camera = True
    else:
        new_camera = False
    cam = cam_ob.data
    half_w = block_w / 2 * 1.16
    half_h = block_h / 2 * 1.16
    tan_h = (cam.sensor_width / 2) / cam.lens
    if aspect < 1.0:
        tan_h *= aspect
    tan_v = tan_h / aspect
    distance = max(half_w / tan_h, half_h / tan_v)
    if settings.auto_camera or new_camera:
        cam_ob.matrix_world = (Matrix.Translation((0.0, -SHELF_DEPTH - distance, centre_z))
                               @ Matrix.Rotation(math.radians(90), 4, "X"))
        cam.clip_end = max(100.0, distance * 4)
        scene.camera = cam_ob

    if settings.auto_room:
        span = max(block_w * 2.5, distance * 2.5, 6.0)
        wall_h = max(top_z + block_h * 0.8 + 1.0, 3.0)
        room = {
            "BS Wall": ([(-span, 0, 0), (span, 0, 0), (span, 0, wall_h), (-span, 0, wall_h)], MAT_WALL),
            "BS Floor": ([(-span, -span, 0), (span, -span, 0), (span, 0, 0), (-span, 0, 0)], MAT_FLOOR),
        }
        for name, (verts, mat_name) in room.items():
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
            mesh.materials.append(material(mat_name))
            mesh.update()
            ob = bpy.data.objects.get(name)
            if ob is None:
                ob = bpy.data.objects.new(name, mesh)
                c_room.objects.link(ob)
            else:
                old = ob.data
                ob.data = mesh
                if old.users == 0:
                    bpy.data.meshes.remove(old)
            ob.color = (*settings.wall_color, 1.0) if name == "BS Wall" else (0.16, 0.10, 0.07, 1.0)
        apply_wall_settings(settings)

        target = Vector((0.0, -SHELF_DEPTH, centre_z))
        lights = {
            # name: (position, size, watts per square metre of shelf wall)
            "BS Key Light": (Vector((-block_w * 0.30, -distance * 0.55, top_z + block_h * 0.6 + 0.5)),
                             max(block_w * 0.7, 1.0), 42.0, (1.0, 0.93, 0.84)),
            "BS Fill Light": (Vector((block_w * 0.95, -distance * 0.7, centre_z - block_h * 0.1)),
                              max(block_w * 0.9, 1.0), 9.0, (0.86, 0.90, 1.0)),
        }
        for name, (pos, size, power, colour) in lights.items():
            ob = bpy.data.objects.get(name)
            if ob is None:
                ob = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
                c_room.objects.link(ob)
            ob.visible_camera = False
            ob.data.shape = "SQUARE"
            ob.data.size = size
            ob.data.color = colour
            ob.data.energy = power * (pos - target).length ** 2 / 4.0
            ob.matrix_world = Matrix.Translation(pos) @ (target - pos).to_track_quat("-Z", "Y").to_matrix().to_4x4()

    return {"board_w": board_w, "block_h": block_h, "distance": distance}


def load_book_list(settings):
    """Return (csv_text, description) for the chosen file, or the built-in sample list."""
    path = bpy.path.abspath(settings.csv_path) if settings.csv_path else ""
    if path:
        if not os.path.isfile(path):
            raise ValueError(f"Can't find the file: {path}")
        with open(path, "rb") as handle:
            return decode_csv(handle.read()), os.path.basename(path)
    sample = bpy.data.texts.get(SAMPLE_TEXT)
    if sample is not None:
        return sample.as_string(), "built-in sample list"
    raise ValueError("Choose your Goodreads CSV file first.")


def generate(context):
    settings = context.scene.bookshelf
    text, source = load_book_list(settings)
    books, counts = read_books(text, settings.shelf_filter, settings.year, settings.shorten_titles)
    if not books:
        detail = f"{counts['total']} rows found"
        if counts["wrong_shelf"]:
            detail += f", {counts['wrong_shelf']} on other shelves (try Books: All)"
        if counts["wrong_year"]:
            detail += f", {counts['wrong_year']} not read in {settings.year}"
        raise ValueError(f"No books to place: {detail}.")

    opts = {
        "seed": settings.seed, "palette": settings.palette, "color_mode": settings.color_mode,
        "thickness_scale": settings.thickness_scale, "rows": settings.rows, "style": settings.style,
        "decor": settings.decor, "stacks": settings.stacks, "leaning": settings.leaning,
        "titles": settings.titles,
    }
    assign_looks(books, opts)
    sort_books(books, settings.sort_by, settings.reverse, settings.seed)
    if settings.max_books and len(books) > settings.max_books:
        books = books[-settings.max_books:] if settings.sort_by == "DATE_READ" and not settings.reverse \
            else books[:settings.max_books]

    scene = context.scene
    aspect = (scene.render.resolution_x * scene.render.pixel_aspect_x) / \
             (scene.render.resolution_y * scene.render.pixel_aspect_y)
    plan = plan_layout(books, opts, available_props(), aspect)
    build_scene(context, books, plan, opts, settings)
    shelves = "shelf" if plan["rows"] == 1 else "shelves"
    noun = "book" if len(books) == 1 else "books"
    settings.status = f"{len(books)} {noun} on {plan['rows']} {shelves} ({source})"
    return settings.status


# --------------------------------------------------------------------------------------
# Interface
# --------------------------------------------------------------------------------------

def _wall_update(self, context):
    apply_wall_settings(self)


class BookshelfSettings(bpy.types.PropertyGroup):
    csv_path: bpy.props.StringProperty(
        name="Book list", subtype="FILE_PATH",
        description="Your Goodreads export (goodreads_library_export.csv) or any CSV with a Title column")
    shelf_filter: bpy.props.EnumProperty(
        name="Books", default="READ",
        items=[("READ", "Read", "Only books on your 'read' shelf"),
               ("CURRENT", "Currently reading", "Only books you are reading now"),
               ("TO_READ", "Want to read", "Only books on your 'to-read' shelf"),
               ("ALL", "All", "Every book in the file")])
    year: bpy.props.IntProperty(
        name="Year read", default=0, min=0, max=2200,
        description="Only books finished in this year. 0 = every year")
    max_books: bpy.props.IntProperty(
        name="Limit", default=0, min=0,
        description="Use at most this many books (the most recent ones when sorted by date). 0 = no limit")
    sort_by: bpy.props.EnumProperty(
        name="Order", default="DATE_READ",
        items=[("DATE_READ", "Date read", "Oldest first, in the order you read them"),
               ("AUTHOR", "Author", "By author surname"),
               ("TITLE", "Title", "Alphabetical by title"),
               ("PAGES", "Thickness", "Thickest books first"),
               ("RATING", "My rating", "Your highest rated first"),
               ("COLOR", "Colour", "Rainbow order by cover colour"),
               ("RANDOM", "Shuffled", "Random order (change Variation for another shuffle)"),
               ("FILE", "As in file", "Keep the order of the CSV")])
    reverse: bpy.props.BoolProperty(name="Reverse order", default=False)
    rows: bpy.props.IntProperty(
        name="Shelves", default=0, min=0, max=80,
        description="Number of shelves. 0 = choose automatically to suit the image shape")
    style: bpy.props.EnumProperty(
        name="Style", default="FLOATING",
        items=[("FLOATING", "Floating shelves", "Boards on the wall"),
               ("BOOKCASE", "Bookcase", "Boards with sides, top and back")])
    palette: bpy.props.EnumProperty(
        name="Colours", default="CLASSIC",
        items=[("CLASSIC", "Classic", "Muted purples, greens, tans and browns"),
               ("LEATHER", "Old library", "Dark leather tones"),
               ("VIVID", "Vivid", "Bright modern covers"),
               ("PASTEL", "Pastel", "Soft light covers"),
               ("MONO", "Black and white", "Greys, black and cream")])
    color_mode: bpy.props.EnumProperty(
        name="Colour by", default="RANDOM",
        items=[("RANDOM", "Each book", "Every book gets its own colour"),
               ("AUTHOR", "Author", "Books by the same author share a colour")])
    thickness_scale: bpy.props.FloatProperty(
        name="Thickness", default=1.0, min=0.4, max=2.5,
        description="Make every book thicker or thinner")
    seed: bpy.props.IntProperty(
        name="Variation", default=1, min=0,
        description="Change for a different mix of colours, leaning books and decorations")
    titles: bpy.props.BoolProperty(name="Titles on spines", default=True)
    shorten_titles: bpy.props.BoolProperty(
        name="Shorten long titles", default=True,
        description="Drop subtitles after a colon when a title is long")
    font_path: bpy.props.StringProperty(
        name="Font", subtype="FILE_PATH",
        description="Optional .ttf / .otf font for the titles. Empty = Blender's built-in font")
    leaning: bpy.props.BoolProperty(name="Leaning books", default=True)
    stacks: bpy.props.BoolProperty(name="Flat stacks", default=True)
    decor: bpy.props.BoolProperty(
        name="Decorations", default=True,
        description=f"Place objects from the '{COLL_PROPS}' collection on the shelves")
    wall_color: bpy.props.FloatVectorProperty(
        name="Wall", subtype="COLOR", size=3, min=0.0, max=1.0,
        default=(0.09, 0.02, 0.03), update=_wall_update)
    wall_pattern: bpy.props.BoolProperty(name="Wallpaper pattern", default=True, update=_wall_update)
    auto_camera: bpy.props.BoolProperty(
        name="Frame camera", default=True,
        description="Move the camera so the whole bookshelf fits the picture. Turn off to keep your own view")
    auto_room: bpy.props.BoolProperty(
        name="Fit wall and lights", default=True,
        description="Resize the wall and lights to suit the bookshelf. Turn off to keep your own")
    status: bpy.props.StringProperty(default="")


class BOOKSHELF_OT_build(bpy.types.Operator):
    bl_idname = "bookshelf.build"
    bl_label = "Build Bookshelf"
    bl_description = "Read the book list and build the bookshelf (replaces the previous one)"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        if context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        try:
            message = generate(context)
        except ValueError as err:
            self.report({"ERROR"}, str(err))
            return {"CANCELLED"}
        self.report({"INFO"}, message)
        return {"FINISHED"}


class BOOKSHELF_OT_clear(bpy.types.Operator):
    bl_idname = "bookshelf.clear"
    bl_label = "Remove Books"
    bl_description = "Remove the generated books, shelves and decorations"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        for name in (COLL_BOOKS, COLL_SHELVES, COLL_DECOR):
            coll = bpy.data.collections.get(name)
            if coll is not None:
                clear_collection(coll)
        context.scene.bookshelf.status = ""
        return {"FINISHED"}


class BOOKSHELF_PT_panel(bpy.types.Panel):
    bl_label = "Bookshelf"
    bl_idname = "BOOKSHELF_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Bookshelf"

    def draw(self, context):
        layout = self.layout
        s = context.scene.bookshelf

        col = layout.column()
        col.label(text="Your book list (CSV)", icon="FILE")
        col.prop(s, "csv_path", text="")
        if not s.csv_path and SAMPLE_TEXT in bpy.data.texts:
            col.label(text="Empty = built-in sample list")

        row = layout.row()
        row.scale_y = 1.8
        row.operator("bookshelf.build", icon="OUTLINER_OB_GROUP_INSTANCE")
        if s.status:
            layout.label(text=s.status, icon="CHECKMARK")
        col = layout.column()
        col.operator_context = "INVOKE_DEFAULT"
        col.operator("render.render", text="Render Image", icon="RENDER_STILL")


class _SubPanel:
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Bookshelf"
    bl_parent_id = "BOOKSHELF_PT_panel"

    def column(self):
        self.layout.use_property_split = True
        self.layout.use_property_decorate = False
        return self.layout.column()


class BOOKSHELF_PT_books(_SubPanel, bpy.types.Panel):
    bl_label = "Which books"
    bl_idname = "BOOKSHELF_PT_books"

    def draw(self, context):
        s = context.scene.bookshelf
        col = self.column()
        col.prop(s, "shelf_filter")
        col.prop(s, "year")
        col.prop(s, "max_books")
        col.prop(s, "sort_by")
        col.prop(s, "reverse")


class BOOKSHELF_PT_look(_SubPanel, bpy.types.Panel):
    bl_label = "Look"
    bl_idname = "BOOKSHELF_PT_look"

    def draw(self, context):
        s = context.scene.bookshelf
        col = self.column()
        col.prop(s, "style")
        col.prop(s, "rows")
        col.prop(s, "palette")
        col.prop(s, "color_mode")
        col.prop(s, "wall_color")
        col.prop(s, "wall_pattern")
        col.prop(s, "seed")


class BOOKSHELF_PT_details(_SubPanel, bpy.types.Panel):
    bl_label = "Details"
    bl_idname = "BOOKSHELF_PT_details"
    bl_options = {"DEFAULT_CLOSED"}

    def draw(self, context):
        s = context.scene.bookshelf
        col = self.column()
        col.prop(s, "thickness_scale")
        col.prop(s, "titles")
        sub = col.column()
        sub.enabled = s.titles
        sub.prop(s, "shorten_titles")
        sub.prop(s, "font_path")
        col.prop(s, "leaning")
        col.prop(s, "stacks")
        col.prop(s, "decor")
        col.prop(s, "auto_camera")
        col.prop(s, "auto_room")
        col.separator()
        col.operator("bookshelf.clear", icon="TRASH")


CLASSES = (BookshelfSettings, BOOKSHELF_OT_build, BOOKSHELF_OT_clear, BOOKSHELF_PT_panel,
           BOOKSHELF_PT_books, BOOKSHELF_PT_look, BOOKSHELF_PT_details)


def register():
    for cls in CLASSES:
        existing = getattr(bpy.types, cls.__name__, None)
        if existing is not None:
            try:
                bpy.utils.unregister_class(existing)
            except Exception:  # noqa: BLE001
                pass
        bpy.utils.register_class(cls)
    bpy.types.Scene.bookshelf = bpy.props.PointerProperty(type=BookshelfSettings)


def unregister():
    if hasattr(bpy.types.Scene, "bookshelf"):
        del bpy.types.Scene.bookshelf
    for cls in reversed(CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    register()
