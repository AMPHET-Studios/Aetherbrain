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
- The Voyage's materials (see Source/AetherBrain/Private/AetherVoyageActor.cpp): M_AetherSky (the 8K nebula sky, texture Sky),
  M_AetherSun (a sun's surface, texture Sun, with limb darkening), M_AetherCorona (additive glow round a sun, texture Tex),
  M_AetherHull and M_AetherRockPBR (lit: BaseColor / Normal / ORM textures made while playing, the vertex colour tints or
  carries baked occlusion), M_AetherGlass (dark and glossy), M_AetherLight (emissive from the vertex colour x Intensity),
  M_AetherCard (a folder's picture, texture Tex, with a thin glowing frame).
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
VOYAGE_MATERIALS = ["M_AetherSky", "M_AetherSun", "M_AetherCorona", "M_AetherHull", "M_AetherGlass", "M_AetherLight", "M_AetherRockPBR", "M_AetherCard"]
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


def _plain_material(name):
    """A material in the folder (None if it exists already or cannot be made); the caller fills it in."""
    path = FOLDER + "/" + name
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return None
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    material = tools.create_asset(name, FOLDER, unreal.Material, unreal.MaterialFactoryNew())
    if material is None:
        unreal.log_error("Aether Brain: could not create " + path)
    return material


def _finish(material, name):
    mel = unreal.MaterialEditingLibrary
    mel.recompile_material(material)
    unreal.EditorAssetLibrary.save_asset(FOLDER + "/" + name, only_if_is_dirty=False)
    log("made " + FOLDER + "/" + name)


def _texture_param(mel, material, name, x, y, linear=False):
    """A texture parameter: the engine's white square until the game puts its own picture in (a texture parameter needs a default)."""
    tex = mel.create_material_expression(material, unreal.MaterialExpressionTextureSampleParameter2D, x, y)
    tex.set_editor_property("parameter_name", name)
    if linear:
        tex.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_LINEAR_COLOR)
    for candidate in ("/Engine/EngineResources/WhiteSquareTexture", "/Engine/EngineResources/DefaultTexture"):
        default_texture = unreal.load_asset(candidate)
        if default_texture is not None:
            tex.set_editor_property("texture", default_texture)
            break
    return tex


def _scalar(mel, material, name, default, x, y):
    expr = mel.create_material_expression(material, unreal.MaterialExpressionScalarParameter, x, y)
    expr.set_editor_property("parameter_name", name)
    expr.set_editor_property("default_value", default)
    return expr


def _times(mel, material, a, a_pin, b, b_pin, x, y):
    expr = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, x, y)
    mel.connect_material_expressions(a, a_pin, expr, "A")
    mel.connect_material_expressions(b, b_pin, expr, "B")
    return expr


def make_sky_material():
    material = _plain_material("M_AetherSky")
    if material is None:
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property("two_sided", True)
    mel = unreal.MaterialEditingLibrary
    tex = _texture_param(mel, material, "Sky", -700, -100)
    glow = _scalar(mel, material, "Glow", 1.0, -700, 120)
    final = _times(mel, material, tex, "RGB", glow, "", -400, 0)
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    _finish(material, "M_AetherSky")


def make_sun_material():
    material = _plain_material("M_AetherSun")
    if material is None:
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    mel = unreal.MaterialEditingLibrary
    tex = _texture_param(mel, material, "Sun", -900, -200)
    gain = _scalar(mel, material, "Gain", 6.0, -900, 0)
    lit = _times(mel, material, tex, "RGB", gain, "", -620, -120)
    # Limb darkening, the standard law I = 1 - 0.62 (1 - mu): Fresnel (exponent 1, no base reflection) is 1 - mu.
    rim = mel.create_material_expression(material, unreal.MaterialExpressionFresnel, -900, 220)
    rim.set_editor_property("exponent", 1.0)
    rim.set_editor_property("base_reflect_fraction", 0.0)
    drop = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -700, 220)
    mel.connect_material_expressions(rim, "", drop, "A")
    drop.set_editor_property("const_b", -0.62)
    limb = mel.create_material_expression(material, unreal.MaterialExpressionAdd, -540, 220)
    mel.connect_material_expressions(drop, "", limb, "A")
    limb.set_editor_property("const_b", 1.0)
    final = _times(mel, material, lit, "", limb, "", -340, 0)
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    _finish(material, "M_AetherSun")


def make_corona_material():
    material = _plain_material("M_AetherCorona")
    if material is None:
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    material.set_editor_property("two_sided", True)
    mel = unreal.MaterialEditingLibrary
    tex = _texture_param(mel, material, "Tex", -700, -100)
    glow = _scalar(mel, material, "Glow", 2.4, -700, 120)
    final = _times(mel, material, tex, "RGB", glow, "", -400, 0)
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    _finish(material, "M_AetherCorona")


def _lit_with_maps(material):
    """Base colour x vertex colour, a normal map, and occlusion / roughness / metal from the packed map ORM (R, G, B)."""
    mel = unreal.MaterialEditingLibrary
    base = _texture_param(mel, material, "BaseColor", -900, -300)
    normal = _texture_param(mel, material, "Normal", -900, 0, linear=True)
    orm = _texture_param(mel, material, "ORM", -900, 300, linear=True)
    vertex = mel.create_material_expression(material, unreal.MaterialExpressionVertexColor, -900, -520)
    tinted = _times(mel, material, base, "RGB", vertex, "RGB", -560, -380)
    mel.connect_material_property(tinted, "", unreal.MaterialProperty.MP_BASE_COLOR)
    # Stored as n * 0.5 + 0.5: back to a direction.
    doubled = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -620, 0)
    mel.connect_material_expressions(normal, "RGB", doubled, "A")
    doubled.set_editor_property("const_b", 2.0)
    shifted = mel.create_material_expression(material, unreal.MaterialExpressionAdd, -460, 0)
    mel.connect_material_expressions(doubled, "", shifted, "A")
    shifted.set_editor_property("const_b", -1.0)
    mel.connect_material_property(shifted, "", unreal.MaterialProperty.MP_NORMAL)
    mel.connect_material_property(orm, "R", unreal.MaterialProperty.MP_AMBIENT_OCCLUSION)
    mel.connect_material_property(orm, "G", unreal.MaterialProperty.MP_ROUGHNESS)
    mel.connect_material_property(orm, "B", unreal.MaterialProperty.MP_METALLIC)


def make_hull_material():
    material = _plain_material("M_AetherHull")
    if material is None:
        return
    _lit_with_maps(material)
    _finish(material, "M_AetherHull")


def make_rock_pbr_material():
    material = _plain_material("M_AetherRockPBR")
    if material is None:
        return
    _lit_with_maps(material)
    _finish(material, "M_AetherRockPBR")


def make_glass_material():
    material = _plain_material("M_AetherGlass")
    if material is None:
        return
    mel = unreal.MaterialEditingLibrary
    colour = mel.create_material_expression(material, unreal.MaterialExpressionConstant3Vector, -500, -100)
    colour.set_editor_property("constant", unreal.LinearColor(0.008, 0.016, 0.026, 1.0))
    mel.connect_material_property(colour, "", unreal.MaterialProperty.MP_BASE_COLOR)
    rough = mel.create_material_expression(material, unreal.MaterialExpressionConstant, -500, 80)
    rough.set_editor_property("r", 0.05)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    spec = mel.create_material_expression(material, unreal.MaterialExpressionConstant, -500, 200)
    spec.set_editor_property("r", 1.0)
    mel.connect_material_property(spec, "", unreal.MaterialProperty.MP_SPECULAR)
    _finish(material, "M_AetherGlass")


def make_light_material():
    material = _plain_material("M_AetherLight")
    if material is None:
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    mel = unreal.MaterialEditingLibrary
    vertex = mel.create_material_expression(material, unreal.MaterialExpressionVertexColor, -700, -100)
    intensity = _scalar(mel, material, "Intensity", 9.0, -700, 100)
    final = _times(mel, material, vertex, "RGB", intensity, "", -420, 0)
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    _finish(material, "M_AetherLight")


def make_card_material():
    material = _plain_material("M_AetherCard")
    if material is None:
        return
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property("two_sided", True)
    mel = unreal.MaterialEditingLibrary
    tex = _texture_param(mel, material, "Tex", -1100, -300)
    bright = _scalar(mel, material, "Brightness", 1.15, -1100, -100)
    picture = _times(mel, material, tex, "RGB", bright, "", -800, -260)
    # A thin frame: how far from the middle of the card, 0 at the middle and 1 at the edge, to a high power, in the longer direction.
    uv = mel.create_material_expression(material, unreal.MaterialExpressionTextureCoordinate, -1100, 120)
    distances = []
    for channel, y in (("r", 80), ("g", 200)):
        mask = mel.create_material_expression(material, unreal.MaterialExpressionComponentMask, -900, y)
        mask.set_editor_property("r", channel == "r")
        mask.set_editor_property("g", channel == "g")
        mask.set_editor_property("b", False)
        mask.set_editor_property("a", False)
        mel.connect_material_expressions(uv, "", mask, "")
        centred = mel.create_material_expression(material, unreal.MaterialExpressionAdd, -760, y)
        mel.connect_material_expressions(mask, "", centred, "A")
        centred.set_editor_property("const_b", -0.5)
        magnitude = mel.create_material_expression(material, unreal.MaterialExpressionAbs, -640, y)
        mel.connect_material_expressions(centred, "", magnitude, "")
        distances.append(magnitude)
    farthest = mel.create_material_expression(material, unreal.MaterialExpressionMax, -520, 140)
    mel.connect_material_expressions(distances[0], "", farthest, "A")
    mel.connect_material_expressions(distances[1], "", farthest, "B")
    edge = mel.create_material_expression(material, unreal.MaterialExpressionMultiply, -400, 140)
    mel.connect_material_expressions(farthest, "", edge, "A")
    edge.set_editor_property("const_b", 2.0)
    frame = mel.create_material_expression(material, unreal.MaterialExpressionPower, -280, 140)
    mel.connect_material_expressions(edge, "", frame, "Base")
    frame.set_editor_property("const_exponent", 60.0)
    glow = mel.create_material_expression(material, unreal.MaterialExpressionConstant3Vector, -520, 320)
    glow.set_editor_property("constant", unreal.LinearColor(2.4, 1.9, 1.0, 1.0))
    final = mel.create_material_expression(material, unreal.MaterialExpressionLinearInterpolate, -140, 0)
    mel.connect_material_expressions(picture, "", final, "A")
    mel.connect_material_expressions(glow, "", final, "B")
    mel.connect_material_expressions(frame, "", final, "Alpha")
    mel.connect_material_property(final, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    _finish(material, "M_AetherCard")


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
    for name, make in (
        ("sky", make_sky_material),
        ("sun", make_sun_material),
        ("corona", make_corona_material),
        ("hull", make_hull_material),
        ("rock (PBR)", make_rock_pbr_material),
        ("glass", make_glass_material),
        ("light", make_light_material),
        ("folder card", make_card_material),
    ):
        try:
            make()
        except Exception as err:  # noqa: BLE001
            unreal.log_error("Aether Brain: the {} material could not be made: {}".format(name, err))
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
