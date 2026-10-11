// A software picture of the asteroids and their rock maps, from the very same arrays the viewer hands to Unreal
// (AetherRockMath.h), drawn by the shared rasteriser (mesh_raster.h). Run with unreal/tests/rock_preview.sh <output folder> [map size].
#include "mesh_raster.h"
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherRockMath.h"

#include <cstdio>
#include <string>

using namespace AetherRock;
using namespace raster;

int main(int Argc, char** Argv)
{
	const std::string Out = Argc > 1 ? Argv[1] : "./rock_preview";
	const int MapSize = Argc > 2 ? std::atoi(Argv[2]) : 2048;
	Clock::time_point T = Clock::now();
	std::vector<RockMaps> Maps;
	for (int K = 0; K < kRockKinds; ++K)
	{
		Maps.push_back(MakeRockMaps(MapSize, 40U + static_cast<uint32_t>(K), static_cast<RockKind>(K)));
	}
	std::printf("4 rock map sets at %d: %.1f s\n", MapSize, Since(T));
	WritePpm(Out + "/rock_albedo_crop.ppm", 1024, 1024, Crop(Maps[1].BaseColor, 0, 0, 1024, 1024));
	WritePpm(Out + "/rock_normal_crop.ppm", 1024, 1024, Crop(Maps[1].Normal, 0, 0, 1024, 1024));
	struct View
	{
		const char* Name;
		uint32_t Seed;
		int Kind;
		int Detail;
		double Elong;
		Vec3 Dir;
		double Rough;
	};
	const View Views[] = {
		{"rock_silicate", 3U, 1, 5, 1.4, Vec3{0.8, -0.5, 0.35}, 1.0},
		{"rock_iron", 9U, 2, 5, 1.7, Vec3{0.7, 0.6, 0.4}, 1.4},
		{"rock_carbon", 21U, 0, 5, 1.2, Vec3{-0.6, -0.7, 0.3}, 1.0},
		{"rock_ice", 33U, 3, 5, 1.3, Vec3{0.5, -0.8, 0.5}, 0.8},
	};
	for (const View& V : Views)
	{
		T = Clock::now();
		RockSpec Spec;
		Spec.Seed = V.Seed;
		Spec.Detail = V.Detail;
		Spec.Elongation = V.Elong;
		Spec.Roughness = V.Rough;
		const Section Rock = MakeAsteroid(Spec);
		const RockMaps& M = Maps[static_cast<size_t>(V.Kind)];
		Scene S;
		S.Light = AetherSpace::Normalized(Vec3{0.55, -0.6, 0.55});
		S.Layers = {Layer{&Rock, &M.BaseColor, &M.Normal, &M.Orm, 0}};
		const Camera Cam(AetherSpace::Normalized(V.Dir) * 3.4, Vec3{}, 1200, 1200, 34.0);
		WritePpm(Out + "/" + V.Name + ".ppm", 1200, 1200, Render(S, Cam, 0.95));
		std::printf("%s: %zu tris, %.1f s\n", V.Name, Rock.Triangles(), Since(T));
	}
	return 0;
}
