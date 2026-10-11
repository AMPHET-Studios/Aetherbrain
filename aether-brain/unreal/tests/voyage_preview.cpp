// One picture of the Voyage as the viewer composes it: the player's interceptor from the chase camera, a field of asteroids ahead, a sun with its
// limb darkening, the nebula sky behind, all made by the very same generators the actor uses (the sky, sun, ship, hull maps, rocks and rock maps)
// and drawn by the software rasteriser. A check of scale and light, and a preview: Unreal draws the real thing. Run with voyage_preview.sh <folder>.
#include "mesh_raster.h"
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherRockMath.h"
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherShipMath.h"

#include <cstdio>
#include <string>

using namespace raster;
namespace Sh = AetherShip;
namespace Rk = AetherRock;
namespace Sp = AetherSpace;
namespace Ms = AetherMesh;

namespace
{
/** `Src` (a finished mesh section) turned, scaled and moved into `Dst` (raw: finished again at the end). */
void Place(Ms::Section& Dst, const Ms::Section& Src, const Sp::Quat& Q, const Vec3& At, double Scale, Ms::GroupCounter& G)
{
	Ms::Append(Dst, Src, Q, At, false, G, Scale);
}

/** A sphere with the picture wrapped round it (u round, v from the top), facing outward. */
Ms::Section MakeSphere(double Radius, int Lon, int Lat)
{
	Ms::Section S;
	for (int J = 0; J <= Lat; ++J)
	{
		const double V = static_cast<double>(J) / static_cast<double>(Lat);
		const double Phi = Sp::kPi * 0.5 - V * Sp::kPi;
		for (int I = 0; I <= Lon; ++I)
		{
			const double U = static_cast<double>(I) / static_cast<double>(Lon);
			const double Th = U * 2.0 * Sp::kPi - Sp::kPi;
			const Vec3 D{std::cos(Phi) * std::cos(Th), std::cos(Phi) * std::sin(Th), std::sin(Phi)};
			S.AddVertex(D * Radius, Ms::Vec2{U, V}, Ms::Rgb{1, 1, 1}, 1U);
		}
	}
	for (int J = 0; J < Lat; ++J)
	{
		for (int I = 0; I < Lon; ++I)
		{
			const uint32_t A = static_cast<uint32_t>(J * (Lon + 1) + I);
			const uint32_t B = A + 1U;
			const uint32_t C = A + static_cast<uint32_t>(Lon + 1);
			const uint32_t D = C + 1U;
			// Outward (b - a) x (c - a): as lon grows and lat falls the surface turns this way.
			S.AddTri(A, B, D);
			S.AddTri(A, D, C);
		}
	}
	Ms::Finish(S);
	// If the winding came out inward, the normals do too: turn them and the triangles round.
	if (Sp::Dot(S.Nrm[static_cast<size_t>(Lat / 2 * (Lon + 1) + Lon / 4)], S.Pos[static_cast<size_t>(Lat / 2 * (Lon + 1) + Lon / 4)]) < 0.0)
	{
		for (size_t K = 0; K + 2U < S.Idx.size(); K += 3U)
		{
			std::swap(S.Idx[K + 1U], S.Idx[K + 2U]);
		}
		Ms::Finish(S);
	}
	return S;
}
} // namespace

int main(int Argc, char** Argv)
{
	const std::string Out = Argc > 1 ? Argv[1] : "./voyage_preview";
	Clock::time_point T = Clock::now();
	AetherSky::SkyParams SP;
	SP.Width = 4096;
	SP.Height = 2048;
	SP.Seed = 2026U;
	const Sp::Image Sky = AetherSky::MakeSkyMap(SP);
	AetherSky::SunParams Su;
	Su.Width = 2048;
	Su.Height = 1024;
	Su.Seed = 77U * 2U;
	Su.Kelvin = 5800.0;
	const Sp::Image Sun = AetherSky::MakeSunMap(Su);
	const Sh::HullMaps Hull = Sh::MakeHullMaps(2048, 5U, Sh::LiveryOf(0));
	std::vector<Rk::RockMaps> Rocks;
	for (int K = 0; K < Rk::kRockKinds; ++K)
	{
		Rocks.push_back(Rk::MakeRockMaps(1024, 400U + static_cast<uint32_t>(K), static_cast<Rk::RockKind>(K)));
	}
	std::printf("pictures: %.1f s\n", Since(T));

	// The ship: 520 cm long, in the middle, banked a little, nose to +X.
	Ms::GroupCounter G;
	const Ms::Mesh Interceptor = Sh::MakeShip(Sh::ShipClass::Interceptor, 7U);
	const double Cm = 520.0 / Sh::ShipLength(Sh::ShipClass::Interceptor);
	const Sp::Quat Bank = Sh::AboutX(-14.0) * Sh::AboutZ(4.0);
	Ms::Mesh Ship;
	for (int Z = 0; Z < Ms::kZones; ++Z)
	{
		Place(Ship.Z[static_cast<size_t>(Z)], Interceptor.Z[static_cast<size_t>(Z)], Bank, Vec3{0, 0, 0}, Cm, G);
		Ms::Finish(Ship.Z[static_cast<size_t>(Z)]);
	}
	// The rocks ahead, one section per kind (each kind wears its own maps).
	std::vector<Ms::Section> Fields(Rk::kRockKinds);
	Sp::Rng R(11U);
	const struct { double Along, Side, Up, Radius; int Kind; uint32_t Seed; int Detail; } Placement[] = {
		{1900, -420, 160, 130, 1, 3U, 4},  {2600, 760, -100, 260, 2, 9U, 5}, {3300, -980, -240, 330, 0, 21U, 5}, {4100, 330, 420, 90, 1, 5U, 4},
		{4800, -250, 60, 480, 1, 33U, 5},  {5600, 1100, 260, 210, 3, 12U, 4}, {6500, -1500, 390, 380, 2, 40U, 5}, {7300, 520, -460, 150, 0, 8U, 4},
		{8300, -700, -80, 560, 1, 17U, 5}, {9400, 1500, 600, 300, 3, 3U, 5}, {10500, -300, 520, 240, 2, 29U, 4}, {1500, 1000, -400, 80, 1, 44U, 4},
		{3000, 1500, 520, 170, 0, 31U, 4}, {6000, 0, -700, 420, 3, 6U, 5},
	};
	for (const auto& P : Placement)
	{
		Rk::RockSpec Spec;
		Spec.Seed = P.Seed;
		Spec.Detail = P.Detail;
		Spec.Roughness = 0.9 + 0.1 * static_cast<double>(P.Seed % 4);
		Spec.Elongation = 1.15 + 0.1 * static_cast<double>(P.Seed % 5);
		const Ms::Section Rock = Rk::MakeAsteroid(Spec);
		const Sp::Quat Q = Sp::FromAxisAngle(R.Unit(), R.Range(0.0, 6.28));
		Place(Fields[static_cast<size_t>(P.Kind)], Rock, Q, Vec3{P.Along, P.Side, P.Up}, P.Radius, G);
	}
	for (Ms::Section& F : Fields)
	{
		Ms::Finish(F);
	}
	// The sun: a big ball far off to the upper left.
	const Vec3 SunDir = Sp::Normalized(Vec3{0.85, -0.49, 0.21});
	const Ms::Section Ball = MakeSphere(4200.0, 128, 64);
	Ms::Section SunBall;
	Place(SunBall, Ball, Sp::Quat{}, SunDir * 62000.0, 1.0, G);
	Ms::Finish(SunBall);

	Scene S;
	// The stage's key light comes over the camera's left shoulder, so the rocks facing the player are lit (the sun ball is just a body in the sky).
	S.Light = Sp::Normalized(Vec3{-0.45, -0.55, 0.70});
	S.Sky = &Sky;
	S.SkyGain = 2.4;
	S.SunGain = 2.2;
	S.Layers = {Layer{&Ship[Ms::Zone::Hull], &Hull.BaseColor, &Hull.Normal, &Hull.Orm, 0}, Layer{&Ship[Ms::Zone::Glass], nullptr, nullptr, nullptr, 1}, Layer{&Ship[Ms::Zone::Light], nullptr, nullptr, nullptr, 2}};
	for (int K = 0; K < Rk::kRockKinds; ++K)
	{
		S.Layers.push_back(Layer{&Fields[static_cast<size_t>(K)], &Rocks[static_cast<size_t>(K)].BaseColor, &Rocks[static_cast<size_t>(K)].Normal, &Rocks[static_cast<size_t>(K)].Orm, 0});
	}
	S.Layers.push_back(Layer{&SunBall, &Sun, nullptr, nullptr, 3});

	// The chase camera of the actor: behind and above the ship, looking a little ahead of its nose.
	const double Ship_ = 260.0;
	const Vec3 CamPos{-Ship_ * 3.1, 0.0, Ship_ * 0.85};
	const Vec3 Look{Ship_ * 5.0, 0.0, 0.0};
	const Camera Cam(CamPos, Look, 1920, 1080, 76.0);
	T = Clock::now();
	WritePpm(Out + "/voyage_chase.ppm", 1920, 1080, Render(S, Cam, 0.9));
	std::printf("voyage_chase: %.1f s\n", Since(T));
	// A second view from the side and above, to see the scale: the ship against its rocks.
	const Camera Side(Vec3{3800.0, -5200.0, 1500.0}, Vec3{4200.0, 0.0, 0.0}, 1920, 1080, 46.0);
	T = Clock::now();
	WritePpm(Out + "/voyage_side.ppm", 1920, 1080, Render(S, Side, 0.9));
	std::printf("voyage_side: %.1f s\n", Since(T));
	return 0;
}
