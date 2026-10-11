// A software picture of the ships and their metal, made from the very same arrays the viewer hands to Unreal
// (AetherShipMath.h), drawn by the shared rasteriser (mesh_raster.h). A check and a preview, not the renderer: Unreal
// draws the real thing with its own lights. Run with unreal/tests/ship_preview.sh <output folder> [map size].
#include "mesh_raster.h"
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherShipMath.h"

#include <cstdio>
#include <string>

using namespace AetherShip;
using namespace raster;

int main(int Argc, char** Argv)
{
	const std::string Out = Argc > 1 ? Argv[1] : "./ship_preview";
	const int MapSize = Argc > 2 ? std::atoi(Argv[2]) : 2048;
	Clock::time_point T = Clock::now();
	const HullMaps Maps = MakeHullMaps(MapSize, 77U, LiveryOf(0));
	std::printf("hull maps %d: %.1f s\n", MapSize, Since(T));
	WritePpm(Out + "/hull_albedo_crop.ppm", 1024, 1024, Crop(Maps.BaseColor, 0, 0, 1024, 1024));
	WritePpm(Out + "/hull_normal_crop.ppm", 1024, 1024, Crop(Maps.Normal, 0, 0, 1024, 1024));
	WritePpm(Out + "/hull_orm_crop.ppm", 1024, 1024, Crop(Maps.Orm, 0, 0, 1024, 1024));
	// The whole albedo, small.
	{
		const int Step = std::max(1, MapSize / 1024);
		std::vector<uint8_t> Small(static_cast<size_t>(1024) * 1024U * 3U);
		for (int Y = 0; Y < 1024; ++Y)
		{
			for (int X = 0; X < 1024; ++X)
			{
				const size_t O = Maps.BaseColor.Offset(std::min(MapSize - 1, X * Step), std::min(MapSize - 1, Y * Step));
				const size_t P = (static_cast<size_t>(Y) * 1024U + static_cast<size_t>(X)) * 3U;
				Small[P + 0] = Maps.BaseColor.Bgra[O + 2];
				Small[P + 1] = Maps.BaseColor.Bgra[O + 1];
				Small[P + 2] = Maps.BaseColor.Bgra[O + 0];
			}
		}
		WritePpm(Out + "/hull_albedo_tile.ppm", 1024, 1024, Small);
	}
	struct View
	{
		const char* Name;
		ShipClass Cls;
		uint32_t Seed;
		Vec3 Dir; // from the ship to the camera, in units of the ship's length
		double Fov;
		double Dist;
		Vec3 Target;
		double Exposure;
	};
	const View Views[] = {
		{"interceptor_front34", ShipClass::Interceptor, 7U, Vec3{0.80, -0.62, 0.28}, 40.0, 1.25, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"interceptor_rear", ShipClass::Interceptor, 7U, Vec3{-0.85, -0.35, 0.18}, 40.0, 1.15, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"interceptor_top", ShipClass::Interceptor, 11U, Vec3{0.12, -0.22, 0.97}, 40.0, 1.15, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"hauler_front34", ShipClass::Hauler, 3U, Vec3{0.78, -0.55, 0.30}, 38.0, 1.75, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"hauler_rear", ShipClass::Hauler, 3U, Vec3{-0.8, -0.45, 0.25}, 38.0, 1.6, Vec3{-0.05, 0.0, 0.0}, 0.9},
		{"cruiser_front34", ShipClass::Cruiser, 5U, Vec3{0.72, -0.62, 0.30}, 40.0, 1.5, Vec3{0.0, 0.0, 0.0}, 0.9},
	};
	for (const View& V : Views)
	{
		T = Clock::now();
		const Mesh M = MakeShip(V.Cls, V.Seed);
		const double Len = ShipLength(V.Cls);
		const Vec3 Target = V.Target * Len;
		const Vec3 Eye = Target + AetherSpace::Normalized(V.Dir) * (V.Dist * Len);
		const Camera Cam(Eye, Target, 1600, 900, V.Fov);
		Scene S;
		S.Light = AetherSpace::Normalized(Vec3{0.45, -0.65, 0.62});
		S.Layers = {Layer{&M[Zone::Hull], &Maps.BaseColor, &Maps.Normal, &Maps.Orm, 0}, Layer{&M[Zone::Glass], nullptr, nullptr, nullptr, 1}, Layer{&M[Zone::Light], nullptr, nullptr, nullptr, 2}};
		const std::vector<uint8_t> Px = Render(S, Cam, V.Exposure);
		WritePpm(Out + "/" + V.Name + ".ppm", 1600, 900, Px);
		std::printf("%s: %zu tris, %.1f s\n", V.Name, M.Triangles(), Since(T));
	}
	return 0;
}
