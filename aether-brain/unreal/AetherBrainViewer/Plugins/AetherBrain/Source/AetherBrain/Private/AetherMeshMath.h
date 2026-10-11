// Triangle meshes made in code, with no Unreal types: the ships and the asteroids of the Voyage are built from these, and
// the viewer hands the arrays to a procedural mesh component as they are.
//
// Conventions (so the host preview and Unreal agree):
//  - Unreal's axes: X forward, Y right, Z up, centimetres or metres as the caller chooses.
//  - A triangle (a, b, c) faces outward when (b - a) x (c - a) points out (that is Unreal's clockwise-from-the-front order).
//  - Every vertex has a tangent T = dP/dU, and the bitangent is N x T = dP/dV (a right-handed frame T, B, N), so Unreal's
//    own TangentY = N x T needs no flip. The V axis of a picture runs down its rows, as in Unreal.
//  - A normal map holds n = (-dh/dU, -dh/dV, 1), normalised and stored as (n * 0.5 + 0.5), the DirectX style Unreal uses.
//  - Textures tile; one UV unit is `Tile` metres on the surface, so panels keep their real size on a small ship and a big one.
//
// A mesh has a few Sections (one per material: hull, glass, light). Builders add raw triangles; Finish() makes the
// normals (smooth inside a "group" of vertices, flat between groups) and the tangents.
#pragma once

#include "AetherSkyMath.h"

#include <array>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace AetherMesh
{
using AetherSky::Rgb;
using AetherSpace::Clamp;
using AetherSpace::Clamp01;
using AetherSpace::Cross;
using AetherSpace::Dot;
using AetherSpace::Hash01;
using AetherSpace::Smoothstep;
using AetherSpace::kPi;
using AetherSpace::Length;
using AetherSpace::Lerp;
using AetherSpace::Normalized;
using AetherSpace::Quat;
using AetherSpace::Rotate;
using AetherSpace::Vec3;

struct Vec2
{
	double U = 0.0;
	double V = 0.0;
};

/** The material slots of a ship. */
enum class Zone : uint8_t
{
	/** Painted metal (the hull maps). */
	Hull = 0,
	/** Dark reflective glass. */
	Glass = 1,
	/** Emissive: engine plasma, running lights, windows (the vertex colour is the light). */
	Light = 2,
};
constexpr int kZones = 3;

struct Section
{
	std::vector<Vec3> Pos;
	std::vector<Vec3> Nrm;
	std::vector<Vec3> Tan;
	std::vector<Vec2> Uv;
	/** A tint (hull: multiplies the paint; light: the colour of the light). */
	std::vector<Rgb> Col;
	/** Vertices of one group share their normal where they are in the same place. */
	std::vector<uint32_t> Group;
	std::vector<uint32_t> Idx;

	uint32_t AddVertex(const Vec3& P, const Vec2& Uv_, const Rgb& C, uint32_t G)
	{
		Pos.push_back(P);
		Uv.push_back(Uv_);
		Col.push_back(C);
		Group.push_back(G);
		return static_cast<uint32_t>(Pos.size() - 1U);
	}
	void AddTri(uint32_t A, uint32_t B, uint32_t C)
	{
		Idx.push_back(A);
		Idx.push_back(B);
		Idx.push_back(C);
	}
	size_t Triangles() const { return Idx.size() / 3U; }
};

struct Mesh
{
	std::array<Section, kZones> Z;
	Section& operator[](Zone Zn) { return Z[static_cast<size_t>(Zn)]; }
	const Section& operator[](Zone Zn) const { return Z[static_cast<size_t>(Zn)]; }
	size_t Triangles() const
	{
		size_t N = 0;
		for (const Section& S : Z)
		{
			N += S.Triangles();
		}
		return N;
	}
	size_t Vertices() const
	{
		size_t N = 0;
		for (const Section& S : Z)
		{
			N += S.Pos.size();
		}
		return N;
	}
	void Bounds(Vec3& Lo, Vec3& Hi) const
	{
		Lo = Vec3{1e30, 1e30, 1e30};
		Hi = Vec3{-1e30, -1e30, -1e30};
		for (const Section& S : Z)
		{
			for (const Vec3& P : S.Pos)
			{
				Lo = Vec3{std::min(Lo.X, P.X), std::min(Lo.Y, P.Y), std::min(Lo.Z, P.Z)};
				Hi = Vec3{std::max(Hi.X, P.X), std::max(Hi.Y, P.Y), std::max(Hi.Z, P.Z)};
			}
		}
	}
};

/** A fresh group number for what a builder is about to add. */
class GroupCounter
{
public:
	uint32_t Next() { return ++N; }

private:
	uint32_t N = 0U;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Placing a part                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Adds `Src` (raw: no normals yet) to `Dst`, turned by Q, moved by T, and, when bMirrorY, reflected across the XZ plane
 * (the other side of a symmetrical ship): winding reversed so it still faces outward, U negated so the tangent frame
 * stays right-handed. Groups are renumbered from `Groups` so two parts never share a normal.
 */
inline void Append(Section& Dst, const Section& Src, const Quat& Q, const Vec3& T, bool bMirrorY, GroupCounter& Groups, double Scale = 1.0)
{
	const uint32_t Base = static_cast<uint32_t>(Dst.Pos.size());
	std::unordered_map<uint32_t, uint32_t> Renumber;
	for (size_t I = 0; I < Src.Pos.size(); ++I)
	{
		Vec3 P = Rotate(Q, Src.Pos[I] * Scale) + T;
		Vec2 Uv = Src.Uv[I];
		if (bMirrorY)
		{
			P.Y = -P.Y;
			Uv.U = -Uv.U;
		}
		auto It = Renumber.find(Src.Group[I]);
		if (It == Renumber.end())
		{
			It = Renumber.emplace(Src.Group[I], Groups.Next()).first;
		}
		Dst.AddVertex(P, Uv, Src.Col[I], It->second);
	}
	for (size_t I = 0; I + 2U < Src.Idx.size(); I += 3U)
	{
		if (bMirrorY)
		{
			Dst.AddTri(Base + Src.Idx[I], Base + Src.Idx[I + 2U], Base + Src.Idx[I + 1U]);
		}
		else
		{
			Dst.AddTri(Base + Src.Idx[I], Base + Src.Idx[I + 1U], Base + Src.Idx[I + 2U]);
		}
	}
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Surfaces: flat polygons                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The tangent and bitangent of a flat face with normal N, as near to `Ref` as it can be: T x B = N. */
inline void PlanarFrame(const Vec3& N, const Vec3& Ref, Vec3& T, Vec3& B)
{
	Vec3 R = Ref - N * Dot(Ref, N);
	if (Length(R) < 1e-6)
	{
		R = Vec3{0.0, 1.0, 0.0} - N * N.Y;
		if (Length(R) < 1e-6)
		{
			R = Vec3{1.0, 0.0, 0.0};
		}
	}
	T = Normalized(R);
	B = Cross(N, T);
}

/**
 * A flat, convex polygon wound to face outward, as a fan, its picture laid flat at the real scale from a random corner
 * of the tile (so two neighbouring faces do not show the same piece of paint).
 */
inline void AddPolygon(Section& S, const std::vector<Vec3>& P, const Rgb& Tint, double Tile, uint32_t Seed, GroupCounter& Groups, const Vec3& Ref = Vec3{1.0, 0.0, 0.0})
{
	if (P.size() < 3U)
	{
		return;
	}
	// Newell's method: the normal of a (nearly) flat polygon.
	Vec3 N{};
	for (size_t I = 0; I < P.size(); ++I)
	{
		const Vec3& A = P[I];
		const Vec3& B = P[(I + 1U) % P.size()];
		N.X += (A.Y - B.Y) * (A.Z + B.Z);
		N.Y += (A.Z - B.Z) * (A.X + B.X);
		N.Z += (A.X - B.X) * (A.Y + B.Y);
	}
	N = Normalized(N, Vec3{0.0, 0.0, 1.0});
	Vec3 T;
	Vec3 B;
	PlanarFrame(N, Ref, T, B);
	const double Ou = AetherSpace::Hash01(Seed, 11U, 3U) * 8.0;
	const double Ov = AetherSpace::Hash01(Seed, 12U, 4U) * 8.0;
	const uint32_t G = Groups.Next();
	const uint32_t First = static_cast<uint32_t>(S.Pos.size());
	for (const Vec3& V : P)
	{
		S.AddVertex(V, Vec2{Dot(V, T) / Tile + Ou, Dot(V, B) / Tile + Ov}, Tint, G);
	}
	for (uint32_t I = 1; I + 1U < P.size(); ++I)
	{
		S.AddTri(First, First + I, First + I + 1U);
	}
}

/** A box, axis-aligned in its own frame (place it with Append). */
inline Section MakeBox(const Vec3& Half, const Rgb& Tint, double Tile, uint32_t Seed, GroupCounter& Groups, const Vec3& Offset = Vec3{})
{
	Section S;
	const double X = Half.X;
	const double Y = Half.Y;
	const double Z = Half.Z;
	auto V = [&](double Sx, double Sy, double Sz) { return Vec3{Sx * X, Sy * Y, Sz * Z} + Offset; };
	// Each face listed so that (b - a) x (c - a) points out.
	AddPolygon(S, {V(1, -1, -1), V(1, 1, -1), V(1, 1, 1), V(1, -1, 1)}, Tint, Tile, Seed * 7U + 1U, Groups, Vec3{0.0, 1.0, 0.0});
	AddPolygon(S, {V(-1, 1, -1), V(-1, -1, -1), V(-1, -1, 1), V(-1, 1, 1)}, Tint, Tile, Seed * 7U + 2U, Groups, Vec3{0.0, 1.0, 0.0});
	AddPolygon(S, {V(-1, 1, -1), V(-1, 1, 1), V(1, 1, 1), V(1, 1, -1)}, Tint, Tile, Seed * 7U + 3U, Groups, Vec3{1.0, 0.0, 0.0});
	AddPolygon(S, {V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), V(-1, -1, -1)}, Tint, Tile, Seed * 7U + 4U, Groups, Vec3{1.0, 0.0, 0.0});
	AddPolygon(S, {V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1)}, Tint, Tile, Seed * 7U + 5U, Groups, Vec3{1.0, 0.0, 0.0});
	AddPolygon(S, {V(-1, 1, -1), V(1, 1, -1), V(1, -1, -1), V(-1, -1, -1)}, Tint, Tile, Seed * 7U + 6U, Groups, Vec3{1.0, 0.0, 0.0});
	return S;
}

/**
 * A slab with a plan outline (counter-clockwise seen from above, in X, Y) and a thickness that can differ at each corner
 * (bottom and top heights per corner): a wing, a fin, a plate. The sides lean as the heights say.
 */
inline Section MakeSlab(const std::vector<Vec2>& Plan, const std::vector<double>& Bottom, const std::vector<double>& Top, const Rgb& Tint, double Tile, uint32_t Seed, GroupCounter& Groups)
{
	Section S;
	const size_t N = Plan.size();
	if (N < 3U || Bottom.size() != N || Top.size() != N)
	{
		return S;
	}
	// Counter-clockwise seen from above (a clockwise outline is turned round).
	double Area = 0.0;
	for (size_t I = 0; I < N; ++I)
	{
		const Vec2& A = Plan[I];
		const Vec2& B = Plan[(I + 1U) % N];
		Area += A.U * B.V - B.U * A.V;
	}
	std::vector<Vec3> Up;
	std::vector<Vec3> Dn;
	for (size_t K = 0; K < N; ++K)
	{
		const size_t I = Area >= 0.0 ? K : N - 1U - K;
		Up.push_back(Vec3{Plan[I].U, Plan[I].V, Top[I]});
		Dn.push_back(Vec3{Plan[I].U, Plan[I].V, Bottom[I]});
	}
	AddPolygon(S, Up, Tint, Tile, Seed * 13U + 1U, Groups);
	std::vector<Vec3> Rev(Dn.rbegin(), Dn.rend());
	AddPolygon(S, Rev, Tint, Tile, Seed * 13U + 2U, Groups);
	for (size_t I = 0; I < N; ++I)
	{
		const size_t J = (I + 1U) % N;
		// Counter-clockwise from above: the outside of edge I -> J is to its right; this quad faces it.
		AddPolygon(S, {Dn[I], Dn[J], Up[J], Up[I]}, Tint, Tile, Seed * 13U + 3U + static_cast<uint32_t>(I), Groups);
	}
	return S;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Surfaces: lofts (hulls, nacelles, nozzles, domes)                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One cross-section of a loft along X: a superellipse (Exp 2 = ellipse, higher = squarer) in the YZ plane. */
struct Ring
{
	double X = 0.0;
	double Hw = 1.0;
	double Hh = 1.0;
	double Exp = 2.0;
	double Cy = 0.0;
	double Cz = 0.0;
};

/** A point of a ring at angle A (A = 0 at +Y, turning toward +Z). */
inline Vec3 RingPoint(const Ring& R, double A)
{
	const double C = std::cos(A);
	const double S = std::sin(A);
	const double E = 2.0 / std::max(0.5, R.Exp);
	const double Y = R.Hw * (C < 0.0 ? -1.0 : 1.0) * std::pow(std::fabs(C), E);
	const double Z = R.Hh * (S < 0.0 ? -1.0 : 1.0) * std::pow(std::fabs(S), E);
	return Vec3{R.X, R.Cy + Y, R.Cz + Z};
}

/**
 * A skin through rings along +X (at least two), smooth all the way round and along, with the picture laid at real scale
 * (U along the length, V round the skin by arc length). Optional flat end caps. A ring of zero size closes a nose.
 */
inline Section MakeLoft(const std::vector<Ring>& Rings, int Sides, bool bCapStart, bool bCapEnd, const Rgb& Tint, double Tile, uint32_t Seed, GroupCounter& Groups)
{
	Section S;
	const int N = std::max(6, Sides);
	const size_t R = Rings.size();
	if (R < 2U)
	{
		return S;
	}
	const uint32_t G = Groups.Next();
	const double Ou = AetherSpace::Hash01(Seed, 21U, 5U) * 8.0;
	const double Ov = AetherSpace::Hash01(Seed, 22U, 6U) * 8.0;
	std::vector<std::vector<Vec3>> Pts(R);
	for (size_t I = 0; I < R; ++I)
	{
		for (int J = 0; J <= N; ++J)
		{
			Pts[I].push_back(RingPoint(Rings[I], 2.0 * kPi * static_cast<double>(J) / static_cast<double>(N)));
		}
	}
	// V runs backward round the skin so that T x B = N for the winding below. The whole loft carries one whole number of repeats of
	// the picture round it (its mean perimeter over the tile, rounded): the picture meets itself at the seam, and neighbouring rings
	// agree, so panels do not shear where the hull swells and narrows.
	std::vector<std::vector<double>> V(R, std::vector<double>(static_cast<size_t>(N) + 1U, 0.0));
	double MeanPerimeter = 0.0;
	for (size_t I = 0; I < R; ++I)
	{
		for (int J = 1; J <= N; ++J)
		{
			MeanPerimeter += Length(Pts[I][static_cast<size_t>(J)] - Pts[I][static_cast<size_t>(J) - 1U]);
		}
	}
	MeanPerimeter /= static_cast<double>(R);
	const double Repeats = std::max(1.0, std::round(MeanPerimeter / Tile));
	for (size_t I = 0; I < R; ++I)
	{
		for (int J = 1; J <= N; ++J)
		{
			V[I][static_cast<size_t>(J)] = -Repeats * static_cast<double>(J) / static_cast<double>(N);
		}
	}
	double X0 = Rings[0].X;
	for (size_t I = 0; I < R; ++I)
	{
		for (int J = 0; J <= N; ++J)
		{
			S.AddVertex(Pts[I][static_cast<size_t>(J)], Vec2{(Rings[I].X - X0) / Tile + Ou, V[I][static_cast<size_t>(J)] + Ov}, Tint, G);
		}
	}
	const uint32_t Row = static_cast<uint32_t>(N) + 1U;
	for (size_t I = 0; I + 1U < R; ++I)
	{
		for (int J = 0; J < N; ++J)
		{
			const uint32_t A = static_cast<uint32_t>(I) * Row + static_cast<uint32_t>(J);
			const uint32_t B = A + Row;
			const uint32_t C = B + 1U;
			const uint32_t D = A + 1U;
			S.AddTri(A, D, C);
			S.AddTri(A, C, B);
		}
	}
	auto Cap = [&](size_t Index, bool bFront) {
		std::vector<Vec3> Ring2;
		for (int J = 0; J < N; ++J)
		{
			Ring2.push_back(Pts[Index][static_cast<size_t>(J)]);
		}
		if (!bFront)
		{
			std::reverse(Ring2.begin(), Ring2.end());
		}
		AddPolygon(S, Ring2, Tint, Tile, Seed * 17U + (bFront ? 1U : 2U), Groups, Vec3{0.0, 1.0, 0.0});
	};
	if (bCapEnd)
	{
		Cap(R - 1U, true);
	}
	if (bCapStart)
	{
		Cap(0U, false);
	}
	return S;
}

/** A tube from the origin along +X: a loft of circles. */
inline Section MakeTube(double Length_, double R0, double R1, int Sides, bool bCapStart, bool bCapEnd, const Rgb& Tint, double Tile, uint32_t Seed, GroupCounter& Groups, int Rings = 2)
{
	std::vector<Ring> Rs;
	const int K = std::max(2, Rings);
	for (int I = 0; I < K; ++I)
	{
		const double T = static_cast<double>(I) / static_cast<double>(K - 1);
		const double R = Lerp(R0, R1, T);
		Rs.push_back(Ring{Length_ * T, R, R, 2.0, 0.0, 0.0});
	}
	return MakeLoft(Rs, Sides, bCapStart, bCapEnd, Tint, Tile, Seed, Groups);
}

/** A flat disc facing +X at the origin (a nozzle's glowing throat, a light). */
inline Section MakeDisc(double Radius, int Sides, const Rgb& Tint, double Tile, uint32_t Seed, GroupCounter& Groups)
{
	Section S;
	std::vector<Vec3> P;
	for (int I = 0; I < std::max(6, Sides); ++I)
	{
		const double A = 2.0 * kPi * static_cast<double>(I) / static_cast<double>(std::max(6, Sides));
		P.push_back(Vec3{0.0, std::cos(A) * Radius, std::sin(A) * Radius});
	}
	AddPolygon(S, P, Tint, Tile, Seed, Groups, Vec3{0.0, 1.0, 0.0});
	return S;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Normals and tangents                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Makes Nrm and Tan for every vertex of a section. Normals are the area-weighted sum of the faces round a vertex, shared
 * with the vertices of the same group in the same place (a seam smooths, a part's edge stays sharp). Tangents come from
 * the picture's own direction.
 */
inline void Finish(Section& S)
{
	const size_t N = S.Pos.size();
	S.Nrm.assign(N, Vec3{});
	S.Tan.assign(N, Vec3{});
	std::vector<Vec3> FaceN(S.Idx.size() / 3U);
	std::vector<Vec3> TanSum(N, Vec3{});
	for (size_t F = 0; F + 2U < S.Idx.size(); F += 3U)
	{
		const uint32_t A = S.Idx[F];
		const uint32_t B = S.Idx[F + 1U];
		const uint32_t C = S.Idx[F + 2U];
		const Vec3 E1 = S.Pos[B] - S.Pos[A];
		const Vec3 E2 = S.Pos[C] - S.Pos[A];
		const Vec3 Fn = Cross(E1, E2); // twice the area, along the normal
		FaceN[F / 3U] = Fn;
		// dP/dU from the two edges and their picture offsets.
		const double Du1 = S.Uv[B].U - S.Uv[A].U;
		const double Dv1 = S.Uv[B].V - S.Uv[A].V;
		const double Du2 = S.Uv[C].U - S.Uv[A].U;
		const double Dv2 = S.Uv[C].V - S.Uv[A].V;
		const double Det = Du1 * Dv2 - Du2 * Dv1;
		Vec3 T{};
		if (std::fabs(Det) > 1e-14)
		{
			T = (E1 * Dv2 - E2 * Dv1) * (1.0 / Det);
		}
		for (const uint32_t V : {A, B, C})
		{
			TanSum[V] = TanSum[V] + T;
		}
	}
	// Welding by (group, place).
	struct Key
	{
		uint32_t G;
		int64_t X;
		int64_t Y;
		int64_t Z;
		bool operator==(const Key& O) const { return G == O.G && X == O.X && Y == O.Y && Z == O.Z; }
	};
	struct KeyHash
	{
		size_t operator()(const Key& K) const
		{
			uint64_t H = K.G * 0x9E3779B97F4A7C15ULL;
			H ^= static_cast<uint64_t>(K.X) * 0xC2B2AE3D27D4EB4FULL;
			H ^= static_cast<uint64_t>(K.Y) * 0x165667B19E3779F9ULL;
			H ^= static_cast<uint64_t>(K.Z) * 0x27D4EB2F165667C5ULL;
			return static_cast<size_t>(H ^ (H >> 29));
		}
	};
	auto KeyOf = [&](size_t I) {
		const double Q = 1e4; // a tenth of a millimetre when the unit is a metre
		return Key{S.Group[I], static_cast<int64_t>(std::llround(S.Pos[I].X * Q)), static_cast<int64_t>(std::llround(S.Pos[I].Y * Q)), static_cast<int64_t>(std::llround(S.Pos[I].Z * Q))};
	};
	std::vector<Vec3> Own(N, Vec3{});
	for (size_t F = 0; F + 2U < S.Idx.size(); F += 3U)
	{
		for (size_t K = 0; K < 3U; ++K)
		{
			Own[S.Idx[F + K]] = Own[S.Idx[F + K]] + FaceN[F / 3U];
		}
	}
	std::unordered_map<Key, Vec3, KeyHash> Welded;
	Welded.reserve(N);
	for (size_t I = 0; I < N; ++I)
	{
		Vec3& W = Welded[KeyOf(I)];
		W = W + Own[I];
	}
	for (size_t I = 0; I < N; ++I)
	{
		S.Nrm[I] = Normalized(Welded[KeyOf(I)], Vec3{0.0, 0.0, 1.0});
		Vec3 T = TanSum[I] - S.Nrm[I] * Dot(TanSum[I], S.Nrm[I]);
		if (Length(T) < 1e-9)
		{
			Vec3 Tt;
			Vec3 Bb;
			PlanarFrame(S.Nrm[I], Vec3{1.0, 0.0, 0.0}, Tt, Bb);
			T = Tt;
		}
		S.Tan[I] = Normalized(T);
	}
}

inline void Finish(Mesh& M)
{
	for (Section& S : M.Z)
	{
		Finish(S);
	}
}

/** Share of vertices whose frame T, N x T, N is right-handed against the picture's V direction (1 = all of them). */
inline double HandednessShare(const Section& S)
{
	if (S.Idx.size() < 3U)
	{
		return 1.0;
	}
	size_t Good = 0;
	size_t Total = 0;
	for (size_t F = 0; F + 2U < S.Idx.size(); F += 3U)
	{
		const uint32_t A = S.Idx[F];
		const uint32_t B = S.Idx[F + 1U];
		const uint32_t C = S.Idx[F + 2U];
		const Vec3 E1 = S.Pos[B] - S.Pos[A];
		const Vec3 E2 = S.Pos[C] - S.Pos[A];
		if (Length(Cross(E1, E2)) < 1e-12)
		{
			continue;
		}
		const double Du1 = S.Uv[B].U - S.Uv[A].U;
		const double Dv1 = S.Uv[B].V - S.Uv[A].V;
		const double Du2 = S.Uv[C].U - S.Uv[A].U;
		const double Dv2 = S.Uv[C].V - S.Uv[A].V;
		const double Det = Du1 * Dv2 - Du2 * Dv1;
		if (std::fabs(Det) < 1e-14)
		{
			continue;
		}
		const Vec3 T = (E1 * Dv2 - E2 * Dv1) * (1.0 / Det);
		const Vec3 Bt = (E2 * Du1 - E1 * Du2) * (1.0 / Det);
		const Vec3 N = Normalized(Cross(E1, E2));
		++Total;
		if (Dot(Cross(N, T), Bt) > 0.0)
		{
			++Good;
		}
	}
	return Total == 0U ? 1.0 : static_cast<double>(Good) / static_cast<double>(Total);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Tileable noise for the maps                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Periodic gradient noise in about [-1, 1]: a lattice of Px x Py cells that wraps. */
inline double PGrad(int Ix, int Iy, double Dx, double Dy, uint32_t Seed)
{
	const double A = Hash01(static_cast<uint32_t>(Ix), static_cast<uint32_t>(Iy), Seed) * 2.0 * kPi;
	return std::cos(A) * Dx + std::sin(A) * Dy;
}

inline double PNoise(double X, double Y, int Px, int Py, uint32_t Seed)
{
	const double Fx = std::floor(X);
	const double Fy = std::floor(Y);
	const int Ix = static_cast<int>(Fx);
	const int Iy = static_cast<int>(Fy);
	const double Dx = X - Fx;
	const double Dy = Y - Fy;
	const auto W = [](int I, int P) { return ((I % P) + P) % P; };
	const int X0 = W(Ix, Px);
	const int X1 = W(Ix + 1, Px);
	const int Y0 = W(Iy, Py);
	const int Y1 = W(Iy + 1, Py);
	const double U = Dx * Dx * Dx * (Dx * (Dx * 6.0 - 15.0) + 10.0);
	const double V = Dy * Dy * Dy * (Dy * (Dy * 6.0 - 15.0) + 10.0);
	const double A = PGrad(X0, Y0, Dx, Dy, Seed);
	const double B = PGrad(X1, Y0, Dx - 1.0, Dy, Seed);
	const double C = PGrad(X0, Y1, Dx, Dy - 1.0, Seed);
	const double D = PGrad(X1, Y1, Dx - 1.0, Dy - 1.0, Seed);
	return Lerp(Lerp(A, B, U), Lerp(C, D, U), V) * 1.4;
}

/** Fractal periodic noise over the tile: U, V in [0, 1), `Fx` x `Fy` cells at the first octave. */
inline double PFbm(double U, double V, int Fx, int Fy, int Octaves, uint32_t Seed)
{
	double Sum = 0.0;
	double Amp = 1.0;
	double Norm = 0.0;
	int Px = Fx;
	int Py = Fy;
	for (int O = 0; O < Octaves; ++O)
	{
		Sum += Amp * PNoise(U * Px, V * Py, Px, Py, Seed + static_cast<uint32_t>(O) * 17U);
		Norm += Amp;
		Amp *= 0.5;
		Px *= 2;
		Py *= 2;
	}
	return Sum / Norm;
}

inline double Bump(double D, double Width) { return std::exp(-(D * D) / (Width * Width)); }

/** Periodic cells (Worley) over the tile: `Cells` x `Cells` of them, the distance to the nearest feature point in cell units (and to the second nearest), and its cell's id in [0, 1). */
inline double PWorley(double U, double V, int Cells, uint32_t Seed, double* OutId = nullptr, double* OutF2 = nullptr)
{
	const double X = U * Cells;
	const double Y = V * Cells;
	const int Ix = static_cast<int>(std::floor(X));
	const int Iy = static_cast<int>(std::floor(Y));
	double Best = 1e9;
	double Second = 1e9;
	double Id = 0.0;
	for (int Dy = -1; Dy <= 1; ++Dy)
	{
		for (int Dx = -1; Dx <= 1; ++Dx)
		{
			const int Cx = Ix + Dx;
			const int Cy = Iy + Dy;
			const int Wx = ((Cx % Cells) + Cells) % Cells;
			const int Wy = ((Cy % Cells) + Cells) % Cells;
			const double Px = Cx + AetherSpace::Hash01(static_cast<uint32_t>(Wx), static_cast<uint32_t>(Wy), Seed);
			const double Py = Cy + AetherSpace::Hash01(static_cast<uint32_t>(Wx), static_cast<uint32_t>(Wy), Seed + 77U);
			const double D = std::sqrt((Px - X) * (Px - X) + (Py - Y) * (Py - Y));
			if (D < Best)
			{
				Second = Best;
				Best = D;
				Id = AetherSpace::Hash01(static_cast<uint32_t>(Wx), static_cast<uint32_t>(Wy), Seed + 131U);
			}
			else if (D < Second)
			{
				Second = D;
			}
		}
	}
	if (OutId != nullptr)
	{
		*OutId = Id;
	}
	if (OutF2 != nullptr)
	{
		*OutF2 = Second;
	}
	return Best;
}

} // namespace AetherMesh
