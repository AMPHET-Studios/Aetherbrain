"""
Lunco - Space Station on the Crater
===================================

Imports CRATER.GLB (from F:\\CONCEPTFORGE or F:\\Lunco, else the D:\\Lunco
backup) into the level you have open, then drops every placeable object from
the Content Drawer onto the crater floor, arranged as a space station.

Needs PythonScriptPlugin + EditorScriptingUtilities (both already enabled in
Lunco.uproject).

Run it
------
1. Open the level you want the station in.
2. Tools > Execute Python Script...  and pick this file.
   (Or: Output Log > switch "Cmd" to "Python" > py "F:/CONCEPTFORGE/build_space_station.py")
3. Ctrl+Z undoes the whole build in one step. Running it again rebuilds the
   station from scratch (the previous station is removed first; the crater stays).

What it does
------------
1. Finds the crater, in this order:
   a) an actor already in the level whose label or mesh contains "crater"
   b) a crater mesh already in the Content Drawer (spawned at the world origin)
   c) CRATER.GLB from F:/CONCEPTFORGE or F:/Lunco (else the D:/Lunco backup),
      imported into /Game/Crater and spawned at the origin (falls back to searching those
      folders, then the D: drive, for crater*.glb)
2. Collects every Static Mesh, Skeletal Mesh and actor Blueprint under /Game,
   minus StarterContent and the crater itself (see EXCLUDE_FOLDERS).
3. Sorts them into station roles by name, then by size:
     Hub         centre            hub, core, command, reactor, control ...
     Habitats    inner ring(s)     hab, module, lab, dome, greenhouse, storage ...
     Connectors  spokes + ring     corridor, tunnel, bridge, airlock, tube ...
     Perimeter   outer ring        antenna, dish, solar, radar, tower, light, tank ...
     Landing     arc on one side   landing, pad, rocket, shuttle, lander, rover ...
     Props       scattered         crate, barrel, console, rock, robot ...
   Unmatched pieces: the biggest becomes the hub if nothing is named like one,
   larger pieces become habitats, smaller ones props.
4. Line-traces the crater surface under every piece so it sits on the ground,
   lays corridor pieces end to end so they meet the hub and modules, files everything in
   the Outliner under "SpaceStation/..." and frames the viewport on it.
"""

import math
import os
import random
import re
import time

try:
    import unreal
except ImportError:  # lets the layout planner run (and be tested) outside the editor
    unreal = None


# ============================================================ settings
# The first path that exists wins. If none do, the search roots are walked
# (CRATER_SEARCH_DEPTH folders deep) for any crater*.glb / crater*.gltf.
CRATER_GLB_CANDIDATES = [
    "F:/CONCEPTFORGE/CRATER.GLB",
    "F:/Lunco/CRATER.GLB",
    "F:/Lunco/Content/CRATER.GLB",
    "D:/Lunco/CRATER.GLB",          # backup copy
    "D:/Lunco/Content/CRATER.GLB",
    "D:/CRATER.GLB",
]
CRATER_SEARCH_ROOTS = ["F:/CONCEPTFORGE", "F:/Lunco", "D:/Lunco", "D:/"]
CRATER_SEARCH_DEPTH = 4
CRATER_NAME_HINT = "crater"
CRATER_IMPORT_FOLDER = "/Game/Crater"
CRATER_SPAWN_LOCATION = (0.0, 0.0, 0.0)

CONTENT_ROOT = "/Game"
EXCLUDE_FOLDERS = [
    "/Game/StarterContent",
    "/Game/Developers",
    "/Game/Collections",
    "/Game/__ExternalActors__",
    "/Game/__ExternalObjects__",
]
EXCLUDE_NAME_CONTAINS = []  # e.g. ["wheel", "_lod"] to skip sub-parts of other assets
PLACEABLE_ASSET_TYPES = ("StaticMesh", "SkeletalMesh", "Blueprint")

STATION_CENTER = None     # (x, y) in cm to override the crater centre
GAP_CM = 300.0            # breathing room between pieces
SINK_CM = 5.0             # push pieces slightly into the ground so nothing floats
LANDING_ANGLE_DEG = 0.0   # side of the station the landing zone sits on (0 = +X)
LANDING_ARC_DEG = 110.0
CORRIDOR_SCALE_RANGE = (0.4, 3.0)
CORRIDOR_MAX_SEGMENTS = 12   # copies of a connector laid end to end per corridor
RANDOM_SEED = 7           # prop scatter; change for a different arrangement
CLEAR_PREVIOUS = True
FRAME_VIEWPORT = True
SHOW_SUMMARY_DIALOG = True

STATION_TAG = "LuncoStation"
CRATER_TAG = "LuncoCrater"
OUTLINER_ROOT = "SpaceStation"


# ============================================================ roles
# Checked in this order; the first role with a matching keyword wins.
# "=word" matches a whole name token, anything else matches a token prefix.
ROLE_ORDER = ("connector", "landing", "perimeter", "hub", "habitat", "prop")
ROLE_KEYWORDS = {
    "connector": ("corridor", "tunnel", "bridge", "walkway", "connector", "=connect",
                  "hallway", "=hall", "passage", "airlock", "=link", "catwalk",
                  "=tube", "tubes", "gangway", "skywalk"),
    "landing": ("landing", "=pad", "pads", "launch", "rocket", "=ship", "ships",
                "spaceship", "starship", "shuttle", "lander", "rover", "vehicle",
                "buggy", "truck", "spacecraft", "=craft", "=drone", "drones",
                "capsule", "ufo"),
    "perimeter": ("antenna", "dish", "=comm", "comms", "communication", "radar",
                  "satellite", "solar", "tower", "mast", "beacon", "=light",
                  "lights", "lamp", "floodlight", "turbine", "batter", "generator",
                  "=tank", "tanks", "silo", "fence", "barrier", "pylon", "relay",
                  "sensor", "=array"),
    "hub": ("=hub", "hubs", "core", "command", "central", "centre", "center",
            "reactor", "nexus", "=main", "headquarter", "=hq", "control"),
    "habitat": ("hab", "module", "=lab", "labs", "laborator", "quarter", "living",
                "greenhouse", "garden", "farm", "storage", "cargo", "container",
                "warehouse", "medbay", "medical", "workshop", "factory", "refinery",
                "hangar", "building", "bunker", "=pod", "pods", "dome", "room",
                "barrack", "dorm", "office"),
    "prop": ("crate", "=box", "boxes", "barrel", "rock", "boulder", "stone", "debris",
             "chair", "table", "desk", "console", "terminal", "screen", "sign",
             "flag", "cone", "=tool", "tools", "toolbox", "astronaut", "character",
             "robot", "=bot", "=pet", "pets", "=prop", "props", "cable", "pipe",
             "ladder", "stair"),
}
ROLE_FOLDERS = {
    "hub": "1_Hub",
    "habitat": "2_Habitats",
    "connector": "3_Connectors",
    "perimeter": "4_Perimeter",
    "landing": "5_Landing",
    "prop": "6_Props",
}
ROLE_LABELS = {
    "hub": "Hub",
    "habitat": "Hab",
    "connector": "Link",
    "perimeter": "Rim",
    "landing": "Pad",
    "prop": "Prop",
}
NAME_NOISE = {"sm", "sk", "skm", "bp", "ba", "mesh", "geo"}


def name_tokens(name):
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", spaced)
    spaced = re.sub(r"(?<=[A-Za-z])(?=[0-9])", " ", spaced)
    return [t for t in re.split(r"[^a-z0-9]+", spaced.lower()) if t and t not in NAME_NOISE]


def _keyword_hit(tokens, keyword):
    if keyword.startswith("="):
        return keyword[1:] in tokens
    return any(t.startswith(keyword) for t in tokens)


def classify(name):
    tokens = name_tokens(name)
    for role in ROLE_ORDER:
        if any(_keyword_hit(tokens, kw) for kw in ROLE_KEYWORDS[role]):
            return role
    return "other"


# ============================================================ layout planner
# Pure Python: works in cm on the XY plane around (0, 0). Unreal-free.

class Piece(object):
    """One Content Drawer asset, measured as a box footprint of half-extents hx, hy."""

    def __init__(self, key, name, half_x, half_y, role=None):
        self.key = key
        self.name = name
        self.hx = max(float(half_x), 25.0)
        self.hy = max(float(half_y), 25.0)
        self.r = math.hypot(self.hx, self.hy)
        self.role = role or classify(name)

    def support(self, direction, yaw):
        """Half-width of the box along a world direction (radians) when rotated by yaw."""
        a = direction - yaw
        return abs(self.hx * math.cos(a)) + abs(self.hy * math.sin(a))


class Placement(object):
    def __init__(self, piece, role, x, y, yaw_deg, sx=1.0, sy=1.0, ring=0, angle=0.0, radius=0.0):
        self.piece = piece
        self.role = role
        self.x = x
        self.y = y
        self.yaw = yaw_deg
        self.sx = sx
        self.sy = sy
        self.ring = ring
        self.angle = angle
        self.radius = radius

    @property
    def footprint(self):
        return math.hypot(self.piece.hx * self.sx, self.piece.hy * self.sy)


def _balanced_slots(n):
    """Slot order that puts similar-sized pieces opposite each other."""
    half = (n + 1) // 2
    order = []
    for i in range(half):
        order.append(i)
        if i + half < n:
            order.append(i + half)
    return order


def pack_rings(pieces, inner_edge, gap, role, arc_deg=360.0, center_deg=0.0, phase=0.0,
               max_single_ring_growth=2.0):
    """Lay pieces out in concentric rings (or arcs) starting at inner_edge.

    Returns (placements, outer_edge). Every piece faces the centre."""
    placements = []
    todo = sorted(pieces, key=lambda p: (-p.r, p.name))
    edge = inner_edge
    full = arc_deg >= 359.9
    arc = math.radians(min(arc_deg, 360.0))
    center = math.radians(center_deg)
    ring = 0
    while todo:
        rmax = todo[0].r
        slot = 2.0 * rmax + gap

        def needed_radius(n):
            if n <= 1:
                return 0.0
            step = arc / n
            return slot / (2.0 * math.sin(min(step, math.pi) / 2.0))

        radius = edge + rmax
        everything = needed_radius(len(todo))
        if everything <= radius * max_single_ring_growth:
            n = len(todo)
            radius = max(radius, everything)
        else:
            n = len(todo)
            while n > 1 and needed_radius(n) > radius:
                n -= 1
        batch, todo = todo[:n], todo[n:]
        slots = _balanced_slots(n) if full else list(range(n))
        offset = phase + (math.pi / n if full and ring % 2 == 1 else 0.0)
        for piece, s in zip(batch, slots):
            if full:
                ang = center + offset + s * 2.0 * math.pi / n
            else:
                ang = center - arc / 2.0 + (s + 0.5) * arc / n
            placements.append(Placement(piece, role, radius * math.cos(ang), radius * math.sin(ang),
                                        math.degrees(ang) + 180.0, ring=ring, angle=ang, radius=radius))
        edge = radius + rmax + gap
        ring += 1
    return placements, edge


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _corridor(conn, x0, y0, x1, y1):
    """Span (x0, y0) -> (x1, y1) with copies of a connector laid end to end along its
    long axis, each stretched a little so the run meets both ends."""
    length = math.hypot(x1 - x0, y1 - y0)
    heading = math.atan2(y1 - y0, x1 - x0)
    long_x = conn.hx >= conn.hy
    native = 2.0 * (conn.hx if long_x else conn.hy)
    count = _clamp(int(round(length / native)), 1, CORRIDOR_MAX_SEGMENTS)
    scale = _clamp(length / (count * native), *CORRIDOR_SCALE_RANGE)
    yaw = math.degrees(heading) + (0.0 if long_x else 90.0)
    sx, sy = (scale, 1.0) if long_x else (1.0, scale)
    segment = length / count
    return [Placement(conn, "connector",
                      x0 + (i + 0.5) * segment * math.cos(heading),
                      y0 + (i + 0.5) * segment * math.sin(heading), yaw, sx, sy)
            for i in range(count)]


def _corridor_discs(pl):
    """Approximate a stretched corridor as a row of discs for overlap tests."""
    hx, hy = pl.piece.hx * pl.sx, pl.piece.hy * pl.sy
    half_len, half_w = max(hx, hy), min(hx, hy)
    yaw = math.radians(pl.yaw) + (0.0 if hx >= hy else math.pi / 2.0)
    count = max(1, int(math.ceil(half_len / max(half_w, 1.0))))
    discs = []
    for i in range(count + 1):
        t = -half_len + 2.0 * half_len * i / count
        discs.append((pl.x + t * math.cos(yaw), pl.y + t * math.sin(yaw), half_w * 1.1))
    return discs


def plan_station(pieces, gap=GAP_CM, seed=RANDOM_SEED,
                 landing_angle_deg=LANDING_ANGLE_DEG, landing_arc_deg=LANDING_ARC_DEG):
    rng = random.Random(seed)
    by_role = {r: [] for r in ROLE_ORDER + ("other",)}
    for p in pieces:
        by_role.setdefault(p.role, []).append(p)

    # --- hub: the biggest hub-named piece, else the biggest unmatched/habitat piece
    hub = None
    hubs = sorted(by_role["hub"], key=lambda p: -p.r)
    if hubs:
        hub = hubs[0]
        by_role["habitat"].extend(hubs[1:])
    else:
        for pool_names in (("other", "habitat"), ("perimeter", "landing", "prop")):
            pool = [p for name in pool_names for p in by_role[name]]
            if pool:
                hub = max(pool, key=lambda p: p.r)
                by_role[hub.role].remove(hub)
                break
    by_role["hub"] = []
    if hub is not None:
        hub.role = "hub"

    # --- unmatched pieces: big ones become habitats, small ones props
    if by_role["other"]:
        sizes = sorted(p.r for p in pieces)
        median = sizes[len(sizes) // 2]
        for p in by_role["other"]:
            p.role = "habitat" if p.r >= median else "prop"
            by_role[p.role].append(p)
        by_role["other"] = []

    placements = []
    occupied = []  # (x, y, radius)

    hub_edge = 0.0
    if hub is not None:
        placements.append(Placement(hub, "hub", 0.0, 0.0, 0.0))
        occupied.append((0.0, 0.0, hub.r))
        hub_edge = hub.r

    # --- habitats, spoke length driven by the connectors we have
    connectors = sorted(by_role["connector"], key=lambda p: p.name)
    if connectors:
        lengths = sorted(2.0 * max(c.hx, c.hy) for c in connectors)
        spoke = lengths[len(lengths) // 2]
    else:
        spoke = gap * 2.0
    habitats, hab_edge = pack_rings(by_role["habitat"], hub_edge + spoke, gap, "habitat")
    placements.extend(habitats)
    occupied.extend((h.x, h.y, h.piece.r) for h in habitats)

    # --- connectors: spokes from the hub to every first-ring habitat (reusing
    #     connector assets if there are more spokes than connectors), then links
    #     between neighbouring habitats, then leftovers become props
    first_ring = sorted([h for h in habitats if h.ring == 0], key=lambda h: h.angle)
    used = set()
    corridor_pls = []
    if connectors and hub is not None:
        for i, hab in enumerate(first_ring):
            a = hab.angle
            start = hub.support(a, 0.0)
            end = hab.radius - hab.piece.support(a, math.radians(hab.yaw))
            if end - start < 10.0:
                continue
            conn = connectors[i % len(connectors)]
            used.add(id(conn))
            corridor_pls.extend(_corridor(conn, start * math.cos(a), start * math.sin(a),
                                          end * math.cos(a), end * math.sin(a)))
    spare = [c for c in connectors if id(c) not in used]
    if spare and len(first_ring) >= 3:
        for i, hab in enumerate(first_ring):
            if not spare:
                break
            nxt = first_ring[(i + 1) % len(first_ring)]
            heading = math.atan2(nxt.y - hab.y, nxt.x - hab.x)
            s0 = hab.piece.support(heading, math.radians(hab.yaw))
            s1 = nxt.piece.support(heading + math.pi, math.radians(nxt.yaw))
            dist = math.hypot(nxt.x - hab.x, nxt.y - hab.y)
            if dist - s0 - s1 < 10.0:
                continue
            conn = spare.pop(0)
            corridor_pls.extend(_corridor(
                conn,
                hab.x + s0 * math.cos(heading), hab.y + s0 * math.sin(heading),
                nxt.x - s1 * math.cos(heading), nxt.y - s1 * math.sin(heading)))
    for c in spare:
        c.role = "prop"
        by_role["prop"].append(c)
    placements.extend(corridor_pls)
    for pl in corridor_pls:
        occupied.extend(_corridor_discs(pl))

    # --- perimeter ring, staggered to sit between the habitats
    phase = (math.pi / len(first_ring)) if first_ring else 0.0
    perimeter, per_edge = pack_rings(by_role["perimeter"], hab_edge + gap, gap, "perimeter", phase=phase)
    placements.extend(perimeter)
    occupied.extend((p.x, p.y, p.piece.r) for p in perimeter)

    # --- landing zone: an arc on one side, outside the perimeter
    landing, land_edge = pack_rings(by_role["landing"], per_edge + gap, gap * 1.5, "landing",
                                    arc_deg=landing_arc_deg, center_deg=landing_angle_deg)
    placements.extend(landing)
    occupied.extend((p.x, p.y, p.piece.r) for p in landing)

    # --- props scattered around the habitats (or the hub)
    anchors = [(h.x, h.y, h.piece.r) for h in habitats] or \
              ([(0.0, 0.0, hub.r)] if hub is not None else [(0.0, 0.0, 0.0)])
    margin = gap * 0.25

    def is_free(x, y, r):
        return all(math.hypot(x - ox, y - oy) >= r + orad + margin for ox, oy, orad in occupied)

    outer = max(land_edge, per_edge, hab_edge)
    for i, prop in enumerate(sorted(by_role["prop"], key=lambda p: (-p.r, p.name))):
        ax, ay, ar = anchors[i % len(anchors)]
        spot = None
        for attempt in range(120):
            ang = rng.uniform(0.0, 2.0 * math.pi)
            dist = ar + prop.r + gap * rng.uniform(0.15, 1.0) + attempt * prop.r * 0.3
            x, y = ax + dist * math.cos(ang), ay + dist * math.sin(ang)
            if is_free(x, y, prop.r):
                spot = (x, y)
                break
        if spot is None:  # crowded: walk outward until there is room
            ang = rng.uniform(0.0, 2.0 * math.pi)
            dist = outer + prop.r
            while not is_free(dist * math.cos(ang), dist * math.sin(ang), prop.r):
                dist += prop.r + margin
                ang += 0.37
            spot = (dist * math.cos(ang), dist * math.sin(ang))
        pl = Placement(prop, "prop", spot[0], spot[1], rng.uniform(0.0, 360.0))
        placements.append(pl)
        occupied.append((pl.x, pl.y, prop.r))

    radius = max([math.hypot(p.x, p.y) + p.footprint for p in placements] or [0.0])
    return placements, radius


# ============================================================ Unreal side

def _log(msg):
    unreal.log("[SpaceStation] " + msg)


def _warn(msg):
    unreal.log_warning("[SpaceStation] " + msg)


def _asset_class_name(asset_data):
    try:
        return str(asset_data.asset_class_path.asset_name)
    except Exception:
        return str(asset_data.asset_class)


def _has_tag(actor, tag):
    try:
        return any(str(t) == tag for t in actor.get_editor_property("tags"))
    except Exception:
        return False


def _add_tag(actor, tag):
    tags = [str(t) for t in actor.get_editor_property("tags")]
    if tag not in tags:
        tags.append(tag)
        actor.set_editor_property("tags", tags)


def _is_excluded(package_name):
    low = package_name.lower()
    for folder in EXCLUDE_FOLDERS:
        if low.startswith(folder.lower().rstrip("/") + "/"):
            return True
    if CRATER_NAME_HINT in low:
        return True
    name = low.rsplit("/", 1)[-1]
    return any(s.lower() in name for s in EXCLUDE_NAME_CONTAINS)


def _is_placeable_blueprint(package_name):
    cls = None
    try:
        cls = unreal.EditorAssetLibrary.load_blueprint_class(package_name)
    except Exception:
        pass
    if cls is None:
        try:
            cls = unreal.BlueprintEditorLibrary.generated_class(unreal.load_asset(package_name))
        except Exception:
            return True  # can't tell - let the spawn decide
    if cls is None:
        return False
    try:
        if not unreal.MathLibrary.class_is_child_of(cls, unreal.Actor.static_class()):
            return False
        for framework in (unreal.Info, unreal.Controller):
            if unreal.MathLibrary.class_is_child_of(cls, framework.static_class()):
                return False  # game modes, game states, player controllers ...
    except Exception:
        pass
    return True


# ---------------------------------------------------------------- crater

def find_crater_glb():
    for path in CRATER_GLB_CANDIDATES:
        if os.path.isfile(path):
            return path
    skip = {"$recycle.bin", "system volume information", "windows", "program files",
            "program files (x86)", "programdata", "intermediate", "saved",
            "deriveddatacache", "binaries", ".git"}
    fallback = None
    for root in CRATER_SEARCH_ROOTS:
        if not os.path.isdir(root):
            continue
        root_depth = os.path.normpath(root).rstrip("\\/").count(os.sep)
        for dirpath, dirnames, filenames in os.walk(root):
            depth = os.path.normpath(dirpath).rstrip("\\/").count(os.sep) - root_depth
            if depth >= CRATER_SEARCH_DEPTH:
                dirnames[:] = []
            else:
                dirnames[:] = [d for d in dirnames if d.lower() not in skip]
            for f in filenames:
                low = f.lower()
                if CRATER_NAME_HINT in low and low.endswith((".glb", ".gltf")):
                    full = os.path.join(dirpath, f)
                    if low == "crater.glb":
                        return full
                    fallback = fallback or full
    return fallback


def _is_surface_actor(actor):
    """Something pieces can stand on: a mesh, a landscape or a Modeling Tools dynamic mesh."""
    if actor.get_components_by_class(unreal.StaticMeshComponent):
        return True
    for name in ("LandscapeProxy", "DynamicMeshActor"):
        cls = getattr(unreal, name, None)
        if cls is not None and isinstance(actor, cls):
            return True
    return False


def find_crater_in_level(actor_sub):
    found = []
    for actor in actor_sub.get_all_level_actors():
        if _has_tag(actor, STATION_TAG):
            continue
        hit = CRATER_NAME_HINT in actor.get_actor_label().lower() or _has_tag(actor, CRATER_TAG)
        if not hit and isinstance(actor, unreal.StaticMeshActor):
            mesh = actor.static_mesh_component.get_editor_property("static_mesh")
            hit = mesh is not None and CRATER_NAME_HINT in mesh.get_path_name().lower()
        if hit and _is_surface_actor(actor):
            found.append(actor)
    return found


def _static_meshes_under(folder):
    meshes = []
    for path in unreal.EditorAssetLibrary.list_assets(folder, recursive=True, include_folder=False):
        asset = unreal.EditorAssetLibrary.load_asset(path.split(".")[0])
        if isinstance(asset, unreal.StaticMesh):
            meshes.append(asset)
    return meshes


def find_crater_assets():
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    groups = {}
    for ad in registry.get_assets_by_path(CONTENT_ROOT, recursive=True):
        if _asset_class_name(ad) != "StaticMesh":
            continue
        pkg = str(ad.package_name)
        if CRATER_NAME_HINT in pkg.lower():
            groups.setdefault(str(ad.package_path), []).append(ad)
    if not groups:
        return []
    preferred = [k for k in groups if k.lower().startswith(CRATER_IMPORT_FOLDER.lower())]
    folder = sorted(preferred or groups)[0]
    return [ad.get_asset() for ad in groups[folder]]


def import_crater_glb(path):
    _log("Importing %s -> %s" % (path, CRATER_IMPORT_FOLDER))
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", path)
    task.set_editor_property("destination_path", CRATER_IMPORT_FOLDER)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", True)
    task.set_editor_property("replace_existing", True)
    try:
        task.set_editor_property("async_", False)
    except Exception:
        pass
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return _static_meshes_under(CRATER_IMPORT_FOLDER)


def spawn_crater(actor_sub, meshes):
    loc = unreal.Vector(*CRATER_SPAWN_LOCATION)
    actors = []
    for mesh in meshes:
        actor = actor_sub.spawn_actor_from_object(mesh, loc, unreal.Rotator(0.0, 0.0, 0.0))
        if not actor:
            continue
        name = mesh.get_name()
        actor.set_actor_label(name if CRATER_NAME_HINT in name.lower() else "Crater_" + name)
        actor.set_folder_path("Crater")
        _add_tag(actor, CRATER_TAG)
        actors.append(actor)
    return actors


def ensure_crater_collision(crater_actors):
    changed = 0
    for actor in crater_actors:
        for comp in actor.get_components_by_class(unreal.StaticMeshComponent):
            if comp.get_collision_enabled() == unreal.CollisionEnabled.NO_COLLISION:
                comp.set_collision_profile_name("BlockAll")
                comp.set_collision_enabled(unreal.CollisionEnabled.QUERY_AND_PHYSICS)
                changed += 1
    if changed:
        _log("Turned collision on for %d crater component(s) so pieces can be traced onto it." % changed)


def combined_bounds(actors):
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for actor in actors:
        origin, ext = actor.get_actor_bounds(False)
        for i, (o, e) in enumerate(((origin.x, ext.x), (origin.y, ext.y), (origin.z, ext.z))):
            lo[i] = min(lo[i], o - e)
            hi[i] = max(hi[i], o + e)
    return lo, hi


# ---------------------------------------------------------------- ground traces

def _first_vector(result):
    if result is None or result is False:
        return None
    if isinstance(result, unreal.Vector):
        return result
    if isinstance(result, unreal.HitResult):
        result = unreal.GameplayStatics.break_hit_result(result)
    if isinstance(result, (tuple, list)):
        if result and isinstance(result[0], bool) and not result[0]:
            return None
        for item in result:
            if isinstance(item, unreal.Vector):
                return item
            if isinstance(item, unreal.HitResult):
                return _first_vector(item)
    return None


class GroundTracer(object):
    """Finds the crater surface height under an XY point."""

    def __init__(self, world, crater_actors, z_top, z_bottom):
        self.world = world
        self.crater = crater_actors
        self.comps = [c for a in crater_actors for c in a.get_components_by_class(unreal.PrimitiveComponent)]
        self.z_top = z_top + 1000.0
        self.z_bottom = z_bottom - 1000.0
        self.ignore = []
        self.mode = None

    def _component_trace(self, x, y):
        start = unreal.Vector(x, y, self.z_top)
        end = unreal.Vector(x, y, self.z_bottom)
        best = None
        for comp in self.comps:
            try:
                hit = _first_vector(comp.line_trace_component(start, end, True, False, False))
            except Exception:
                hit = None
            if hit is not None and (best is None or hit.z > best):
                best = hit.z
        return best

    def _world_trace(self, x, y):
        try:
            result = unreal.SystemLibrary.line_trace_single(
                self.world, unreal.Vector(x, y, self.z_top), unreal.Vector(x, y, self.z_bottom),
                unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, True, self.ignore,
                unreal.DrawDebugTrace.NONE, True)
        except Exception:
            return None
        hit = _first_vector(result)
        return None if hit is None else hit.z

    def pick_mode(self, points):
        """Use per-component traces if they hit the crater, else a world trace."""
        for mode, fn in (("component", self._component_trace), ("world", self._world_trace)):
            if any(fn(x, y) is not None for x, y in points):
                self.mode = mode
                return True
        self.mode = "none"
        return False

    def height(self, x, y):
        if self.mode == "component":
            return self._component_trace(x, y)
        if self.mode == "world":
            return self._world_trace(x, y)
        return None


# ---------------------------------------------------------------- content

class Measured(object):
    def __init__(self, asset, actor, name, off_x, off_y, lift):
        self.asset = asset
        self.actor = actor
        self.name = name
        self.off_x = off_x
        self.off_y = off_y
        self.lift = lift  # actor Z minus the bottom of its bounds


def collect_station_assets():
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    picked = []
    for ad in registry.get_assets_by_path(CONTENT_ROOT, recursive=True):
        cls = _asset_class_name(ad)
        if cls not in PLACEABLE_ASSET_TYPES:
            continue
        pkg = str(ad.package_name)
        if _is_excluded(pkg):
            continue
        if cls == "Blueprint" and not _is_placeable_blueprint(pkg):
            continue
        picked.append(ad)
    picked.sort(key=lambda ad: str(ad.package_name).lower())
    return picked


def measure(actor_sub, asset, staging):
    actor = actor_sub.spawn_actor_from_object(asset, staging, unreal.Rotator(0.0, 0.0, 0.0))
    if not actor:
        return None
    loc = actor.get_actor_location()
    origin, ext = actor.get_actor_bounds(False)
    if ext.x < 1.0 and ext.y < 1.0 and ext.z < 1.0:
        origin, ext = loc, unreal.Vector(50.0, 50.0, 50.0)
    m = Measured(asset, actor, asset.get_name(), origin.x - loc.x, origin.y - loc.y,
                 loc.z - (origin.z - ext.z))
    return m, ext


def place_actor(actor, meas, pl, cx, cy, tracer, floor_z):
    yaw = math.radians(pl.yaw)
    c, s = math.cos(yaw), math.sin(yaw)
    ox, oy = meas.off_x * pl.sx, meas.off_y * pl.sy
    tx, ty = cx + pl.x, cy + pl.y  # where the bounds centre should land

    # sample the centre and four footprint corners; sit on the lowest so nothing floats
    hx, hy = pl.piece.hx * pl.sx * 0.6, pl.piece.hy * pl.sy * 0.6
    heights = []
    for lx, ly in ((0.0, 0.0), (hx, hy), (-hx, hy), (hx, -hy), (-hx, -hy)):
        z = tracer.height(tx + lx * c - ly * s, ty + lx * s + ly * c)
        if z is not None:
            heights.append(z)
    ground = min(heights) if heights else floor_z

    actor.set_actor_scale3d(unreal.Vector(pl.sx, pl.sy, 1.0))
    actor.set_actor_location_and_rotation(
        unreal.Vector(tx - (ox * c - oy * s), ty - (ox * s + oy * c), ground + meas.lift - SINK_CM),
        unreal.Rotator(roll=0.0, pitch=0.0, yaw=pl.yaw), False, True)
    return bool(heights)


def frame_viewport(cx, cy, cz, radius):
    dist = max(radius * 2.2, 3000.0)
    cam = unreal.Vector(cx - dist * 0.75, cy - dist * 0.75, cz + dist * 0.6)
    rot = unreal.MathLibrary.find_look_at_rotation(cam, unreal.Vector(cx, cy, cz))
    unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).set_level_viewport_camera_info(cam, rot)


# ---------------------------------------------------------------- main

def build():
    started = time.time()
    actor_sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    if world is None:
        unreal.log_error("[SpaceStation] No level is open.")
        return

    # 1. crater: in the level, else in the Content Drawer, else import the GLB
    crater_actors = find_crater_in_level(actor_sub)
    crater_meshes = []
    if crater_actors:
        _log("Using crater already in the level: %s" % ", ".join(a.get_actor_label() for a in crater_actors))
    else:
        crater_meshes = find_crater_assets()
        if not crater_meshes:
            glb = find_crater_glb()
            if not glb:
                unreal.log_error("[SpaceStation] No crater in the level or Content Drawer, and no crater*.glb "
                                 "found in F:/CONCEPTFORGE, F:/Lunco or on D:. Put the path in CRATER_GLB_CANDIDATES "
                                 "at the top of this script.")
                return
            crater_meshes = import_crater_glb(glb)
            if not crater_meshes:
                unreal.log_error("[SpaceStation] Importing %s produced no static meshes." % glb)
                return

    assets = collect_station_assets()
    if not assets:
        unreal.log_error("[SpaceStation] No Static Meshes / Skeletal Meshes / actor Blueprints found under %s "
                         "(outside EXCLUDE_FOLDERS)." % CONTENT_ROOT)
        return
    _log("Found %d placeable asset(s) in the Content Drawer." % len(assets))

    with unreal.ScopedEditorTransaction("Build Lunco Space Station"):
        with unreal.ScopedSlowTask(len(assets) * 2 + 6, "Building the space station on the crater...") as task:
            task.make_dialog(True)

            if CLEAR_PREVIOUS:
                old = [a for a in actor_sub.get_all_level_actors() if _has_tag(a, STATION_TAG)]
                for actor in old:
                    actor_sub.destroy_actor(actor)
                if old:
                    _log("Removed %d actor(s) from the previous station." % len(old))

            if not crater_actors:
                crater_actors = spawn_crater(actor_sub, crater_meshes)
                _log("Spawned the crater at %s." % (CRATER_SPAWN_LOCATION,))
            task.enter_progress_frame(1, "Preparing the crater")

            ensure_crater_collision(crater_actors)
            lo, hi = combined_bounds(crater_actors)
            cx, cy = STATION_CENTER or ((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0)
            crater_radius = min(hi[0] - lo[0], hi[1] - lo[1]) / 2.0
            tracer = GroundTracer(world, crater_actors, hi[2], lo[2])
            probe = [(cx, cy)] + [(cx + crater_radius * f * math.cos(a), cy + crater_radius * f * math.sin(a))
                                  for f in (0.15, 0.35) for a in (0.0, 2.1, 4.2)]
            if not tracer.pick_mode(probe):
                _warn("Could not line-trace the crater surface (no collision?). Pieces go on the "
                      "bottom of the crater's bounds instead.")
            floor_z = tracer.height(cx, cy)
            if floor_z is None:
                floor_z = lo[2]
            _log("Crater: %.0f m across, floor at Z=%.0f, centre (%.0f, %.0f)."
                 % (crater_radius * 2.0 / 100.0, floor_z, cx, cy))

            # 2. spawn every asset once, off to the side, to measure it
            staging = unreal.Vector(cx, cy, hi[2] + 50000.0)
            measured = {}
            pieces = []
            skipped = []
            for ad in assets:
                if task.should_cancel():
                    _warn("Cancelled.")
                    for m in measured.values():
                        actor_sub.destroy_actor(m.actor)
                    return
                task.enter_progress_frame(1, "Measuring %s" % ad.asset_name)
                asset = ad.get_asset()
                result = measure(actor_sub, asset, staging) if asset else None
                if result is None:
                    skipped.append((str(ad.asset_name), "could not be spawned"))
                    continue
                meas, ext = result
                piece = Piece(str(ad.package_name), meas.name, ext.x, ext.y)
                if piece.r > crater_radius:
                    actor_sub.destroy_actor(meas.actor)
                    skipped.append((meas.name, "wider than the crater (%.0f m)" % (piece.r * 2 / 100.0)))
                    continue
                measured[piece.key] = meas
                pieces.append(piece)
                tracer.ignore.append(meas.actor)

            if not pieces:
                unreal.log_error("[SpaceStation] Nothing could be placed.")
                return

            # 3. plan
            task.enter_progress_frame(1, "Planning the layout")
            placements, station_radius = plan_station(pieces)

            # 4. place (the first placement of an asset reuses its measured actor,
            #    repeats - e.g. corridors used for several spokes - get a new spawn)
            placed_actors = []
            untraced = 0
            used = set()
            for pl in placements:
                task.enter_progress_frame(1, "Placing %s" % pl.piece.name)
                meas = measured[pl.piece.key]
                if pl.piece.key in used:
                    actor = actor_sub.spawn_actor_from_object(meas.asset, staging, unreal.Rotator(0.0, 0.0, 0.0))
                    if not actor:
                        continue
                    tracer.ignore.append(actor)
                else:
                    actor = meas.actor
                    used.add(pl.piece.key)
                if not place_actor(actor, meas, pl, cx, cy, tracer, floor_z):
                    untraced += 1
                actor.set_actor_label("%s_%s" % (ROLE_LABELS[pl.role], pl.piece.name))
                actor.set_folder_path("%s/%s" % (OUTLINER_ROOT, ROLE_FOLDERS[pl.role]))
                _add_tag(actor, STATION_TAG)
                placed_actors.append(actor)
            for key, meas in measured.items():
                if key not in used:
                    actor_sub.destroy_actor(meas.actor)

            # 5. wrap up
            task.enter_progress_frame(1, "Framing the view")
            if placed_actors:
                actor_sub.set_selected_level_actors(placed_actors)
            if FRAME_VIEWPORT:
                frame_viewport(cx, cy, floor_z, station_radius)

    counts = {}
    for pl in placements:
        counts[pl.role] = counts.get(pl.role, 0) + 1
    order = ("hub", "habitat", "connector", "perimeter", "landing", "prop")
    names = {"hub": "hub", "habitat": "habitats", "connector": "corridors",
             "perimeter": "perimeter", "landing": "landing", "prop": "props"}
    breakdown = "  ".join("%d %s" % (counts[r], names[r]) for r in order if counts.get(r))

    _log("-" * 60)
    _log("Placed %d actor(s) from %d asset(s): %s" % (len(placed_actors), len(pieces), breakdown))
    for role in order:
        items = sorted({pl.piece.name for pl in placements if pl.role == role})
        if items:
            _log("  %-10s %s" % (names[role], ", ".join(items)))
    _log("Station is %.0f m across on a crater %.0f m across." % (station_radius * 2 / 100.0, crater_radius * 2 / 100.0))
    if station_radius > crater_radius * 0.6:
        _warn("The station is wider than the crater floor, so the outer pieces climb the walls. "
              "Lower GAP_CM or scale the crater up and run again.")
    if untraced:
        _warn("%d piece(s) had no crater surface under them and were set to the floor height." % untraced)
    for name, why in skipped:
        _warn("Skipped %s: %s" % (name, why))
    if skipped and len(skipped) > len(pieces):
        _warn("Most assets were wider than the crater. If the crater imported at the wrong scale, "
              "scale the crater actor up and run this again.")
    _log("Done in %.1fs. Ctrl+Z undoes the whole build. Save the level to keep it." % (time.time() - started))

    if SHOW_SUMMARY_DIALOG:
        msg = ("Space station built on the crater.\n\n%s\n\nStation %.0f m across, crater %.0f m across.%s\n\n"
               "Everything is under '%s' in the Outliner. Ctrl+Z undoes it; details are in the Output Log."
               % (breakdown, station_radius * 2 / 100.0, crater_radius * 2 / 100.0,
                  ("\n%d asset(s) skipped (see Output Log)." % len(skipped)) if skipped else "",
                  OUTLINER_ROOT))
        unreal.EditorDialog.show_message("Lunco Space Station", msg, unreal.AppMsgType.OK)


if __name__ == "__main__" and unreal is not None:
    build()
