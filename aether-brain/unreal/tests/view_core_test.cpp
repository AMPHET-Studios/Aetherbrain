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
	CHECK(ApparentRadius(1.2, 300000.0, kMinThreadAngle) > 60.0);
	// Nonsense distances (behind the camera, not a number) leave the body alone.
	CHECK_NEAR(ApparentRadius(20.0, -5.0, kMinNodeAngle), 20.0, 1e-12);
	CHECK_NEAR(ApparentRadius(20.0, 0.0, kMinNodeAngle), 20.0, 1e-12);
	CHECK_NEAR(ApparentRadius(20.0, std::numeric_limits<double>::quiet_NaN(), kMinNodeAngle), 20.0, 1e-12);
	CHECK_NEAR(ApparentRadius(20.0, std::numeric_limits<double>::infinity(), kMinNodeAngle), 20.0, 1e-12);
}

static void TestRanks()
{
	// Seen from far enough that every body is at its minimum, a sun is bigger than a star, a star than a planet, a planet than a moon.
	const double D = 300000.0;
	double Last = 1e30;
	for (int Rank = 0; Rank <= 3; ++Rank)
	{
		const double R = ApparentRadius(1.0, D, MinAngleOfRank(Rank));
		CHECK(R < Last);
		CHECK(R >= 1.0);
		Last = R;
	}
	// A moon is still at least a pixel across (about 0.0005 rad) and a sun not a blob that hides its neighbours (under 0.003 rad).
	CHECK(MinAngleOfRank(3) > 0.0005);
	CHECK(MinAngleOfRank(0) < 0.003);
	// Nonsense ranks are the nearest real one.
	CHECK_NEAR(MinAngleOfRank(-4), MinAngleOfRank(0), 1e-15);
	CHECK_NEAR(MinAngleOfRank(99), MinAngleOfRank(3), 1e-15);
	// A name is readable from afar: 3 km away it is at least 21 m tall in world units of cm (0.007 rad).
	CHECK(ApparentRadius(24.0, D, kMinLabelAngle) > 2000.0);
	CHECK_NEAR(ApparentRadius(24.0, 100.0, kMinLabelAngle), 24.0, 1e-9);
}

static void TestPicking()
{
	// Nothing offered, nothing picked.
	PickState None;
	CHECK(None.Index < 0);

	// A body whose centre the ray passes through is hit; one beyond its reach is not.
	PickState A;
	PickOffer(A, 7, 0.0, 50.0, 1000.0);
	CHECK(A.Index == 7 && A.bInside);
	PickState Far;
	PickOffer(Far, 7, 80.0, 50.0, 1000.0);
	CHECK(Far.Index < 0);
	// Even a tiny body is hit within kPickAngle of its centre: 4 m at 1 km.
	PickState Small;
	PickOffer(Small, 3, 3.0, 0.1, 1000.0);
	CHECK(Small.Index == 3);
	PickOffer(Small, 4, 5.0, 0.1, 1000.0);
	CHECK(Small.Index == 3);
	CHECK_NEAR(PickReach(0.1, 1000.0), 1000.0 * kPickAngle, 1e-9);
	CHECK_NEAR(PickReach(50.0, 10.0), 57.5, 1e-9);

	// Of two bodies the ray is clearly inside, the nearer wins (it hides the other) whichever is offered first.
	for (int Order = 0; Order < 2; ++Order)
	{
		PickState S;
		const int First = Order == 0 ? 1 : 2;
		const int Second = 3 - First;
		const auto Offer = [&S](int Which) {
			if (Which == 1) PickOffer(S, 1, 10.0, 100.0, 500.0);
			else PickOffer(S, 2, 0.0, 100.0, 900.0);
		};
		Offer(First);
		Offer(Second);
		CHECK(S.Index == 1);
	}
	// A body only grazed does not beat one clearly pointed at, even a farther one.
	{
		PickState S;
		PickOffer(S, 1, 100.0, 100.0, 300.0); // grazed (within reach 115, beyond 0.8 of it)
		PickOffer(S, 2, 10.0, 100.0, 900.0);  // clearly inside, behind
		CHECK(S.Index == 2);
		PickOffer(S, 3, 0.0, 100.0, 800.0);   // clearly inside and nearer than 2
		CHECK(S.Index == 3);
	}
	// Two grazed ones: the ray nearer the centre of the body it is on wins, the nearer in depth only breaks a tie.
	{
		PickState S;
		PickOffer(S, 1, 110.0, 100.0, 300.0);
		PickOffer(S, 2, 95.0, 100.0, 900.0);
		CHECK(S.Index == 2);
		PickOffer(S, 3, 95.0, 100.0, 900.0);
		CHECK(S.Index == 2);
	}
	// Nonsense distances do not break the reach.
	PickState Odd;
	PickOffer(Odd, 5, 1.0, 10.0, std::numeric_limits<double>::quiet_NaN());
	CHECK(Odd.Index == 5);
	PickState Zero;
	PickOffer(Zero, 6, 0.0, 0.0, 0.0);
	CHECK(Zero.Index == 6);
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
	TestRanks();
	TestPicking();
	TestUpdateGap();
	TestLooksUnplaced();
	TestRingFingerprint();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
