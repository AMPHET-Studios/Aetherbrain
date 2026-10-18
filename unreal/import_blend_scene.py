"""
Lunco - Import a Blender scene into Unreal
==========================================

Brings E:/LunCo/LunCo_MAINREFRESHblend.blend into the level you have open:
every mesh that renders (with its materials and textures), where each object
sits, plus lights and cameras.

Needs Blender installed, blender_export_for_unreal.py in the same folder as this
script, and PythonScriptPlugin + EditorScriptingUtilities (both already enabled
in Lunco.uproject).

Run it
------
1. Put this file and blender_export_for_unreal.py in the same folder (F:/CONCEPTFORGE).
2. Open the level you want the scene in.
3. Tools > Execute Python Script...  and pick this file.
4. Save the level (Ctrl+S) to keep it. Ctrl+Z removes the placed actors in one step.

What happens
------------
1. Blender opens the .blend in the background and exports each unique mesh once,
   plus a manifest of where everything goes, to F:/CONCEPTFORGE/UnrealExport/<blend name>.
   If that export is newer than the .blend it is reused.
2. The meshes are imported into /Game/<blend name> with their materials.
3. Every object, instance, light and camera is placed with its Blender transform
   (pivots stay on the Blender object origins), in Outliner folders that mirror
   the Blender collections. A mesh repeated INSTANCE_THRESHOLD+ times (scatters)
   becomes one instanced actor.
4. The viewport jumps to the Blender scene camera.

Not carried over: animation, armatures (meshes come in posed), Blender-only
shader nodes (glTF keeps Principled BSDF + image textures), the World / HDRI.
"""

import glob
import json
import math
import os
import queue
import re
import shutil
import subprocess
import threading
import time

try:
    import unreal
except ImportError:  # lets the transform maths run (and be tested) outside the editor
    unreal = None


# ============================================================ settings
BLEND_FILE = "E:/LunCo/LunCo_MAINREFRESHblend.blend"
WORK_FOLDER = "F:/CONCEPTFORGE"
EXPORT_DIR = None           # None = <WORK_FOLDER>/UnrealExport/<blend name> (next to the .blend if WORK_FOLDER is missing)
BLENDER_EXE = None          # None = find it (file association, Program Files, Steam, PATH)
REEXPORT = "auto"           # "auto" = only when the .blend is newer than the export; "always"; "never"
DEST_FOLDER = None          # None = /Game/<blend name>
OUTLINER_ROOT = None        # None = <blend name>

IMPORT_LIGHTS = True
IMPORT_CAMERAS = True
INSTANCE_THRESHOLD = 100    # a mesh placed this many times becomes one instanced actor (0 = never)
RESPECT_UNIT_SCALE = True   # honour Blender's Scene > Units > Unit Scale
LIGHT_INTENSITY_SCALE = 1.0 # multiply converted light intensities (Blender W -> Unreal cd / lux)
REPLACE_PREVIOUS = True     # re-running removes what the last run of this .blend placed
FRAME_VIEWPORT = True
SHOW_SUMMARY_DIALOG = True
IMPORT_BATCH = 8            # meshes per import call (progress updates between batches)

# How Unreal's glTF import maps Blender axes when the axis probe can't be read:
# Blender (x, y, z) metres -> Unreal (x, -y, z) centimetres.
DEFAULT_AXES = ([[1, 0, 0], [0, -1, 0], [0, 0, 1]], 100.0)


# ============================================================ transform maths
# Pure Python so it runs in any Unreal build and can be tested outside it.

def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _normalize(a):
    length = math.sqrt(_dot(a, a))
    return _mul(a, 1.0 / length) if length > 1e-12 else (0.0, 0.0, 0.0)


def _column(m, j):
    return (m[0][j], m[1][j], m[2][j])


def _apply(m, v):
    return tuple(m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] for i in range(3))


def _matmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _transpose(m):
    return [[m[j][i] for j in range(3)] for i in range(3)]


def _det(m):
    return _dot(_column(m, 0), _cross(_column(m, 1), _column(m, 2)))


def axis_mapping(box_min, box_max, extent=(1.0, 2.0, 3.0)):
    """Read how the importer mapped Blender axes from the imported probe's bounds.

    The probe reaches extent[j] Blender units along Blender axis j. Returns a
    signed permutation P (unreal = P * blender) and the Unreal units per Blender unit."""
    lengths = [box_max[i] - box_min[i] for i in range(3)]
    units = sum(lengths) / float(sum(extent))
    if units <= 0:
        raise ValueError("probe has no size")
    perm = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    used = set()
    for i in range(3):
        ratio = lengths[i] / units
        j = min(range(3), key=lambda k: abs(extent[k] - ratio))
        if j in used or abs(extent[j] - ratio) > 0.05 * extent[j]:
            raise ValueError("probe bounds %s..%s are not an axis permutation" % (box_min, box_max))
        used.add(j)
        perm[i][j] = 1 if box_max[i] > -box_min[i] else -1
    return perm, units


def convert_transform(matrix, perm, units, unit_scale=1.0):
    """Blender world matrix (4x4 rows) -> Unreal (location, (x, y, z) axes, scale).

    An imported mesh vertex is units * P * v, so the actor needs
    linear part P * L * P^T and location units * P * t."""
    linear = [[matrix[r][c] for c in range(3)] for r in range(3)]
    trans = (matrix[0][3], matrix[1][3], matrix[2][3])
    a = _matmul(_matmul(perm, linear), _transpose(perm))
    location = _mul(_apply(perm, trans), units * unit_scale)
    cols = [_column(a, j) for j in range(3)]
    scale = [math.sqrt(_dot(c, c)) for c in cols]
    if _det(a) < 0:
        scale[0] = -scale[0]  # mirrored object: keep a proper rotation, flip X scale
    basis = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    axes = [_mul(cols[j], 1.0 / scale[j]) if abs(scale[j]) > 1e-9 else basis[j] for j in range(3)]
    x = _normalize(axes[0])
    y = _normalize(_sub(axes[1], _mul(x, _dot(axes[1], x))))
    if y == (0.0, 0.0, 0.0):
        y = _normalize(_cross(axes[2], x))
    z = _cross(x, y)
    scale = [s * unit_scale if abs(s) > 1e-9 else 1e-4 for s in scale]
    return location, (x, y, z), tuple(scale)


def frame_from_forward_up(forward, up):
    """Orthonormal (x, y, z) axes whose X is forward and Z is as close to up as possible."""
    f = _normalize(forward)
    right = _normalize(_cross(up, f))
    if right == (0.0, 0.0, 0.0):
        right = _normalize(_cross((0.0, 0.0, 1.0) if abs(f[2]) < 0.9 else (0.0, 1.0, 0.0), f))
    return f, right, _cross(f, right)


def rotator_from_axes(x, y, z):
    """(pitch, yaw, roll) in degrees for axes X/Y/Z, matching Unreal's FMatrix::Rotator()."""
    pitch = math.atan2(x[2], math.sqrt(x[0] * x[0] + x[1] * x[1]))
    yaw = math.atan2(x[1], x[0])
    sy = (-math.sin(yaw), math.cos(yaw), 0.0)  # Y axis of FRotationMatrix(pitch, yaw, 0)
    roll = math.atan2(_dot(z, sy), _dot(y, sy))
    return math.degrees(pitch), math.degrees(yaw), math.degrees(roll)


def axes_from_rotator(pitch, yaw, roll):
    """Unreal's FRotationMatrix axes for a rotator (used by the tests)."""
    p, yw, r = (math.radians(v) for v in (pitch, yaw, roll))
    sp, cp, sy, cy, sr, cr = math.sin(p), math.cos(p), math.sin(yw), math.cos(yw), math.sin(r), math.cos(r)
    x = (cp * cy, cp * sy, sp)
    y = (sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp)
    z = (-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp)
    return x, y, z


def light_frame(matrix, perm):
    """Blender lights and cameras look down local -Z with +Y up; Unreal ones look down +X."""
    linear = [[matrix[r][c] for c in range(3)] for r in range(3)]
    forward = _apply(perm, _mul(_column(linear, 2), -1.0))
    up = _apply(perm, _column(linear, 1))
    return frame_from_forward_up(forward, up)


def light_intensity(light):
    """Blender watts -> Unreal candela (point / spot / area) or lux (sun)."""
    energy = light["energy"] * LIGHT_INTENSITY_SCALE
    if light["type"] == "SUN":
        return energy
    if light["type"] == "AREA":
        return energy / math.pi
    return energy / (4.0 * math.pi)


def sensor_size(camera, resolution):
    """Filmback (width, height) in mm that matches Blender's sensor fit."""
    rx, ry = float(resolution[0]), float(resolution[1])
    fit = camera["sensor_fit"]
    if fit == "VERTICAL" or (fit == "AUTO" and ry > rx):
        height = camera["sensor_height"] if fit == "VERTICAL" else camera["sensor_width"]
        return height * rx / ry, height
    return camera["sensor_width"], camera["sensor_width"] * ry / rx


# ============================================================ Unreal side

def _log(msg):
    unreal.log("[BlendImport] " + msg)


def _warn(msg):
    unreal.log_warning("[BlendImport] " + msg)


def _error(msg):
    unreal.log_error("[BlendImport] " + msg)
    if SHOW_SUMMARY_DIALOG:
        unreal.EditorDialog.show_message("Blender scene import", msg, unreal.AppMsgType.OK)


def _asset_safe(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "BlendScene"


def _asset_class_name(asset_data):
    try:
        return str(asset_data.asset_class_path.asset_name)
    except Exception:
        return str(asset_data.asset_class)


def _vec(v):
    return unreal.Vector(float(v[0]), float(v[1]), float(v[2]))


def _rot(axes):
    pitch, yaw, roll = rotator_from_axes(*axes)
    return unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw)


def _has_tag(actor, tag):
    try:
        return any(str(t) == tag for t in actor.get_editor_property("tags"))
    except Exception:
        return False


def _finish_actor(actor, label, folder, tag):
    actor.set_actor_label(label)
    actor.set_folder_path(folder)
    tags = [str(t) for t in actor.get_editor_property("tags")]
    actor.set_editor_property("tags", tags + [tag])


# ---------------------------------------------------------------- Blender

def find_blender():
    if BLENDER_EXE:
        return BLENDER_EXE if os.path.isfile(BLENDER_EXE) else None
    found = []
    try:  # whatever opens .blend files on double-click
        import winreg
        command = winreg.QueryValue(winreg.HKEY_CLASSES_ROOT, r"blendfile\shell\open\command")
        exe = re.findall(r'"([^"]+\.exe)"', command) or command.split()[:1]
        if exe:
            found.append(os.path.join(os.path.dirname(exe[0]), "blender.exe"))
    except Exception:
        pass
    roots = [os.environ.get("ProgramFiles", "C:/Program Files"),
             os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"),
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")]
    for root in roots:
        found += sorted(glob.glob(os.path.join(root, "Blender Foundation", "Blender*", "blender.exe")),
                        key=lambda p: [int(n) for n in re.findall(r"\d+", os.path.basename(os.path.dirname(p)))],
                        reverse=True)
    for drive in "CDEFG":
        for sub in ("Program Files (x86)/Steam/steamapps/common/Blender", "SteamLibrary/steamapps/common/Blender",
                    "Steam/steamapps/common/Blender", "Blender"):
            found.append("%s:/%s/blender.exe" % (drive, sub))
    found.append(shutil.which("blender") or "")
    return next((p for p in found if p and os.path.isfile(p)), None)


def find_exporter():
    here = os.path.dirname(os.path.abspath(globals().get("__file__", "") or "."))
    places = [here, WORK_FOLDER, os.path.dirname(BLEND_FILE)]
    try:
        places += [unreal.Paths.project_dir(), os.path.join(unreal.Paths.project_content_dir(), "Python")]
    except Exception:
        pass
    for place in places:
        path = os.path.join(place, "blender_export_for_unreal.py")
        if os.path.isfile(path):
            return path
    return None


def run_blender(blender, exporter, out_dir):
    cmd = [blender, "--factory-startup", "-noaudio", "-b", BLEND_FILE,
           "--python-exit-code", "1", "--python", exporter, "--", "--out", out_dir]
    _log("Running: " + " ".join('"%s"' % c if " " in c else c for c in cmd))
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", creationflags=flags)
    lines = queue.Queue()
    reader = threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True)
    reader.start()
    tail = []
    done = 0.0
    with unreal.ScopedSlowTask(100.0, "Exporting the .blend from Blender...") as task:
        task.make_dialog(True)
        while reader.is_alive() or not lines.empty():
            try:
                line = lines.get(timeout=0.1).rstrip()
            except queue.Empty:
                task.enter_progress_frame(0.0)
                if task.should_cancel():
                    proc.kill()
                    _warn("Cancelled while Blender was exporting.")
                    return False
                continue
            tail = (tail + [line])[-40:]
            match = re.match(r"\[LUNCO\] PROGRESS (\d+)/(\d+) (.*)", line)
            if match:
                target = 100.0 * int(match.group(1)) / max(1, int(match.group(2)))
                task.enter_progress_frame(max(0.0, target - done), "Blender: exporting %s" % match.group(3))
                done = max(done, target)
            elif line.startswith("[LUNCO]"):
                _log(line)
    proc.wait()
    if proc.returncode != 0:
        _error("Blender export failed (exit code %s). Last output:\n\n%s" % (proc.returncode, "\n".join(tail[-15:])))
        return False
    return True


# ---------------------------------------------------------------- import

def import_files(files, dest):
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    with unreal.ScopedSlowTask(float(len(files)), "Importing meshes into %s..." % dest) as task:
        task.make_dialog(True)
        for start in range(0, len(files), IMPORT_BATCH):
            if task.should_cancel():
                return False
            batch = files[start:start + IMPORT_BATCH]
            task.enter_progress_frame(float(len(batch)), "Importing %s" % os.path.basename(batch[0]))
            tasks = []
            for path in batch:
                t = unreal.AssetImportTask()
                t.set_editor_property("filename", path)
                t.set_editor_property("destination_path", dest)
                t.set_editor_property("automated", True)
                t.set_editor_property("save", True)
                t.set_editor_property("replace_existing", True)
                try:
                    t.set_editor_property("async_", False)
                except Exception:
                    pass
                tasks.append(t)
            tools.import_asset_tasks(tasks)
    return True


def static_meshes_in(folder):
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    return {str(ad.asset_name): ad for ad in registry.get_assets_by_path(folder, recursive=True)
            if _asset_class_name(ad) == "StaticMesh"}


def resolve_mesh(name, available):
    if name in available:
        return available[name]
    low = name.lower()
    for key, ad in available.items():
        if key.lower() == low or key.lower().endswith(low):
            return ad
    return None


def read_axis_probe(manifest, out_dir, dest):
    probe = manifest.get("probe")
    if not probe:
        return None
    import_files([os.path.join(out_dir, probe["file"])], dest)
    ad = resolve_mesh(probe["name"], static_meshes_in(dest))
    if ad is None:
        return None
    mesh = ad.get_asset()
    try:
        box = mesh.get_bounding_box()
        result = axis_mapping((box.min.x, box.min.y, box.min.z), (box.max.x, box.max.y, box.max.z),
                              probe.get("extent", (1.0, 2.0, 3.0)))
    finally:
        unreal.EditorAssetLibrary.delete_asset(str(ad.package_name))
    return result


# ---------------------------------------------------------------- placing

def spawn_instanced(actor_sub, mesh, transforms):
    """One actor holding a hierarchical instanced static mesh component, or None."""
    actor = actor_sub.spawn_actor_from_class(unreal.Actor, unreal.Vector(0.0, 0.0, 0.0))
    try:
        subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
        root = subsystem.k2_gather_subobject_data_for_instance(actor)[0]
        params = unreal.AddNewSubobjectParams(parent_handle=root,
                                              new_class=unreal.HierarchicalInstancedStaticMeshComponent,
                                              blueprint_context=None)
        handle, _ = subsystem.add_new_subobject(params)
        data = unreal.SubobjectDataBlueprintFunctionLibrary.get_data(handle)
        comp = unreal.SubobjectDataBlueprintFunctionLibrary.get_object(data)
        comp.set_static_mesh(mesh)
        comp.add_instances(transforms, False, True)
        if comp.get_instance_count() != len(transforms):
            raise RuntimeError("instances not added")
        return actor
    except Exception as exc:
        _warn("Instanced actor failed (%s); placing individual actors instead." % exc)
        actor_sub.destroy_actor(actor)
        return None


def place_light(actor_sub, light, perm, units, unit_scale):
    location, _, _ = convert_transform(light["matrix"], perm, units, unit_scale)
    axes = light_frame(light["matrix"], perm)
    cls = {"POINT": unreal.PointLight, "SPOT": unreal.SpotLight,
           "SUN": unreal.DirectionalLight, "AREA": unreal.RectLight}.get(light["type"])
    if cls is None:
        return None
    actor = actor_sub.spawn_actor_from_class(cls, _vec(location), _rot(axes))
    comp = actor.get_component_by_class(unreal.LightComponent)
    intensity = light_intensity(light)
    cm = units * unit_scale
    try:
        if light["type"] != "SUN":
            comp.set_editor_property("intensity_units", unreal.LightUnits.CANDELAS)
        comp.set_intensity(intensity)
        comp.set_light_color(unreal.LinearColor(light["color"][0], light["color"][1], light["color"][2], 1.0), True)
        if light["type"] == "SUN":
            comp.set_editor_property("light_source_angle", max(0.0, math.degrees(light.get("angle", 0.0))))
        else:
            reach = light["cutoff"] * cm if light.get("cutoff") else math.sqrt(max(intensity, 0.0) / 0.01) * 100.0
            comp.set_attenuation_radius(min(max(reach, 1000.0), 50000.0))
        if light["type"] in ("POINT", "SPOT"):
            comp.set_source_radius(light["radius"] * cm)
        if light["type"] == "SPOT":
            outer = min(80.0, math.degrees(light["spot_size"]) / 2.0)
            comp.set_outer_cone_angle(outer)
            comp.set_inner_cone_angle(outer * (1.0 - light["spot_blend"]))
        if light["type"] == "AREA":
            height = light["size_y"] if light.get("shape") in ("RECTANGLE", "ELLIPSE") else light["size"]
            comp.set_source_width(light["size"] * cm)
            comp.set_source_height(height * cm)
    except Exception as exc:
        _warn("Light %s: some settings not applied (%s)" % (light["name"], exc))
    return actor


def place_camera(actor_sub, camera, perm, units, unit_scale, resolution):
    location, _, _ = convert_transform(camera["matrix"], perm, units, unit_scale)
    axes = light_frame(camera["matrix"], perm)
    actor = actor_sub.spawn_actor_from_class(unreal.CineCameraActor, _vec(location), _rot(axes))
    try:
        comp = actor.get_cine_camera_component()
        width, height = sensor_size(camera, resolution)
        filmback = comp.get_editor_property("filmback")
        filmback.set_editor_property("sensor_width", width)
        filmback.set_editor_property("sensor_height", height)
        comp.set_editor_property("filmback", filmback)
        comp.set_editor_property("current_focal_length", camera["lens"])
        if camera["type"] == "ORTHO":
            comp.set_editor_property("projection_mode", unreal.CameraProjectionMode.ORTHOGRAPHIC)
            comp.set_editor_property("ortho_width", camera["ortho_scale"] * units * unit_scale)
    except Exception as exc:
        _warn("Camera %s: some settings not applied (%s)" % (camera["name"], exc))
    return actor, location, axes


# ---------------------------------------------------------------- main

def build():
    started = time.time()
    if not os.path.isfile(BLEND_FILE):
        _error("Can't find the .blend at %s. Set BLEND_FILE at the top of this script." % BLEND_FILE)
        return
    stem = os.path.splitext(os.path.basename(BLEND_FILE))[0]
    base = WORK_FOLDER if WORK_FOLDER and os.path.isdir(WORK_FOLDER) else os.path.dirname(BLEND_FILE)
    out_dir = EXPORT_DIR or os.path.join(base, "UnrealExport", stem)
    dest = DEST_FOLDER or "/Game/" + _asset_safe(stem)
    root = OUTLINER_ROOT or stem
    tag = "BlendImport_" + _asset_safe(stem)
    manifest_path = os.path.join(out_dir, "manifest.json")

    # 1. export from Blender (or reuse an export that's newer than the .blend)
    fresh = os.path.isfile(manifest_path) and os.path.getmtime(manifest_path) >= os.path.getmtime(BLEND_FILE)
    if REEXPORT == "always" or (REEXPORT == "auto" and not fresh) or not os.path.isfile(manifest_path):
        if REEXPORT == "never" and not os.path.isfile(manifest_path):
            _error("REEXPORT is 'never' but there is no export at %s." % out_dir)
            return
        blender = find_blender()
        exporter = find_exporter()
        if not blender:
            _error("Couldn't find Blender. Set BLENDER_EXE at the top of this script, e.g.\n"
                   "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe")
            return
        if not exporter:
            _error("Couldn't find blender_export_for_unreal.py. Put it in the same folder as this script.")
            return
        if not run_blender(blender, exporter, out_dir):
            return
    else:
        _log("Reusing the export in %s (newer than the .blend)." % out_dir)

    with open(manifest_path) as f:
        manifest = json.load(f)
    unit_scale = manifest.get("unit_scale", 1.0) if RESPECT_UNIT_SCALE else 1.0

    # 2. how does this Unreal build map Blender axes? (import a known shape and look)
    try:
        mapping = read_axis_probe(manifest, out_dir, dest)
    except Exception as exc:
        _warn("Axis probe failed (%s)." % exc)
        mapping = None
    if mapping is None:
        _warn("Using the standard glTF axis mapping.")
        mapping = DEFAULT_AXES
    perm, units = mapping
    _log("Axis mapping %s, %.3g Unreal units per Blender unit." % (perm, units))

    # 3. import every unique mesh once
    files = [os.path.join(out_dir, m["file"]) for m in manifest["meshes"].values()]
    if not import_files(files, dest):
        _warn("Cancelled during import.")
        return
    available = static_meshes_in(dest)
    meshes = {}
    for name in manifest["meshes"]:
        ad = resolve_mesh(name, available)
        if ad is not None:
            meshes[name] = ad.get_asset()
    missing = sorted(set(manifest["meshes"]) - set(meshes))
    for name in missing:
        _warn("Mesh %s didn't import; its objects are skipped." % name)

    # 4. place everything
    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    placed = []
    counts = {"actors": 0, "instanced": 0, "lights": 0, "cameras": 0}
    view = None
    with unreal.ScopedEditorTransaction("Import %s" % stem):
        if REPLACE_PREVIOUS:
            old = [a for a in actor_sub.get_all_level_actors() if _has_tag(a, tag)]
            for actor in old:
                actor_sub.destroy_actor(actor)
            if old:
                _log("Removed %d actor(s) from the previous import." % len(old))

        by_mesh = {}
        for obj in manifest["objects"]:
            if obj["mesh"] in meshes:
                by_mesh.setdefault(obj["mesh"], []).append(obj)
        with unreal.ScopedSlowTask(float(len(manifest["objects"])), "Placing the scene...") as task:
            task.make_dialog(True)
            for name, objs in sorted(by_mesh.items()):
                mesh = meshes[name]
                task.enter_progress_frame(float(len(objs)), "Placing %s" % name)
                converted = [convert_transform(o["matrix"], perm, units, unit_scale) for o in objs]
                if INSTANCE_THRESHOLD and len(objs) >= INSTANCE_THRESHOLD:
                    transforms = [unreal.Transform(_vec(loc), _rot(axes), _vec(scale))
                                  for loc, axes, scale in converted]
                    actor = spawn_instanced(actor_sub, mesh, transforms)
                    if actor is not None:
                        _finish_actor(actor, "%s_x%d" % (name, len(objs)),
                                      "%s/%s" % (root, objs[0]["folder"]) if objs[0]["folder"] else root, tag)
                        placed.append(actor)
                        counts["instanced"] += len(objs)
                        continue
                for obj, (loc, axes, scale) in zip(objs, converted):
                    actor = actor_sub.spawn_actor_from_object(mesh, _vec(loc), _rot(axes))
                    if not actor:
                        continue
                    actor.set_actor_scale3d(_vec(scale))
                    _finish_actor(actor, obj["name"], "%s/%s" % (root, obj["folder"]) if obj["folder"] else root, tag)
                    placed.append(actor)
                    counts["actors"] += 1

        if IMPORT_LIGHTS:
            for light in manifest["lights"]:
                actor = place_light(actor_sub, light, perm, units, unit_scale)
                if actor:
                    _finish_actor(actor, light["name"], "%s/%s" % (root, light["folder"] or "Lights"), tag)
                    counts["lights"] += 1
        if IMPORT_CAMERAS:
            for camera in manifest["cameras"]:
                actor, location, axes = place_camera(actor_sub, camera, perm, units, unit_scale,
                                                     manifest.get("render_resolution", (1920, 1080)))
                _finish_actor(actor, camera["name"], "%s/%s" % (root, camera["folder"] or "Cameras"), tag)
                counts["cameras"] += 1
                if camera["active"]:
                    view = (location, axes)

    # 5. look at it
    if FRAME_VIEWPORT:
        editor = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
        if view is not None:
            editor.set_level_viewport_camera_info(_vec(view[0]), _rot(view[1]))
        elif placed:
            locs = [a.get_actor_location() for a in placed]
            c = unreal.Vector(sum(l.x for l in locs) / len(locs), sum(l.y for l in locs) / len(locs),
                              sum(l.z for l in locs) / len(locs))
            r = max(max(abs(l.x - c.x), abs(l.y - c.y), abs(l.z - c.z)) for l in locs) + 1000.0
            cam = unreal.Vector(c.x - r * 1.5, c.y - r * 1.5, c.z + r)
            editor.set_level_viewport_camera_info(cam, unreal.MathLibrary.find_look_at_rotation(cam, c))
        if placed:
            actor_sub.set_selected_level_actors(placed)

    summary = ("%d meshes imported into %s\n%d objects placed%s, %d lights, %d cameras"
               % (len(meshes), dest, counts["actors"] + counts["instanced"],
                  (" (%d as instances)" % counts["instanced"]) if counts["instanced"] else "",
                  counts["lights"], counts["cameras"]))
    _log(summary.replace("\n", " | "))
    for item in manifest.get("skipped", []):
        _warn("Blender skipped %s: %s" % (item["name"], item["reason"]))
    _log("Done in %.0fs. Everything is in the Outliner under '%s'." % (time.time() - started, root))
    if SHOW_SUMMARY_DIALOG:
        extra = ""
        if missing:
            extra += "\n%d mesh(es) failed to import (see Output Log)." % len(missing)
        if manifest.get("skipped"):
            extra += "\n%d Blender object(s) skipped (see Output Log)." % len(manifest["skipped"])
        unreal.EditorDialog.show_message(
            "Blender scene imported",
            "%s imported.\n\n%s%s\n\nEverything is under '%s' in the Outliner. Ctrl+Z removes it; "
            "save the level to keep it." % (os.path.basename(BLEND_FILE), summary, extra, root),
            unreal.AppMsgType.OK)


if __name__ == "__main__" and unreal is not None:
    build()
