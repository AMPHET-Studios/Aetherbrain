"""
Blender side of the LunCo .blend -> Unreal importer.

Exports what a .blend scene renders so import_blend_scene.py can rebuild it in
Unreal:

  <out>/manifest.json          where every object, light and camera goes
  <out>/meshes/<name>.gltf     one file per unique mesh, in its own local space
  <out>/meshes/textures/       textures shared by those files

Linked duplicates, collection instances, particle and Geometry Nodes instances
all point at the same exported mesh, so Unreal imports each mesh once and
places it many times, with the pivot at the Blender object origin.

You normally don't run this yourself: import_blend_scene.py starts Blender in
the background with it. To run it by hand:

  blender -b "E:/LunCo/LunCo_MAINREFRESHblend.blend" --python blender_export_for_unreal.py -- --out "E:/LunCo/UnrealExport/LunCo_MAINREFRESHblend"

or open the .blend, go to the Scripting tab, open this file and press Run
Script (it exports to UnrealExport/<blend name> next to the .blend).
"""

import json
import os
import re
import sys
import time

import bpy

MESH_TYPES = {"MESH", "CURVE", "SURFACE", "META", "FONT"}
PROBE_NAME = "SM___AxisProbe"
PROBE_EXTENT = (1.0, 2.0, 3.0)  # probe tetrahedron reaches 1 / 2 / 3 units along X / Y / Z
TEMP_COLLECTION = "__unreal_export_tmp"
GLTF_OPTIONS = {
    "export_format": "GLTF_SEPARATE",
    "export_texture_dir": "textures",
    "use_selection": True,
    "export_apply": True,
    "export_yup": True,
    "export_materials": "EXPORT",
    "export_image_format": "AUTO",
    "export_animations": False,
    "export_skins": False,
    "export_morph": False,
    "export_lights": False,
    "export_cameras": False,
    "export_extras": False,
}


def log(msg):
    print("[LUNCO] " + msg, flush=True)


def _safe(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "Mesh"


def _matrix(m):
    return [[float(m[r][c]) for c in range(4)] for r in range(4)]


def _renders(obj):
    """Would this object show up in a render?"""
    if obj.hide_render:
        return False
    collections = obj.users_collection
    return not (collections and all(c.hide_render for c in collections))


def _collection_paths(scene):
    paths = {}

    def walk(coll, prefix):
        for child in coll.children:
            path = prefix + "/" + child.name if prefix else child.name
            paths.setdefault(child.name, path)
            walk(child, path)

    walk(scene.collection, "")
    return paths


def _folder_of(obj, paths):
    for coll in obj.users_collection:
        if coll.name in paths:
            return paths[coll.name]
    return ""


class _Names(object):
    """Unique, Unreal-safe asset names that don't collide with anything in the .blend."""

    def __init__(self):
        self.used = set()

    def make(self, base):
        root = "SM_" + _safe(base)
        name, n = root, 2
        while name.lower() in self.used or name in bpy.data.meshes or name in bpy.data.objects:
            name = "%s_%d" % (root, n)
            n += 1
        self.used.add(name.lower())
        return name


def _export_gltf(path):
    op = bpy.ops.export_scene.gltf
    supported = op.get_rna_type().properties.keys()
    op(filepath=path, **{k: v for k, v in GLTF_OPTIONS.items() if k in supported})


def _light_entry(obj, label, matrix, folder):
    d = obj.data
    return {
        "name": label,
        "type": d.type,
        "color": [float(c) for c in d.color],
        "energy": float(d.energy),
        "matrix": _matrix(matrix),
        "folder": folder,
        "radius": float(getattr(d, "shadow_soft_size", 0.0)),
        "spot_size": float(getattr(d, "spot_size", 0.0)),
        "spot_blend": float(getattr(d, "spot_blend", 0.0)),
        "shape": getattr(d, "shape", None),
        "size": float(getattr(d, "size", 0.0)),
        "size_y": float(getattr(d, "size_y", 0.0)),
        "angle": float(getattr(d, "angle", 0.0)),
        "cutoff": float(d.cutoff_distance) if getattr(d, "use_custom_distance", False) else None,
    }


def _camera_entry(obj, label, matrix, folder, is_active):
    d = obj.data
    return {
        "name": label,
        "type": d.type,
        "matrix": _matrix(matrix),
        "folder": folder,
        "lens": float(d.lens),
        "sensor_width": float(d.sensor_width),
        "sensor_height": float(d.sensor_height),
        "sensor_fit": d.sensor_fit,
        "clip_start": float(d.clip_start),
        "clip_end": float(d.clip_end),
        "ortho_scale": float(d.ortho_scale),
        "active": bool(is_active),
    }


def export(out_dir):
    started = time.time()
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except RuntimeError:
            pass

    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    paths = _collection_paths(scene)
    mesh_dir = os.path.join(out_dir, "meshes")
    os.makedirs(mesh_dir, exist_ok=True)
    names = _Names()

    sources = {}      # key -> {"name", "object" | "copy", "materials"}
    placements = []
    lights = []
    cameras = []
    skipped = []
    gn_hosts = set()  # objects whose Geometry Nodes output is instances

    # 1. walk everything the depsgraph draws: real objects plus collection,
    #    particle and Geometry Nodes instances
    for inst in depsgraph.object_instances:
        ob = inst.object
        orig = ob.original
        instancer = inst.parent.original if inst.is_instance and inst.parent is not None else None
        if not _renders(instancer if instancer is not None else orig):
            continue
        matrix = inst.matrix_world.copy()
        folder = _folder_of(instancer if instancer is not None else orig, paths)
        if instancer is not None:
            folder = (folder + "/" if folder else "") + instancer.name
        label = orig.name

        if ob.type in MESH_TYPES:
            geometry_instance = instancer is not None and orig == instancer
            if geometry_instance:
                if instancer.type != "MESH":
                    continue  # a curve / text object's own mesh; the object itself is exported
                # geometry made by Geometry Nodes, not a real object: copy it now,
                # the instance object only lives for this loop iteration
                key = ("geo", instancer.name, ob.data.as_pointer() if ob.data else id(ob))
                label = instancer.name + "_instance"
                gn_hosts.add(instancer.name)
            elif ob.type == "MESH" and len(orig.modifiers) == 0:
                object_materials = tuple(s.material.name_full if s.material else ""
                                         for s in orig.material_slots if s.link == "OBJECT")
                key = ("data", orig.data.name_full, object_materials)
            else:
                key = ("obj", orig.name_full)  # name_full: linked-library objects can share names

            if key not in sources:
                entry = {"name": names.make(orig.data.name if key[0] == "data" else label),
                         "label": label}
                if geometry_instance:
                    try:
                        entry["copy"] = ob.data.copy()
                        entry["materials"] = [s.material.original if s.material else None
                                              for s in ob.material_slots]
                    except Exception as exc:  # noqa: BLE001 - keep going, report it
                        skipped.append({"name": label, "reason": "could not copy instance geometry: %s" % exc})
                        entry = None
                else:
                    entry["object"] = orig  # the original datablock; safe to keep past this loop
                sources[key] = entry
            entry = sources[key]
            if entry is not None:
                placements.append({"name": label, "mesh": entry["name"], "matrix": _matrix(matrix),
                                   "folder": folder})
        elif ob.type == "LIGHT":
            lights.append(_light_entry(ob, label, matrix, folder))
        elif ob.type == "CAMERA":
            cameras.append(_camera_entry(ob, label, matrix, folder, scene.camera is not None
                                         and orig == scene.camera and instancer is None))

    # 2. export each unique mesh once, at the origin, with its modifiers applied
    temp = bpy.data.collections.new(TEMP_COLLECTION)
    scene.collection.children.link(temp)
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)

    meshes = {}
    todo = [e for e in sources.values() if e is not None]
    probe = bpy.data.meshes.new(PROBE_NAME)
    probe.from_pydata([(0, 0, 0), (PROBE_EXTENT[0], 0, 0), (0, PROBE_EXTENT[1], 0), (0, 0, PROBE_EXTENT[2])],
                      [], [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)])
    todo.append({"name": PROBE_NAME, "label": PROBE_NAME, "probe": probe})

    total = len(todo)
    for i, entry in enumerate(todo):
        log("PROGRESS %d/%d %s" % (i + 1, total, entry["label"]))
        mesh = None
        tmp = None
        try:
            if "probe" in entry:
                mesh = entry["probe"]
                materials = []
            elif "copy" in entry:
                mesh = entry["copy"]
                materials = entry["materials"]
            else:
                src = entry["object"]
                mesh = bpy.data.meshes.new_from_object(src.evaluated_get(depsgraph),
                                                       preserve_all_data_layers=True, depsgraph=depsgraph)
                materials = [s.material for s in src.material_slots]
            if len(mesh.polygons) == 0:
                if entry["label"] not in gn_hosts:  # a scatter host's own mesh is often empty
                    skipped.append({"name": entry["label"], "reason": "no faces (curve path, empty mesh...)"})
                continue
            mesh.name = entry["name"]
            tmp = bpy.data.objects.new(entry["name"], mesh)
            temp.objects.link(tmp)
            for slot, material in zip(tmp.material_slots, materials):
                if material is not None and slot.material != material:
                    slot.link = "OBJECT"
                    slot.material = material
            tmp.select_set(True)
            bpy.context.view_layer.objects.active = tmp
            path = os.path.join(mesh_dir, entry["name"] + ".gltf")
            _export_gltf(path)
            meshes[entry["name"]] = {"file": "meshes/" + entry["name"] + ".gltf", "source": entry["label"]}
        except Exception as exc:  # noqa: BLE001 - one bad mesh shouldn't stop the export
            skipped.append({"name": entry["label"], "reason": str(exc)})
        finally:
            if tmp is not None:
                bpy.data.objects.remove(tmp)
            if mesh is not None and mesh.users == 0:
                bpy.data.meshes.remove(mesh)

    bpy.data.collections.remove(temp)

    probe_entry = meshes.pop(PROBE_NAME, None)
    placements = [p for p in placements if p["mesh"] in meshes]
    manifest = {
        "version": 1,
        "source": bpy.data.filepath,
        "blender": bpy.app.version_string,
        "scene": scene.name,
        "unit_scale": float(scene.unit_settings.scale_length),
        "render_resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "probe": dict(probe_entry, name=PROBE_NAME, extent=list(PROBE_EXTENT)) if probe_entry else None,
        "meshes": meshes,
        "objects": placements,
        "lights": lights,
        "cameras": cameras,
        "skipped": skipped,
    }
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=1)

    log("Exported %d unique meshes, %d placements, %d lights, %d cameras in %.1fs (%d skipped)"
        % (len(meshes), len(placements), len(lights), len(cameras), time.time() - started, len(skipped)))
    for s in skipped:
        log("SKIPPED %s: %s" % (s["name"], s["reason"]))
    log("DONE " + manifest_path)
    return manifest_path


def _default_out_dir():
    blend = bpy.data.filepath
    if not blend:
        raise RuntimeError("Save the .blend first (or pass --out).")
    stem = os.path.splitext(os.path.basename(blend))[0]
    return os.path.join(os.path.dirname(blend), "UnrealExport", stem)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out_dir = None
    if "--out" in argv:
        out_dir = argv[argv.index("--out") + 1]
    export(os.path.abspath(out_dir or _default_out_dir()))


if __name__ == "__main__":
    main()
