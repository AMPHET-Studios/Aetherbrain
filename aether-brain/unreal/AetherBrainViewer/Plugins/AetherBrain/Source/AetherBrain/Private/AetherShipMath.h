// Spaceships made in code: three designs (a fighter-sized interceptor, a boxy hauler under its containers, a spindle
// cruiser with a habitat wheel) as lofted hulls, slab wings and fins, nozzles, cannons and greebles, in metres, nose
// toward +X; and the tileable PBR maps their metal wears (painted plates, seams, rivets, hatches, vents, hazard stripes,
// scratches, chipped paint over bare metal, grime): base colour, normal and occlusion / roughness / metal.
//
// No Unreal types: the viewer feeds the arrays to a procedural mesh, tests/ship_core_test.cpp checks them, and
// tests/ship_preview.cpp rasterises them to a picture. Everything is a function of the seed.
#pragma once

#include "AetherMeshMath.h"

namespace AetherShip
{
using namespace AetherMesh;
using AetherSky::ParallelRows;
using AetherSpace::FromAxisAngle;
using AetherSpace::Hash01;
using AetherSpace::Image;
using AetherSpace::Rng;
using AetherSpace::Smoothstep;

enum class ShipClass : uint8_t
{
	/** The player's ship: 14 m, delta wings, twin engines. */
	Interceptor,
	/** A freighter: 110 m, a bridge, rows of containers, four engines. */
	Hauler,
	/** A research cruiser: 190 m, ribbed spindle, a habitat wheel, a dish. */
	Cruiser,
};
constexpr int kShipClasses = 3;

/** How long the ship is, nose to tail, in metres (before any scale). */
inline double ShipLength(ShipClass C)
{
	switch (C)
	{
	case ShipClass::Interceptor: return 15.0;
	case ShipClass::Hauler: return 112.0;
	default: return 190.0;
	}
}

/** Real metres of surface that one repeat of the hull maps covers on a small craft; bigger ships use a bigger tile (plates grow with the hull). */
constexpr double kHullTile = 6.0;

inline Quat AboutX(double Deg) { return FromAxisAngle(Vec3{1.0, 0.0, 0.0}, AetherSpace::DegToRad(Deg)); }
inline Quat AboutY(double Deg) { return FromAxisAngle(Vec3{0.0, 1.0, 0.0}, AetherSpace::DegToRad(Deg)); }
inline Quat AboutZ(double Deg) { return FromAxisAngle(Vec3{0.0, 0.0, 1.0}, AetherSpace::DegToRad(Deg)); }

/** The light of an engine's throat and of the running lights: HDR (above 1), the material's emissive. */
constexpr Rgb kPlasmaBlue{0.35 * 9.0, 0.62 * 9.0, 1.00 * 9.0};
constexpr Rgb kPlasmaOrange{1.00 * 8.0, 0.52 * 8.0, 0.16 * 8.0};
constexpr Rgb kLightRed{1.0 * 6.0, 0.05 * 6.0, 0.04 * 6.0};
constexpr Rgb kLightGreen{0.05 * 6.0, 1.0 * 6.0, 0.18 * 6.0};
constexpr Rgb kLightWhite{1.0 * 7.0, 0.95 * 7.0, 0.85 * 7.0};
constexpr Rgb kWindowWarm{1.0 * 2.6, 0.78 * 2.6, 0.45 * 2.6};

namespace
{
/** Place a part: turned, moved, and (bBoth) also its mirror image on the other side. */
struct Builder
{
	Mesh M;
	GroupCounter G;
	Rng R;
	explicit Builder(uint32_t Seed) : R(Seed) {}

	void Put(Zone Z, const Section& Part, const Vec3& At, const Quat& Q = Quat{}, bool bBoth = false)
	{
		Append(M[Z], Part, Q, At, false, G);
		if (bBoth)
		{
			Append(M[Z], Part, Q, At, true, G);
		}
	}
};

/** Height of a lofted fuselage's top surface at (x, y): from the rings it was made of. */
inline double TopOf(const std::vector<Ring>& Rings, double X, double Y)
{
	for (size_t I = 0; I + 1U < Rings.size(); ++I)
	{
		if (X >= Rings[I].X && X <= Rings[I + 1U].X)
		{
			const double T = (X - Rings[I].X) / std::max(1e-9, Rings[I + 1U].X - Rings[I].X);
			const double Hw = Lerp(Rings[I].Hw, Rings[I + 1U].Hw, T);
			const double Hh = Lerp(Rings[I].Hh, Rings[I + 1U].Hh, T);
			const double E = Lerp(Rings[I].Exp, Rings[I + 1U].Exp, T);
			const double Cz = Lerp(Rings[I].Cz, Rings[I + 1U].Cz, T);
			const double K = Clamp01(std::fabs(Y) / std::max(1e-9, Hw));
			return Cz + Hh * std::pow(std::max(0.0, 1.0 - std::pow(K, E)), 1.0 / E);
		}
	}
	return 0.0;
}

inline std::vector<Vec2> Poly(std::initializer_list<Vec2> P) { return std::vector<Vec2>(P); }

/** A wing-like slab from its plan, with a thickness at the root and at the tip. */
inline Section Wing(const std::vector<Vec2>& Plan, const std::vector<double>& Thick, const Rgb& Tint, uint32_t Seed, GroupCounter& G)
{
	std::vector<double> Bottom;
	std::vector<double> Top;
	for (const double T : Thick)
	{
		Bottom.push_back(-T * 0.45);
		Top.push_back(T * 0.55);
	}
	return MakeSlab(Plan, Bottom, Top, Tint, kHullTile, Seed, G);
}

/** An engine nozzle pointing aft from `At`: a housing, a bell that widens to the lip, a dark ring and a glowing throat. */
inline void Nozzle(Builder& B, const Vec3& At, double Radius, double Length_, const Rgb& Glow, bool bMirror)
{
	const Rgb Hull{1.0, 1.0, 1.0};
	const Section Housing = MakeTube(Length_ * 0.5, Radius * 0.92, Radius * 0.92, 20, false, true, Hull, kHullTile, B.R.NextU(), B.G, 2);
	const Section Bell = MakeTube(Length_ * 0.7, Radius * 1.12, Radius * 0.62, 20, false, false, Hull, kHullTile, B.R.NextU(), B.G, 4);
	const Section Collar = MakeTube(Length_ * 0.12, Radius * 1.17, Radius * 1.17, 20, false, false, Hull, kHullTile, B.R.NextU(), B.G, 2);
	const double Recess = 0.25 + 0.15 * Radius;
	const Section Throat = MakeDisc(Radius * 0.84, 20, Glow, kHullTile, B.R.NextU(), B.G);
	const Section Dark = MakeDisc(Radius * 0.98, 20, Rgb{0.04, 0.04, 0.05}, kHullTile, B.R.NextU(), B.G);
	const Quat Aft = AboutZ(180.0);
	const double Lip = -Length_ * 0.7;
	const auto Place = [&](Zone Z, const Section& S, const Vec3& P, const Quat& Q) {
		Append(B.M[Z], S, Q, At + P, false, B.G);
		if (bMirror)
		{
			Append(B.M[Z], S, Q, At + P, true, B.G);
		}
	};
	Place(Zone::Hull, Housing, Vec3{}, Quat{});
	Place(Zone::Hull, Bell, Vec3{Lip, 0.0, 0.0}, Quat{});
	Place(Zone::Hull, Collar, Vec3{Lip - 0.02, 0.0, 0.0}, Quat{});
	// Seen from behind: the glowing throat in front of a dark ring, both inside the bell.
	Place(Zone::Light, Throat, Vec3{Lip + Recess, 0.0, 0.0}, Aft);
	Place(Zone::Light, Dark, Vec3{Lip + Recess + 0.04, 0.0, 0.0}, Aft);
}

/** A small box of light (a running light, a window) on the skin. */
inline void LightBox(Builder& B, const Vec3& At, const Vec3& Half, const Rgb& Glow, bool bBoth = false)
{
	const Section S = MakeBox(Half, Glow, kHullTile, B.R.NextU(), B.G);
	B.Put(Zone::Light, S, At, Quat{}, bBoth);
}

inline Mesh MakeInterceptor(uint32_t Seed)
{
	Builder B(Seed * 31U + 7U);
	Rng& R = B.R;
	const Rgb White{1.0, 1.0, 1.0};
	const double Wm = R.Range(0.94, 1.08);
	const double Hm = R.Range(0.94, 1.06);
	std::vector<Ring> F = {
		{-7.0, 1.10 * Wm, 0.78 * Hm, 3.2, 0.0, 0.0},  {-6.5, 1.34 * Wm, 0.92 * Hm, 3.0, 0.0, 0.0}, {-5.0, 1.56 * Wm, 1.04 * Hm, 2.8, 0.0, 0.0},
		{-2.5, 1.46 * Wm, 1.06 * Hm, 2.6, 0.0, 0.05}, {0.0, 1.26 * Wm, 0.96 * Hm, 2.5, 0.0, 0.0},  {2.4, 0.96 * Wm, 0.78 * Hm, 2.4, 0.0, -0.04},
		{4.6, 0.60 * Wm, 0.54 * Hm, 2.3, 0.0, -0.10}, {6.2, 0.28 * Wm, 0.28 * Hm, 2.2, 0.0, -0.14}, {7.2, 0.06, 0.06, 2.0, 0.0, -0.16},
	};
	B.Put(Zone::Hull, MakeLoft(F, 28, true, true, White, kHullTile, Seed + 1U, B.G), Vec3{});

	// The canopy: dark glass over the fuselage, mostly sunk into it.
	std::vector<Ring> Cp = {
		{-1.2, 0.20, 0.10, 2.2, 0.0, 0.88}, {-0.2, 0.55, 0.38, 2.2, 0.0, 0.74}, {1.4, 0.56, 0.42, 2.2, 0.0, 0.66},
		{3.0, 0.34, 0.26, 2.2, 0.0, 0.52},  {4.2, 0.10, 0.07, 2.2, 0.0, 0.40},
	};
	B.Put(Zone::Glass, MakeLoft(Cp, 20, false, false, White, kHullTile, Seed + 2U, B.G), Vec3{});
	// A frame round it.
	B.Put(Zone::Hull, MakeBox(Vec3{1.5, 0.05, 0.05}, White, kHullTile, Seed + 3U, B.G), Vec3{1.4, 0.0, 1.06}, AboutZ(0.0));

	// Wings: swept deltas, tips lowered; a fin and a light at each tip.
	const double Sweep = R.Range(0.92, 1.12);
	const std::vector<Vec2> Plan = Poly({{-5.7, 1.2}, {1.4, 1.0}, {-3.1 * Sweep, 6.7}, {-4.7 * Sweep, 6.7}});
	Section Wg = Wing(Plan, {0.42, 0.34, 0.14, 0.14}, White, Seed + 4U, B.G);
	B.Put(Zone::Hull, Wg, Vec3{0.0, 0.0, -0.18}, AboutX(-6.0), true);
	// The wing's thick root fairing.
	std::vector<Ring> Fair = {{-5.6, 0.2, 0.25, 2.4, 1.5, -0.2}, {-2.0, 0.9, 0.42, 2.4, 1.6, -0.2}, {1.0, 0.5, 0.3, 2.4, 1.3, -0.15}, {2.5, 0.05, 0.05, 2.0, 1.1, -0.1}};
	B.Put(Zone::Hull, MakeLoft(Fair, 16, true, true, White, kHullTile, Seed + 5U, B.G), Vec3{}, Quat{}, true);
	// Winglets (vertical fins at the tips).
	const Section Fin = MakeSlab(Poly({{-5.2, 0.0}, {-3.3, 0.0}, {-4.2, 1.9}, {-5.4, 1.9}}), {-0.06, -0.06, -0.04, -0.04}, {0.06, 0.06, 0.04, 0.04}, White, kHullTile, Seed + 6U, B.G);
	B.Put(Zone::Hull, Fin, Vec3{0.0, 6.65, -0.86}, AboutX(90.0 - 6.0), true);
	// Twin tail fins, canted outward.
	const Section Tail = MakeSlab(Poly({{-6.4, 0.0}, {-3.4, 0.0}, {-4.8, 3.0}, {-6.6, 3.0}}), {-0.07, -0.07, -0.05, -0.05}, {0.07, 0.07, 0.05, 0.05}, White, kHullTile, Seed + 7U, B.G);
	B.Put(Zone::Hull, Tail, Vec3{0.0, 0.85, 0.75}, AboutX(90.0 + 16.0), true);

	// Engines: two nacelles with nozzles, and sometimes a third on the spine.
	const std::vector<Ring> Nac = {{-6.6, 0.64, 0.64, 2.2, 0.0, 0.0}, {-5.5, 0.70, 0.70, 2.2, 0.0, 0.0}, {-3.0, 0.62, 0.62, 2.2, 0.0, 0.0}, {-1.2, 0.40, 0.40, 2.2, 0.0, 0.0}};
	B.Put(Zone::Hull, MakeLoft(Nac, 20, false, true, White, kHullTile, Seed + 8U, B.G), Vec3{0.0, 0.98, -0.12}, Quat{}, true);
	Nozzle(B, Vec3{-6.55, 0.98, -0.12}, 0.55, 1.1, kPlasmaBlue, true);
	if (R.Chance(0.5))
	{
		Nozzle(B, Vec3{-6.3, 0.0, 0.55}, 0.42, 0.9, kPlasmaBlue, false);
	}
	// Cannons under the nose.
	for (const double Y : {0.62})
	{
		B.Put(Zone::Hull, MakeBox(Vec3{0.8, 0.2, 0.17}, White, kHullTile, Seed + 9U, B.G), Vec3{1.4, Y, -0.78}, Quat{}, true);
		B.Put(Zone::Hull, MakeTube(3.4, 0.085, 0.07, 10, false, true, White, kHullTile, Seed + 10U, B.G, 2), Vec3{1.6, Y, -0.78}, Quat{}, true);
		B.Put(Zone::Hull, MakeTube(0.5, 0.12, 0.12, 10, false, true, White, kHullTile, Seed + 11U, B.G, 2), Vec3{1.5, Y, -0.78}, Quat{}, true);
	}
	// Missiles under the wings.
	for (const double Y : {2.7, 4.2})
	{
		B.Put(Zone::Hull, MakeBox(Vec3{0.8, 0.07, 0.1}, White, kHullTile, Seed + 12U + static_cast<uint32_t>(Y * 10.0), B.G), Vec3{-2.8, Y, -0.62}, Quat{}, true);
		B.Put(Zone::Hull, MakeTube(2.1, 0.13, 0.13, 10, true, true, White, kHullTile, Seed + 14U, B.G, 2), Vec3{-3.8, Y, -0.8}, Quat{}, true);
		B.Put(Zone::Hull, MakeTube(0.6, 0.13, 0.02, 10, false, true, White, kHullTile, Seed + 15U, B.G, 3), Vec3{-1.7, Y, -0.8}, Quat{}, true);
	}
	// Greebles on the spine and the wings: vents, hatches, sensors.
	const int Count = 16 + static_cast<int>(R.Next() * 8.0);
	for (int I = 0; I < Count; ++I)
	{
		const double X = R.Range(-6.0, 2.4);
		const double Y = R.Range(0.0, 0.9) * (R.Chance(0.5) ? 1.0 : -1.0);
		const double Top = TopOf(F, X, Y);
		const Vec3 Half{R.Range(0.12, 0.5), R.Range(0.1, 0.32), R.Range(0.04, 0.1)};
		const double Tn = R.Range(0.72, 1.08);
		B.Put(Zone::Hull, MakeBox(Half, Rgb{Tn, Tn, Tn * 0.97}, kHullTile, Seed + 100U + static_cast<uint32_t>(I), B.G), Vec3{X, Y, Top + Half.Z * 0.6});
	}
	// A sensor mast.
	B.Put(Zone::Hull, MakeTube(1.3, 0.03, 0.02, 8, false, true, White, kHullTile, Seed + 16U, B.G, 2), Vec3{-4.0, 0.0, 1.0}, AboutY(-90.0));
	// Lights: red to port, green to starboard, white on the tail.
	LightBox(B, Vec3{-3.9, -6.8, -0.9}, Vec3{0.14, 0.08, 0.08}, kLightRed);
	LightBox(B, Vec3{-3.9, 6.8, -0.9}, Vec3{0.14, 0.08, 0.08}, kLightGreen);
	LightBox(B, Vec3{-5.7, 1.62, 3.5}, Vec3{0.1, 0.05, 0.05}, kLightWhite * 0.6, true);
	// A strip of cockpit lights.
	for (int I = 0; I < 5; ++I)
	{
		LightBox(B, Vec3{-1.0 + 0.55 * I, 0.0, 1.0}, Vec3{0.05, 0.28, 0.025}, kWindowWarm * 0.35);
	}
	Finish(B.M);
	return B.M;
}

inline Mesh MakeHauler(uint32_t Seed)
{
	Builder B(Seed * 37U + 11U);
	Rng& R = B.R;
	const Rgb White{1.0, 1.0, 1.0};
	const double Tk = 12.0; // plates on a 110 m ship are 1.5 m
	// The keel: a square beam the whole length.
	std::vector<Ring> Spine = {
		{-44.0, 5.2, 5.2, 4.0, 0.0, 0.0}, {-38.0, 5.6, 5.8, 4.0, 0.0, 0.0}, {-20.0, 3.4, 3.4, 4.0, 0.0, 0.0},
		{20.0, 3.4, 3.4, 4.0, 0.0, 0.0},  {34.0, 5.0, 5.0, 3.4, 0.0, 0.0},  {40.0, 4.6, 4.6, 3.0, 0.0, 0.0},
	};
	B.Put(Zone::Hull, MakeLoft(Spine, 24, true, false, White, Tk, Seed + 1U, B.G), Vec3{});
	// The bridge: a wedge bow with a glass band and rows of windows.
	std::vector<Ring> Bow = {
		{40.0, 4.6, 4.6, 3.0, 0.0, 0.0}, {47.0, 4.2, 4.4, 2.8, 0.0, 0.4}, {53.0, 3.0, 3.6, 2.6, 0.0, 0.8}, {57.0, 1.4, 1.9, 2.4, 0.0, 0.7}, {58.5, 0.2, 0.3, 2.2, 0.0, 0.5},
	};
	B.Put(Zone::Hull, MakeLoft(Bow, 24, false, true, White, Tk, Seed + 2U, B.G), Vec3{});
	std::vector<Ring> Glass = {{44.5, 0.4, 0.2, 2.2, 0.0, 3.1}, {50.0, 3.2, 0.9, 2.2, 0.0, 3.2}, {55.0, 2.0, 0.7, 2.2, 0.0, 2.9}, {57.5, 0.3, 0.2, 2.2, 0.0, 2.5}};
	B.Put(Zone::Glass, MakeLoft(Glass, 20, false, false, White, Tk, Seed + 3U, B.G), Vec3{});
	for (int I = 0; I < 12; ++I)
	{
		const double X = 42.0 + 1.1 * I;
		const double Wy = 4.55 - 0.045 * I;
		LightBox(B, Vec3{X, Wy, 1.0}, Vec3{0.28, 0.04, 0.2}, kWindowWarm, true);
		LightBox(B, Vec3{X, Wy * 0.98, -1.2}, Vec3{0.28, 0.04, 0.2}, kWindowWarm * 0.8, true);
	}
	// Containers on four sides of the keel, in bays.
	const Rgb Paints[] = {Rgb{0.78, 0.36, 0.2}, Rgb{0.28, 0.45, 0.75}, Rgb{0.85, 0.85, 0.82}, Rgb{0.32, 0.55, 0.4}, Rgb{0.86, 0.66, 0.2}, Rgb{0.4, 0.4, 0.42}, Rgb{0.7, 0.18, 0.15}};
	int Block = 0;
	for (double X = -30.0; X <= 24.0; X += 11.5)
	{
		for (int Side = 0; Side < 4; ++Side)
		{
			if (R.Chance(0.12))
			{
				continue;
			}
			const double Len = R.Range(4.4, 5.4);
			const Vec3 Half{Len, 2.7, 2.7};
			const double Off = 3.4 + Half.Y;
			Vec3 At{X, 0.0, 0.0};
			switch (Side)
			{
			case 0: At.Y = Off; break;
			case 1: At.Y = -Off; break;
			case 2: At.Z = Off; break;
			default: At.Z = -Off; break;
			}
			const Rgb P = Paints[static_cast<size_t>(R.NextU() % 7U)];
			B.Put(Zone::Hull, MakeBox(Half, P, kHullTile, Seed + 200U + static_cast<uint32_t>(Block++), B.G), At);
			// Their locking frames.
			B.Put(Zone::Hull, MakeBox(Vec3{0.25, Half.Y + 0.1, Half.Z + 0.1}, White, kHullTile, Seed + 300U + static_cast<uint32_t>(Block), B.G), At + Vec3{Half.X + 0.3, 0.0, 0.0});
		}
	}
	// Radiator fins on the top and bottom of the engine block.
	for (const double Z : {1.0, -1.0})
	{
		const Section Fin = MakeSlab(Poly({{-44.0, -9.0}, {-30.0, -9.0}, {-30.0, 9.0}, {-44.0, 9.0}}), {-0.15, -0.15, -0.15, -0.15}, {0.15, 0.15, 0.15, 0.15}, White, Tk, Seed + 4U, B.G);
		B.Put(Zone::Hull, Fin, Vec3{0.0, 0.0, Z * 7.45});
	}
	// The engine block and its four nozzles.
	B.Put(Zone::Hull, MakeBox(Vec3{4.0, 7.4, 7.4}, White, Tk, Seed + 5U, B.G), Vec3{-48.0, 0.0, 0.0});
	for (const double Y : {-3.4, 3.4})
	{
		for (const double Z : {-3.4, 3.4})
		{
			Nozzle(B, Vec3{-52.0, Y, Z}, 2.5, 4.0, kPlasmaBlue, false);
		}
	}
	// Antennas and a mast.
	B.Put(Zone::Hull, MakeTube(14.0, 0.18, 0.1, 8, false, true, White, Tk, Seed + 6U, B.G, 2), Vec3{20.0, 0.0, 3.4}, AboutY(-90.0));
	B.Put(Zone::Hull, MakeTube(6.0, 0.14, 0.08, 8, false, true, White, Tk, Seed + 7U, B.G, 2), Vec3{12.0, 0.0, -3.4}, AboutY(90.0));
	LightBox(B, Vec3{20.0, 0.0, 17.6}, Vec3{0.3, 0.3, 0.3}, kLightRed);
	LightBox(B, Vec3{-43.0, 6.0, 1.0}, Vec3{0.4, 0.2, 0.2}, kLightWhite, true);
	// A few greebles on the keel.
	for (int I = 0; I < 40; ++I)
	{
		const double X = R.Range(-36.0, 38.0);
		const Vec3 Half{R.Range(0.3, 1.6), R.Range(0.3, 1.0), R.Range(0.1, 0.4)};
		const double Tn = R.Range(0.7, 1.05);
		B.Put(Zone::Hull, MakeBox(Half, Rgb{Tn, Tn, Tn}, kHullTile, Seed + 400U + static_cast<uint32_t>(I), B.G), Vec3{X, R.Range(-1.0, 1.0), 3.4 + Half.Z * 0.5});
	}
	Finish(B.M);
	return B.M;
}

inline Mesh MakeCruiser(uint32_t Seed)
{
	Builder B(Seed * 41U + 13U);
	Rng& R = B.R;
	const Rgb White{1.0, 1.0, 1.0};
	const double Tk = 24.0; // plates on a 190 m ship are 3 m
	// A ribbed spindle: a bulge every twelve metres.
	std::vector<Ring> Hull;
	Hull.push_back(Ring{-90.0, 6.0, 6.0, 2.8, 0.0, 0.0});
	for (double X = -84.0; X <= 78.0; X += 6.0)
	{
		const double Phase = std::fmod(X + 90.0, 12.0) < 6.0 ? 1.0 : 0.88;
		const double Env = std::sin(kPi * (X + 90.0) / 190.0);
		const double W = (8.0 + 9.0 * Env) * Phase;
		Hull.push_back(Ring{X, W, W * 0.82, 2.6, 0.0, 0.0});
	}
	Hull.push_back(Ring{86.0, 4.2, 3.6, 2.4, 0.0, 0.0});
	Hull.push_back(Ring{96.0, 0.5, 0.4, 2.2, 0.0, 0.0});
	B.Put(Zone::Hull, MakeLoft(Hull, 32, true, true, White, Tk, Seed + 1U, B.G), Vec3{});
	// A glass observation dome on top.
	std::vector<Ring> Dome = {{20.0, 4.0, 2.5, 2.2, 0.0, 12.2}, {26.0, 6.0, 3.6, 2.2, 0.0, 12.0}, {34.0, 4.5, 2.6, 2.2, 0.0, 11.8}, {40.0, 1.0, 0.6, 2.2, 0.0, 11.4}};
	B.Put(Zone::Glass, MakeLoft(Dome, 20, false, false, White, Tk, Seed + 2U, B.G), Vec3{});
	// The habitat wheel: a ring of tube segments and four spokes.
	const double WheelR = 34.0;
	const double WheelX = -10.0;
	const int Segs = 24;
	for (int I = 0; I < Segs; ++I)
	{
		const double A0 = 2.0 * kPi * I / Segs;
		const double A1 = 2.0 * kPi * (I + 1) / Segs;
		const Vec3 P0{WheelX, std::cos(A0) * WheelR, std::sin(A0) * WheelR};
		const Vec3 P1{WheelX, std::cos(A1) * WheelR, std::sin(A1) * WheelR};
		const Vec3 D = P1 - P0;
		const double Len = Length(D) * 1.04;
		const Quat Q = AetherSpace::LookRotation(Normalized(D), Vec3{1.0, 0.0, 0.0});
		B.Put(Zone::Hull, MakeTube(Len, 3.6, 3.6, 14, false, false, White, Tk, Seed + 10U + static_cast<uint32_t>(I), B.G, 2), P0 - Normalized(D) * (Len * 0.02), Q);
		// Windows in the ring, facing out.
		if (I % 2 == 0)
		{
			const Vec3 Mid = (P0 + P1) * 0.5;
			const Vec3 Out = Normalized(Vec3{0.0, Mid.Y, Mid.Z});
			LightBox(B, Mid + Out * 3.5, Vec3{0.2, 0.2, 0.2}, kWindowWarm);
		}
	}
	for (int I = 0; I < 4; ++I)
	{
		const double A = kPi * 0.5 * I + kPi * 0.25;
		const Vec3 Out{0.0, std::cos(A), std::sin(A)};
		const Quat Q = AetherSpace::LookRotation(Out, Vec3{1.0, 0.0, 0.0});
		B.Put(Zone::Hull, MakeTube(WheelR - 12.0, 1.4, 1.4, 12, false, false, White, Tk, Seed + 50U + static_cast<uint32_t>(I), B.G, 2), Out * 12.0 + Vec3{WheelX, 0.0, 0.0}, Q);
	}
	// A dish on a mast at the nose.
	B.Put(Zone::Hull, MakeTube(14.0, 0.5, 0.3, 10, false, true, White, Tk, Seed + 3U, B.G, 2), Vec3{80.0, 0.0, 0.0}, AboutY(-90.0) * AboutZ(0.0));
	std::vector<Ring> Dish = {{-1.8, 7.5, 7.5, 2.2, 0.0, 0.0}, {-0.6, 3.0, 3.0, 2.2, 0.0, 0.0}, {0.0, 0.3, 0.3, 2.2, 0.0, 0.0}};
	B.Put(Zone::Hull, MakeLoft(Dish, 24, true, false, White, Tk, Seed + 4U, B.G), Vec3{80.0, 0.0, 15.0}, AboutY(-70.0));
	// Engines: three big nozzles aft.
	for (int I = 0; I < 3; ++I)
	{
		const double A = 2.0 * kPi * I / 3.0 + kPi * 0.5;
		Nozzle(B, Vec3{-90.0, std::cos(A) * 3.2, std::sin(A) * 3.2}, 3.0, 5.0, kPlasmaOrange, false);
	}
	// Window rows along the hull, lights, greebles.
	for (int Row = 0; Row < 3; ++Row)
	{
		for (double X = -70.0; X < 70.0; X += 4.0)
		{
			if (R.Chance(0.25))
			{
				continue;
			}
			const double Env = std::sin(kPi * (X + 90.0) / 190.0);
			const double W = (8.0 + 9.0 * Env) * 0.94;
			const double A = AetherSpace::DegToRad(-10.0 + 14.0 * Row);
			LightBox(B, Vec3{X, std::cos(A) * W, std::sin(A) * W * 0.82}, Vec3{0.35, 0.05, 0.22}, kWindowWarm * R.Range(0.5, 1.0), true);
		}
	}
	LightBox(B, Vec3{96.0, 0.0, 0.0}, Vec3{0.25, 0.25, 0.25}, kLightRed);
	for (int I = 0; I < 50; ++I)
	{
		const double X = R.Range(-70.0, 70.0);
		const double Env = std::sin(kPi * (X + 90.0) / 190.0);
		const double W = (8.0 + 9.0 * Env);
		const double A = R.Range(0.0, 2.0 * kPi);
		const Vec3 Half{R.Range(0.5, 2.0), R.Range(0.4, 1.4), R.Range(0.15, 0.5)};
		const Vec3 Out{0.0, std::cos(A), std::sin(A)};
		const Quat Q = AetherSpace::LookRotation(Out, Vec3{1.0, 0.0, 0.0});
		const double Tn = R.Range(0.7, 1.05);
		B.Put(Zone::Hull, MakeBox(Vec3{Half.X, Half.Y, Half.Z}, Rgb{Tn, Tn, Tn}, Tk, Seed + 500U + static_cast<uint32_t>(I), B.G), Out * (W * 0.9) + Vec3{X, 0.0, 0.0}, Q);
	}
	Finish(B.M);
	return B.M;
}
} // namespace

/** A ship of the class, built from its seed. */
inline Mesh MakeShip(ShipClass C, uint32_t Seed)
{
	switch (C)
	{
	case ShipClass::Interceptor: return MakeInterceptor(Seed);
	case ShipClass::Hauler: return MakeHauler(Seed);
	default: return MakeCruiser(Seed);
	}
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The metal: tileable PBR maps                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The paint of a ship. */
struct Livery
{
	Rgb Primary;
	Rgb Secondary;
	Rgb Accent;
	/** Bare metal under chipped paint. */
	Rgb Bare;
};

constexpr int kLiveries = 4;

inline Livery LiveryOf(int Index)
{
	switch (((Index % kLiveries) + kLiveries) % kLiveries)
	{
	case 0: return Livery{Rgb{0.20, 0.23, 0.28}, Rgb{0.34, 0.37, 0.42}, Rgb{0.80, 0.30, 0.06}, Rgb{0.50, 0.50, 0.52}};
	case 1: return Livery{Rgb{0.62, 0.63, 0.60}, Rgb{0.44, 0.46, 0.46}, Rgb{0.66, 0.08, 0.06}, Rgb{0.55, 0.55, 0.56}};
	case 2: return Livery{Rgb{0.10, 0.11, 0.13}, Rgb{0.19, 0.20, 0.23}, Rgb{0.05, 0.62, 0.75}, Rgb{0.42, 0.43, 0.45}};
	default: return Livery{Rgb{0.40, 0.31, 0.19}, Rgb{0.28, 0.23, 0.16}, Rgb{0.84, 0.64, 0.08}, Rgb{0.52, 0.5, 0.46}};
	}
}

struct HullMaps
{
	/** sRGB base colour. */
	Image BaseColor;
	/** Tangent-space normal, stored as n * 0.5 + 0.5 in R, G, B (linear: no sRGB). */
	Image Normal;
	/** R = ambient occlusion, G = roughness, B = metallic (linear). */
	Image Orm;
};


/**
 * The maps of a ship's metal, `Size` px square (2048 is a good size), tiling every `kHullTile` metres. The tile is 8 x 8
 * big plates of 75 cm; each is whole, or split in two or in four, and most are plain with a seam and rivets; some are
 * hatches, vents, split plates, dark insets or (rarely) hazard stripes. The paint is in blocks of two colours with a thin
 * accent line, mottled, streaked with grime that gathers in the seams, scratched, and chipped to bare metal at the edges.
 */
inline HullMaps MakeHullMaps(int Size, uint32_t Seed, const Livery& Paint, unsigned Threads = 0U)
{
	const int N = std::max(64, Size);
	constexpr int kBig = 8;
	const double BigPx = static_cast<double>(N) / kBig;
	const double PxToTile = 1.0 / static_cast<double>(N);
	const double Scale = static_cast<double>(N) / 2048.0;
	HullMaps Maps;
	Maps.BaseColor = Image(N, N);
	Maps.Normal = Image(N, N);
	Maps.Orm = Image(N, N);
	std::vector<float> Height(static_cast<size_t>(N) * static_cast<size_t>(N), 0.0F);
	ParallelRows(
		N,
		[&](int Py) {
			for (int Px = 0; Px < N; ++Px)
			{
				const double U = (static_cast<double>(Px) + 0.5) * PxToTile;
				const double V = (static_cast<double>(Py) + 0.5) * PxToTile;
				const double Bu = U * kBig;
				const double Bv = V * kBig;
				const int Ci = static_cast<int>(std::floor(Bu));
				const int Cj = static_cast<int>(std::floor(Bv));
				const double Fx = Bu - Ci;
				const double Fy = Bv - Cj;
				const double H1 = Hash01(static_cast<uint32_t>(Ci), static_cast<uint32_t>(Cj), Seed + 3U);
				// Whole, two columns, two rows or four.
				const int Nx = (H1 < 0.30 || (H1 >= 0.60 && H1 < 0.80)) ? 1 : 2;
				const int Ny = (H1 < 0.30 || (H1 >= 0.30 && H1 < 0.60)) ? 1 : 2;
				const double Sx = Fx * Nx;
				const double Sy = Fy * Ny;
				const int Si = static_cast<int>(std::floor(Sx));
				const int Sj = static_cast<int>(std::floor(Sy));
				const double Lx = Sx - Si;
				const double Ly = Sy - Sj;
				const double WPx = BigPx / Nx;
				const double HPx = BigPx / Ny;
				const double Dl = Lx * WPx;
				const double Dr = (1.0 - Lx) * WPx;
				const double Dt = Ly * HPx;
				const double Db = (1.0 - Ly) * HPx;
				const double Edge = std::min(std::min(Dl, Dr), std::min(Dt, Db));
				const uint32_t Pid = static_cast<uint32_t>(Ci * 31 + Si) * 977U + static_cast<uint32_t>(Cj * 17 + Sj);
				const double H = Hash01(Pid, Seed + 5U, 1U);
				const double H2 = Hash01(Pid, Seed + 9U, 2U);
				// A seam is a narrow groove with a raised lip; the big plates' seams are deeper than the small ones'.
				const double Big = (Edge <= std::min(std::min(Fx * BigPx, (1.0 - Fx) * BigPx), std::min(Fy * BigPx, (1.0 - Fy) * BigPx)) + 0.5) ? 1.0 : 0.0;
				const double Groove = Bump(Edge, 1.4 * Scale) * (0.75 + 0.35 * Big);
				const double Lip = Bump(Edge - 2.8 * Scale, 2.0 * Scale);
				double Height_ = -1.0 * Groove + 0.16 * Lip;
				double Ao = 1.0 - 0.55 * Bump(Edge, 4.2 * Scale) * (0.7 + 0.4 * Big);
				double Stripe = 0.0;
				double Dark = 0.0;
				double RivetD = 1e9;
				const double MinSide = std::min(WPx, HPx);
				if (H < 0.08)
				{
					// A hatch: an inset panel with its own border, four bolts and a handle.
					const double M = 0.15 * MinSide;
					const double Hd = std::min(std::min(Dl - M, Dr - M), std::min(Dt - M, Db - M));
					if (Hd > 0.0)
					{
						Height_ -= 0.26;
						Ao -= 0.05;
					}
					Height_ -= 0.6 * Bump(Hd, 1.2 * Scale);
					Ao -= 0.35 * Bump(Hd, 3.2 * Scale);
					const double Bx = std::min(std::fabs(Dl - M * 1.9), std::fabs(Dr - M * 1.9));
					const double By = std::min(std::fabs(Dt - M * 1.9), std::fabs(Db - M * 1.9));
					RivetD = std::sqrt(Bx * Bx + By * By);
					const double Cx = std::fabs(Lx - 0.5) * WPx;
					const double Cy = std::fabs(Ly - 0.5) * HPx;
					Height_ += 0.5 * std::exp(-(Cy * Cy) / (9.0 * Scale * Scale * 4.0)) * (Cx < 0.16 * MinSide ? 1.0 : 0.0);
				}
				else if (H < 0.16)
				{
					// A vent: slits.
					const double M = 0.12 * MinSide;
					if (Dl > M && Dr > M && Dt > M * 1.2 && Db > M * 1.2)
					{
						const double Slot = std::fabs(std::fmod(Ly * 9.0, 1.0) - 0.5);
						const double In = Smoothstep(0.32, 0.24, Slot);
						Height_ -= 0.9 * In;
						Ao -= 0.5 * In;
						Dark = In;
					}
				}
				else if (H < 0.24)
				{
					// A split plate: one more seam through the middle.
					const double Sd = H2 < 0.5 ? std::fabs(Lx - 0.5) * WPx : std::fabs(Ly - 0.5) * HPx;
					Height_ -= 0.8 * Bump(Sd, 1.3 * Scale);
					Ao -= 0.45 * Bump(Sd, 3.6 * Scale);
				}
				else if (H < 0.27)
				{
					const double D = std::fmod((Lx + Ly) * 5.0, 1.0);
					Stripe = Smoothstep(0.46, 0.5, D) * Smoothstep(1.0, 0.96, D);
				}
				else if (H < 0.38)
				{
					Height_ -= 0.14;
					Dark = 0.5;
					Ao -= 0.08;
				}
				if (H >= 0.08 || RivetD > 1e8)
				{
					if (H >= 0.08)
					{
						const double Sp = 17.0 * Scale;
						const double Off = 7.0 * Scale;
						double Best = 1e9;
						const auto Along = [&](double Along_, double Across) {
							const double K = std::round((Along_ - Sp * 0.5) / Sp);
							const double Dx = Along_ - (Sp * 0.5 + K * Sp);
							const double Dy = Across - Off;
							Best = std::min(Best, std::sqrt(Dx * Dx + Dy * Dy));
						};
						Along(Lx * WPx, Dt);
						Along(Lx * WPx, Db);
						Along(Ly * HPx, Dl);
						Along(Ly * HPx, Dr);
						RivetD = std::min(RivetD, Best);
					}
				}
				const double Rivet = Bump(RivetD, 2.2 * Scale);
				Height_ += 0.7 * Rivet;
				Ao -= 0.22 * Bump(RivetD - 3.0 * Scale, 1.5 * Scale);

				// Paint: blocks of two colours, plate-to-plate shade, a thin accent line, rarely a hazard panel.
				const double Block = Hash01(static_cast<uint32_t>(Ci / 2), static_cast<uint32_t>(Cj / 2), Seed + 21U);
				Rgb Base = Block < 0.6 ? Paint.Primary : Paint.Secondary;
				Base = Base * (0.90 + 0.20 * H2);
				const double Mottle = PFbm(U, V, 3, 3, 4, Seed + 33U);
				Base = Base * (1.0 + 0.16 * Mottle);
				const bool bLine = (Cj % 8) == 3 && Fy > 0.42 && Fy < 0.50;
				const bool bHair = (Cj % 4) == 0 && Fy < 0.0 + 3.0 / BigPx;
				if (bLine)
				{
					Base = Paint.Accent;
				}
				else if (bHair)
				{
					Base = LerpRgb(Base, Paint.Accent, 0.55);
				}
				if (Stripe > 0.5)
				{
					Base = Paint.Accent;
				}
				else if (H >= 0.24 && H < 0.27)
				{
					Base = Rgb{0.04, 0.04, 0.04};
				}
				if (Dark > 0.0)
				{
					Base = LerpRgb(Base, Rgb{0.02, 0.022, 0.026}, Dark);
				}
				// Weathering.
				const double Blotch = 0.5 + 0.5 * PFbm(U, V, 6, 6, 5, Seed + 31U);
				const double Streak = 0.5 + 0.5 * PFbm(U, V, 64, 4, 3, Seed + 41U);
				double Grime = Smoothstep(0.55, 1.0, Blotch * 0.75 + Streak * 0.45);
				Grime = Clamp01(Grime * 0.7 + 0.5 * Bump(Edge, 5.0 * Scale) * Streak);
				const double Fine = PFbm(U, V, 64, 64, 3, Seed + 51U);
				const double Brush = PNoise(U * 700.0, V * 6.0, 700, 6, Seed + 52U);
				const double Scr1 = std::pow(Clamp01(1.0 - std::fabs(PNoise(U * 220.0, V * 7.0, 220, 7, Seed + 61U)) * 7.0), 5.0) * Smoothstep(0.05, 0.35, PNoise(U * 5.0, V * 5.0, 5, 5, Seed + 62U));
				const double Scr2 = std::pow(Clamp01(1.0 - std::fabs(PNoise(U * 7.0, V * 200.0, 7, 200, Seed + 63U)) * 7.0), 5.0) * Smoothstep(0.10, 0.40, PNoise(U * 4.0, V * 4.0, 4, 4, Seed + 64U));
				const double Scratch = Clamp01(Scr1 + Scr2);
				const double ChipN = 0.5 + 0.5 * PFbm(U, V, 32, 32, 4, Seed + 71U);
				const double Chip = Smoothstep(0.55, 0.70, ChipN + 0.55 * Bump(Edge, 4.0 * Scale)) * Smoothstep(8.0 * Scale, 0.0, Edge);
				const double Bare = Clamp01(Chip * 0.85 + Scratch * 0.8);
				Height_ += -0.25 * Scratch + 0.05 * Fine + 0.012 * Brush;
				Base = Base * (1.0 - 0.55 * Grime);
				Base = LerpRgb(Base, Paint.Bare * (0.75 + 0.35 * Fine), Bare);
				Ao = Clamp01(Ao - 0.25 * Grime);
				const double Rough = Clamp01(Lerp(0.36 + 0.10 * Fine, 0.80, Grime) * (1.0 - Bare) + 0.30 * Bare + 0.08 * Dark + 0.03 * Brush);
				const double Metal = Clamp01(0.05 + 0.95 * Bare);
				AetherSky::PutDithered(Maps.BaseColor, Px, Py, Base.R * (0.92 + 0.08 * Ao), Base.G * (0.92 + 0.08 * Ao), Base.B * (0.92 + 0.08 * Ao));
				const size_t O = Maps.Orm.Offset(Px, Py);
				// ORM: R = occlusion, G = roughness, B = metallic. Linear bytes, in B, G, R order for the BGRA image.
				Maps.Orm.Bgra[O + 0] = static_cast<uint8_t>(std::lround(Clamp01(Metal) * 255.0));
				Maps.Orm.Bgra[O + 1] = static_cast<uint8_t>(std::lround(Clamp01(Rough) * 255.0));
				Maps.Orm.Bgra[O + 2] = static_cast<uint8_t>(std::lround(Clamp01(Ao) * 255.0));
				Maps.Orm.Bgra[O + 3] = 255;
				Height[static_cast<size_t>(Py) * static_cast<size_t>(N) + static_cast<size_t>(Px)] = static_cast<float>(Height_);
			}
		},
		Threads);
	// Normals from the height, wrapping at the tile's edges: n = (-dh/dU, -dh/dV, 1) with U along the columns, V down the rows.
	constexpr double Strength = 1.6;
	ParallelRows(
		N,
		[&](int Py) {
			const int Y0 = (Py + N - 1) % N;
			const int Y1 = (Py + 1) % N;
			for (int Px = 0; Px < N; ++Px)
			{
				const int X0 = (Px + N - 1) % N;
				const int X1 = (Px + 1) % N;
				const auto At = [&](int X, int Y) { return static_cast<double>(Height[static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(X)]); };
				const double Dx = (At(X1, Py) - At(X0, Py)) * 0.5 * Strength;
				const double Dy = (At(Px, Y1) - At(Px, Y0)) * 0.5 * Strength;
				const Vec3 Nrm = Normalized(Vec3{-Dx, -Dy, 1.0});
				const size_t O = Maps.Normal.Offset(Px, Py);
				Maps.Normal.Bgra[O + 0] = static_cast<uint8_t>(std::lround((Nrm.Z * 0.5 + 0.5) * 255.0));
				Maps.Normal.Bgra[O + 1] = static_cast<uint8_t>(std::lround((Nrm.Y * 0.5 + 0.5) * 255.0));
				Maps.Normal.Bgra[O + 2] = static_cast<uint8_t>(std::lround((Nrm.X * 0.5 + 0.5) * 255.0));
				Maps.Normal.Bgra[O + 3] = 255;
			}
		},
		Threads);
	return Maps;
}
} // namespace AetherShip
