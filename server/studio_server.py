#!/usr/bin/env python3
"""Ender Studio helper: model library + slicing (PrusaSlicer CLI) for the web UI.

Everything printer-related goes straight from the browser to Moonraker; this
only does what Moonraker can't: keep the original model files and slice.

Listens on 127.0.0.1:8091; nginx exposes it as /studio-api/.

  GET    /studio-api/info                 slicer version, presets
  GET    /studio-api/models               model library
  PUT    /studio-api/models/<name>        store a model (raw body)
  GET    /studio-api/models/<name>        fetch a model
  DELETE /studio-api/models/<name>
  POST   /studio-api/slice                start a slice job (see read_slice_body)
  GET    /studio-api/jobs/<id>            job progress / result
  POST   /studio-api/jobs/<id>/cancel
  GET    /studio-api/update               version + update status
  POST   /studio-api/update/check         look for updates now
  POST   /studio-api/update/install       install the waiting update now
  POST   /studio-api/update/auto          {"auto": true|false}
  GET    /studio-api/designs              saved Design-tab projects
  GET    /studio-api/designs/<name>.json  one project
  PUT    /studio-api/designs/<name>.json  save one (JSON body)
  DELETE /studio-api/designs/<name>.json
"""
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import updater

HOME = os.path.expanduser("~")
GCODES = os.path.join(HOME, "printer_data", "gcodes")
MODELS = os.path.join(HOME, "printer_data", "models")
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILES = os.path.join(os.path.dirname(HERE), "profiles")
SLICER = shutil.which("prusa-slicer") or "/usr/bin/prusa-slicer"
MODEL_EXT = (".stl", ".3mf", ".obj")
DESIGNS = os.path.join(HOME, "printer_data", "design")

# What the UI offers.  Values are PrusaSlicer config keys.
QUALITY = {
    "draft":    {"label": "Draft (0.28 mm, fast)", "layer_height": 0.28,
                 "first_layer_height": 0.28, "perimeters": 2,
                 "top_solid_layers": 3, "bottom_solid_layers": 3},
    "standard": {"label": "Standard (0.20 mm)", "layer_height": 0.2,
                 "first_layer_height": 0.2, "perimeters": 2,
                 "top_solid_layers": 4, "bottom_solid_layers": 4},
    "fine":     {"label": "Fine (0.12 mm, slow)", "layer_height": 0.12,
                 "first_layer_height": 0.2, "perimeters": 3,
                 "top_solid_layers": 7, "bottom_solid_layers": 5},
    "strong":   {"label": "Strong (0.20 mm, thick walls)", "layer_height": 0.2,
                 "first_layer_height": 0.2, "perimeters": 4,
                 "top_solid_layers": 5, "bottom_solid_layers": 5},
}
# Filament presets.  Slicer keys are PrusaSlicer config keys; the rest:
#   squish      default first-layer nozzle height change in mm vs. PLA
#               (+ = higher = less squish).  PRINT_START applies it with
#               SET_GCODE_OFFSET; a value saved on the printer (SAVE_VARIABLE
#               squish_<key>, from the Print page) wins over this default.
#               PLA is the reference: its "squish" is the probe Z offset.
#   speed_pct   default print speed (% of the base profile's speeds)
#   note        one line shown under the dropdown
#   tower       temperature tower range (hot -> cool, 5 degree steps)
# max_volumetric_speed (mm3/s) caps how fast the stock hotend can melt it.
MATERIAL = {
    "pla": {"label": "PLA", "squish": 0.0, "speed_pct": 100,
            "tower": (220, 190),
            "note": "The reference filament. Easy, no smell.",
            "filament_type": "PLA",
            "temperature": 205, "first_layer_temperature": 210,
            "bed_temperature": 60, "first_layer_bed_temperature": 60,
            "min_fan_speed": 100, "max_fan_speed": 100,
            "disable_fan_first_layers": 1, "retract_length": 5,
            "retract_speed": 40, "deretract_speed": 40,
            "max_volumetric_speed": 10, "first_layer_speed": 20},
    "pla_plus": {"label": "PLA+ / Tough PLA", "squish": 0.0, "speed_pct": 100,
            "tower": (230, 205),
            "note": "Like PLA but a bit hotter; tougher, less brittle.",
            "filament_type": "PLA",
            "temperature": 215, "first_layer_temperature": 220,
            "bed_temperature": 60, "first_layer_bed_temperature": 60,
            "min_fan_speed": 100, "max_fan_speed": 100,
            "disable_fan_first_layers": 1, "retract_length": 5,
            "retract_speed": 40, "deretract_speed": 40,
            "max_volumetric_speed": 10, "first_layer_speed": 20},
    "silk": {"label": "Silk PLA", "squish": 0.0, "speed_pct": 70,
            "tower": (230, 205),
            "note": "Shiny PLA. Slower and hotter keeps the shine.",
            "filament_type": "PLA",
            "temperature": 215, "first_layer_temperature": 220,
            "bed_temperature": 60, "first_layer_bed_temperature": 60,
            "min_fan_speed": 100, "max_fan_speed": 100,
            "disable_fan_first_layers": 1, "retract_length": 5,
            "retract_speed": 40, "deretract_speed": 40,
            "max_volumetric_speed": 8, "first_layer_speed": 20},
    "petg": {"label": "PETG", "squish": 0.05, "speed_pct": 80,
            "tower": (250, 230),
            "note": "Strong and heat-resistant. Less squish, less fan; a bit stringy.",
            "filament_type": "PETG",
            "temperature": 235, "first_layer_temperature": 240,
            "bed_temperature": 75, "first_layer_bed_temperature": 75,
            "min_fan_speed": 30, "max_fan_speed": 50,
            "disable_fan_first_layers": 3, "retract_length": 4,
            "retract_speed": 35, "deretract_speed": 30,
            # PETG oozes and sticks to the nozzle: wipe as it retracts, and keep
            # travel moves inside the part so strings don't cross open gaps
            "wipe": 1, "avoid_crossing_perimeters": 1,
            "max_volumetric_speed": 8, "first_layer_speed": 20},
    "tpu": {"label": "TPU (flexible)", "squish": 0.03, "speed_pct": 40,
            "tower": (240, 215),
            "note": "Rubbery. Prints slowly with almost no retraction (Bowden tube).",
            "filament_type": "FLEX",
            "temperature": 225, "first_layer_temperature": 230,
            "bed_temperature": 50, "first_layer_bed_temperature": 50,
            "min_fan_speed": 50, "max_fan_speed": 50,
            "disable_fan_first_layers": 1, "retract_length": 1,
            "retract_speed": 20, "deretract_speed": 20,
            "max_volumetric_speed": 2.5, "first_layer_speed": 15},
    "abs": {"label": "ABS / ASA", "squish": 0.0, "speed_pct": 80,
            "tower": (250, 230),
            "note": "Needs a draft-free enclosure and ventilation (fumes). Bed 100 °C.",
            "filament_type": "ABS",
            "temperature": 240, "first_layer_temperature": 245,
            "bed_temperature": 100, "first_layer_bed_temperature": 100,
            "min_fan_speed": 0, "max_fan_speed": 15,
            "disable_fan_first_layers": 3, "retract_length": 5,
            "retract_speed": 40, "deretract_speed": 40,
            "max_volumetric_speed": 10, "first_layer_speed": 20},
}
MATERIAL_META = ("label", "squish", "speed_pct", "note", "tower")
SUPPORTS = {
    "none":      {"label": "No supports"},
    "auto":      {"label": "Supports everywhere"},
    "buildplate": {"label": "Supports from the bed only"},
    "tree":      {"label": "Tree supports (easy to remove)"},
}

# Advanced overrides the UI may send: key -> (type, min, max) or a list of
# allowed values.  Anything else is ignored.
ADVANCED = {
    "layer_height": (float, 0.06, 0.32),
    "perimeters": (int, 1, 10),
    "top_solid_layers": (int, 0, 30),
    "bottom_solid_layers": (int, 0, 30),
    "fill_pattern": ["gyroid", "grid", "rectilinear", "honeycomb", "cubic",
                     "lightning", "adaptivecubic", "triangles", "line"],
    "temperature": (int, 150, 250),
    "first_layer_temperature": (int, 150, 250),
    "bed_temperature": (int, 0, 100),
    "first_layer_bed_temperature": (int, 0, 100),
    "max_fan_speed": (int, 0, 100),
    "seam_position": ["aligned", "nearest", "random", "rear"],
    "ironing": (int, 0, 1),
    "fuzzy_skin": ["none", "external", "all"],
    "raft_layers": (int, 0, 6),
    "spiral_vase": (int, 0, 1),
    "retract_length": (float, 0, 10),
    "retract_lift": (float, 0, 2),
    "elefant_foot_compensation": (float, 0, 1),
    "xy_size_compensation": (float, -1, 1),
    "support_material_interface_layers": (int, 0, 6),
    "support_material_contact_distance": (float, 0, 0.5),
}
SPEED_KEYS = ["perimeter_speed", "external_perimeter_speed",
              "small_perimeter_speed", "infill_speed", "solid_infill_speed",
              "top_solid_infill_speed", "gap_fill_speed", "bridge_speed",
              "support_material_speed", "support_material_interface_speed"]
BASE_SPEEDS = {}


def base_speeds():
    """Speeds from the base profile, so a speed % can scale them."""
    if not BASE_SPEEDS:
        with open(os.path.join(PROFILES, "ender3.ini")) as f:
            for line in f:
                k, _, v = line.partition("=")
                if k.strip() in SPEED_KEYS:
                    BASE_SPEEDS[k.strip()] = float(v)
    return BASE_SPEEDS


def materials_info():
    """What the UI shows about each filament preset."""
    return {k: {"label": v["label"], "note": v["note"], "squish": v["squish"],
                "speed_pct": v["speed_pct"],
                "temp": v["first_layer_temperature"],
                "nozzle": v["temperature"], "bed_print": v["bed_temperature"],
                "bed": v["first_layer_bed_temperature"],
                "fan": v["max_fan_speed"], "retract": v["retract_length"],
                "flow": v["max_volumetric_speed"], "tower": v["tower"]}
            for k, v in MATERIAL.items()}


def advanced_config(adv, material=None):
    cfg = {}
    for key, val in (adv or {}).items():
        spec = ADVANCED.get(key)
        if spec is None or val in ("", None):
            continue
        if isinstance(spec, list):
            if val in spec:
                cfg[key] = val
            continue
        typ, lo, hi = spec
        try:
            cfg[key] = max(lo, min(hi, typ(val)))
        except (TypeError, ValueError):
            continue
    # One nozzle temperature implies the first layer too, unless given.
    if "temperature" in cfg and "first_layer_temperature" not in cfg:
        cfg["first_layer_temperature"] = min(250, cfg["temperature"] + 5)
    if "bed_temperature" in cfg and "first_layer_bed_temperature" not in cfg:
        cfg["first_layer_bed_temperature"] = cfg["bed_temperature"]
    if "max_fan_speed" in cfg:
        cfg["min_fan_speed"] = cfg["max_fan_speed"]
    try:
        pct = float((adv or {}).get("speed_pct")
                    or (material or {}).get("speed_pct") or 100)
    except ValueError:
        pct = 100
    pct = max(30, min(200, pct))
    if pct != 100:
        for k, v in base_speeds().items():
            cfg[k] = round(v * pct / 100, 1)
    if cfg.get("spiral_vase"):
        # Vase mode needs a single wall, no top and no infill.
        cfg.update(perimeters=1, top_solid_layers=0, fill_density="0%",
                   support_material=0)
    return cfg


jobs = {}
jobs_lock = threading.Lock()


def slicing():
    return any(j["state"] in ("queued", "slicing") for j in jobs.values())


UPDATER = updater.Updater(slicing)


def safe_name(name, exts=None):
    name = os.path.basename(unquote(name)).strip()
    name = re.sub(r"[^\w.\- ()]+", "_", name)
    if not name or name.startswith("."):
        raise ValueError("bad file name")
    if exts and not name.lower().endswith(exts):
        raise ValueError("unsupported file type")
    return name


def unique_path(folder, name):
    base, ext = os.path.splitext(name)
    path, n = os.path.join(folder, name), 2
    while os.path.exists(path):
        path = os.path.join(folder, "%s (%d)%s" % (base, n, ext))
        n += 1
    return path


def slicer_version():
    try:
        out = subprocess.run([SLICER, "--help"], capture_output=True,
                             text=True, timeout=30).stdout
        m = re.search(r"PrusaSlicer-([\w.+-]+)", out)
        return m.group(1) if m else "unknown"
    except Exception:
        return None


# Infill patterns PrusaSlicer accepts at 100% density.
SOLID_OK = ("rectilinear", "monotonic", "monotoniclines", "alignedrectilinear",
            "concentric", "hilbertcurve", "archimedeanchords", "octagramspiral")


def job_config(opts):
    """The per-job PrusaSlicer settings layered over profiles/ender3.ini."""
    cfg = {}
    cfg.update({k: v for k, v in QUALITY[opts.get("quality", "standard")].items()
                if k != "label"})
    key = opts.get("material", "pla")
    mat = MATERIAL[key]
    cfg.update({k: v for k, v in mat.items() if k not in MATERIAL_META})
    # PRINT_START applies the filament's first-layer squish (a value saved on
    # the printer for this filament wins over the default passed here).
    cfg["start_gcode"] = (
        "SET_PRINT_STATS_INFO TOTAL_LAYER=[total_layer_count]\\n"
        "PRINT_START BED=[first_layer_bed_temperature] "
        "HOTEND=[first_layer_temperature] MATERIAL=%s SQUISH=%.3f "
        # first layer's box, so PRINT_START can purge right next to the part
        "AREA={first_layer_print_min[0]},{first_layer_print_min[1]},"
        "{first_layer_print_max[0]},{first_layer_print_max[1]}"
        % (key, mat["squish"]))
    sup = opts.get("supports", "none")
    cfg["support_material"] = int(sup != "none")
    cfg["support_material_auto"] = 1
    cfg["support_material_buildplate_only"] = int(sup == "buildplate")
    cfg["support_material_style"] = "organic" if sup == "tree" else "snug"
    cfg["support_material_threshold"] = int(opts.get("overhang", 45))
    cfg["fill_density"] = "%d%%" % max(0, min(100, int(opts.get("infill", 15))))
    brim = float(opts.get("brim", 0))
    cfg["brim_width"] = brim
    cfg["skirts"] = 0 if brim > 0 else 1
    cfg.update(advanced_config(opts.get("advanced"), mat))
    # PrusaSlicer refuses 100% with gyroid, honeycomb, cubic... ("not supposed
    # to work at 100% density"); solid parts get the solid-capable pattern.
    if cfg["fill_density"] == "100%" and cfg.get("fill_pattern", "gyroid") not in SOLID_OK:
        cfg["fill_pattern"] = "rectilinear"
    return cfg


def add_thumbnail(gcode_path, png_b64):
    """Embed a PNG preview the way PrusaSlicer does, so Moonraker shows it."""
    png = base64.b64decode(png_b64)
    w, h = struct.unpack(">II", png[16:24])
    lines = [png_b64[i:i + 78] for i in range(0, len(png_b64), 78)]
    block = ["; thumbnail begin %dx%d %d" % (w, h, len(png_b64))]
    block += ["; " + line for line in lines]
    block += ["; thumbnail end", ";", ""]
    tmp = gcode_path + ".tmp"
    with open(gcode_path) as src, open(tmp, "w") as dst:
        first = src.readline()          # "; generated by PrusaSlicer ..."
        dst.write(first + ";\n" + "\n".join(block))
        shutil.copyfileobj(src, dst)
    os.replace(tmp, gcode_path)


def gcode_stats(path):
    """PrusaSlicer writes its estimates as comments at the end of the file."""
    stats = {}
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - 400000))
        tail = f.read().decode("utf-8", "replace")
    pats = {"time": r"estimated printing time \(normal mode\) = (.+)",
            "filament_m": r"filament used \[mm\] = ([\d.]+)",
            "filament_g": r"filament used \[g\] = ([\d.]+)",
            "layers": None}
    for key, pat in pats.items():
        if pat:
            m = re.search(pat, tail)
            if m:
                stats[key] = m.group(1).strip()
    if "filament_m" in stats:
        stats["filament_m"] = "%.2f" % (float(stats["filament_m"]) / 1000)
    return stats


def boxes_stl(path, boxes):
    """Binary STL of axis-aligned boxes (x0, y0, z0, x1, y1, z1)."""
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    normals = [(0, 0, -1), (0, 0, -1), (0, 0, 1), (0, 0, 1), (0, -1, 0),
               (0, -1, 0), (1, 0, 0), (1, 0, 0), (0, 1, 0), (0, 1, 0),
               (-1, 0, 0), (-1, 0, 0)]
    with open(path, "wb") as f:
        f.write(b"Ender Studio calibration".ljust(80, b" "))
        f.write(struct.pack("<I", 12 * len(boxes)))
        for x0, y0, z0, x1, y1, z1 in boxes:
            v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                 (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
            for (a, b, c), n in zip(faces, normals):
                f.write(struct.pack("<12fH", *n, *v[a], *v[b], *v[c], 0))


def temp_tower(start, end, step):
    """Tower boxes (one block per temperature) and the Z where each begins.

    Each 10 mm block is two pillars joined by a bridge, so stringing,
    bridging and surface finish can be compared block by block."""
    step = abs(step) if end >= start else -abs(step)
    temps = list(range(start, end + (1 if step > 0 else -1), step))
    w, d, base = 30.0, 12.0, 1.0
    x0, y0 = 117.5 - w / 2, 117.5 - d / 2
    boxes = [(x0 - 3, y0 - 3, 0, x0 + w + 3, y0 + d + 3, base)]
    steps = []
    for i, t in enumerate(temps):
        z = base + 10 * i
        steps.append((z, t))
        boxes += [(x0, y0, z, x0 + 6, y0 + d, z + 8),
                  (x0 + w - 6, y0, z, x0 + w, y0 + d, z + 8),
                  (x0, y0, z + 8, x0 + w, y0 + d, z + 10)]
    return boxes, steps, temps


def apply_temp_steps(gcode_path, steps):
    """Insert an M104 at the first layer at or above each step's Z."""
    steps = sorted(steps)
    tmp = gcode_path + ".tmp"
    i = 0
    with open(gcode_path) as src, open(tmp, "w") as dst:
        for line in src:
            dst.write(line)
            if i < len(steps) and line.startswith(";Z:"):
                z = float(line[3:])
                temp = None
                while i < len(steps) and z >= steps[i][0] - 1e-6:
                    temp = steps[i][1]
                    i += 1
                if temp is not None:
                    dst.write("M104 S%d ; temperature tower block\n" % temp)
    os.replace(tmp, gcode_path)


def run_slice(job_id, stl_paths, opts, workdir):
    job = jobs[job_id]
    try:
        cfg_path = os.path.join(workdir, "job.ini")
        with open(cfg_path, "w") as f:
            for k, v in job_config(opts).items():
                f.write("%s = %s\n" % (k, v))
        out_path = os.path.join(workdir, "out.gcode")
        # Each model arrives already placed in bed coordinates; --merge keeps
        # them as separate objects (so one can be skipped mid-print) and
        # --dont-arrange keeps them where the user put them.
        cmd = ["nice", "-n", "15", SLICER, "--export-gcode",
               "--load", os.path.join(PROFILES, "ender3.ini"),
               "--load", cfg_path, "--merge", "--dont-arrange",
               "--output", out_path] + stl_paths
        job.update(state="slicing", progress=2, message="Starting slicer")
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True,
                                cwd=workdir)
        job["proc"] = proc
        log = []
        for line in proc.stdout:
            line = line.strip()
            log.append(line)
            m = re.match(r"(\d+) => (.+)", line)
            if m:
                job.update(progress=max(job["progress"], int(m.group(1))),
                           message=m.group(2))
        proc.wait()
        if job.get("cancelled"):
            job.update(state="cancelled", message="Cancelled")
            return
        if proc.returncode != 0 or not os.path.exists(out_path):
            err = [l for l in log if l and "=>" not in l][-6:]
            job.update(state="error", message="\n".join(err) or
                       "Slicer failed (exit %d)" % proc.returncode)
            return
        if opts.get("temp_steps"):
            apply_temp_steps(out_path, opts["temp_steps"])
        if opts.get("thumbnail"):
            try:
                add_thumbnail(out_path, opts["thumbnail"])
            except Exception as e:
                log.append("thumbnail: %s" % e)
        name = safe_name(opts.get("name") or "model")
        name = os.path.splitext(name)[0] + ".gcode"
        os.makedirs(GCODES, exist_ok=True)
        final = unique_path(GCODES, name)
        stats = gcode_stats(out_path)
        shutil.move(out_path, final)
        job.update(state="done", progress=100, message="Done",
                   file=os.path.basename(final), stats=stats)
    except Exception as e:
        job.update(state="error", message=str(e))
    finally:
        job.pop("proc", None)
        shutil.rmtree(workdir, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "EnderStudio/1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error(self, msg, code=400):
        self.send_json({"error": msg}, code)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        data, chunks = n, []
        while data > 0:
            c = self.rfile.read(min(data, 1 << 20))
            if not c:
                break
            chunks.append(c)
            data -= len(c)
        return b"".join(chunks)

    def route(self):
        path = self.path.split("?")[0]
        if path.startswith("/studio-api"):
            path = path[len("/studio-api"):]
        return [p for p in path.split("/") if p]

    # ------------------------------------------------------------- GET
    def do_GET(self):
        parts = self.route()
        try:
            if parts == ["info"]:
                return self.send_json({
                    "slicer": self.server.slicer_version,
                    "quality": {k: v["label"] for k, v in QUALITY.items()},
                    "material": {k: v["label"] for k, v in MATERIAL.items()},
                    "materials": materials_info(),
                    "supports": {k: v["label"] for k, v in SUPPORTS.items()},
                })
            if parts == ["update"]:
                return self.send_json(UPDATER.status())
            if parts == ["models"]:
                os.makedirs(MODELS, exist_ok=True)
                out = []
                for n in sorted(os.listdir(MODELS)):
                    p = os.path.join(MODELS, n)
                    if n.lower().endswith(MODEL_EXT) and os.path.isfile(p):
                        st = os.stat(p)
                        out.append({"name": n, "size": st.st_size,
                                    "modified": st.st_mtime})
                out.sort(key=lambda m: -m["modified"])
                return self.send_json({"models": out})
            if len(parts) == 2 and parts[0] == "models":
                p = os.path.join(MODELS, safe_name(parts[1], MODEL_EXT))
                if not os.path.isfile(p):
                    return self.error("not found", 404)
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(os.path.getsize(p)))
                self.end_headers()
                with open(p, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            if parts == ["designs"]:
                os.makedirs(DESIGNS, exist_ok=True)
                out = []
                for n in os.listdir(DESIGNS):
                    p = os.path.join(DESIGNS, n)
                    if n.lower().endswith(".json") and os.path.isfile(p):
                        st = os.stat(p)
                        out.append({"name": n[:-5], "size": st.st_size,
                                    "modified": st.st_mtime})
                out.sort(key=lambda m: -m["modified"])
                return self.send_json({"designs": out})
            if len(parts) == 2 and parts[0] == "designs":
                p = os.path.join(DESIGNS, safe_name(parts[1], (".json",)))
                if not os.path.isfile(p):
                    return self.error("not found", 404)
                with open(p, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            if len(parts) == 2 and parts[0] == "jobs":
                job = jobs.get(parts[1])
                if not job:
                    return self.error("no such job", 404)
                return self.send_json({k: v for k, v in job.items()
                                       if k != "proc"})
            return self.error("not found", 404)
        except ValueError as e:
            return self.error(str(e))

    # ------------------------------------------------------------- PUT
    def do_PUT(self):
        parts = self.route()
        try:
            if len(parts) == 2 and parts[0] == "models":
                os.makedirs(MODELS, exist_ok=True)
                name = safe_name(parts[1], MODEL_EXT)
                data = self.body()
                if not data:
                    return self.error("empty file")
                path = os.path.join(MODELS, name)
                with open(path + ".part", "wb") as f:
                    f.write(data)
                os.replace(path + ".part", path)
                return self.send_json({"name": name, "size": len(data)})
            if len(parts) == 2 and parts[0] == "designs":
                os.makedirs(DESIGNS, exist_ok=True)
                name = safe_name(parts[1], (".json",))
                data = self.body()
                try:
                    json.loads(data)
                except ValueError:
                    return self.error("not a project")
                path = os.path.join(DESIGNS, name)
                with open(path + ".part", "wb") as f:
                    f.write(data)
                os.replace(path + ".part", path)
                return self.send_json({"name": name[:-5], "size": len(data)})
            return self.error("not found", 404)
        except ValueError as e:
            return self.error(str(e))

    # ------------------------------------------------------------- DELETE
    def do_DELETE(self):
        parts = self.route()
        try:
            if len(parts) == 2 and parts[0] == "models":
                p = os.path.join(MODELS, safe_name(parts[1], MODEL_EXT))
                if os.path.isfile(p):
                    os.remove(p)
                return self.send_json({"ok": True})
            if len(parts) == 2 and parts[0] == "designs":
                p = os.path.join(DESIGNS, safe_name(parts[1], (".json",)))
                if os.path.isfile(p):
                    os.remove(p)
                return self.send_json({"ok": True})
            return self.error("not found", 404)
        except ValueError as e:
            return self.error(str(e))

    # ------------------------------------------------------------- POST
    def do_POST(self):
        parts = self.route()
        if parts == ["slice"]:
            return self.start_slice()
        if parts == ["calibration", "temp_tower"]:
            return self.start_temp_tower()
        if parts == ["gcode", "color_changes"]:
            return self.color_changes()
        if parts[:1] == ["update"]:
            return self.update_action(parts[1:])
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel":
            job = jobs.get(parts[1])
            if not job:
                return self.error("no such job", 404)
            job["cancelled"] = True
            proc = job.get("proc")
            if proc:
                proc.kill()
            return self.send_json({"ok": True})
        return self.error("not found", 404)

    def start_slice(self):
        """Body: 4-byte big-endian JSON length, JSON options, then the binary
        STLs of every model back to back.

        options.parts lists [{"name", "bytes"}] in the same order.  Each STL
        is already rotated/scaled/moved into bed coordinates by the browser."""
        if not self.server.slicer_version:
            return self.error("PrusaSlicer is not installed on the Pi", 500)
        data = self.body()
        if len(data) < 4:
            return self.error("empty request")
        n = struct.unpack(">I", data[:4])[0]
        try:
            opts = json.loads(data[4:4 + n])
        except ValueError:
            return self.error("bad options")
        parts = opts.get("parts") or []
        if not parts:
            return self.error("no models on the bed")
        if sum(int(p["bytes"]) for p in parts) != len(data) - 4 - n:
            return self.error("model data is incomplete")
        for key, table in (("quality", QUALITY), ("material", MATERIAL),
                           ("supports", SUPPORTS)):
            if opts.get(key, next(iter(table))) not in table:
                return self.error("unknown %s" % key)
        workdir = tempfile.mkdtemp(prefix="studio-slice-")
        paths, pos = [], 4 + n
        for i, part in enumerate(parts):
            try:
                base = os.path.splitext(safe_name(part.get("name") or ""))[0]
            except ValueError:
                base = "part"
            # The file name becomes the object name Klipper shows.
            path = unique_path(workdir, "%s.stl" % (base or "part%d" % i))
            with open(path, "wb") as f:
                f.write(data[pos:pos + int(part["bytes"])])
            pos += int(part["bytes"])
            paths.append(path)
        job_id = self.new_job(opts, paths, workdir)
        if not job_id:
            return self.error("Already slicing - wait for it to finish", 409)
        return self.send_json({"id": job_id})

    def update_action(self, parts):
        try:
            if parts == ["check"]:
                UPDATER.check()
            elif parts == ["install"]:
                UPDATER.install(manual=True)
            elif parts == ["auto"]:
                UPDATER.set_auto(json.loads(self.body() or b"{}").get("auto", True))
            else:
                return self.error("not found", 404)
        except updater.UpdateError as e:
            return self.error(str(e), 409)
        return self.send_json(UPDATER.status())

    def new_job(self, opts, paths, workdir):
        """Start slicing in the background; None if a slice is running."""
        with jobs_lock:
            if any(j["state"] in ("queued", "slicing") for j in jobs.values()):
                shutil.rmtree(workdir, ignore_errors=True)
                return None
            # Forget old jobs so the dict doesn't grow forever.
            cutoff = time.time() - 3600
            for k in [k for k, j in jobs.items() if j["started"] < cutoff]:
                jobs.pop(k, None)
            job_id = uuid.uuid4().hex[:12]
            jobs[job_id] = {"id": job_id, "state": "queued", "progress": 0,
                            "message": "Queued", "started": time.time(),
                            "name": opts.get("name")}
        threading.Thread(target=run_slice, daemon=True,
                         args=(job_id, paths, opts, workdir)).start()
        return job_id

    def color_changes(self):
        """Add/remove M600 filament changes in a sliced file.

        Body: {"file": "x.gcode", "z": [list of layer Z heights]} - the file
        ends up with exactly those changes (an empty list removes them)."""
        try:
            req = json.loads(self.body() or b"{}")
            name = req["file"]
            zs = sorted({round(float(z), 3) for z in req.get("z", [])})
        except (KeyError, ValueError, TypeError):
            return self.error("bad request")
        path = os.path.realpath(os.path.join(GCODES, name))
        if not path.startswith(os.path.realpath(GCODES) + os.sep) or \
                not os.path.isfile(path):
            return self.error("no such file", 404)
        tmp = path + ".studio-tmp"
        added = 0
        with open(path) as src, open(tmp, "w") as dst:
            for line in src:
                if line.startswith("M600 ; studio filament change"):
                    continue
                dst.write(line)
                if line.startswith(";Z:"):
                    try:
                        z = round(float(line[3:]), 3)
                    except ValueError:
                        continue
                    if z in zs:
                        dst.write("M600 ; studio filament change\n")
                        added += 1
        os.replace(tmp, path)
        return self.send_json({"ok": True, "changes": added})

    def start_temp_tower(self):
        try:
            req = json.loads(self.body() or b"{}")
            material = req.get("material", "pla")
            if material not in MATERIAL:
                return self.error("unknown material")
            hot, cool = MATERIAL[material]["tower"]
            start, end = int(req.get("start", hot)), int(req.get("end", cool))
            step = int(req.get("step", 5)) or 5
        except ValueError:
            return self.error("bad request")
        if not 150 <= min(start, end) <= max(start, end) <= 250:
            return self.error("temperatures must be between 150 and 250")
        boxes, steps, temps = temp_tower(start, end, step)
        workdir = tempfile.mkdtemp(prefix="studio-cal-")
        path = os.path.join(workdir, "temp_tower.stl")
        boxes_stl(path, boxes)
        opts = {"name": "temp_tower_%s_%d-%d" % (material, temps[0], temps[-1]),
                "quality": "standard", "material": material, "supports": "none",
                "infill": 15, "brim": 0, "temp_steps": steps}
        job_id = self.new_job(opts, [path], workdir)
        if not job_id:
            return self.error("Already slicing - wait for it to finish", 409)
        return self.send_json({"id": job_id, "temps": temps})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 8091), Handler)
    srv.slicer_version = slicer_version()
    UPDATER.start()
    print("Ender Studio server on 127.0.0.1:8091, slicer:",
          srv.slicer_version, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
