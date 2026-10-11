// Asteroids made in code: a displaced, cratered icosphere (lumps, ridges, fine grit, bowls with raised rims) with pictures
// laid by box projection, occlusion baked into the vertex colour, and the tileable PBR maps the rock wears (four kinds:
// dark carbonaceous, grey silicate, rusty iron, dirty ice). No Unreal types, a function of the seed: the viewer hands the
// arrays to a procedural mesh; tests/rock_core_test.cpp checks them; tests/rock_preview.cpp renders them.
#pragma once

#include "AetherMeshMath.h"

#include <map>

namespace AetherRock
{
using namespace AetherMesh;
using AetherSky::Fbm3;
using AetherSky::ParallelRows;
using AetherSky::Perlin3;
using AetherSky::Ridged3;
using AetherSpace::Image;
using AetherSpace::Rng;

enum class RockKind : uint8_t
{
	Carbon,
	Silicate,
	Iron,
	Ice,
};
constexpr int kRockKinds = 4;

struct RockSpec
{
	uint32_t Seed = 1U;
	/** Subdivisions of the icosahedron: 3 = 1,280 faces, 4 = 5,120, 5 = 20,480. */
	int Detail = 4;
	/** 0 = a smooth pebble, 1 = as designed, 2 = jagged. */
	double Roughness = 1.0;
	/** How stretched the whole rock is (1 = a ball, up to 2 = a potato). */
	double Elongation = 1.4;
	/** How many craters (before Roughness). */
	int Craters = 7;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* The shape                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

namespace
{
struct Crater
{
	Vec3 Dir;
	double Radius; // angular, radians
	double Depth;  // fraction of the unit radius
};

struct Facet
{
	Vec3 Normal;
	double Distance; // of the cutting plane from the middle, in unit radii
};

struct Shape
{
	uint32_t Seed;
	double Rough;
	Vec3 Scale;
	std::vector<Crater> Craters;
	std::vector<Facet> Facets;

	Shape(const RockSpec& S) : Seed(S.Seed), Rough(AetherSpace::Clamp(S.Roughness, 0.0, 3.0))
	{
		Rng R(S.Seed * 2654435761U + 17U);
		const double E = AetherSpace::Clamp(S.Elongation, 1.0, 3.0);
		// A potato: one long axis, the others near 1 (the volume stays about the same).
		const double A = std::pow(E, 0.66);
		Scale = Vec3{A * R.Range(0.9, 1.1), R.Range(0.85, 1.05) / std::sqrt(A), R.Range(0.8, 1.0) / std::sqrt(A)};
		const int Count = std::max(0, static_cast<int>(std::lround(S.Craters * (0.6 + 0.4 * Rough))));
		for (int I = 0; I < Count; ++I)
		{
			// A few big old craters, many small young ones.
			const double Rad = I < 2 ? R.Range(0.28, 0.46) : (I < 5 ? R.Range(0.14, 0.26) : R.Range(0.06, 0.14));
			Craters.push_back(Crater{R.Unit(), Rad, Rad * R.Range(0.30, 0.55)});
		}
		// Flat faces where pieces broke off: the plane cuts a ball of radius ~1.
		const int Cuts = static_cast<int>(std::lround(5.0 * Rough));
		for (int I = 0; I < Cuts; ++I)
		{
			Facets.push_back(Facet{R.Unit(), R.Range(0.62, 0.86)});
		}
	}

	/** Surface height at unit direction D: the radius, and (in `Detail`) how far it is above or below its smooth shape. */
	double Radius(const Vec3& D, double* Detail = nullptr) const
	{
		const double Lump = Fbm3(D.X * 1.4, D.Y * 1.4, D.Z * 1.4, 3, Seed + 1U);
		const double Mid = Fbm3(D.X * 3.8, D.Y * 3.8, D.Z * 3.8, 4, Seed + 2U);
		const double Ridge = Ridged3(D.X * 2.6, D.Y * 2.6, D.Z * 2.6, 3, Seed + 3U);
		const double Grit = Fbm3(D.X * 13.0, D.Y * 13.0, D.Z * 13.0, 4, Seed + 4U);
		const double Fine = Fbm3(D.X * 32.0, D.Y * 32.0, D.Z * 32.0, 3, Seed + 5U);
		double R = 1.0 + 0.22 * Lump + 0.11 * Rough * Mid + 0.09 * Rough * (Ridge - 0.45) + 0.03 * Rough * Grit + 0.010 * Rough * Fine;
		// The ellipsoid (the potato) scales the direction first, so cut the planes on the scaled shape.
		for (const Facet& F : Facets)
		{
			const double Dn = Dot(D, F.Normal);
			if (Dn > 1e-3)
			{
				// Soft minimum: the plane flattens the rock but its edges are not razor sharp.
				const double Cut = F.Distance / Dn;
				const double K = 0.03;
				const double H = Clamp01(0.5 + 0.5 * (Cut - R) / K);
				R = Lerp(Cut, R, H) - K * H * (1.0 - H);
			}
		}
		double Cr = 0.0;
		for (const Crater& C : Craters)
		{
			const double Ang = std::acos(AetherSpace::Clamp(Dot(D, C.Dir), -1.0, 1.0));
			const double T = Ang / C.Radius;
			if (T < 1.7)
			{
				// A bowl with a flatter floor, a raised rim just outside it, and ejecta fading out.
				const double Bowl = (1.0 - AetherSpace::Smoothstep(0.0, 1.0, T));
				const double Rim = std::exp(-((T - 1.0) / 0.2) * ((T - 1.0) / 0.2));
				Cr += -C.Depth * AetherSpace::Smoothstep(0.0, 0.5, Bowl) * (0.7 + 0.3 * Bowl) + C.Depth * 0.4 * Rim;
			}
		}
		R += Cr;
		if (Detail != nullptr)
		{
			*Detail = 0.11 * Rough * Mid + 0.03 * Rough * Grit + Cr;
		}
		return R;
	}
};

struct Icosphere
{
	std::vector<Vec3> V;
	std::vector<uint32_t> F; // triples

	explicit Icosphere(int Subdiv)
	{
		const double T = (1.0 + std::sqrt(5.0)) * 0.5;
		const Vec3 Base[12] = {{-1, T, 0}, {1, T, 0}, {-1, -T, 0}, {1, -T, 0}, {0, -1, T}, {0, 1, T}, {0, -1, -T}, {0, 1, -T}, {T, 0, -1}, {T, 0, 1}, {-T, 0, -1}, {-T, 0, 1}};
		for (const Vec3& B : Base)
		{
			V.push_back(Normalized(B));
		}
		const uint32_t Faces[60] = {0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
									3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1};
		F.assign(Faces, Faces + 60);
		for (int S = 0; S < Subdiv; ++S)
		{
			std::map<std::pair<uint32_t, uint32_t>, uint32_t> Mid;
			const auto Midpoint = [&](uint32_t A, uint32_t B) {
				const std::pair<uint32_t, uint32_t> Key{std::min(A, B), std::max(A, B)};
				const auto It = Mid.find(Key);
				if (It != Mid.end())
				{
					return It->second;
				}
				V.push_back(Normalized((V[A] + V[B]) * 0.5));
				return Mid[Key] = static_cast<uint32_t>(V.size() - 1U);
			};
			std::vector<uint32_t> Next;
			for (size_t I = 0; I < F.size(); I += 3U)
			{
				const uint32_t A = F[I];
				const uint32_t B = F[I + 1U];
				const uint32_t C = F[I + 2U];
				const uint32_t Ab = Midpoint(A, B);
				const uint32_t Bc = Midpoint(B, C);
				const uint32_t Ca = Midpoint(C, A);
				for (const uint32_t T4 : {A, Ab, Ca, B, Bc, Ab, C, Ca, Bc, Ab, Bc, Ca})
				{
					Next.push_back(T4);
				}
			}
			F = std::move(Next);
		}
	}
};
} // namespace

/**
 * An asteroid of unit radius (scale it). One section: the rock, with box-projected pictures at `Tile` units to a
 * repeat (1.2 is about the whole rock once), and vertex colours that carry the baked occlusion (dark in bowls and
 * crevices) and a mottled tint.
 */
inline Section MakeAsteroid(const RockSpec& Spec, double Tile = 1.2)
{
	const Shape Sh(Spec);
	const Icosphere Ico(std::max(0, std::min(6, Spec.Detail)));
	// The radius and the detail of each shared vertex, once.
	std::vector<Vec3> P(Ico.V.size());
	std::vector<double> Det(Ico.V.size());
	for (size_t I = 0; I < Ico.V.size(); ++I)
	{
		double D = 0.0;
		const double R = Sh.Radius(Ico.V[I], &D);
		P[I] = Vec3{Ico.V[I].X * R * Sh.Scale.X, Ico.V[I].Y * R * Sh.Scale.Y, Ico.V[I].Z * R * Sh.Scale.Z};
		Det[I] = D;
	}
	// Re-centre on the middle of the box and fit the longest reach to about 1.
	Vec3 Lo{1e30, 1e30, 1e30};
	Vec3 Hi{-1e30, -1e30, -1e30};
	for (const Vec3& V : P)
	{
		Lo = Vec3{std::min(Lo.X, V.X), std::min(Lo.Y, V.Y), std::min(Lo.Z, V.Z)};
		Hi = Vec3{std::max(Hi.X, V.X), std::max(Hi.Y, V.Y), std::max(Hi.Z, V.Z)};
	}
	const Vec3 Mid = (Lo + Hi) * 0.5;
	double Reach = 1e-9;
	for (const Vec3& V : P)
	{
		Reach = std::max(Reach, Length(V - Mid));
	}
	for (Vec3& V : P)
	{
		V = (V - Mid) * (1.0 / Reach);
	}
	Section S;
	const uint32_t Group = 1U;
	for (size_t F = 0; F + 2U < Ico.F.size(); F += 3U)
	{
		const uint32_t I0 = Ico.F[F];
		const uint32_t I1 = Ico.F[F + 1U];
		const uint32_t I2 = Ico.F[F + 2U];
		// The icosahedron is wound counter-clockwise from outside: flip to our (b - a) x (c - a) outward rule when needed.
		Vec3 N = Cross(P[I1] - P[I0], P[I2] - P[I0]);
		const Vec3 C = (P[I0] + P[I1] + P[I2]) * (1.0 / 3.0);
		const bool bFlip = Dot(N, C) < 0.0;
		const uint32_t Ids[3] = {I0, bFlip ? I2 : I1, bFlip ? I1 : I2};
		N = Cross(P[Ids[1]] - P[Ids[0]], P[Ids[2]] - P[Ids[0]]);
		// Box projection along the dominant axis of the direction from the middle of the rock (a cube map: the seams are the cube's
		// twelve edges, not a scatter of triangles that happen to face another way); T x B = N for each of the six.
		const Vec3 Fn = Normalized(C);
		const double Ax = std::fabs(Fn.X);
		const double Ay = std::fabs(Fn.Y);
		const double Az = std::fabs(Fn.Z);
		const uint32_t Base = static_cast<uint32_t>(S.Pos.size());
		for (const uint32_t Id : Ids)
		{
			const Vec3& Q = P[Id];
			Vec2 Uv;
			if (Ax >= Ay && Ax >= Az)
			{
				Uv = Fn.X >= 0.0 ? Vec2{Q.Y, Q.Z} : Vec2{-Q.Y, Q.Z};
			}
			else if (Ay >= Az)
			{
				Uv = Fn.Y >= 0.0 ? Vec2{Q.Z, Q.X} : Vec2{-Q.Z, Q.X};
			}
			else
			{
				Uv = Fn.Z >= 0.0 ? Vec2{Q.X, Q.Y} : Vec2{-Q.X, Q.Y};
			}
			Uv.U /= Tile;
			Uv.V /= Tile;
			// Baked occlusion from how far below its smooth shape the surface lies, and a slow mottle of tint.
			const double Ao = 0.55 + 0.45 * AetherSpace::Smoothstep(-0.09, 0.05, Det[Id]);
			const double Mottle = 0.9 + 0.2 * (0.5 + 0.5 * Fbm3(Q.X * 2.2, Q.Y * 2.2, Q.Z * 2.2, 3, Spec.Seed + 9U));
			const double T = Ao * Mottle;
			S.AddVertex(Q, Uv, Rgb{T, T, T}, Group);
		}
		S.AddTri(Base, Base + 1U, Base + 2U);
	}
	Finish(S);
	return S;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The rock: tileable PBR maps                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

struct RockMaps
{
	/** sRGB base colour. */
	Image BaseColor;
	/** Tangent-space normal, n * 0.5 + 0.5 (linear). */
	Image Normal;
	/** R = occlusion, G = roughness, B = metallic (linear). */
	Image Orm;
};

inline Rgb RockTint(RockKind K)
{
	switch (K)
	{
	case RockKind::Carbon: return Rgb{0.075, 0.07, 0.065};
	case RockKind::Silicate: return Rgb{0.17, 0.162, 0.150};
	case RockKind::Iron: return Rgb{0.28, 0.15, 0.085};
	default: return Rgb{0.62, 0.68, 0.72};
	}
}

/**
 * The maps of a rock surface, `Size` px square, tiling once over a rock (see MakeAsteroid's Tile): lumps, ridged cracks,
 * pits, small craters with rims, dust gathered in the low places, thin mineral veins, speckle.
 */
inline RockMaps MakeRockMaps(int Size, uint32_t Seed, RockKind Kind, unsigned Threads = 0U)
{
	const int N = std::max(64, Size);
	const double Inv = 1.0 / static_cast<double>(N);
	RockMaps Maps;
	Maps.BaseColor = Image(N, N);
	Maps.Normal = Image(N, N);
	Maps.Orm = Image(N, N);
	const Rgb Tint = RockTint(Kind);
	const Rgb Dust = Kind == RockKind::Ice ? Rgb{0.78, 0.82, 0.86} : (Kind == RockKind::Iron ? Rgb{0.42, 0.27, 0.17} : Rgb{0.36, 0.32, 0.26});
	const Rgb Vein = Kind == RockKind::Ice ? Rgb{0.9, 0.95, 1.0} : (Kind == RockKind::Iron ? Rgb{0.55, 0.52, 0.5} : (Kind == RockKind::Carbon ? Rgb{0.2, 0.19, 0.18} : Rgb{0.7, 0.68, 0.62}));
	std::vector<float> Height(static_cast<size_t>(N) * static_cast<size_t>(N), 0.0F);
	ParallelRows(
		N,
		[&](int Py) {
			for (int Px = 0; Px < N; ++Px)
			{
				const double U = (static_cast<double>(Px) + 0.5) * Inv;
				const double V = (static_cast<double>(Py) + 0.5) * Inv;
				// Warp the lookup so cells and cracks are not honeycombs.
				const double Wu = U + 0.012 * PFbm(U, V, 6, 6, 3, Seed + 11U);
				const double Wv = V + 0.012 * PFbm(U, V, 6, 6, 3, Seed + 12U);
				const double Lump = PFbm(U, V, 3, 3, 4, Seed + 1U);
				const double Rock = PFbm(U, V, 8, 8, 6, Seed + 2U);
				const double Ridge = 1.0 - std::fabs(PFbm(U, V, 12, 12, 4, Seed + 3U)) * 2.0;
				const double Grit = PFbm(U, V, 128, 128, 3, Seed + 4U);
				const double Grain = PFbm(U, V, 256, 256, 2, Seed + 14U);
				// Cracks: the edges between large cells, and a finer network, each broken up by noise.
				double Id1 = 0.0;
				double F2a = 0.0;
				const double F1a = PWorley(Wu, Wv, 7, Seed + 5U, &Id1, &F2a);
				double Id2 = 0.0;
				double F2b = 0.0;
				const double F1b = PWorley(Wu, Wv, 19, Seed + 6U, &Id2, &F2b);
				const double Break1 = AetherSpace::Smoothstep(-0.15, 0.35, PFbm(U, V, 5, 5, 3, Seed + 15U));
				const double Break2 = AetherSpace::Smoothstep(-0.1, 0.4, PFbm(U, V, 9, 9, 3, Seed + 16U));
				const double CrackA = AetherSpace::Smoothstep(0.075, 0.0, F2a - F1a) * Break1;
				const double CrackB = AetherSpace::Smoothstep(0.06, 0.0, F2b - F1b) * Break2 * 0.7;
				const double Crack = Kind == RockKind::Ice ? std::max(CrackA * 0.6, CrackB * 0.4) : std::max(CrackA, CrackB);
				// Plates: each big cell sits a little higher or lower than its neighbours.
				const double Plate = (Id1 - 0.5) * 0.28;
				// Craters: a few, with a rim; pits: scattered, irregular, of many sizes.
				double Cid = 0.0;
				const double Fc = PWorley(Wu, Wv, 4, Seed + 7U, &Cid);
				double Cr = 0.0;
				if (Cid > 0.35)
				{
					const double Rad = 0.22 + 0.25 * Cid;
					const double T = Fc / Rad;
					const double Bowl = 1.0 - AetherSpace::Smoothstep(0.0, 1.0, T);
					Cr = -0.9 * AetherSpace::Smoothstep(0.0, 0.6, Bowl) * (0.75 + 0.25 * Bowl) + 0.4 * Bump(T - 1.05, 0.16);
				}
				double Pid = 0.0;
				const double Fp = PWorley(Wu, Wv, 17, Seed + 8U, &Pid);
				const double PitMask = AetherSpace::Smoothstep(0.1, 0.55, 0.5 + 0.5 * PFbm(U, V, 7, 7, 3, Seed + 17U)) * (Pid > 0.55 ? 1.0 : 0.0);
				const double Pit = AetherSpace::Smoothstep(0.05 + 0.2 * Pid, 0.0, Fp) * PitMask;
				const double Cracks = Kind == RockKind::Ice ? 0.6 : 1.0;
				const double Low_ = 0.5 * Lump + 0.3 * Rock + Plate;
				const double H = Low_ + 0.2 * (Ridge - 0.4) * (0.4 + 0.6 * Rock) + 0.11 * Grit + 0.035 * Grain - 0.5 * Pit + Cr - 0.55 * Cracks * Crack;
				Height[static_cast<size_t>(Py) * static_cast<size_t>(N) + static_cast<size_t>(Px)] = static_cast<float>(H);

				const double Patch = 0.5 + 0.5 * PFbm(U, V, 5, 5, 5, Seed + 7U + 40U);
				Rgb Base = Tint * (0.55 + 0.9 * Patch) * (0.85 + 0.3 * (Id1));
				Base = Base * (1.0 - 0.4 * Pit - 0.5 * Crack);
				// Dust collects in the low places and in the bowls.
				const double DustAmt = AetherSpace::Smoothstep(0.0, -0.6, Low_ + 0.7 * Cr) * (Kind == RockKind::Ice ? 0.22 : 0.30) * (0.5 + 0.8 * Patch);
				Base = AetherSky::LerpRgb(Base, Dust, DustAmt);
				// Veins: thin lines where a second noise allows them, brighter on raised grain.
				const double VeinLine = std::pow(std::max(0.0, 1.0 - std::fabs(PNoise(Wu * 7.0, Wv * 7.0, 7, 7, Seed + 18U)) * 14.0), 4.0) * AetherSpace::Smoothstep(0.1, 0.5, PNoise(U * 3.0, V * 3.0, 3, 3, Seed + 19U));
				Base = AetherSky::LerpRgb(Base, Vein, Clamp01(VeinLine) * 0.4);
				// Grains: bright and dark crystals.
				const double Speck = AetherSpace::Smoothstep(0.6, 0.9, 0.5 + 0.5 * PNoise(U * 480.0, V * 480.0, 480, 480, Seed + 20U));
				const double Dim = AetherSpace::Smoothstep(0.6, 0.9, 0.5 + 0.5 * PNoise(U * 330.0, V * 330.0, 330, 330, Seed + 21U));
				Base = Base * (1.0 + 0.45 * Speck - 0.3 * Dim);
				const double Ao = Clamp01(0.55 + 0.45 * AetherSpace::Smoothstep(-0.6, 0.35, Low_ + 0.5 * Cr) - 0.2 * Pit - 0.35 * Crack);
				const double Rough = Clamp01((Kind == RockKind::Ice ? 0.5 : 0.88) + 0.1 * Grit - 0.12 * VeinLine);
				const double Metal = Kind == RockKind::Iron ? Clamp01(0.12 + 0.55 * VeinLine + 0.25 * Speck) : 0.0;
				AetherSky::PutDithered(Maps.BaseColor, Px, Py, Base.R, Base.G, Base.B);
				const size_t O = Maps.Orm.Offset(Px, Py);
				Maps.Orm.Bgra[O + 0] = static_cast<uint8_t>(std::lround(Metal * 255.0));
				Maps.Orm.Bgra[O + 1] = static_cast<uint8_t>(std::lround(Rough * 255.0));
				Maps.Orm.Bgra[O + 2] = static_cast<uint8_t>(std::lround(Ao * 255.0));
				Maps.Orm.Bgra[O + 3] = 255;
			}
		},
		Threads);
	constexpr double Strength = 2.4;
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
				// The texel size shrinks as the picture grows: scale the slope so a 4K map is as bumpy as a 1K one.
				const double K = Strength * static_cast<double>(N) / 1024.0 * 0.5;
				const double Dx = (At(X1, Py) - At(X0, Py)) * K * 0.5;
				const double Dy = (At(Px, Y1) - At(Px, Y0)) * K * 0.5;
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
} // namespace AetherRock
