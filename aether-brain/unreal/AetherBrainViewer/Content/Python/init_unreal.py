"""
Runs when the Unreal Editor opens this project (any Content/Python/init_unreal.py is run at startup by the
Python Editor Script Plugin, which AetherBrainViewer.uproject enables).

The first time, it makes the two assets the viewer needs, so there is nothing to set up by hand:

- /Game/AetherBrain/M_AetherNode: an unlit material that glows in each instance's own colour.
  Per-instance custom data 0, 1, 2 = linear RGB, 3 = glow. A soft rim (Fresnel) makes spheres read as spheres.
- /Game/AetherBrain/Maps/Brain: an empty level (space). The game mode fills it when you press Play.

Both are made once; if they exist they are left alone (edit them freely). Errors only go to the Output Log.
"""

import unreal

FOLDER = "/Game/AetherBrain"
MATERIAL = FOLDER + "/M_AetherNode"
MAP = FOLDER + "/Maps/Brain"


def log(message):
    unreal.log("Aether Brain: " + message)


def make_material():
    if unreal.EditorAssetLibrary.does_asset_exist(MATERIAL):
        return
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = tools.create_asset("M_AetherNode", FOLDER, unreal.Material, unreal.MaterialFactoryNew())
    if material is None:
        unreal.log_error("Aether Brain: could not create " + MATERIAL)
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    # Cooked games only draw a material on instanced meshes when it says it is used with them.
    material.set_editor_property("used_with_instanced_static_meshes", True)

    mel = unreal.MaterialEditingLibrary

    def custom_data(index, default, y):
        expr = mel.create_material_expression(material, unreal.MaterialExpressionPerInstanceCustomData, -900, y)
        expr.set_editor_property("data_index", index)
        expr.set_editor_property("const_default_value", default)
        return expr

    red = custom_data(0, 1.0, -260)
    green = custom_data(1, 1.0, -160)
    blue = custom_data(2, 1.0, -60)
    glow = custom_data(3, 1.0, 60)

    rg = mel.create_material_expression(material, unreal.MaterialExpressionAppendVector, -680, -220)
    mel.connect_material_expressions(red, "", rg, "A")
    mel.connect_material_expressions(green, "", rg, "B")
    rgb = mel.create_material_expression(material, unreal.MaterialExpressionAppendVector, -520, -160)
    mel.connect_material_expressions(rg, "", rgb, "A")
    mel.connect_material_expressions(blue, "", rgb, "B")

    # Colour × glow.
    lit = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -360, -80)
    mel.connect_material_expressions(rgb, "", lit, "A")
    mel.connect_material_expressions(glow, "", lit, "B")

    # A rim: 0.65 in the middle of a sphere, brighter toward its edge.
    rim = mel.create_material_expression(material, unreal.MaterialExpressionFresnel, -520, 160)
    rim.set_editor_property("exponent", 2.5)
    rim.set_editor_property("base_reflect_fraction", 0.0)
    rim_scaled = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -360, 160)
    mel.connect_material_expressions(rim, "", rim_scaled, "A")
    rim_scaled.set_editor_property("const_b", 0.9)
    shade = mel.create_material_expression(material, unreal.MaterialExpressionAdd, -220, 160)
    mel.connect_material_expressions(rim_scaled, "", shade, "A")
    shade.set_editor_property("const_b", 0.65)

    final = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -100, 0)
    mel.connect_material_expressions(lit, "", final, "A")
    mel.connect_material_expressions(shade, "", final, "B")
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    mel.recompile_material(material)
    unreal.EditorAssetLibrary.save_asset(MATERIAL, only_if_is_dirty=False)
    log("made " + MATERIAL)


def make_map():
    if unreal.EditorAssetLibrary.does_asset_exist(MAP):
        return
    levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if not levels.new_level(MAP):
        unreal.log_error("Aether Brain: could not create " + MAP)
        return
    levels.save_current_level()
    log("made " + MAP + " (press Play: the brain appears when Aether Brain's companion link is on)")


_handle = None


def _once(_delta):
    # After the editor has finished starting (assets and levels can't be made safely before that).
    global _handle
    unreal.unregister_slate_post_tick_callback(_handle)
    try:
        make_material()
    except Exception as err:  # noqa: BLE001 - the editor must keep starting whatever happens here
        unreal.log_error("Aether Brain: the glow material could not be made: {}".format(err))
    try:
        make_map()
    except Exception as err:  # noqa: BLE001
        unreal.log_error("Aether Brain: the map could not be made: {}".format(err))


if unreal.is_editor():
    _handle = unreal.register_slate_post_tick_callback(_once)
