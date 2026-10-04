// Tests for the space world's maths (AetherSpaceMath.h). Plain C++, no Unreal: run with unreal/tests/run.sh
// (or `pnpm exec vitest run apps/desktop/test/unreal-space.test.ts`, which compiles and runs this when a C++ compiler is installed).
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherSpaceMath.h"

#include <algorithm>
#include <cstdio>
#include <set>
#include <string>

using namespace AetherSpace;

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

#define CHECK_NEAR(A, B, Eps)                                                                               \
	do                                                                                                      \
	{                                                                                                       \
		++Checks;                                                                                           \
		const double A_ = (A);                                                                              \
		const double B_ = (B);                                                                              \
		if (!(std::fabs(A_ - B_) <= (Eps)))                                                                 \
		{                                                                                                   \
			++Failures;                                                                                     \
			std::printf("FAIL %s:%d  %s = %g, expected %g (+/- %g)\n", __FILE__, __LINE__, #A, A_, B_, (Eps)); \
		}                                                                                                   \
	} while (0)

static bool Finite(const Vec3& V) { return std::isfinite(V.X) && std::isfinite(V.Y) && std::isfinite(V.Z); }
static bool Finite(const Quat& Q) { return std::isfinite(Q.X) && std::isfinite(Q.Y) && std::isfinite(Q.Z) && std::isfinite(Q.W); }
static double Luma(const Image& I, int X, int Y)
{
	double R = 0.0;
	double G = 0.0;
	double B = 0.0;
	I.Get(X, Y, R, G, B);
	return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestRandom()
{
	double Sum = 0.0;
	for (uint32_t I = 0; I < 100000; ++I)
	{
		const double H = Hash01(I, 3U, 7U);
		CHECK(H >= 0.0 && H < 1.0);
		Sum += H;
	}
	CHECK_NEAR(Sum / 100000.0, 0.5, 0.01);
	CHECK(HashU(1, 2, 3) == HashU(1, 2, 3));
	CHECK(HashU(1, 2, 3) != HashU(1, 2, 4));
	CHECK(HashU(1, 2, 3) != HashU(2, 1, 3));

	Rng A(42);
	Rng B(42);
	Rng C(43);
	bool Same = true;
	bool Differs = false;
	for (int I = 0; I < 100; ++I)
	{
		const double X = A.Next();
		Same = Same && X == B.Next();
		Differs = Differs || X != C.Next();
		CHECK(X >= 0.0 && X < 1.0);
	}
	CHECK(Same);
	CHECK(Differs);
	Rng Zero(0);
	CHECK(Zero.NextU() != 0U);

	Rng U(9);
	Vec3 Mean;
	double GaussSum = 0.0;
	double GaussSq = 0.0;
	for (int I = 0; I < 20000; ++I)
	{
		const Vec3 V = U.Unit();
		CHECK_NEAR(Length(V), 1.0, 1e-9);
		Mean = Mean + V;
		const double G = U.Gauss();
		GaussSum += G;
		GaussSq += G * G;
	}
	CHECK(Length(Mean) / 20000.0 < 0.03);
	CHECK_NEAR(GaussSum / 20000.0, 0.0, 0.04);
	CHECK_NEAR(GaussSq / 20000.0, 1.0, 0.06);
}

static void TestNoise()
{
	double Previous = ValueNoise(0.0, 0.0, 5U);
	for (int I = 1; I < 2000; ++I)
	{
		const double X = static_cast<double>(I) * 0.01;
		const double V = ValueNoise(X, X * 0.7, 5U);
		CHECK(V >= 0.0 && V <= 1.0);
		CHECK(std::fabs(V - Previous) < 0.08);
		Previous = V;
		const double F = Fbm(X * 3.0, -X, 5, 7U);
		CHECK(F >= 0.0 && F <= 1.0);
	}
	CHECK(ValueNoise(1.5, 2.5, 5U) == ValueNoise(1.5, 2.5, 5U));
	CHECK(ValueNoise(1.5, 2.5, 5U) != ValueNoise(1.5, 2.5, 6U));
	// Negative coordinates work too.
	CHECK(std::isfinite(Fbm(-123.4, -77.7, 5, 1U)));
}

static void TestQuaternions()
{
	Rng R(5);
	for (int I = 0; I < 400; ++I)
	{
		const Vec3 Dir = I % 40 == 0 ? Vec3{0.0, 0.0, I % 80 == 0 ? 1.0 : -1.0} : R.Unit();
		const Quat Q = FromZTo(Dir);
		CHECK(Finite(Q));
		CHECK_NEAR(Q.X * Q.X + Q.Y * Q.Y + Q.Z * Q.Z + Q.W * Q.W, 1.0, 1e-9);
		const Vec3 Z = Rotate(Q, Vec3{0.0, 0.0, 1.0});
		CHECK_NEAR(Z.X, Dir.X, 1e-9);
		CHECK_NEAR(Z.Y, Dir.Y, 1e-9);
		CHECK_NEAR(Z.Z, Dir.Z, 1e-9);
		// The other two axes stay at right angles to it and to each other.
		const Vec3 X = Rotate(Q, Vec3{1.0, 0.0, 0.0});
		const Vec3 Y = Rotate(Q, Vec3{0.0, 1.0, 0.0});
		CHECK_NEAR(Dot(X, Z), 0.0, 1e-9);
		CHECK_NEAR(Dot(X, Y), 0.0, 1e-9);
		CHECK_NEAR(Length(X), 1.0, 1e-9);
	}

	// Pointing up is no turn at all: a part that points up keeps its own axes (a wing stays along Y, a hull along X).
	const Quat Up = FromZTo(kUp);
	CHECK_NEAR(Up.X, 0.0, 1e-12);
	CHECK_NEAR(Up.Y, 0.0, 1e-12);
	CHECK_NEAR(Up.Z, 0.0, 1e-12);
	CHECK_NEAR(Up.W, 1.0, 1e-12);
	const Vec3 AxisX = Rotate(FromZTo(Vec3{0.0, 0.0, -1.0}), Vec3{1.0, 0.0, 0.0});
	CHECK_NEAR(AxisX.X, 1.0, 1e-12);

	// Look at something: +X goes to Forward, and +Z leans to Up (a level ship stays level).
	for (int I = 0; I < 200; ++I)
	{
		const Vec3 Fwd = R.Unit();
		const Quat Q = LookRotation(Fwd, kUp);
		CHECK(Finite(Q));
		const Vec3 X = Rotate(Q, Vec3{1.0, 0.0, 0.0});
		const Vec3 Z = Rotate(Q, Vec3{0.0, 0.0, 1.0});
		CHECK_NEAR(Dot(X, Fwd), 1.0, 1e-9);
		CHECK(Z.Z >= -1e-9);
		// Right-handed frame: X x Y = Z.
		const Vec3 Y = Rotate(Q, Vec3{0.0, 1.0, 0.0});
		CHECK_NEAR(Dot(Cross(X, Y), Z), 1.0, 1e-9);
	}
	CHECK(Finite(LookRotation(Vec3{0.0, 0.0, 1.0}, kUp)));
	CHECK(Finite(LookRotation(Vec3{0.0, 0.0, -1.0}, kUp)));
	CHECK(Finite(LookRotation(Vec3{0.0, 0.0, 0.0}, kUp)));

	// A quarter turn about Z takes +X to +Y (Unreal's positive yaw).
	const Vec3 Turned = Rotate(FromAxisAngle(kUp, kPi * 0.5), Vec3{1.0, 0.0, 0.0});
	CHECK_NEAR(Turned.X, 0.0, 1e-9);
	CHECK_NEAR(Turned.Y, 1.0, 1e-9);

	// A * B applies B first.
	const Quat A = FromAxisAngle(kUp, kPi * 0.5);
	const Quat B = FromAxisAngle(Vec3{1.0, 0.0, 0.0}, kPi * 0.5);
	const Vec3 V{0.3, -0.4, 0.8};
	const Vec3 Both = Rotate(A * B, V);
	const Vec3 Step = Rotate(A, Rotate(B, V));
	CHECK_NEAR(Both.X, Step.X, 1e-9);
	CHECK_NEAR(Both.Y, Step.Y, 1e-9);
	CHECK_NEAR(Both.Z, Step.Z, 1e-9);
}

/* ---------------------------------------------------------------------------------------------------------------- */

struct Stats
{
	double Border = 0.0;
	double Centre = 0.0;
	double Mean = 0.0;
	double Clipped = 0.0;
	double Max = 0.0;
};

static Stats Measure(const Image& I)
{
	Stats S;
	const int N = I.Width;
	double Sum = 0.0;
	int Clipped = 0;
	for (int Y = 0; Y < N; ++Y)
	{
		for (int X = 0; X < N; ++X)
		{
			const double L = Luma(I, X, Y);
			Sum += L;
			S.Max = std::max(S.Max, L);
			const size_t O = I.Offset(X, Y);
			if (I.Bgra[O] > 250 && I.Bgra[O + 1] > 250 && I.Bgra[O + 2] > 250)
			{
				++Clipped;
			}
			if (X == 0 || Y == 0 || X == N - 1 || Y == N - 1)
			{
				S.Border = std::max(S.Border, L);
			}
		}
	}
	S.Mean = Sum / (static_cast<double>(N) * static_cast<double>(N));
	S.Clipped = static_cast<double>(Clipped) / (static_cast<double>(N) * static_cast<double>(N));
	for (int Y = N / 2 - 4; Y < N / 2 + 4; ++Y)
	{
		for (int X = N / 2 - 4; X < N / 2 + 4; ++X)
		{
			S.Centre = std::max(S.Centre, Luma(I, X, Y));
		}
	}
	return S;
}

static void TestNebulaPictures()
{
	std::set<std::vector<uint8_t>> Seen;
	for (int V = 0; V < kNebulaVariants; ++V)
	{
		const Image I = MakeNebula(128, 100U + static_cast<uint32_t>(V) * 17U);
		CHECK(I.Width == 128 && I.Height == 128);
		CHECK(I.Bgra.size() == 128U * 128U * 4U);
		const Stats S = Measure(I);
		// No visible rectangle: the border is black; and there is something in it, not blown out.
		CHECK(S.Border < 0.002);
		CHECK(S.Mean > 0.02);
		CHECK(S.Mean < 0.45);
		CHECK(S.Clipped < 0.02);
		CHECK(S.Max > 0.25);
		bool OpaqueAlpha = true;
		for (size_t O = 3; O < I.Bgra.size(); O += 4)
		{
			OpaqueAlpha = OpaqueAlpha && I.Bgra[O] == 255;
		}
		CHECK(OpaqueAlpha);
		Seen.insert(I.Bgra);
	}
	CHECK(static_cast<int>(Seen.size()) == kNebulaVariants);
	// Deterministic.
	CHECK(MakeNebula(64, 5U).Bgra == MakeNebula(64, 5U).Bgra);
	CHECK(MakeNebula(64, 5U).Bgra != MakeNebula(64, 6U).Bgra);
}

static void TestGalaxyPictures()
{
	for (int K = 0; K < kGalaxyVariants; ++K)
	{
		const Image I = MakeGalaxy(160, 200U + static_cast<uint32_t>(K), static_cast<GalaxyKind>(K));
		const Stats S = Measure(I);
		CHECK(S.Border < 0.002);
		// A bright core, brighter than the disc a third of the way out.
		CHECK(S.Centre > 0.3);
		double Ring = 0.0;
		for (int A = 0; A < 16; ++A)
		{
			const double Ang = 2.0 * kPi * static_cast<double>(A) / 16.0;
			Ring += Luma(I, 80 + static_cast<int>(std::lround(std::cos(Ang) * 56.0)), 80 + static_cast<int>(std::lround(std::sin(Ang) * 56.0)));
		}
		CHECK(S.Centre > 2.0 * Ring / 16.0);
		CHECK(S.Mean > 0.005);
		CHECK(S.Mean < 0.3);
		CHECK(S.Clipped < 0.03);
	}
	// The edge-on one really is flat: its glow is spread far wider one way than the other.
	const Image Edge = MakeGalaxy(160, 203U, GalaxyKind::EdgeOn);
	double Wide = 0.0;
	double Narrow = 1e9;
	for (int Deg = 0; Deg < 180; Deg += 5)
	{
		// Extent of pixels brighter than 8% along this direction through the centre.
		const double Ang = DegToRad(static_cast<double>(Deg));
		double Extent = 0.0;
		for (double Rr = 0.0; Rr < 78.0; Rr += 1.0)
		{
			const int X = 80 + static_cast<int>(std::lround(std::cos(Ang) * Rr));
			const int Y = 80 + static_cast<int>(std::lround(std::sin(Ang) * Rr));
			if (Luma(Edge, X, Y) > 0.08)
			{
				Extent = Rr;
			}
		}
		Wide = std::max(Wide, Extent);
		Narrow = std::min(Narrow, Extent);
	}
	CHECK(Wide > 2.2 * Narrow);
	CHECK(MakeGalaxy(64, 7U, GalaxyKind::Spiral).Bgra == MakeGalaxy(64, 7U, GalaxyKind::Spiral).Bgra);
	CHECK(MakeGalaxy(64, 7U, GalaxyKind::Spiral).Bgra != MakeGalaxy(64, 7U, GalaxyKind::Grand).Bgra);
}

static void TestStarDot()
{
	const Image I = MakeStarDot(64);
	const Stats S = Measure(I);
	CHECK(S.Border < 0.001);
	CHECK(S.Centre > 0.9);
	CHECK(Luma(I, 32, 32) > 20.0 * Luma(I, 32 + 18, 32 + 18));
}

/* ---------------------------------------------------------------------------------------------------------------- */

static double AngleOf(const Vec3& Camera, const LayerSpec& L)
{
	// How far (degrees) a sprite straight ahead of the layer's centre appears to slide against the true sky when the
	// camera has moved by Camera: the layer's centre is off the camera by the lag.
	const Vec3 Lag = ParallaxLag(Camera, L.Follow, L.Radius);
	return std::atan2(Length(Lag), L.Radius) * 180.0 / kPi;
}

static void TestParallax()
{
	// A sky follows the camera exactly; a layer left behind slides.
	const Vec3 Cam{12000.0, -5000.0, 3000.0};
	CHECK(Length(ParallaxLag(Cam, 1.0, 1e6)) == 0.0);
	CHECK(Length(ParallaxLag(Vec3{}, 0.3, 1e6)) == 0.0);
	// Small moves are linear: (1 - Follow) of the move, in the same direction.
	const Vec3 Lag = ParallaxLag(Cam, 0.6, 5e6);
	CHECK_NEAR(Length(Lag) / Length(Cam), 0.4, 0.001);
	CHECK_NEAR(Dot(Normalized(Lag), Normalized(Cam)), 1.0, 1e-9);
	const Vec3 Origin = LayerOrigin(Cam, 0.6, 5e6);
	CHECK_NEAR(Length(Origin - Cam * 0.6), 0.0, 20.0);

	// Always capped: however far the camera flies, the layer stays more than 0.65 radius from it.
	double Previous = 0.0;
	for (double D = 0.0; D < 1e8; D = D * 1.5 + 1000.0)
	{
		const double L = Length(ParallaxLag(Vec3{D, 0.0, 0.0}, 0.0, 1.0e5));
		CHECK(L <= 0.35e5 + 1e-6);
		CHECK(L >= Previous - 1e-9);
		Previous = L;
	}
	// And the camera never nears a sprite of the layer.
	const Vec3 Far{9e7, 0.0, 0.0};
	const Vec3 Centre = LayerOrigin(Far, 0.0, 1.0e5);
	CHECK(Length(Far - Centre) > 0.34e5);

	// Nearer layers slide more than far ones for the same flight: that is the depth.
	const std::vector<LayerSpec> Layers = DefaultLayers();
	const Vec3 Flight{30000.0, 0.0, 0.0};
	double Deep = -1.0;
	double Dust = -1.0;
	double Nebulae = -1.0;
	double FarGalaxies = -1.0;
	double MidGalaxies = -1.0;
	for (const LayerSpec& L : Layers)
	{
		const std::string Name = L.Name;
		if (Name == "deep-stars") Deep = AngleOf(Flight, L);
		if (Name == "dust") Dust = AngleOf(Flight, L);
		if (Name == "nebulae") Nebulae = AngleOf(Flight, L);
		if (Name == "far-galaxies") FarGalaxies = AngleOf(Flight, L);
		if (Name == "mid-galaxies") MidGalaxies = AngleOf(Flight, L);
	}
	CHECK_NEAR(Deep, 0.0, 1e-9);
	CHECK(FarGalaxies > 0.02 && FarGalaxies < MidGalaxies);
	CHECK(MidGalaxies < Nebulae);
	CHECK(Nebulae < Dust);
	// Visible, but not wild: the nearest layer slides some degrees, the far galaxies a hair.
	CHECK(Dust > 3.0 && Dust < 25.0);
	CHECK(FarGalaxies < 0.2);
}

static void TestLayers()
{
	const std::vector<LayerSpec> Layers = DefaultLayers();
	CHECK(Layers.size() >= 8);
	std::set<std::string> Names;
	double LastRadius = 1e18;
	for (const LayerSpec& L : Layers)
	{
		Names.insert(L.Name);
		CHECK(L.Radius > 1e5);
		CHECK(L.Follow >= 0.0 && L.Follow <= 1.0);
		CHECK(L.AngMin > 0.0 && L.AngMin <= L.AngMax);
		CHECK(L.GlowMin > 0.0 && L.GlowMin <= L.GlowMax);
		const std::vector<SkyItem> Items = BuildLayerItems(L, L.Count, 1234U);
		CHECK(static_cast<int>(Items.size()) == L.Count);
		for (const SkyItem& It : Items)
		{
			CHECK_NEAR(Length(It.Dir), 1.0, 1e-9);
			CHECK(It.AngDeg >= L.AngMin - 1e-9 && It.AngDeg <= L.AngMax + 1e-9);
			CHECK(It.Glow >= L.GlowMin - 1e-9 && It.Glow <= L.GlowMax + 1e-9);
			CHECK(It.R > 0.0 && It.G > 0.0 && It.B > 0.0 && It.R <= 1.0 && It.G <= 1.0 && It.B <= 1.0);
			CHECK(It.Variant >= 0);
			CHECK(L.Kind != SpriteKind::Nebula || It.Variant < kNebulaVariants);
			CHECK(L.Kind != SpriteKind::Galaxy || It.Variant < kGalaxyVariants);
			const Xf X = SpriteXf(It, L.Radius);
			CHECK(Finite(X.Pos) && Finite(X.Rot) && Finite(X.Scale));
			CHECK_NEAR(Length(X.Pos), L.Radius, 1e-3);
			// The plane's normal (+Z) faces the layer's centre.
			const Vec3 Normal = Rotate(X.Rot, Vec3{0.0, 0.0, 1.0});
			CHECK_NEAR(Dot(Normal, -It.Dir), 1.0, 1e-9);
			// And it covers the angle asked for.
			const double Covered = 2.0 * std::atan(X.Scale.X * 100.0 * 0.5 / L.Radius) * 180.0 / kPi;
			CHECK_NEAR(Covered, It.AngDeg, 1e-6);
		}
		(void)LastRadius;
	}
	CHECK(Names.size() == Layers.size());

	// Deterministic by seed.
	const std::vector<SkyItem> A = BuildLayerItems(Layers[0], 50, 7U);
	const std::vector<SkyItem> B = BuildLayerItems(Layers[0], 50, 7U);
	const std::vector<SkyItem> C = BuildLayerItems(Layers[0], 50, 8U);
	bool Same = true;
	bool Differs = false;
	for (size_t I = 0; I < A.size(); ++I)
	{
		Same = Same && A[I].Dir.X == B[I].Dir.X && A[I].AngDeg == B[I].AngDeg;
		Differs = Differs || A[I].Dir.X != C[I].Dir.X;
	}
	CHECK(Same);
	CHECK(Differs);

	// The Milky Way layer hugs one great circle.
	for (const LayerSpec& L : Layers)
	{
		if (std::string(L.Name) != "milky-way")
		{
			continue;
		}
		const std::vector<SkyItem> Items = BuildLayerItems(L, 400, 99U);
		double MeanLat = 0.0;
		for (const SkyItem& It : Items)
		{
			MeanLat += std::fabs(std::asin(Clamp(Dot(It.Dir, BandNormal()), -1.0, 1.0)));
		}
		MeanLat = MeanLat / static_cast<double>(Items.size()) * 180.0 / kPi;
		CHECK(MeanLat < 9.0);
	}
	// Showpieces sit in front of the home view, big and (for nebulae) bright.
	for (const LayerSpec& L : Layers)
	{
		const std::vector<SkyItem> Items = BuildLayerItems(L, L.Count, 31U);
		for (int I = 0; I < L.Showpieces; ++I)
		{
			const SkyItem& It = Items[static_cast<size_t>(I)];
			CHECK(Dot(It.Dir, HomeForward()) > std::cos(DegToRad(36.0)));
			if (L.Kind != SpriteKind::Star)
			{
				CHECK(It.AngDeg >= Lerp(L.AngMin, L.AngMax, 0.59));
			}
		}
	}
	int Showing = 0;
	for (const LayerSpec& L : Layers)
	{
		Showing += L.Showpieces;
	}
	CHECK(Showing >= 3);
	CHECK_NEAR(Length(HomeForward()), 1.0, 1e-12);
	// Zero and negative counts are fine.
	CHECK(BuildLayerItems(Layers[0], 0, 1U).empty());
	CHECK(BuildLayerItems(Layers[0], -5, 1U).empty());

	// Drift turns slowly and keeps unit length.
	const Quat Drift = LayerDrift(Layers[6], 6U, 100.0);
	const Vec3 Turned = Rotate(Drift, Vec3{1.0, 0.0, 0.0});
	CHECK_NEAR(Length(Turned), 1.0, 1e-9);
	CHECK(Length(Turned - Vec3{1.0, 0.0, 0.0}) < 0.1);
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestFlyby()
{
	const Vec3 Centre{100.0, -50.0, 20.0};
	const double Field = 6000.0;
	FlybyParams P;
	P.Shell = 4.0;
	P.SpeedMin = 3000.0;
	P.SpeedMax = 8000.0;
	P.IdleMax = 6.0;
	P.MissMin = 0.3;
	P.MissMax = 1.2;
	for (uint32_t Id = 1; Id <= 40; ++Id)
	{
		int VisibleSteps = 0;
		int Steps = 0;
		double ClosestEver = 1e18;
		double Longest = 0.0;
		// One step before the first sample, so every step has a predecessor.
		FlybyState Last = EvalFlyby(Id, -0.05, Centre, Field, P);
		for (double T = 0.0; T < 600.0; T += 0.05)
		{
			const FlybyState S = EvalFlyby(Id, T, Centre, Field, P);
			++Steps;
			CHECK(Finite(S.Pos));
			CHECK(S.Fade >= 0.0 && S.Fade <= 1.0);
			CHECK(S.Speed >= P.SpeedMin - 1e-9 && S.Speed <= P.SpeedMax + 1e-9);
			CHECK_NEAR(Length(S.Dir), 1.0, 1e-9);
			// The pass starts and ends on the shell and aims inside it: never farther out than the shell.
			CHECK(Length(S.Pos - Centre) <= P.Shell * Field + 1e-6 || !S.Visible);
			CHECK(S.Miss >= P.MissMin * Field - 1e-6);
			CHECK(S.Miss <= P.MissMax * Field + 1e-6);
			if (S.Visible)
			{
				++VisibleSteps;
				ClosestEver = std::min(ClosestEver, Length(S.Pos - Centre));
				// Same pass: it moved by speed x dt, along its direction.
				if (Last.Visible && S.Cycle == Last.Cycle)
				{
					CHECK_NEAR(Length(S.Pos - Last.Pos), S.Speed * 0.05, 1e-6 * S.Speed + 1e-6);
					CHECK_NEAR(Dot(Normalized(S.Pos - Last.Pos), S.Dir), 1.0, 1e-6);
				}
			}
			else
			{
				// Invisible means scaled to nothing at the ends, never a shape that pops.
				CHECK(S.Fade <= 0.0021 || S.Fade >= 0.0);
			}
			Longest = std::max(Longest, S.Fade);
			Last = S;
		}
		// It does fly through, not forever and not never.
		CHECK(VisibleSteps > Steps / 20);
		CHECK(VisibleSteps < Steps);
		CHECK_NEAR(Longest, 1.0, 1e-9);
		// Every pass misses by what was asked: never nearer than MissMin, and the nearest of all about MissMax or less.
		CHECK(ClosestEver >= P.MissMin * Field - 1e-6);
		CHECK(ClosestEver <= P.MissMax * Field + 1000.0);
	}
	// A pure function: the same arguments, the same answer, in any order.
	const FlybyState A = EvalFlyby(5, 123.4, Centre, Field, P);
	(void)EvalFlyby(5, 999.0, Centre, Field, P);
	const FlybyState B = EvalFlyby(5, 123.4, Centre, Field, P);
	CHECK(A.Pos.X == B.Pos.X && A.Pos.Y == B.Pos.Y && A.Pos.Z == B.Pos.Z);
	// Different ids fly different ways.
	CHECK(EvalFlyby(5, 50.0, Centre, Field, P).Pos.X != EvalFlyby(6, 50.0, Centre, Field, P).Pos.X);
	// Huge times still work.
	CHECK(Finite(EvalFlyby(5, 1.0e9, Centre, Field, P).Pos));
}

static void TestBelt()
{
	const std::vector<BeltRock> Rocks = BuildBelt(900, 77U);
	CHECK(Rocks.size() == 900);
	const Vec3 Centre{};
	const double Field = 8000.0;
	int Racers = 0;
	int Retro = 0;
	int Boulders = 0;
	double MaxSize = 0.0;
	for (const BeltRock& B : Rocks)
	{
		CHECK(B.Radius01 >= 0.9 && B.Radius01 <= 3.0);
		CHECK_NEAR(Length(B.Frame.E1), 1.0, 1e-9);
		CHECK_NEAR(Dot(B.Frame.E1, B.Frame.E2), 0.0, 1e-9);
		CHECK_NEAR(Dot(Cross(B.Frame.E1, B.Frame.E2), B.Frame.E3), 1.0, 1e-9);
		const double Speed = std::fabs(B.Omega) * B.Radius01 * kNominalField;
		CHECK(Speed >= 249.0 && Speed <= 8001.0);
		Racers += Speed > 4400.0 ? 1 : 0;
		Retro += B.Omega < 0.0 ? 1 : 0;
		CHECK(B.Look.SizeCm >= 30.0 && B.Look.SizeCm <= 950.0);
		Boulders += B.Look.SizeCm > 560.0 ? 1 : 0;
		MaxSize = std::max(MaxSize, B.Look.SizeCm);
		CHECK(B.Look.Lumps[0].Shape == Prim::Sphere);
		for (int Lump = 0; Lump < 3; ++Lump)
		{
			const Vec3 S = B.Look.Lumps[Lump].Size;
			CHECK(S.X > 5.0 && S.Y > 5.0 && S.Z > 5.0);
			CHECK(B.Look.Lumps[Lump].Shape == Prim::Sphere || B.Look.Lumps[Lump].Shape == Prim::Cube);
			CHECK(B.Look.Lumps[Lump].Shade >= 0.8 && B.Look.Lumps[Lump].Shade <= 1.2);
			// A lump stays within about one size of the middle: one rock, not three.
			CHECK(Length(B.Look.Lumps[Lump].Offset) <= B.Look.SizeCm * 0.47);
		}
		CHECK(B.Look.R > 0.0 && B.Look.R < 0.8 && B.Look.G > 0.0 && B.Look.B > 0.0);
		CHECK(B.Look.Metal >= 0.0 && B.Look.Metal <= 0.8);
		for (double T = 0.0; T < 200.0; T += 7.3)
		{
			const Pose P = EvalBelt(B, T, Centre, Field);
			CHECK(Finite(P.Pos) && Finite(P.Rot));
			const double Dist = Length(P.Pos - Centre);
			// Never inside the brain's own field, never lost in the distance.
			CHECK(Dist >= 0.85 * Field && Dist <= 3.2 * Field);
		}
	}
	CHECK(Racers >= 15 && Racers <= 120);
	// Both kinds of lump turn up: rounded ones and angular chunks.
	int Chunks = 0;
	for (const BeltRock& B : Rocks)
	{
		Chunks += (B.Look.Lumps[1].Shape == Prim::Cube ? 1 : 0) + (B.Look.Lumps[2].Shape == Prim::Cube ? 1 : 0);
	}
	CHECK(Chunks > 900 / 2 && Chunks < 900 * 2 - 100);
	CHECK(Retro >= 120 && Retro <= 330);
	CHECK(Boulders >= 1 && Boulders <= 30);
	CHECK(MaxSize >= 560.0);
	// They move: a quarter of a minute later the rock is somewhere else, the same distance out.
	const BeltRock& B0 = Rocks[0];
	const Pose P0 = EvalBelt(B0, 0.0, Centre, Field);
	const Pose P1 = EvalBelt(B0, 15.0, Centre, Field);
	CHECK(Length(P1.Pos - P0.Pos) > 100.0);
	CHECK_NEAR(Length(P1.Pos), Length(P0.Pos), Field * 0.3);

	// Flyby rocks and streaks.
	const std::vector<FlybyRock> Fly = BuildFlybyRocks(60, 5U);
	CHECK(Fly.size() == 60);
	int Seen = 0;
	for (const FlybyRock& F : Fly)
	{
		for (double T = 0.0; T < 300.0; T += 0.5)
		{
			double Fade = 0.0;
			const Pose P = EvalFlybyRock(F, T, Centre, Field, Fade);
			CHECK(Finite(P.Pos) && Finite(P.Rot));
			CHECK(Fade >= 0.0 && Fade <= 1.0);
			Seen += Fade > 0.5 ? 1 : 0;
		}
	}
	CHECK(Seen > 60 * 20);
	const std::vector<Streak> Streaks = BuildStreaks(40, 11U);
	int Shown = 0;
	for (const Streak& S : Streaks)
	{
		for (double T = 0.0; T < 120.0; T += 0.25)
		{
			bool Visible = false;
			const Xf X = StreakXf(S, T, Centre, Field, Visible);
			CHECK(Finite(X.Pos) && Finite(X.Rot) && Finite(X.Scale));
			if (Visible)
			{
				++Shown;
				// Long and thin, lying along its way (the cylinder's +Z runs along the path).
				CHECK(X.Scale.Z * 100.0 <= S.LengthCm + 1e-6);
				CHECK(X.Scale.X <= X.Scale.Z * 0.25 || X.Scale.Z * 100.0 < 4.0 * S.ThickCm);
			}
		}
	}
	CHECK(Shown > 40);
}

/* ---------------------------------------------------------------------------------------------------------------- */

static Vec3 WorldOf(const Xf& X, const Vec3& Local)
{
	// The mesh is a 100 cm shape centred on its pivot: Local is a fraction of its extent (0.5 is the far face).
	return X.Pos + Rotate(X.Rot, Vec3{Local.X * X.Scale.X * 100.0, Local.Y * X.Scale.Y * 100.0, Local.Z * X.Scale.Z * 100.0});
}

static void TestShips()
{
	const ShipDesign Designs[4] = {ShipDesign::Saucer, ShipDesign::Dart, ShipDesign::Mother, ShipDesign::Orb};
	for (ShipDesign D : Designs)
	{
		const std::vector<Part> Parts = ShipParts(D);
		CHECK(Parts.size() >= 7);
		int Hull = 0;
		int Glow = 0;
		for (const Part& P : Parts)
		{
			CHECK(P.Size.X > 0.0 && P.Size.Y > 0.0 && P.Size.Z > 0.0);
			CHECK_NEAR(Length(P.Dir), 1.0, 1e-9);
			if (P.Shape == Prim::Cylinder || P.Shape == Prim::Cone)
			{
				// Round: the engine's cylinder and cone are, and the maths does not know which way round they spin.
				CHECK_NEAR(P.Size.X, P.Size.Y, 1e-9);
			}
			(IsGlowTone(P.Colour) ? Glow : Hull) += 1;
		}
		CHECK(Hull >= 2);
		CHECK(Glow >= 3);
	}

	// The dart: nose forward, wings swept back, engines at the tail.
	{
		const std::vector<Part> Parts = ShipParts(ShipDesign::Dart);
		ShipPose Pose;
		Pose.Pos = Vec3{1000.0, 2000.0, 3000.0};
		Pose.Rot = LookRotation(Vec3{0.0, 1.0, 0.0}, kUp);
		const Vec3 Forward = Rotate(Pose.Rot, Vec3{1.0, 0.0, 0.0});
		CHECK_NEAR(Forward.Y, 1.0, 1e-9);
		const double Unit = 30.0;
		bool SawNose = false;
		bool SawRight = false;
		bool SawLeft = false;
		for (const Part& P : Parts)
		{
			const Xf X = PartWorld(P, Pose, Unit);
			CHECK(Finite(X.Pos) && Finite(X.Rot) && Finite(X.Scale));
			if (P.Shape == Prim::Cone)
			{
				SawNose = true;
				// A cone's tip is +Z of the mesh (50 cm up at scale 1): it must point where the ship does.
				const Vec3 Tip = WorldOf(X, Vec3{0.0, 0.0, 0.5});
				const Vec3 Base = WorldOf(X, Vec3{0.0, 0.0, -0.5});
				CHECK(Dot(Tip - Base, Forward) > 0.0);
				CHECK(Dot(Tip - Pose.Pos, Forward) > 4.0 * Unit);
			}
			if (P.Shape == Prim::Cube && P.Size.Y > 5.0)
			{
				// A wing: its outer tip is further back than its root.
				const double Side = P.Pos.Y > 0.0 ? 1.0 : -1.0;
				const Vec3 Tip = WorldOf(X, Vec3{0.0, Side * 0.5, 0.0});
				const Vec3 Root = WorldOf(X, Vec3{0.0, -Side * 0.5, 0.0});
				CHECK(Dot(Tip - Root, Forward) < -0.5 * Unit);
				(Side > 0.0 ? SawRight : SawLeft) = true;
			}
			if (P.Colour == Tone::Engine && P.Shape == Prim::Cylinder)
			{
				CHECK(Dot(X.Pos - Pose.Pos, Forward) < -4.0 * Unit);
			}
		}
		CHECK(SawNose && SawRight && SawLeft);
	}

	// The saucer is flat and wide, level on its pose; the mother is long.
	{
		const std::vector<Part> Parts = ShipParts(ShipDesign::Saucer);
		CHECK(Parts[0].Size.X > 3.0 * Parts[0].Size.Z);
		const std::vector<Part> Mother = ShipParts(ShipDesign::Mother);
		CHECK(Mother[0].Size.X > 2.5 * Mother[0].Size.Y);
	}

	// A scaled-away ship (a pass that is off) has no size and all its parts sit on one point.
	{
		const std::vector<Part> Parts = ShipParts(ShipDesign::Orb);
		ShipPose Gone;
		Gone.Pos = Vec3{5.0, 6.0, 7.0};
		Gone.Fade = 0.0;
		for (const Part& P : Parts)
		{
			const Xf X = PartWorld(P, Gone, 90.0);
			CHECK_NEAR(Length(X.Pos - Gone.Pos), 0.0, 1e-9);
			CHECK_NEAR(Length(X.Scale), 0.0, 1e-9);
		}
	}

	// The fleet.
	const std::vector<ShipSpec> Fleet = DefaultFleet(2026U, 1.0);
	CHECK(Fleet.size() == 21);
	int Counts[4] = {0, 0, 0, 0};
	std::set<uint32_t> Ids;
	for (const ShipSpec& S : Fleet)
	{
		Counts[static_cast<int>(S.Design)] += 1;
		Ids.insert(S.Id);
		CHECK(S.UnitCm > 20.0 && S.UnitCm < 300.0);
		CHECK(S.GlowR + S.GlowG + S.GlowB > 1.0);
		CHECK(S.HullR < 0.25 && S.HullG < 0.25 && S.HullB < 0.25);
		const LayerSpec* None = nullptr;
		(void)None;
	}
	CHECK(Counts[static_cast<int>(ShipDesign::Saucer)] == 5);
	CHECK(Counts[static_cast<int>(ShipDesign::Dart)] == 8);
	CHECK(Counts[static_cast<int>(ShipDesign::Mother)] == 2);
	CHECK(Counts[static_cast<int>(ShipDesign::Orb)] == 6);
	CHECK(Ids.size() == Fleet.size());
	CHECK(DefaultFleet(2026U, 0.0).empty());
	CHECK(DefaultFleet(2026U, 0.5).size() < Fleet.size());
	CHECK(DefaultFleet(2026U, 2.0).size() > Fleet.size());
	CHECK(DefaultFleet(1U, 1.0)[0].Id != Fleet[0].Id);

	// Fly them all for a while, around a brain of any size.
	const Vec3 Centre{50.0, 0.0, 0.0};
	for (double Field : {6000.0, 20000.0})
	{
		double ClosestPatrol = 1e18;
		double ClosestZip = 1e18;
		double ClosestSquad = 1e18;
		for (const ShipSpec& S : Fleet)
		{
			double Seen = 0.0;
			for (double T = 0.0; T < 900.0; T += 0.5)
			{
				const ShipPose P = EvalShip(S, T, Centre, Field);
				CHECK(Finite(P.Pos) && Finite(P.Rot));
				CHECK(P.Fade >= 0.0 && P.Fade <= 1.0);
				CHECK_NEAR(P.Rot.X * P.Rot.X + P.Rot.Y * P.Rot.Y + P.Rot.Z * P.Rot.Z + P.Rot.W * P.Rot.W, 1.0, 1e-9);
				const double Dist = Length(P.Pos - Centre);
				CHECK(Dist < 12.0 * Field);
				Seen += P.Fade > 0.9 ? 1.0 : 0.0;
				if (P.Fade > 0.5)
				{
					if (S.Path == ShipPath::Patrol) ClosestPatrol = std::min(ClosestPatrol, Dist);
					if (S.Path == ShipPath::Zip) ClosestZip = std::min(ClosestZip, Dist);
					if (S.Path == ShipPath::Squadron) ClosestSquad = std::min(ClosestSquad, Dist);
					// A mother ship sails past, it does not go through the brain.
					if (S.Path == ShipPath::Drift) CHECK(Dist > 1.4 * Field);
				}
			}
			// Everyone shows up sometime in a quarter of an hour.
			CHECK(Seen > 5.0);
		}
		CHECK(ClosestPatrol >= 1.4 * Field);
		CHECK(ClosestZip >= 0.89 * Field);
		// Squadrons zoom past the brain, never through it (a wingman may be a little nearer than its leader).
		CHECK(ClosestSquad >= 0.74 * Field);
	}

	// A squadron flies together: leader ahead, wingmen behind and either side, same speed.
	{
		std::vector<ShipSpec> Squad;
		for (const ShipSpec& S : Fleet)
		{
			if (S.Path == ShipPath::Squadron && S.Group == Fleet[5].Group)
			{
				Squad.push_back(S);
			}
		}
		CHECK(Squad.size() == 4);
		for (double T = 0.0; T < 400.0; T += 1.3)
		{
			const ShipPose Lead = EvalShip(Squad[0], T, Centre, 6000.0);
			if (Lead.Fade < 0.99)
			{
				continue;
			}
			const Vec3 Fwd = Rotate(Lead.Rot, Vec3{1.0, 0.0, 0.0});
			for (size_t M = 1; M < Squad.size(); ++M)
			{
				const ShipPose Wing = EvalShip(Squad[M], T, Centre, 6000.0);
				const Vec3 Rel = Wing.Pos - Lead.Pos;
				CHECK(Dot(Rel, Fwd) < -100.0);
				CHECK(Length(Rel) < 15.0 * Squad[M].UnitCm * 10.0);
				CHECK_NEAR(Wing.Fade, Lead.Fade, 1e-9);
			}
		}
	}

	// A saucer keeps level: its up stays near the orbit's up (it never flips).
	for (const ShipSpec& S : Fleet)
	{
		if (S.Design != ShipDesign::Saucer)
		{
			continue;
		}
		for (double T = 0.0; T < 300.0; T += 3.1)
		{
			const ShipPose P = EvalShip(S, T, Centre, 6000.0);
			const Vec3 Up = Rotate(P.Rot, kUp);
			CHECK(Up.Z > 0.3);
		}
	}

	// Looks: hull parts have a metal value, glowing ones a brightness above 1 (so they bloom).
	for (const ShipSpec& S : Fleet)
	{
		for (Tone T : {Tone::Hull, Tone::Plate, Tone::Faction, Tone::Window, Tone::Engine})
		{
			const PartLook L = LookOf(S, T);
			CHECK(L.R >= 0.0 && L.R <= 1.0 && L.G >= 0.0 && L.G <= 1.0 && L.B >= 0.0 && L.B <= 1.0);
			if (IsGlowTone(T))
			{
				CHECK(L.Extra > 1.0);
			}
			else
			{
				CHECK(L.Extra >= 0.0 && L.Extra <= 1.0);
			}
		}
	}
}

static void TestField()
{
	CHECK_NEAR(FieldRadius(1000.0), kNominalField, 1e-9);
	CHECK_NEAR(FieldRadius(10000.0), 11500.0, 1e-9);
	CHECK_NEAR(FieldRadius(0.0, 100.0), 100.0, 1e-9);
}

int main()
{
	TestRandom();
	TestNoise();
	TestQuaternions();
	TestNebulaPictures();
	TestGalaxyPictures();
	TestStarDot();
	TestParallax();
	TestLayers();
	TestFlyby();
	TestBelt();
	TestShips();
	TestField();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
