// Tests for the asteroids (AetherRockMath.h): the mesh and the rock maps. Plain C++, no Unreal: run with unreal/tests/run.sh
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherRockMath.h"

#include <cstdio>

using namespace AetherRock;

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

static void Extent(const Section& S, Vec3& Lo, Vec3& Hi)
{
	Lo = Vec3{1e30, 1e30, 1e30};
	Hi = Vec3{-1e30, -1e30, -1e30};
	for (const Vec3& P : S.Pos)
	{
		Lo = Vec3{std::min(Lo.X, P.X), std::min(Lo.Y, P.Y), std::min(Lo.Z, P.Z)};
		Hi = Vec3{std::max(Hi.X, P.X), std::max(Hi.Y, P.Y), std::max(Hi.Z, P.Z)};
	}
}

static void TestMesh()
{
	RockSpec Spec;
	Spec.Seed = 7U;
	Spec.Detail = 3;
	const Section A = MakeAsteroid(Spec);
	const Section B = MakeAsteroid(Spec);
	RockSpec Other = Spec;
	Other.Seed = 8U;
	const Section C = MakeAsteroid(Other);
	// 20 * 4^3 faces, each with its own three vertices (box projection cuts the pictures per face).
	CHECK(A.Triangles() == 20U * 64U);
	CHECK(A.Pos.size() == A.Triangles() * 3U);
	CHECK(A.Nrm.size() == A.Pos.size() && A.Tan.size() == A.Pos.size() && A.Uv.size() == A.Pos.size() && A.Col.size() == A.Pos.size());
	// Deterministic; a seed matters.
	bool Same = A.Pos.size() == B.Pos.size();
	for (size_t I = 0; I < A.Pos.size() && Same; ++I)
	{
		Same = A.Pos[I].X == B.Pos[I].X && A.Pos[I].Y == B.Pos[I].Y && A.Pos[I].Z == B.Pos[I].Z;
	}
	CHECK(Same);
	bool Differs = false;
	for (size_t I = 0; I < std::min(A.Pos.size(), C.Pos.size()) && !Differs; ++I)
	{
		Differs = A.Pos[I].X != C.Pos[I].X;
	}
	CHECK(Differs);
	// Unit size, centred, nothing outside the unit ball by much.
	Vec3 Lo;
	Vec3 Hi;
	Extent(A, Lo, Hi);
	double Reach = 0.0;
	for (const Vec3& P : A.Pos)
	{
		Reach = std::max(Reach, Length(P));
	}
	CHECK(Reach > 0.7 && Reach < 1.35);
	CHECK(std::fabs(Hi.X + Lo.X) < 0.5 && std::fabs(Hi.Y + Lo.Y) < 0.5 && std::fabs(Hi.Z + Lo.Z) < 0.5);
	size_t Outward = 0;
	size_t Degenerate = 0;
	for (size_t F = 0; F + 2U < A.Idx.size(); F += 3U)
	{
		const Vec3& P = A.Pos[A.Idx[F]];
		const Vec3& Q = A.Pos[A.Idx[F + 1U]];
		const Vec3& R = A.Pos[A.Idx[F + 2U]];
		const Vec3 N = Cross(Q - P, R - P);
		if (Length(N) < 1e-14)
		{
			++Degenerate;
			continue;
		}
		if (Dot(N, (P + Q + R) * (1.0 / 3.0)) > 0.0)
		{
			++Outward;
		}
	}
	// A rock is a star shape from its middle: its faces face out (steep crater walls aside).
	CHECK(Outward + Degenerate >= A.Triangles() * 995U / 1000U);
	for (size_t I = 0; I < A.Pos.size(); ++I)
	{
		CHECK(Finite(A.Pos[I]) && Finite(A.Nrm[I]) && Finite(A.Tan[I]));
		CHECK(std::fabs(Length(A.Nrm[I]) - 1.0) < 1e-6);
		CHECK(std::fabs(Length(A.Tan[I]) - 1.0) < 1e-6);
		CHECK(std::fabs(Dot(A.Nrm[I], A.Tan[I])) < 1e-6);
		CHECK(std::isfinite(A.Uv[I].U) && std::isfinite(A.Uv[I].V));
		// The baked occlusion and tint stay in a sane range.
		CHECK(A.Col[I].R > 0.3 && A.Col[I].R < 1.2 && A.Col[I].R == A.Col[I].G && A.Col[I].G == A.Col[I].B);
		// The normal points out of the rock.
		CHECK(Dot(A.Nrm[I], Normalized(A.Pos[I])) > -0.2);
	}
	CHECK(HandednessShare(A) > 0.97);
	// The picture is laid at about one repeat across the rock (Tile 1.2): UVs span a couple of units, not hundreds.
	double MaxUv = 0.0;
	for (const Vec2& U : A.Uv)
	{
		MaxUv = std::max(MaxUv, std::max(std::fabs(U.U), std::fabs(U.V)));
	}
	CHECK(MaxUv > 0.4 && MaxUv < 1.5);

	// Elongation stretches it; roughness roughens it; no craters is smoother than craters.
	RockSpec Ball = Spec;
	Ball.Elongation = 1.0;
	RockSpec Long = Spec;
	Long.Elongation = 2.4;
	const auto Aspect = [](const Section& S) {
		Vec3 L;
		Vec3 H;
		Extent(S, L, H);
		const double X = H.X - L.X;
		const double Y = H.Y - L.Y;
		const double Z = H.Z - L.Z;
		return std::max(X, std::max(Y, Z)) / std::min(X, std::min(Y, Z));
	};
	CHECK(Aspect(MakeAsteroid(Long)) > Aspect(MakeAsteroid(Ball)) * 1.25);
	const auto Spread = [](const Section& S) {
		// How far the surface strays from the mean radius.
		double Mean = 0.0;
		for (const Vec3& P : S.Pos)
		{
			Mean += Length(P);
		}
		Mean /= static_cast<double>(S.Pos.size());
		double V = 0.0;
		for (const Vec3& P : S.Pos)
		{
			V += (Length(P) - Mean) * (Length(P) - Mean);
		}
		return std::sqrt(V / static_cast<double>(S.Pos.size()));
	};
	RockSpec Smooth = Ball;
	Smooth.Roughness = 0.0;
	Smooth.Craters = 0;
	RockSpec Jagged = Ball;
	Jagged.Roughness = 2.0;
	CHECK(Spread(MakeAsteroid(Jagged)) > Spread(MakeAsteroid(Smooth)));
	// A smooth ball with no craters is nearly round.
	CHECK(Spread(MakeAsteroid(Smooth)) < 0.12);
	// Detail changes the face count by four each step.
	RockSpec D4 = Spec;
	D4.Detail = 4;
	CHECK(MakeAsteroid(D4).Triangles() == 4U * A.Triangles());
	RockSpec D0 = Spec;
	D0.Detail = 0;
	CHECK(MakeAsteroid(D0).Triangles() == 20U);
	RockSpec Huge = Spec;
	Huge.Detail = 99; // capped, not 20 * 4^99
	CHECK(MakeAsteroid(Huge).Triangles() == 20U * 4096U);
}

static void TestMaps()
{
	std::vector<RockMaps> Maps;
	for (int K = 0; K < kRockKinds; ++K)
	{
		Maps.push_back(MakeRockMaps(256, 5U + static_cast<uint32_t>(K), static_cast<RockKind>(K), 2U));
	}
	const RockMaps Again = MakeRockMaps(256, 6U, RockKind::Silicate, 3U);
	CHECK(Maps[1].BaseColor.Bgra == Again.BaseColor.Bgra && Maps[1].Normal.Bgra == Again.Normal.Bgra && Maps[1].Orm.Bgra == Again.Orm.Bgra);
	double Luma[kRockKinds] = {};
	double Metal[kRockKinds] = {};
	for (int K = 0; K < kRockKinds; ++K)
	{
		const RockMaps& M = Maps[static_cast<size_t>(K)];
		CHECK(M.BaseColor.Width == 256 && M.Normal.Height == 256);
		double Mx = 0.0;
		double My = 0.0;
		double Mz = 0.0;
		double RoughMin = 1.0;
		double RoughMax = 0.0;
		double AoMin = 1.0;
		for (int Y = 0; Y < 256; ++Y)
		{
			for (int X = 0; X < 256; ++X)
			{
				const size_t O = M.Normal.Offset(X, Y);
				const Vec3 N{M.Normal.Bgra[O + 2] / 255.0 * 2.0 - 1.0, M.Normal.Bgra[O + 1] / 255.0 * 2.0 - 1.0, M.Normal.Bgra[O + 0] / 255.0 * 2.0 - 1.0};
				CHECK(std::fabs(Length(N) - 1.0) < 0.03 && N.Z > 0.0);
				Mx += N.X;
				My += N.Y;
				Mz += N.Z;
				const size_t P = M.Orm.Offset(X, Y);
				RoughMin = std::min(RoughMin, M.Orm.Bgra[P + 1] / 255.0);
				RoughMax = std::max(RoughMax, M.Orm.Bgra[P + 1] / 255.0);
				AoMin = std::min(AoMin, M.Orm.Bgra[P + 2] / 255.0);
				Metal[K] += M.Orm.Bgra[P + 0] / 255.0 / (256.0 * 256.0);
				double R = 0.0;
				double G = 0.0;
				double B = 0.0;
				M.BaseColor.Get(X, Y, R, G, B);
				Luma[K] += (0.2126 * R + 0.7152 * G + 0.0722 * B) / (256.0 * 256.0);
			}
		}
		CHECK(std::fabs(Mx / 65536.0) < 0.03 && std::fabs(My / 65536.0) < 0.03 && Mz / 65536.0 > 0.8);
		CHECK(RoughMax - RoughMin > 0.05);
		CHECK(AoMin < 0.75);
		// It tiles: the wrap is no rougher than a step inside the picture.
		double Seam = 0.0;
		double Inner = 0.0;
		const auto L = [&](int X, int Y) {
			double R = 0.0;
			double G = 0.0;
			double B = 0.0;
			M.BaseColor.Get(X, Y, R, G, B);
			return 0.2126 * R + 0.7152 * G + 0.0722 * B;
		};
		for (int I = 0; I < 256; ++I)
		{
			Seam += std::fabs(L(0, I) - L(255, I)) + std::fabs(L(I, 0) - L(I, 255));
			Inner += std::fabs(L(100, I) - L(101, I)) + std::fabs(L(I, 100) - L(I, 101));
		}
		CHECK(Seam < Inner * 2.0 + 1.0);
	}
	// Ice is bright, carbon dark; iron is the only one with metal in it.
	CHECK(Luma[static_cast<int>(RockKind::Ice)] > Luma[static_cast<int>(RockKind::Silicate)]);
	CHECK(Luma[static_cast<int>(RockKind::Silicate)] > Luma[static_cast<int>(RockKind::Carbon)]);
	CHECK(Metal[static_cast<int>(RockKind::Iron)] > 0.05);
	CHECK(Metal[static_cast<int>(RockKind::Carbon)] == 0.0 && Metal[static_cast<int>(RockKind::Silicate)] == 0.0 && Metal[static_cast<int>(RockKind::Ice)] == 0.0);
	// Rock is not shiny: the bulk of it is rough.
	CHECK(Rgb{}.R == 0.0);
	const Rgb T = RockTint(RockKind::Iron);
	CHECK(T.R > T.B); // rust
}

int main()
{
	std::printf("rocks\n");
	TestMesh();
	TestMaps();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
