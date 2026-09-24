"""
Lunco - Replace the landscape with the crater
=============================================

In the level you have open:
1. deletes the Landscape (and any landscape streaming proxies),
2. imports F:/Lunco/CRATER.GLB into /Game/Crater,
3. places the crater where the landscape was, rim level with the old ground,
   with collision you can walk on.

Run it: Tools > Execute Python Script...  and pick this file.
Ctrl+Z brings the landscape back. Save the level (Ctrl+S) to keep the change.

World Partition levels: load every region first (Window > World Partition,
select all regions, right-click > Load Region From Selection) so no
landscape pieces are left behind.
"""

import os

import unreal

CRATER_GLB = "F:/Lunco/CRATER.GLB"
FALLBACK_GLBS = ["F:/CONCEPTFORGE/CRATER.GLB", "D:/Lunco/CRATER.GLB"]  # tried if the first is missing
IMPORT_FOLDER = "/Game/Crater"
PLACE_AT_LANDSCAPE = True   # False = put the crater at the world origin
WALKABLE = True             # per-triangle collision so characters can walk down into the bowl
CRATER_TAG = "LuncoCrater"  # same tag the space station script looks for


def log(msg):
    unreal.log("[Crater] " + msg)


def warn(msg):
    unreal.log_warning("[Crater] " + msg)


def fail(msg):
    unreal.log_error("[Crater] " + msg)
    unreal.EditorDialog.show_message("Replace landscape with crater", msg, unreal.AppMsgType.OK)


def find_glb():
    for path in [CRATER_GLB] + FALLBACK_GLBS:
        if os.path.isfile(path):
            return path
    folder = os.path.dirname(CRATER_GLB)
    for root, dirs, files in os.walk(folder) if os.path.isdir(folder) else []:
        if root.count(os.sep) - folder.count(os.sep) > 2:
            dirs[:] = []
        for f in files:
            if "crater" in f.lower() and f.lower().endswith((".glb", ".gltf")):
                return os.path.join(root, f)
    return None


def is_landscape(actor):
    cls = getattr(unreal, "LandscapeProxy", None)
    if cls is not None:
        return isinstance(actor, cls)
    return type(actor).__name__ in ("Landscape", "LandscapeProxy", "LandscapeStreamingProxy")


def has_tag(actor, tag):
    try:
        return any(str(t) == tag for t in actor.get_editor_property("tags"))
    except Exception:
        return False


def bounds(actors):
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for actor in actors:
        origin, ext = actor.get_actor_bounds(False)
        for i, (o, e) in enumerate(((origin.x, ext.x), (origin.y, ext.y), (origin.z, ext.z))):
            lo[i] = min(lo[i], o - e)
            hi[i] = max(hi[i], o + e)
    return lo, hi


def import_glb(path):
    log("Importing %s -> %s" % (path, IMPORT_FOLDER))
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", path)
    task.set_editor_property("destination_path", IMPORT_FOLDER)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", True)
    task.set_editor_property("replace_existing", True)
    try:
        task.set_editor_property("async_", False)
    except Exception:
        pass
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    meshes = []
    for asset_path in unreal.EditorAssetLibrary.list_assets(IMPORT_FOLDER, recursive=True, include_folder=False):
        asset = unreal.EditorAssetLibrary.load_asset(asset_path.split(".")[0])
        if isinstance(asset, unreal.StaticMesh):
            meshes.append(asset)
    return meshes


def make_walkable(meshes, actors):
    for actor in actors:
        for comp in actor.get_components_by_class(unreal.StaticMeshComponent):
            comp.set_collision_profile_name("BlockAll")
            comp.set_collision_enabled(unreal.CollisionEnabled.QUERY_AND_PHYSICS)
    for mesh in meshes:
        try:
            body = mesh.get_editor_property("body_setup")
            body.set_editor_property("collision_trace_flag", unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
            unreal.EditorAssetLibrary.save_loaded_asset(mesh)
        except Exception as exc:
            warn("Couldn't set walkable collision on %s (%s). Open the mesh and set Collision Complexity "
                 "to 'Use Complex Collision As Simple'." % (mesh.get_name(), exc))


def main():
    glb = find_glb()
    if glb is None:
        fail("Can't find CRATER.GLB in F:/Lunco (or the F:/CONCEPTFORGE / D:/Lunco backups).\n"
             "Check the file is there, or set CRATER_GLB at the top of this script.")
        return

    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    landscapes = [a for a in actor_sub.get_all_level_actors() if is_landscape(a)]
    previous = [a for a in actor_sub.get_all_level_actors() if has_tag(a, CRATER_TAG)]
    target = None
    if landscapes:
        lo, hi = bounds(landscapes)
        target = ((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0)
        log("Found %d landscape actor(s): %s" % (len(landscapes), ", ".join(a.get_actor_label() for a in landscapes)))
    elif previous:
        lo, hi = bounds(previous)  # re-run: keep the crater where the last run put it
        target = ((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, hi[2])
        log("No landscape left; replacing the crater from the last run in the same spot.")
    else:
        warn("No landscape in this level; the crater goes at the world origin.")

    meshes = import_glb(glb)
    if not meshes:
        fail("Importing %s produced no static meshes. Check the Output Log for import errors." % glb)
        return

    with unreal.ScopedEditorTransaction("Replace landscape with crater"):
        for actor in landscapes:
            actor_sub.destroy_actor(actor)
        for actor in previous:  # a crater from an earlier run
            actor_sub.destroy_actor(actor)

        crater = []
        for mesh in meshes:
            actor = actor_sub.spawn_actor_from_object(mesh, unreal.Vector(0.0, 0.0, 0.0),
                                                      unreal.Rotator(0.0, 0.0, 0.0))
            if not actor:
                continue
            name = mesh.get_name()
            actor.set_actor_label(name if "crater" in name.lower() else "Crater_" + name)
            actor.set_folder_path("Crater")
            tags = [str(t) for t in actor.get_editor_property("tags")]
            actor.set_editor_property("tags", tags + [CRATER_TAG])
            crater.append(actor)
        if not crater:
            fail("Couldn't place the crater in the level.")
            return

        # line the crater up with where the landscape was: same centre, rim at the old ground height
        clo, chi = bounds(crater)
        if target is not None and PLACE_AT_LANDSCAPE:
            delta = unreal.Vector(target[0] - (clo[0] + chi[0]) / 2.0,
                                  target[1] - (clo[1] + chi[1]) / 2.0,
                                  target[2] - chi[2])
            for actor in crater:
                actor.set_actor_location(actor.get_actor_location() + delta, False, True)
            clo, chi = bounds(crater)

        if WALKABLE:
            make_walkable(meshes, crater)

    # look at it
    size = max(chi[0] - clo[0], chi[1] - clo[1])
    centre = unreal.Vector((clo[0] + chi[0]) / 2.0, (clo[1] + chi[1]) / 2.0, (clo[2] + chi[2]) / 2.0)
    cam = unreal.Vector(centre.x - size * 0.8, centre.y - size * 0.8, chi[2] + size * 0.6)
    unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(
        cam, unreal.MathLibrary.find_look_at_rotation(cam, centre))
    actor_sub.set_selected_level_actors(crater)

    msg = ("Deleted %d landscape actor(s) and placed the crater (%.0f m across)%s.\n\n"
           "Imported from %s into %s.\nCtrl+Z undoes it; save the level (Ctrl+S) to keep it."
           % (len(landscapes), size / 100.0, " at the world origin" if target is None or not PLACE_AT_LANDSCAPE
              else " where the landscape was" if landscapes else " where the last crater was", glb, IMPORT_FOLDER))
    log(msg.replace("\n", " "))
    unreal.EditorDialog.show_message("Replace landscape with crater", msg, unreal.AppMsgType.OK)


if __name__ == "__main__":
    main()
