// Tests for the Niagara layer's maths (AetherFxMath.h): the link index, the streams of events, which link a pulse runs along, shooting
// stars, coronas, ripples, dust and the pool of slots. Plain C++, no Unreal: run with unreal/tests/run.sh
// (or `pnpm exec vitest run apps/desktop/test/unreal-space.test.ts`, which compiles and runs this when a C++ compiler is installed).
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherFxMath.h"

#include <algorithm>
#include <cstdio>
#include <set>
#include <string>

using namespace AetherFx;

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

/* ---------------------------------------------------------------------------------------------------------------- */
/* The link index                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

static void TestLinkIndex()
{
	// Links 0-1, 1-2, 2-0, a self link, a link out of range, a negative one, a repeat of 0-1, and a stray int at the end.
	const int Pairs[] = {0, 1, 1, 2, 2, 0, 3, 3, 1, 9, -1, 2, 0, 1, 2};
	LinkIndex L;
	L.Build(Pairs, 15, 4);
	CHECK(L.NodeCount() == 4);
	CHECK(L.LinkCount() == 4);
	CHECK(L.Degree(0) == 3);
	CHECK(L.Degree(1) == 3);
	CHECK(L.Degree(2) == 2);
	CHECK(L.Degree(3) == 0);
	CHECK(L.Degree(-1) == 0);
	CHECK(L.Degree(4) == 0);
	int Total = 0;
	for (int N = 0; N < L.NodeCount(); ++N)
	{
		Total += L.Degree(N);
		for (int I = 0; I < L.Degree(N); ++I)
		{
			int A = -1;
			int B = -1;
			L.Ends(L.IncidentLink(N, I), A, B);
			CHECK(A == N || B == N);
		}
	}
	CHECK(Total == 2 * L.LinkCount());

	// A link whose first end is the first number past the nodes (and one whose second end is) is out of the graph.
	const int Past[] = {4, 1, 1, 4, 3, 1};
	LinkIndex PastEnd;
	PastEnd.Build(Past, 6, 4);
	CHECK(PastEnd.LinkCount() == 1 && PastEnd.Degree(3) == 1 && PastEnd.Degree(1) == 1);

	// Nothing, nowhere.
	LinkIndex Empty;
	Empty.Build(nullptr, 0, 0);
	CHECK(Empty.LinkCount() == 0 && Empty.NodeCount() == 0);
	Empty.Build(Pairs, 15, 0);
	CHECK(Empty.LinkCount() == 0);
	Empty.Build(Pairs, -4, 4);
	CHECK(Empty.LinkCount() == 0 && Empty.NodeCount() == 4);
	Empty.Build(nullptr, 6, 4);
	CHECK(Empty.LinkCount() == 0);

	// Rebuilding replaces everything.
	L.Build(Pairs, 2, 2);
	CHECK(L.LinkCount() == 1 && L.Degree(0) == 1 && L.Degree(1) == 1 && L.Degree(2) == 0);

	// A huge brain is indexed only so far, and every link of the index is whole.
	std::vector<int> Big;
	const int Nodes = 1000;
	for (int I = 0; I < kMaxIndexedLinks + 5000; ++I)
	{
		Big.push_back(I % Nodes);
		Big.push_back((I * 7 + 1) % Nodes);
	}
	L.Build(Big.data(), static_cast<int>(Big.size()), Nodes);
	CHECK(L.LinkCount() <= kMaxIndexedLinks);
	CHECK(L.LinkCount() > kMaxIndexedLinks - 1000);
	int Sum = 0;
	for (int N = 0; N < Nodes; ++N)
	{
		Sum += L.Degree(N);
	}
	CHECK(Sum == 2 * L.LinkCount());
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Streams of events                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

static void TestEventTimes()
{
	const double Rate = 4.0;
	for (uint32_t K = 0; K < 500U; ++K)
	{
		const double T = EventTime(7U, kPulseSalt, Rate, K);
		CHECK(T >= static_cast<double>(K) / Rate && T < static_cast<double>(K + 1U) / Rate);
		CHECK(T == EventTime(7U, kPulseSalt, Rate, K));
	}
	// The slots do not overlap, so the events are in order; the salts are different streams.
	CHECK(EventTime(7U, kPulseSalt, Rate, 3U) < EventTime(7U, kPulseSalt, Rate, 4U));
	int Same = 0;
	for (uint32_t K = 0; K < 200U; ++K)
	{
		Same += EventTime(7U, kPulseSalt, Rate, K) == EventTime(7U, kMeteorSalt, Rate, K) ? 1 : 0;
	}
	CHECK(Same == 0);
}

/** Runs windows of the given lengths from 0 to End, returns every event delivered. */
static std::vector<uint32_t> Run(uint32_t Seed, uint32_t Salt, double Rate, double End, uint32_t FrameSeed, double MinDt, double MaxDt, int MaxCount = kMaxEventsPerFrame)
{
	std::vector<uint32_t> All;
	Sp::Rng R(FrameSeed);
	double Prev = 0.0;
	while (Prev < End)
	{
		const double Now = Prev + R.Range(MinDt, MaxDt);
		const std::vector<uint32_t> Due = DueEvents(Seed, Salt, Rate, Prev, Now, kMaxLateSeconds, MaxCount);
		All.insert(All.end(), Due.begin(), Due.end());
		Prev = Now;
	}
	return All;
}

static void TestDueEvents()
{
	const double Rate = 7.3;
	// Frames of any ordinary length deliver every event once, in order, none twice and none missed.
	for (uint32_t Trial = 0; Trial < 12U; ++Trial)
	{
		const double Dt = Trial % 2U == 0U ? 1.0 / 240.0 : 0.2;
		const std::vector<uint32_t> All = Run(11U + Trial, kPulseSalt, Rate, 60.0, 100U + Trial, Dt * 0.25, Dt);
		std::set<uint32_t> Seen(All.begin(), All.end());
		CHECK(Seen.size() == All.size());
		CHECK(std::is_sorted(All.begin(), All.end()));
		// All events with time in [0, End) where End is wherever the last frame stopped: the count is about Rate * End.
		CHECK(All.size() >= static_cast<size_t>(Rate * 59.0));
		CHECK(All.size() <= static_cast<size_t>(Rate * 61.0) + 1U);
		// Contiguous numbers (no event missed).
		for (size_t I = 1; I < All.size(); ++I)
		{
			CHECK(All[I] == All[I - 1U] + 1U);
		}
	}

	// A long frame (a hitch of two seconds) never makes a burst: only what is within MaxLate, and never more than the cap.
	const std::vector<uint32_t> Hitch = DueEvents(3U, kPulseSalt, 14.0, 10.0, 12.0);
	// (Pinned as numbers on purpose: six starts in a frame at most, nothing more than a quarter of a second late.)
	CHECK(kMaxEventsPerFrame == 6 && kMaxLateSeconds == 0.25 && kLingerSeconds == 0.8);
	CHECK(kPulseSlots == 40 && kMeteorSlots == 6 && kRippleSlots == 4 && kSunSlots == 3);
	CHECK(static_cast<int>(Hitch.size()) <= 6);
	CHECK(Hitch.size() >= 2U);
	for (const uint32_t K : Hitch)
	{
		CHECK(EventTime(3U, kPulseSalt, 14.0, K) >= 12.0 - 0.25);
		CHECK(EventTime(3U, kPulseSalt, 14.0, K) < 12.0);
	}
	// The cap keeps the newest.
	const std::vector<uint32_t> Capped = DueEvents(3U, kPulseSalt, 100.0, 0.0, 0.25, 0.25, 3);
	CHECK(Capped.size() == 3U);
	const std::vector<uint32_t> Everything = DueEvents(3U, kPulseSalt, 100.0, 0.0, 0.25, 0.25, 1000);
	CHECK(Everything.size() > 3U);
	CHECK(Capped.back() == Everything.back() && Capped.front() == Everything[Everything.size() - 3U]);

	// Nothing at no rate, a backwards or empty window, or a cap of nothing; nothing is slow at an absurd time.
	CHECK(DueEvents(1U, kPulseSalt, 0.0, 0.0, 1.0).empty());
	CHECK(DueEvents(1U, kPulseSalt, -3.0, 0.0, 1.0).empty());
	CHECK(DueEvents(1U, kPulseSalt, 5.0, 2.0, 1.0).empty());
	CHECK(DueEvents(1U, kPulseSalt, 5.0, 1.0, 1.0).empty());
	CHECK(DueEvents(1U, kPulseSalt, 5.0, 0.0, 1.0, 0.25, 0).empty());
	CHECK(DueEvents(1U, kPulseSalt, 5.0, 1.0e12, 1.0e12 + 0.1).empty());
	CHECK(DueEvents(1U, kPulseSalt, 5.0, 3.0e8, 3.0e8 + 0.1).empty());
	// A silly rate is held to the cap, so a frame is still cheap and bounded.
	CHECK(static_cast<int>(DueEvents(1U, kPulseSalt, 1.0e9, 0.0, 0.25, 0.25, 1000).size()) <= static_cast<int>(kMaxEventRate * 0.25) + 2);
	// Time before zero is ignored.
	CHECK(DueEvents(1U, kPulseSalt, 5.0, -10.0, -5.0).empty());
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Pulses                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

static void TestPulseRate()
{
	CHECK_NEAR(PulseRate(0, 1.0), 0.0, 1e-12);
	CHECK_NEAR(PulseRate(-4, 1.0), 0.0, 1e-12);
	CHECK_NEAR(PulseRate(100, 0.0), 0.0, 1e-12);
	CHECK_NEAR(PulseRate(100, -1.0), 0.0, 1e-12);
	double Last = 0.0;
	for (const int Links : {1, 3, 10, 100, 1000, 10000, 100000, 10000000})
	{
		const double Rate = PulseRate(Links, 1.0);
		CHECK(Rate >= Last);
		CHECK(Rate > 0.0 && Rate <= 14.0);
		Last = Rate;
	}
	CHECK_NEAR(PulseRate(500, 2.0), 2.0 * PulseRate(500, 1.0), 1e-9);
	// A rate from the formula: 2 + 1.5 log10(1 + links); held to 14 a second however many links (and Density multiplies after).
	CHECK_NEAR(PulseRate(99, 1.0), 5.0, 1e-9);
	CHECK_NEAR(PulseRate(1000000000, 1.0), 14.0, 1e-9);
	CHECK_NEAR(PulseRate(1000000000, 2.0), 28.0, 1e-9);
}

static void TestPulseSizes()
{
	CHECK_NEAR(PulseSeconds(0.0), 0.6, 1e-12);
	CHECK_NEAR(PulseSeconds(1.0e9), 3.5, 1e-12);
	CHECK_NEAR(PulseSeconds(kPulseSpeed * 2.0), 2.0, 1e-9);
	CHECK(PulseSeconds(900.0) >= 0.6 && PulseSeconds(900.0) <= 3.5);
	CHECK_NEAR(PulseSize(0.0), 10.0, 1e-12);
	CHECK_NEAR(PulseSize(1.0e6), 70.0, 1e-12);
	CHECK(PulseSize(100.0) > 10.0 && PulseSize(100.0) < 70.0);
}

static LinkIndex Ring(int Nodes)
{
	std::vector<int> Pairs;
	for (int I = 0; I < Nodes; ++I)
	{
		Pairs.push_back(I);
		Pairs.push_back((I + 1) % Nodes);
	}
	LinkIndex L;
	L.Build(Pairs.data(), static_cast<int>(Pairs.size()), Nodes);
	return L;
}

static void TestPickLink()
{
	// No links: nothing to pick.
	LinkIndex None;
	None.Build(nullptr, 0, 5);
	CHECK(PickLink(None, 1U, 0U, -1, 0.5).Link == -1);
	CHECK(PickLink(None, 1U, 0U, 2, 1.0).From == -1);

	const int Nodes = 60;
	const LinkIndex L = Ring(Nodes);
	std::set<int> Used;
	int OutOfFocus = 0;
	for (uint32_t K = 0; K < 4000U; ++K)
	{
		const LinkPick P = PickLink(L, 5U, K, -1, 0.65);
		CHECK(P.Link >= 0 && P.Link < L.LinkCount());
		int A = 0;
		int B = 0;
		L.Ends(P.Link, A, B);
		CHECK((P.From == A && P.To == B) || (P.From == B && P.To == A));
		Used.insert(P.Link);
		// Same inputs, same pick.
		const LinkPick Again = PickLink(L, 5U, K, -1, 0.65);
		CHECK(Again.Link == P.Link && Again.From == P.From && Again.To == P.To);
		OutOfFocus += P.From == A ? 1 : 0;
	}
	// Without a focus every link is used, either way round about equally.
	CHECK(static_cast<int>(Used.size()) == L.LinkCount());
	CHECK(std::fabs(static_cast<double>(OutOfFocus) / 4000.0 - 0.5) < 0.05);

	// With a focus, its share of the pulses run on its own links, mostly leaving it.
	const int Focus = 17;
	int OnFocus = 0;
	int Leaving = 0;
	const int Draws = 6000;
	for (uint32_t K = 0; K < static_cast<uint32_t>(Draws); ++K)
	{
		const LinkPick P = PickLink(L, 9U, K, Focus, 0.65);
		int A = 0;
		int B = 0;
		L.Ends(P.Link, A, B);
		if (A == Focus || B == Focus)
		{
			++OnFocus;
			Leaving += P.From == Focus ? 1 : 0;
		}
	}
	// 65 % are chosen on the focus, plus the few ordinary picks that land on it (2 of 60 links).
	CHECK(std::fabs(static_cast<double>(OnFocus) / Draws - (0.65 + 0.35 * 2.0 / 60.0)) < 0.04);
	CHECK(static_cast<double>(Leaving) / OnFocus > 0.55);

	// A focus with no links (or no such node) is no focus at all.
	std::vector<int> Pairs = {0, 1, 1, 2};
	LinkIndex Small;
	Small.Build(Pairs.data(), 4, 6);
	int Linked = 0;
	for (uint32_t K = 0; K < 500U; ++K)
	{
		const LinkPick P = PickLink(Small, 2U, K, 5, 1.0);
		CHECK(P.Link >= 0 && P.Link < 2);
		const LinkPick Q = PickLink(Small, 2U, K, 99, 1.0);
		CHECK(Q.Link >= 0 && Q.Link < 2);
		const LinkPick R = PickLink(Small, 2U, K, -1, 1.0);
		CHECK(R.Link >= 0 && R.Link < 2);
		Linked += P.Link == Q.Link ? 1 : 0;
	}
	CHECK(Linked == 500);
	// A share of nothing never picks the focus on purpose, a share of everything always does.
	int Always = 0;
	for (uint32_t K = 0; K < 300U; ++K)
	{
		const LinkPick P = PickLink(L, 4U, K, Focus, 1.0);
		Always += (P.From == Focus || P.To == Focus) ? 1 : 0;
	}
	CHECK(Always == 300);
}

static void TestPulseTint()
{
	const Vec3 T = PulseTint(Vec3{0.2, 0.4, 1.0});
	CHECK(T.X > 0.2 && T.Y > 0.4 && T.Z >= 1.0 - 1e-12);
	CHECK(T.X <= 1.0 && T.Y <= 1.0 && T.Z <= 1.0 + 1e-12);
	const Vec3 White = PulseTint(Vec3{1.0, 1.0, 1.0});
	CHECK_NEAR(White.X, 1.0, 1e-12);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Shooting stars                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

static double AngleDeg(const Vec3& A, const Vec3& B)
{
	return std::acos(Sp::Clamp(Sp::Dot(Sp::Normalized(A), Sp::Normalized(B)), -1.0, 1.0)) * 180.0 / Sp::kPi;
}

static void TestMeteors()
{
	const Vec3 Camera{1200.0, -800.0, 400.0};
	const Vec3 Forward = Sp::Normalized(Vec3{0.3, 1.0, -0.2});
	for (uint32_t K = 0; K < 800U; ++K)
	{
		const MeteorShot S = Meteor(21U, K, Camera, Forward);
		CHECK(Finite(S.From) && Finite(S.To));
		const Vec3 Head = S.From - Camera;
		const double Dist = Sp::Length(Head);
		CHECK(Dist >= 2500.0 - 1e-6 && Dist <= 5500.0 + 1e-6);
		// Within the cone the camera looks into.
		CHECK(AngleDeg(Head, Forward) <= 75.0 + 1e-6);
		// It crosses the sky: its path is at right angles to the line of sight to its start.
		const Vec3 Path = S.To - S.From;
		const double Len = Sp::Length(Path);
		CHECK(Len >= 2200.0 - 1e-6 && Len <= 5200.0 + 1e-6);
		CHECK_NEAR(Sp::Dot(Sp::Normalized(Path), Sp::Normalized(Head)), 0.0, 1e-9);
		CHECK(S.Seconds >= 0.9 && S.Seconds <= 1.7);
		// Wide enough to see (0.6 % to 1.2 % of how far away it is), and a colour of the palette.
		CHECK(S.Width >= Dist * 0.006 - 1e-9 && S.Width <= Dist * 0.012 + 1e-9);
		CHECK(S.R > 0.0 && S.G > 0.0 && S.B > 0.0 && S.R <= 1.0 && S.G <= 1.0 && S.B <= 1.0);
		// The same number is the same star.
		const MeteorShot Again = Meteor(21U, K, Camera, Forward);
		CHECK(Again.From.X == S.From.X && Again.To.Z == S.To.Z && Again.Seconds == S.Seconds);
	}
	// Different numbers and seeds are different stars.
	CHECK(Meteor(21U, 1U, Camera, Forward).From.X != Meteor(21U, 2U, Camera, Forward).From.X);
	CHECK(Meteor(21U, 1U, Camera, Forward).From.X != Meteor(22U, 1U, Camera, Forward).From.X);
	// The camera moving moves the sky with it.
	CHECK_NEAR(Meteor(21U, 5U, Camera + Vec3{100.0, 0.0, 0.0}, Forward).From.X - Meteor(21U, 5U, Camera, Forward).From.X, 100.0, 1e-9);

	// Awkward ways of looking: straight up, straight down, nowhere (no direction at all), and a huge one.
	for (const Vec3& Look : {Vec3{0.0, 0.0, 1.0}, Vec3{0.0, 0.0, -1.0}, Vec3{0.0, 0.0, 0.0}, Vec3{1.0e9, 0.0, 0.0}, Vec3{1.0, 0.0, 0.0}})
	{
		for (uint32_t K = 0; K < 100U; ++K)
		{
			const MeteorShot S = Meteor(3U, K, Camera, Look);
			CHECK(Finite(S.From) && Finite(S.To));
			CHECK(Sp::Length(S.To - S.From) > 1000.0);
		}
	}

	// Over a few minutes the colours are mixed, not one.
	std::set<int> Palette;
	for (uint32_t K = 0; K < 300U; ++K)
	{
		const MeteorShot S = Meteor(3U, K, Camera, Forward);
		Palette.insert(S.R > 0.9 ? 1 : (S.G > 0.95 ? 2 : 0));
	}
	CHECK(Palette.size() == 3U);
}

static void TestPerpendicular()
{
	for (const Vec3& Dir : {Vec3{1.0, 0.0, 0.0}, Vec3{0.0, 0.0, 1.0}, Vec3{0.0, 0.0, -1.0}, Sp::Normalized(Vec3{1.0, 2.0, 3.0})})
	{
		for (const Vec3& Hint : {Vec3{0.0, 0.0, 0.0}, Dir, Vec3{1.0, 1.0, 1.0}, Vec3{0.0, 1.0, 0.0}})
		{
			const Vec3 P = PerpendicularTo(Dir, Hint);
			CHECK(Finite(P));
			CHECK_NEAR(Sp::Length(P), 1.0, 1e-9);
			CHECK_NEAR(Sp::Dot(P, Dir), 0.0, 1e-9);
		}
	}
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Coronas, ripples, dust                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

static void TestCorona()
{
	double MinR = 1e9;
	double MaxR = -1e9;
	double MinI = 1e9;
	double MaxI = -1e9;
	for (int I = 0; I < 4000; ++I)
	{
		const CoronaLook L = Corona(0.05 * I, 100.0, 3U);
		MinR = std::min(MinR, L.Radius);
		MaxR = std::max(MaxR, L.Radius);
		MinI = std::min(MinI, L.Intensity);
		MaxI = std::max(MaxI, L.Intensity);
		CHECK(std::isfinite(L.Radius) && std::isfinite(L.Intensity));
	}
	CHECK(MinR >= 100.0 * (2.6 - 0.18) - 1e-9 && MaxR <= 100.0 * (2.6 + 0.18) + 1e-9);
	CHECK(MaxR - MinR > 30.0);
	CHECK(MinI >= 1.0 - 0.18 - 0.06 - 1e-9 && MaxI <= 1.0 + 0.18 + 0.06 + 1e-9);
	CHECK(MaxI - MinI > 0.2);
	// Smooth: a hundredth of a second never jumps.
	for (int I = 0; I < 2000; ++I)
	{
		const CoronaLook A = Corona(0.01 * I, 100.0, 1U);
		const CoronaLook B = Corona(0.01 * (I + 1), 100.0, 1U);
		CHECK(std::fabs(A.Radius - B.Radius) < 2.0);
		CHECK(std::fabs(A.Intensity - B.Intensity) < 0.02);
	}
	// Two coronas are out of step; one is a pure function of time.
	CHECK(Corona(1.0, 100.0, 1U).Radius != Corona(1.0, 100.0, 2U).Radius);
	CHECK(Corona(1.0, 100.0, 1U).Radius == Corona(1.0, 100.0, 1U).Radius);
	// Bigger sun, bigger corona.
	CHECK_NEAR(Corona(2.0, 200.0, 1U).Radius, 2.0 * Corona(2.0, 100.0, 1U).Radius, 1e-9);
}

static void TestRipple()
{
	const RippleLook L = Ripple(50.0);
	CHECK_NEAR(L.Radius, 200.0, 1e-9);
	CHECK(L.Seconds >= 1.2 && L.Seconds <= 2.2);
	CHECK(L.Intensity > 0.0);
	// A tiny or missing radius still makes a ripple you can see, and a huge one is not slower than it should be.
	CHECK_NEAR(Ripple(0.0).Radius, 40.0, 1e-9);
	CHECK_NEAR(Ripple(-5.0).Radius, 40.0, 1e-9);
	CHECK(Ripple(1.0e7).Seconds <= 2.2 + 1e-12);
	CHECK(Ripple(1000.0).Radius > Ripple(500.0).Radius);
}

static void TestDust()
{
	const DustLook Small = Dust(100.0, 1.0);
	CHECK_NEAR(Small.HalfExtent.X, 1500.0, 1e-9);
	CHECK_NEAR(Small.HalfExtent.Z, 1050.0, 1e-9);
	const DustLook Big = Dust(1.0e7, 1.0);
	CHECK_NEAR(Big.HalfExtent.X, 6000.0, 1e-9);
	const DustLook Mid = Dust(8000.0, 1.0);
	CHECK_NEAR(Mid.HalfExtent.Y, 4000.0, 1e-9);
	CHECK_NEAR(Dust(6000.0, 1.0).SpawnRate, 90.0, 1e-9);
	CHECK_NEAR(Dust(6000.0, 2.0).SpawnRate, 180.0, 1e-9);
	CHECK_NEAR(Dust(6000.0, 99.0).SpawnRate, 270.0, 1e-9);
	CHECK_NEAR(Dust(6000.0, -1.0).SpawnRate, 0.0, 1e-9);
	CHECK_NEAR(Dust(6000.0, 0.0).SpawnRate, 0.0, 1e-9);
}

static void TestEase()
{
	const Vec3 A{0.0, 0.0, 0.0};
	const Vec3 B{100.0, -50.0, 20.0};
	CHECK_NEAR(Ease(A, B, 0.0, 3.0).X, 0.0, 1e-12);
	CHECK_NEAR(Ease(A, B, -1.0, 3.0).X, 0.0, 1e-12);
	CHECK_NEAR(Ease(A, B, 1000.0, 3.0).X, 100.0, 1e-9);
	// The same easing in one step or in ten.
	Vec3 P = A;
	for (int I = 0; I < 10; ++I)
	{
		P = Ease(P, B, 0.01, 3.0);
	}
	const Vec3 Q = Ease(A, B, 0.1, 3.0);
	CHECK_NEAR(P.X, Q.X, 1e-9);
	CHECK_NEAR(P.Y, Q.Y, 1e-9);
	CHECK_NEAR(P.Z, Q.Z, 1e-9);
	// Never past the target.
	CHECK(Ease(A, B, 0.2, 3.0).X < 100.0);
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The pool                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

static void TestPool()
{
	SlotPool Pool(3);
	CHECK(Pool.Size() == 3);
	CHECK(Pool.Busy(0.0) == 0);
	const int A = Pool.Acquire(0.0, 2.0);
	const int B = Pool.Acquire(0.0, 3.0);
	const int C = Pool.Acquire(0.0, 4.0);
	CHECK(A == 0 && B == 1 && C == 2);
	CHECK(Pool.Busy(0.5) == 3);
	// Every slot is busy: the next is dropped, not queued and not stolen.
	CHECK(Pool.Acquire(1.0, 9.0) == -1);
	CHECK(Pool.IsBusy(0, 1.0) && Pool.IsBusy(1, 1.0) && Pool.IsBusy(2, 1.0));
	// When one ends its slot is free again (exactly at its end too).
	CHECK(Pool.Acquire(2.0, 5.0) == 0);
	CHECK(Pool.Busy(2.5) == 3);
	CHECK(Pool.Acquire(3.5, 6.0) == 1);
	// Release frees at once, and the slots are used in turn.
	Pool.Release(2);
	CHECK(!Pool.IsBusy(2, 3.5));
	CHECK(Pool.Acquire(3.5, 7.0) == 2);
	Pool.ReleaseAll();
	CHECK(Pool.Busy(0.0) == 0);
	CHECK(Pool.Acquire(0.0, 1.0) == 0);
	CHECK(Pool.Acquire(0.0, 1.0) == 1);
	// Odd slot numbers do nothing.
	Pool.Release(-1);
	Pool.Release(99);
	CHECK(!Pool.IsBusy(-1, 0.0) && !Pool.IsBusy(99, 0.0));

	// An empty pool never gives one; a negative size is empty.
	SlotPool Empty(0);
	CHECK(Empty.Acquire(0.0, 1.0) == -1 && Empty.Size() == 0 && Empty.Busy(0.0) == 0);
	Empty.Resize(-5);
	CHECK(Empty.Size() == 0 && Empty.Acquire(0.0, 1.0) == -1);
	Empty.Resize(2);
	CHECK(Empty.Acquire(0.0, 1.0) == 0);
}

/** A minute of pulses at 60 fps through the pool: never more busy than there are slots, and the numbers add up. */
static void TestPulseTraffic()
{
	for (const int Links : {5, 500, 100000})
	{
		for (const double Density : {1.0, 3.0})
		{
			SlotPool Pool(kPulseSlots);
			const double Rate = PulseRate(Links, Density);
			int Fired = 0;
			int Dropped = 0;
			double MaxBusy = 0.0;
			double Prev = 0.0;
			for (int Frame = 1; Frame <= 3600; ++Frame)
			{
				const double Now = static_cast<double>(Frame) / 60.0;
				for (const uint32_t K : DueEvents(1U, kPulseSalt, Rate, Prev, Now))
				{
					(void)K;
					const double Seconds = PulseSeconds(900.0 + 150.0 * static_cast<double>(K % 9U));
					if (Pool.Acquire(Now, Now + Seconds + kLingerSeconds) >= 0)
					{
						++Fired;
					}
					else
					{
						++Dropped;
					}
				}
				MaxBusy = std::max(MaxBusy, static_cast<double>(Pool.Busy(Now)));
				Prev = Now;
			}
			CHECK(MaxBusy <= static_cast<double>(kPulseSlots));
			CHECK(Fired + Dropped >= static_cast<int>(Rate * 58.0));
			CHECK(Fired + Dropped <= static_cast<int>(Rate * 61.0) + 1);
			// An ordinary brain never fills the pool.
			if (Density <= 1.0)
			{
				CHECK(Dropped == 0);
			}
		}
	}
}

int main()
{
	TestLinkIndex();
	TestEventTimes();
	TestDueEvents();
	TestPulseRate();
	TestPulseSizes();
	TestPickLink();
	TestPulseTint();
	TestMeteors();
	TestPerpendicular();
	TestCorona();
	TestRipple();
	TestDust();
	TestEase();
	TestPool();
	TestPulseTraffic();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
