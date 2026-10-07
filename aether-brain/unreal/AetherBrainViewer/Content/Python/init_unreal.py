"""
Runs when the Unreal Editor opens this project (any Content/Python/init_unreal.py is run at startup by the
Python Editor Script Plugin, which AetherBrainViewer.uproject enables).

The first time, it makes the assets the viewer needs, so there is nothing to set up by hand:

- /Game/AetherBrain/M_AetherNode: an unlit material that glows in each instance's own colour.
  Per-instance custom data 0, 1, 2 = linear RGB, 3 = glow. A soft rim (Fresnel) makes spheres read as spheres.
- /Game/AetherBrain/M_AetherSprite: an unlit, additive, two-sided material for the sky (stars, nebulae, galaxies).
  Parameter Tex is the picture (generated while playing); custom data 0, 1, 2 = tint, 3 = glow.
- /Game/AetherBrain/M_AetherRock: a lit material for asteroids and ships. Custom data 0, 1, 2 = colour,
  3 = how metallic (it also sets how rough).
- /Game/AetherBrain/Maps/Brain: an empty level (space). The game mode fills it when you press Play.

Each is made once; if it exists it is left alone (edit it freely). Errors only go to the Output Log.

It also makes the empty folder /Game/AetherFX and tells the Output Log which of the five Niagara systems the effects
layer plays are still missing there. Python cannot build Niagara graphs, so those are made by hand, once, from the
recipes in docs/UNREAL-NIAGARA.md (a missing system is simply not played).
"""

import unreal

FOLDER = "/Game/AetherBrain"
MATERIAL = FOLDER + "/M_AetherNode"
SPRITE_MATERIAL = FOLDER + "/M_AetherSprite"
ROCK_MATERIAL = FOLDER + "/M_AetherRock"
MAP = FOLDER + "/Maps/Brain"
FX_FOLDER = "/Game/AetherFX"
FX_SYSTEMS = ["NS_AetherPulses", "NS_AetherCorona", "NS_AetherDust", "NS_AetherShootingStars", "NS_AetherRipple"]


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


def _custom_data(mel, material, index, default, y):
    expr = mel.create_material_expression(material, unreal.MaterialExpressionPerInstanceCustomData, -900, y)
    expr.set_editor_property("data_index", index)
    expr.set_editor_property("const_default_value", default)
    return expr


def _new_material(name, path):
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = tools.create_asset(name, FOLDER, unreal.Material, unreal.MaterialFactoryNew())
    if material is None:
        unreal.log_error("Aether Brain: could not create " + path)
        return None
    # Cooked games only draw a material on instanced meshes when it says it is used with them.
    material.set_editor_property("used_with_instanced_static_meshes", True)
    return material


def make_sprite_material():
    if unreal.EditorAssetLibrary.does_asset_exist(SPRITE_MATERIAL):
        return
    material = _new_material("M_AetherSprite", SPRITE_MATERIAL)
    if material is None:
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    material.set_editor_property("two_sided", True)

    mel = unreal.MaterialEditingLibrary

    # The picture. A texture parameter wants a default texture or the material will not compile.
    tex = mel.create_material_expression(material, unreal.MaterialExpressionTextureSampleParameter2D, -900, -420)
    tex.set_editor_property("parameter_name", "Tex")
    for candidate in ("/Engine/EngineResources/WhiteSquareTexture", "/Engine/EngineResources/DefaultTexture"):
        default_texture = unreal.load_asset(candidate)
        if default_texture is not None:
            tex.set_editor_property("texture", default_texture)
            break
    else:
        unreal.log_warning("Aether Brain: no engine texture found to be the sprite material's default picture")

    red = _custom_data(mel, material, 0, 1.0, -260)
    green = _custom_data(mel, material, 1, 1.0, -160)
    blue = _custom_data(mel, material, 2, 1.0, -60)
    glow = _custom_data(mel, material, 3, 1.0, 60)
    rg = mel.create_material_expression(material, unreal.MaterialExpressionAppendVector, -680, -220)
    mel.connect_material_expressions(red, "", rg, "A")
    mel.connect_material_expressions(green, "", rg, "B")
    tint = mel.create_material_expression(material, unreal.MaterialExpressionAppendVector, -520, -160)
    mel.connect_material_expressions(rg, "", tint, "A")
    mel.connect_material_expressions(blue, "", tint, "B")

    # Picture x tint x glow, added to the sky.
    tinted = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -360, -200)
    mel.connect_material_expressions(tex, "", tinted, "A")
    mel.connect_material_expressions(tint, "", tinted, "B")
    final = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -200, -120)
    mel.connect_material_expressions(tinted, "", final, "A")
    mel.connect_material_expressions(glow, "", final, "B")
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)

    mel.recompile_material(material)
    unreal.EditorAssetLibrary.save_asset(SPRITE_MATERIAL, only_if_is_dirty=False)
    log("made " + SPRITE_MATERIAL)


def make_rock_material():
    if unreal.EditorAssetLibrary.does_asset_exist(ROCK_MATERIAL):
        return
    material = _new_material("M_AetherRock", ROCK_MATERIAL)
    if material is None:
        return
    # Default lit: the stage's two lights shade it.
    mel = unreal.MaterialEditingLibrary

    red = _custom_data(mel, material, 0, 0.2, -260)
    green = _custom_data(mel, material, 1, 0.2, -160)
    blue = _custom_data(mel, material, 2, 0.2, -60)
    metal = _custom_data(mel, material, 3, 0.0, 60)
    rg = mel.create_material_expression(material, unreal.MaterialExpressionAppendVector, -680, -220)
    mel.connect_material_expressions(red, "", rg, "A")
    mel.connect_material_expressions(green, "", rg, "B")
    rgb = mel.create_material_expression(material, unreal.MaterialExpressionAppendVector, -520, -160)
    mel.connect_material_expressions(rg, "", rgb, "A")
    mel.connect_material_expressions(blue, "", rgb, "B")
    mel.connect_material_property(rgb, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(metal, "", unreal.MaterialProperty.MP_METALLIC)

    # Rougher the less metallic: 0.92 - 0.5 x metal.
    scaled = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -520, 140)
    mel.connect_material_expressions(metal, "", scaled, "A")
    scaled.set_editor_property("const_b", -0.5)
    rough = mel.create_material_expression(material, unreal.MaterialExpressionAdd, -360, 140)
    mel.connect_material_expressions(scaled, "", rough, "A")
    rough.set_editor_property("const_b", 0.92)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)

    mel.recompile_material(material)
    unreal.EditorAssetLibrary.save_asset(ROCK_MATERIAL, only_if_is_dirty=False)
    log("made " + ROCK_MATERIAL)


def make_map():
    if unreal.EditorAssetLibrary.does_asset_exist(MAP):
        return
    levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if not levels.new_level(MAP):
        unreal.log_error("Aether Brain: could not create " + MAP)
        return
    levels.save_current_level()
    log("made " + MAP + " (press Play: the brain appears when Aether Brain's companion link is on)")


def check_fx_systems():
    unreal.EditorAssetLibrary.make_directory(FX_FOLDER)
    missing = [name for name in FX_SYSTEMS if not unreal.EditorAssetLibrary.does_asset_exist(FX_FOLDER + "/" + name)]
    if missing:
        log(
            "Niagara systems not made yet (those effects are not played): "
            + ", ".join(missing)
            + ". Recipes: docs/UNREAL-NIAGARA.md. Save them in "
            + FX_FOLDER
            + "."
        )
    else:
        log("all five Niagara systems are in " + FX_FOLDER)


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
        make_sprite_material()
    except Exception as err:  # noqa: BLE001
        unreal.log_error("Aether Brain: the sky material could not be made: {}".format(err))
    try:
        make_rock_material()
    except Exception as err:  # noqa: BLE001
        unreal.log_error("Aether Brain: the rock material could not be made: {}".format(err))
    try:
        make_map()
    except Exception as err:  # noqa: BLE001
        unreal.log_error("Aether Brain: the map could not be made: {}".format(err))
    try:
        check_fx_systems()
    except Exception as err:  # noqa: BLE001
        unreal.log_error("Aether Brain: the Niagara folder could not be checked: {}".format(err))


if unreal.is_editor():
    _handle = unreal.register_slate_post_tick_callback(_once)
