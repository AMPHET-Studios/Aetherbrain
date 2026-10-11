// Tests for the mesh toolkit and the ships (AetherMeshMath.h, AetherShipMath.h). Plain C++, no Unreal: run with unreal/tests/run.sh
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherShipMath.h"

#include <cstdio>
#include <set>

using namespace AetherShip;

static int Failures = 0;
static int Checks = 0;

#define CHECK(Cond)                                                                                         \
	do                                                                                                      \
	{                                                                                                       \
		++Checks;                                                                                           \
		if (!(Cond))                                                                                        \
		{                                                                                                   \
			++Failures;                                                                                     \
			std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #Cond);                                     \
		}                                                                                                   \
	} while (0)

static bool Finite(const Vec3& V) { return std::isfinite(V.X) && std::isfinite(V.Y) && std::isfinite(V.Z); }

/** Every triangle of a convex solid faces away from its middle. */
static bool FacesOutward(const Section& S, const Vec3& Middle)
{
	for (size_t F = 0; F + 2U < S.Idx.size(); F += 3U)
	{
		const Vec3& A = S.Pos[S.Idx[F]];
		const Vec3& B = S.Pos[S.Idx[F + 1U]];
		const Vec3& C = S.Pos[S.Idx[F + 2U]];
		const Vec3 N = Cross(B - A, C - A);
		const Vec3 Centre = (A + B + C) * (1.0 / 3.0);
		if (Dot(N, Centre - Middle) <= 0.0)
		{
			return false;
		}
	}
	return true;
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestPrimitives()
{
	GroupCounter G;
	// A box: 12 triangles, 24 vertices (flat faces), faces outward, normals are the face normals.
	Section Box = MakeBox(Vec3{1.0, 2.0, 3.0}, Rgb{1, 1, 1}, 6.0, 5U, G);
	Finish(Box);
	CHECK(Box.Triangles() == 12U);
	CHECK(Box.Pos.size() == 24U);
	CHECK(FacesOutward(Box, Vec3{}));
	for (size_t I = 0; I < Box.Pos.size(); ++I)
	{
		// The normal of a face of an axis-aligned box is an axis, and points the way the vertex lies.
		const Vec3& N = Box.Nrm[I];
		const double Mx = std::max(std::fabs(N.X), std::max(std::fabs(N.Y), std::fabs(N.Z)));
		CHECK(Mx > 0.999);
		CHECK(Dot(N, Box.Pos[I]) > 0.0);
		CHECK(std::fabs(Length(Box.Tan[I]) - 1.0) < 1e-9);
		CHECK(std::fabs(Dot(Box.Tan[I], N)) < 1e-9);
	}
	CHECK(HandednessShare(Box) > 0.999);
	// UVs are metric: a 2 m wide face covers 2 / 6 of a tile.
	{
		double MinU = 1e9;
		double MaxU = -1e9;
		for (size_t I = 0; I < 4U; ++I)
		{
			MinU = std::min(MinU, Box.Uv[I].U);
			MaxU = std::max(MaxU, Box.Uv[I].U);
		}
		const double Span = MaxU - MinU;
		CHECK(std::fabs(Span - 4.0 / 6.0) < 1e-9 || std::fabs(Span - 6.0 / 6.0) < 1e-9 || std::fabs(Span - 2.0 / 6.0) < 1e-9 || std::fabs(Span - 8.0 / 6.0) < 1e-9);
	}

	// A tube: smooth, outward, closed by caps.
	Section Tube = MakeTube(4.0, 1.0, 1.0, 16, true, true, Rgb{1, 1, 1}, 6.0, 3U, G, 3);
	Finish(Tube);
	CHECK(FacesOutward(Tube, Vec3{2.0, 0.0, 0.0}));
	CHECK(HandednessShare(Tube) > 0.999);
	for (size_t I = 0; I < Tube.Pos.size(); ++I)
	{
		CHECK(Finite(Tube.Pos[I]) && Finite(Tube.Nrm[I]) && Finite(Tube.Tan[I]));
		CHECK(std::fabs(Length(Tube.Nrm[I]) - 1.0) < 1e-9);
	}
	// On the barrel the normal is radial, also across the seam where the picture wraps.
	size_t Barrel = 0;
	for (size_t I = 0; I < Tube.Pos.size(); ++I)
	{
		const Vec3 P = Tube.Pos[I];
		if (std::fabs(Tube.Nrm[I].X) < 0.2 && P.X > 0.1 && P.X < 3.9)
		{
			const Vec3 Radial = Normalized(Vec3{0.0, P.Y, P.Z});
			CHECK(Dot(Radial, Tube.Nrm[I]) > 0.97);
			++Barrel;
		}
	}
	CHECK(Barrel >= 17U);

	// A slab: outward faces whichever way its outline runs.
	const std::vector<Vec2> Ccw = {{0, 0}, {4, 0}, {4, 2}, {0, 2}};
	const std::vector<Vec2> Cw(Ccw.rbegin(), Ccw.rend());
	for (const auto& Plan : {Ccw, Cw})
	{
		Section Slab = MakeSlab(Plan, {-0.2, -0.2, -0.2, -0.2}, {0.3, 0.3, 0.3, 0.3}, Rgb{1, 1, 1}, 6.0, 9U, G);
		Finish(Slab);
		CHECK(Slab.Triangles() == 4U * 2U + 2U * 2U);
		CHECK(FacesOutward(Slab, Vec3{2.0, 1.0, 0.05}));
	}

	// A ring is where it says, a closed one touches itself.
	const Ring R{0.0, 2.0, 1.0, 2.0, 0.5, 0.25};
	const Vec3 P0 = RingPoint(R, 0.0);
	CHECK(std::fabs(P0.Y - 2.5) < 1e-9 && std::fabs(P0.Z - 0.25) < 1e-9);
	const Vec3 P90 = RingPoint(R, kPi * 0.5);
	CHECK(std::fabs(P90.Y - 0.5) < 1e-9 && std::fabs(P90.Z - 1.25) < 1e-9);
}

static void TestAppend()
{
	GroupCounter G;
	Section Src = MakeBox(Vec3{1.0, 1.0, 1.0}, Rgb{1, 1, 1}, 6.0, 1U, G);
	Section Dst;
	Append(Dst, Src, Quat{}, Vec3{0.0, 5.0, 0.0}, false, G);
	Append(Dst, Src, Quat{}, Vec3{0.0, 5.0, 0.0}, true, G);
	CHECK(Dst.Pos.size() == 2U * Src.Pos.size());
	CHECK(Dst.Triangles() == 2U * Src.Triangles());
	Finish(Dst);
	// The two boxes are mirror images across Y = 0, each facing outward from its own middle.
	Section A;
	Section B;
	for (size_t I = 0; I < Dst.Pos.size() / 2U; ++I)
	{
		A.Pos.push_back(Dst.Pos[I]);
		B.Pos.push_back(Dst.Pos[I + Dst.Pos.size() / 2U]);
		CHECK(std::fabs(Dst.Pos[I].Y + Dst.Pos[I + Dst.Pos.size() / 2U].Y) < 1e-9);
	}
	CHECK(HandednessShare(Dst) > 0.999);
	// Outward after the mirror: the triangles of the mirrored copy point away from (0, -5, 0).
	for (size_t F = Dst.Idx.size() / 2U; F + 2U < Dst.Idx.size(); F += 3U)
	{
		const Vec3& P = Dst.Pos[Dst.Idx[F]];
		const Vec3& Q = Dst.Pos[Dst.Idx[F + 1U]];
		const Vec3& S = Dst.Pos[Dst.Idx[F + 2U]];
		const Vec3 N = Cross(Q - P, S - P);
		const Vec3 C = (P + Q + S) * (1.0 / 3.0);
		CHECK(Dot(N, C - Vec3{0.0, -5.0, 0.0}) > 0.0);
	}
	// Two parts never share a normal even where they touch.
	std::set<uint32_t> Groups(Dst.Group.begin(), Dst.Group.end());
	CHECK(Groups.size() == 12U);
}

static void CheckMesh(const Mesh& M, const char* Name)
{
	std::printf("  %s: %zu vertices, %zu triangles\n", Name, M.Vertices(), M.Triangles());
	CHECK(M.Triangles() > 1000U);
	CHECK(M.Triangles() < 30000U); // a ship is cheap: thousands, not millions
	CHECK(M.Vertices() < 40000U);
	for (const Section& S : M.Z)
	{
		CHECK(S.Pos.size() == S.Nrm.size() && S.Pos.size() == S.Tan.size() && S.Pos.size() == S.Uv.size() && S.Pos.size() == S.Col.size() && S.Pos.size() == S.Group.size());
		CHECK(S.Idx.size() % 3U == 0U);
		size_t Bad = 0;
		size_t Degenerate = 0;
		for (size_t I = 0; I < S.Pos.size(); ++I)
		{
			if (!Finite(S.Pos[I]) || !Finite(S.Nrm[I]) || !Finite(S.Tan[I]) || !std::isfinite(S.Uv[I].U) || !std::isfinite(S.Uv[I].V))
			{
				++Bad;
			}
			else if (std::fabs(Length(S.Nrm[I]) - 1.0) > 1e-6 || std::fabs(Length(S.Tan[I]) - 1.0) > 1e-6 || std::fabs(Dot(S.Nrm[I], S.Tan[I])) > 1e-6)
			{
				++Bad;
			}
		}
		for (const uint32_t I : S.Idx)
		{
			CHECK(I < S.Pos.size());
		}
		for (size_t F = 0; F + 2U < S.Idx.size(); F += 3U)
		{
			if (Length(Cross(S.Pos[S.Idx[F + 1U]] - S.Pos[S.Idx[F]], S.Pos[S.Idx[F + 2U]] - S.Pos[S.Idx[F]])) < 1e-12)
			{
				++Degenerate;
			}
		}
		CHECK(Bad == 0U);
		// A few collapsed triangles (a nose that closes to a point) are fine, a lot are not.
		CHECK(Degenerate * 50U <= S.Triangles());
		CHECK(HandednessShare(S) > 0.97);
	}
	// All three zones are used by every design (hull, glass, lights).
	CHECK(M[Zone::Hull].Triangles() > 500U);
	CHECK(M[Zone::Glass].Triangles() > 0U);
	CHECK(M[Zone::Light].Triangles() > 0U);
	// Lights are HDR (the emissive), hull tints are about 1.
	double MaxLight = 0.0;
	for (const Rgb& C : M[Zone::Light].Col)
	{
		MaxLight = std::max(MaxLight, std::max(C.R, std::max(C.G, C.B)));
	}
	CHECK(MaxLight > 1.5);
	for (const Rgb& C : M[Zone::Hull].Col)
	{
		CHECK(C.R >= 0.0 && C.R < 1.6 && C.G >= 0.0 && C.G < 1.6 && C.B >= 0.0 && C.B < 1.6);
	}
}

static void TestShips()
{
	for (int C = 0; C < kShipClasses; ++C)
	{
		const ShipClass Cls = static_cast<ShipClass>(C);
		const Mesh A = MakeShip(Cls, 7U);
		const Mesh B = MakeShip(Cls, 7U);
		const Mesh Other = MakeShip(Cls, 8U);
		CheckMesh(A, C == 0 ? "interceptor" : (C == 1 ? "hauler" : "cruiser"));
		// Deterministic, and a seed matters.
		CHECK(A.Z[0].Pos.size() == B.Z[0].Pos.size());
		bool Same = true;
		for (size_t I = 0; I < A.Z[0].Pos.size() && Same; ++I)
		{
			Same = A.Z[0].Pos[I].X == B.Z[0].Pos[I].X && A.Z[0].Pos[I].Y == B.Z[0].Pos[I].Y && A.Z[0].Pos[I].Z == B.Z[0].Pos[I].Z;
		}
		CHECK(Same);
		bool Differs = A.Triangles() != Other.Triangles();
		for (size_t I = 0; I < std::min(A.Z[0].Pos.size(), Other.Z[0].Pos.size()) && !Differs; ++I)
		{
			Differs = A.Z[0].Pos[I].X != Other.Z[0].Pos[I].X || A.Z[0].Pos[I].Y != Other.Z[0].Pos[I].Y;
		}
		CHECK(Differs);
		// The size is the size it says: nose toward +X, not far from the stated length.
		Vec3 Lo;
		Vec3 Hi;
		A.Bounds(Lo, Hi);
		const double Len = Hi.X - Lo.X;
		CHECK(Len > ShipLength(Cls) * 0.9 && Len < ShipLength(Cls) * 1.2);
		CHECK(Hi.X > std::fabs(Lo.X) * 0.7 || C != 0); // an interceptor's nose reaches farther ahead of the middle than its tail behind
		// Symmetrical across the keel line (the hauler and cruiser have a few asymmetric bits: windows, containers).
		if (Cls == ShipClass::Interceptor)
		{
			CHECK(std::fabs(Hi.Y + Lo.Y) < 0.05);
		}
	}
}

static void TestMaps()
{
	const HullMaps Maps = MakeHullMaps(256, 5U, LiveryOf(0), 2U);
	const HullMaps Again = MakeHullMaps(256, 5U, LiveryOf(0), 3U);
	const HullMaps Other = MakeHullMaps(256, 6U, LiveryOf(0), 2U);
	CHECK(Maps.BaseColor.Width == 256 && Maps.Normal.Height == 256 && Maps.Orm.Width == 256);
	// The same seed gives the same metal whatever the thread count; another seed another metal.
	CHECK(Maps.BaseColor.Bgra == Again.BaseColor.Bgra);
	CHECK(Maps.Normal.Bgra == Again.Normal.Bgra);
	CHECK(Maps.Orm.Bgra == Again.Orm.Bgra);
	CHECK(Maps.BaseColor.Bgra != Other.BaseColor.Bgra);
	// Normals are unit, point out of the surface (z > 0), and average to straight up.
	double Mx = 0.0;
	double My = 0.0;
	double Mz = 0.0;
	size_t Tilted = 0;
	for (int Y = 0; Y < 256; ++Y)
	{
		for (int X = 0; X < 256; ++X)
		{
			const size_t O = Maps.Normal.Offset(X, Y);
			const Vec3 N{Maps.Normal.Bgra[O + 2] / 255.0 * 2.0 - 1.0, Maps.Normal.Bgra[O + 1] / 255.0 * 2.0 - 1.0, Maps.Normal.Bgra[O + 0] / 255.0 * 2.0 - 1.0};
			CHECK(std::fabs(Length(N) - 1.0) < 0.03);
			CHECK(N.Z > 0.0);
			Mx += N.X;
			My += N.Y;
			Mz += N.Z;
			if (N.Z < 0.97)
			{
				++Tilted;
			}
			CHECK(Maps.Normal.Bgra[O + 3] == 255 && Maps.BaseColor.Bgra[O + 3] == 255 && Maps.Orm.Bgra[O + 3] == 255);
		}
	}
	const double Count = 256.0 * 256.0;
	CHECK(std::fabs(Mx / Count) < 0.02 && std::fabs(My / Count) < 0.02 && Mz / Count > 0.9);
	CHECK(Tilted > 200U);              // seams, rivets and scratches do show in the normals
	CHECK(Tilted < static_cast<size_t>(Count * 0.5)); // and most of the metal is flat
	// Occlusion, roughness, metal stay in range and are not constant; paint is mostly not metal.
	double RoughMin = 1.0;
	double RoughMax = 0.0;
	double MetalMean = 0.0;
	double AoMin = 1.0;
	double LumaMean = 0.0;
	for (int Y = 0; Y < 256; ++Y)
	{
		for (int X = 0; X < 256; ++X)
		{
			const size_t O = Maps.Orm.Offset(X, Y);
			const double Ao = Maps.Orm.Bgra[O + 2] / 255.0;
			const double Rough = Maps.Orm.Bgra[O + 1] / 255.0;
			const double Metal = Maps.Orm.Bgra[O + 0] / 255.0;
			RoughMin = std::min(RoughMin, Rough);
			RoughMax = std::max(RoughMax, Rough);
			AoMin = std::min(AoMin, Ao);
			MetalMean += Metal;
			double R = 0.0;
			double Gc = 0.0;
			double B = 0.0;
			Maps.BaseColor.Get(X, Y, R, Gc, B);
			LumaMean += 0.2126 * R + 0.7152 * Gc + 0.0722 * B;
		}
	}
	CHECK(RoughMax - RoughMin > 0.25);
	CHECK(AoMin < 0.7);
	CHECK(MetalMean / Count < 0.35);
	LumaMean /= Count;
	CHECK(LumaMean > 0.03 && LumaMean < 0.7); // painted metal: neither black nor white
	// It tiles: the wrap from the last column to the first is like any other plate boundary (a plate is 32 px here), not a rougher cut.
	double Seam = 0.0;
	double Boundary = 0.0;
	const auto L = [&](int X, int Yy) {
		double R = 0.0;
		double Gc = 0.0;
		double B = 0.0;
		Maps.BaseColor.Get(X, Yy, R, Gc, B);
		return 0.2126 * R + 0.7152 * Gc + 0.0722 * B;
	};
	for (int Y = 0; Y < 256; ++Y)
	{
		Seam += std::fabs(L(0, Y) - L(255, Y)) + std::fabs(L(Y, 0) - L(Y, 255));
		for (int K = 1; K < 8; ++K)
		{
			Boundary += (std::fabs(L(K * 32 - 1, Y) - L(K * 32, Y)) + std::fabs(L(Y, K * 32 - 1) - L(Y, K * 32))) / 7.0;
		}
	}
	CHECK(Seam < Boundary * 1.5 + 1.0);
	// Four liveries, all different, and the index wraps.
	CHECK(LiveryOf(0).Primary.R != LiveryOf(1).Primary.R);
	CHECK(LiveryOf(4).Primary.R == LiveryOf(0).Primary.R);
	CHECK(LiveryOf(-1).Primary.R == LiveryOf(3).Primary.R);
}

int main()
{
	std::printf("meshes\n");
	TestPrimitives();
	TestAppend();
	TestShips();
	TestMaps();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
