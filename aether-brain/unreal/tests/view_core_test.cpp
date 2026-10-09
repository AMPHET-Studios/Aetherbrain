// Tests for the brain viewer's visibility and budget maths (AetherViewMath.h). Plain C++, no Unreal: run with unreal/tests/run.sh
// (or `pnpm exec vitest run apps/desktop/test/unreal-space.test.ts`, which compiles and runs this when a C++ compiler is installed).
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherViewMath.h"

#include <cstdio>
#include <limits>
#include <vector>

using namespace AetherView;

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

static void TestApparentRadius()
{
	// Close up a body is as big as it is.
	CHECK_NEAR(ApparentRadius(50.0, 1000.0, kMinNodeAngle), 50.0, 1e-9);
	// Far away it is never less than MinAngle across: a 20 cm moon seen from 3 km.
	CHECK_NEAR(ApparentRadius(20.0, 300000.0, kMinNodeAngle), 270.0, 1e-9);
	CHECK(ApparentRadius(20.0, 300000.0, kMinNodeAngle) > 20.0 * 10.0);
	// The angle it subtends is at least the minimum, at every distance.
	for (double D = 100.0; D < 1e7; D *= 3.7)
	{
		const double R = ApparentRadius(20.0, D, kMinNodeAngle);
		CHECK(R >= 20.0);
		CHECK(R / D >= kMinNodeAngle * 0.999);
	}
	// A thread is thinner than a node at the same distance, so links never swallow the bodies they join.
	CHECK(ApparentRadius(1.2, 300000.0, kMinThreadAngle) < ApparentRadius(20.0, 300000.0, kMinNodeAngle));
	CHECK(ApparentRadius(1.2, 300000.0, kMinThreadAngle) > 100.0);
	// Nonsense distances (behind the camera, not a number) leave the body alone.
	CHECK_NEAR(ApparentRadius(20.0, -5.0, kMinNodeAngle), 20.0, 1e-12);
	CHECK_NEAR(ApparentRadius(20.0, 0.0, kMinNodeAngle), 20.0, 1e-12);
	CHECK_NEAR(ApparentRadius(20.0, std::numeric_limits<double>::quiet_NaN(), kMinNodeAngle), 20.0, 1e-12);
	CHECK_NEAR(ApparentRadius(20.0, std::numeric_limits<double>::infinity(), kMinNodeAngle), 20.0, 1e-12);
}

static void TestUpdateGap()
{
	// A small scene: 30 a second.
	CHECK_NEAR(UpdateGap(0.0), kMinUpdateGap, 1e-12);
	CHECK_NEAR(UpdateGap(0.002), kMinUpdateGap, 1e-12);
	// A scene that takes 20 ms may take a fifth of the time: one redraw per 100 ms.
	CHECK_NEAR(UpdateGap(0.020), 0.100, 1e-12);
	// Never slower than twice a second, however long it took, and nonsense counts as nothing.
	CHECK_NEAR(UpdateGap(5.0), kMaxUpdateGap, 1e-12);
	CHECK_NEAR(UpdateGap(-1.0), kMinUpdateGap, 1e-12);
	CHECK_NEAR(UpdateGap(std::numeric_limits<double>::quiet_NaN()), kMinUpdateGap, 1e-12);
	// Monotone: a slower redraw never asks for a shorter wait.
	double Last = 0.0;
	for (double S = 0.0; S < 1.0; S += 0.003)
	{
		const double G = UpdateGap(S);
		CHECK(G >= Last - 1e-12);
		Last = G;
	}
}

static void TestLooksUnplaced()
{
	auto Unplaced = [](const std::vector<double>& P) {
		return LooksUnplaced(static_cast<int>(P.size() / 3), [&P](int I, int Axis) { return P[static_cast<size_t>(3 * I + Axis)]; });
	};
	CHECK(!Unplaced({}));
	CHECK(!Unplaced({0, 0, 0}));
	// A vault just opened: every node at the origin.
	CHECK(Unplaced(std::vector<double>(3 * 40, 0.0)));
	// All at one spot that is not the origin is just as unplaced.
	std::vector<double> Same(3 * 10);
	for (int I = 0; I < 10; ++I)
	{
		Same[static_cast<size_t>(3 * I)] = 7.5;
		Same[static_cast<size_t>(3 * I + 1)] = -2.0;
		Same[static_cast<size_t>(3 * I + 2)] = 1.0;
	}
	CHECK(Unplaced(Same));
	// One node somewhere else (any axis, at the end or in the middle) and it is a layout.
	for (int Axis = 0; Axis < 3; ++Axis)
	{
		for (int Which : {1, 5, 9})
		{
			std::vector<double> P = Same;
			P[static_cast<size_t>(3 * Which + Axis)] += 0.01;
			CHECK(!Unplaced(P));
		}
	}
	// A hair of noise below a thousandth of a unit is still unplaced.
	std::vector<double> Noise = Same;
	Noise[3 * 4] += 0.0004;
	CHECK(Unplaced(Noise));
	// Single-precision places work too (the viewer's points are narrowed or widened freely).
	const std::vector<float> Floats(3 * 6, 0.f);
	CHECK(LooksUnplaced(6, [&Floats](int I, int Axis) { return Floats[static_cast<size_t>(3 * I + Axis)]; }));
}

static void TestRingFingerprint()
{
	auto Fingerprint = [](const std::vector<std::pair<int, double>>& Rings) {
		uint32_t H = kRingSeed;
		for (const auto& R : Rings)
		{
			H = FoldRing(H, R.first, R.second);
		}
		return H;
	};
	const std::vector<std::pair<int, double>> A = {{0, 30.0}, {3, 12.5}, {7, 4.0}};
	CHECK(Fingerprint(A) == Fingerprint(A));
	CHECK(Fingerprint(A) != kRingSeed);
	// Another parent, another radius, another order, one fewer: all change it.
	CHECK(Fingerprint(A) != Fingerprint({{0, 30.0}, {3, 12.5}, {8, 4.0}}));
	CHECK(Fingerprint(A) != Fingerprint({{0, 30.0}, {3, 12.5}, {7, 4.5}}));
	CHECK(Fingerprint(A) != Fingerprint({{3, 12.5}, {0, 30.0}, {7, 4.0}}));
	CHECK(Fingerprint(A) != Fingerprint({{0, 30.0}, {3, 12.5}}));
	// A radius that only moves in the float noise is the same ring.
	CHECK(Fingerprint(A) == Fingerprint({{0, 30.000001}, {3, 12.5000001}, {7, 4.0}}));
	// A negative or missing parent (INDEX_NONE) is a valid input.
	CHECK(Fingerprint({{-1, 5.0}}) != Fingerprint({{0, 5.0}}));
	// Many rings: no two of a few thousand different single rings share a fingerprint.
	std::vector<uint32_t> Seen;
	for (int P = 0; P < 60; ++P)
	{
		for (int R = 1; R <= 50; ++R)
		{
			Seen.push_back(Fingerprint({{P, static_cast<double>(R) * 0.37}}));
		}
	}
	std::sort(Seen.begin(), Seen.end());
	CHECK(std::adjacent_find(Seen.begin(), Seen.end()) == Seen.end());
}

int main()
{
	TestApparentRadius();
	TestUpdateGap();
	TestLooksUnplaced();
	TestRingFingerprint();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
