// Tests for one voyage (AetherVoyageState.h): flown start to end with and without the player, the cursor aim, the camera.
// Plain C++, no Unreal: run with unreal/tests/run.sh
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherVoyageState.h"

#include <cstdio>

using namespace AetherVoyage;

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

static Setup Standard(uint32_t Seed = 3U)
{
	Setup S;
	S.From = Vec3{0.0, 0.0, 0.0};
	S.To = Vec3{45000.0, 7000.0, -2000.0};
	S.Seed = Seed;
	return S;
}

static void TestBegin()
{
	Session S;
	CHECK(!S.Active());
	S.Tick(0.016, Input{}); // nothing happens before Begin
	CHECK(S.Elapsed() == 0.0);
	const Setup Cfg = Standard();
	S.Begin(Cfg);
	CHECK(S.Active() && !S.Arrived());
	CHECK(Length(S.GetPilot().Pos - Cfg.From) < 1e-9);
	CHECK(S.GetRoute().Length() > Length(Cfg.To - Cfg.From));
	CHECK(S.GetField().Rocks.size() > 10U);
	CHECK(S.Ship().Shield == S.Ship().MaxShield && S.Ship().Hull == 100.0);
	CHECK_NEAR(S.DistanceToGo(), S.GetRoute().Length() - Cfg.CardWidth * 1.35, 1.0);
	CHECK(S.Progress() == 0.0);
	// The camera starts behind and above the ship, looking along its nose.
	const ChaseCamera& C = S.Camera();
	CHECK(Dot(C.Fwd, S.GetPilot().Fwd) > 0.9);
	CHECK(Dot(S.GetPilot().Pos - C.Pos, S.GetPilot().Fwd) > 300.0);
	CHECK(Dot(C.Pos - S.GetPilot().Pos, S.GetPilot().Up) > 100.0);
	CHECK_NEAR(Length(C.Fwd), 1.0, 1e-9);
	CHECK_NEAR(Length(C.Up), 1.0, 1e-9);
	CHECK(Dot(C.Fwd, C.Up) < 0.2);
	// The stand-off grows with the card: a big card is stopped in front of from farther away.
	Setup Big = Cfg;
	Big.CardWidth = 3000.0;
	Session B;
	B.Begin(Big);
	CHECK(B.DistanceToGo() < S.DistanceToGo() - 1000.0);
	// End lets everything go; Begin again starts fresh.
	S.Tick(0.5, Input{});
	CHECK(S.Elapsed() > 0.0);
	S.End();
	CHECK(!S.Active() && S.GetField().Rocks.empty());
	S.Begin(Cfg);
	CHECK(S.Elapsed() == 0.0 && S.Progress() == 0.0);
}

static void TestFlightAlone()
{
	// Flown with no input, the autopilot's assist gets the ship through: it arrives, the shield holds or comes back.
	Session S;
	S.Begin(Standard());
	int Steps = 0;
	double MinShield = 1e9;
	double MaxSpeed = 0.0;
	std::vector<Event> All;
	for (; Steps < 60 * 150 && !S.Arrived(); ++Steps)
	{
		S.Tick(1.0 / 60.0, Input{});
		MinShield = std::min(MinShield, S.Ship().Shield);
		MaxSpeed = std::max(MaxSpeed, S.GetPilot().Speed);
		const std::vector<Event> Ev = S.TakeEvents();
		All.insert(All.end(), Ev.begin(), Ev.end());
		CHECK(Finite(S.GetPilot().Pos) && Finite(S.Camera().Pos) && Finite(S.Camera().Fwd));
	}
	CHECK(S.Arrived());
	CHECK(Steps < 60 * 100);
	CHECK(S.Progress() > 0.999 && S.DistanceToGo() < 3.0);
	CHECK(S.Ship().Hull > 0.0);
	// It stops in front of the folder, not on it.
	const double Gap = Length(S.GetPilot().Pos - S.Config().To);
	CHECK(Gap > S.Config().CardWidth * 1.0 && Gap < S.Config().CardWidth * 2.4);
	CHECK(MaxSpeed > S.Config().Flight.Cruise * 0.99);
	// Without guns fired, no shot events; rocks only meet the ship if the assist let them.
	int Fired = 0;
	for (const Event& E : All)
	{
		Fired += E.Kind == EventKind::Fired ? 1 : 0;
	}
	CHECK(Fired == 0);
	// The camera ends behind the ship, close to it.
	CHECK(Length(S.Camera().Pos - S.GetPilot().Pos) < S.Config().ShipRadius * 4.0);
}

static void TestFlightFighting()
{
	// Held fire with the sights on: it breaks rocks and gets through; the same seed gives the same score.
	auto Fly = [](uint32_t Seed, int* OutBroken, int* OutScore, double* OutEnd, bool* OutArrived) {
		Session S;
		S.Begin(Standard(Seed));
		Input In;
		In.bFire = true;
		int Steps = 0;
		for (; Steps < 60 * 150 && !S.Arrived(); ++Steps)
		{
			S.Tick(1.0 / 60.0, In);
			S.TakeEvents();
		}
		*OutBroken = S.GetField().RocksDestroyed;
		*OutScore = S.GetField().Score;
		*OutEnd = S.GetPilot().Pos.X;
		*OutArrived = S.Arrived();
		return Steps;
	};
	int B1 = 0;
	int B2 = 0;
	int B3 = 0;
	int S1 = 0;
	int S2 = 0;
	int S3 = 0;
	double E1 = 0.0;
	double E2 = 0.0;
	double E3 = 0.0;
	bool A1 = false;
	bool A2 = false;
	bool A3 = false;
	const int T1 = Fly(3U, &B1, &S1, &E1, &A1);
	const int T2 = Fly(3U, &B2, &S2, &E2, &A2);
	Fly(4U, &B3, &S3, &E3, &A3);
	CHECK(A1 && A2 && A3);
	CHECK(T1 == T2 && B1 == B2 && S1 == S2 && E1 == E2);
	CHECK(B1 != B3 || S1 != S3 || E1 != E3);
	CHECK(B1 >= 10);
	CHECK(S1 > 80);
	std::printf("  fighting voyage: %d rocks broken, score %d, %d steps\n", B1, S1, T1);
}

static void TestAim()
{
	Session S;
	Setup Cfg = Standard();
	Cfg.Rocks.MaxRocks = 0; // an empty sky first
	S.Begin(Cfg);
	// The cursor ray from the camera: the guns swing toward it, but not past their limit.
	Input In;
	In.bHasAim = true;
	In.AimDir = Normalized(S.GetPilot().Fwd + S.GetPilot().Right * 0.2 + S.GetPilot().Up * 0.1);
	S.Tick(0.016, In);
	const Vec3 A = S.AimDirection();
	CHECK_NEAR(Length(A), 1.0, 1e-9);
	CHECK(Dot(A, S.GetPilot().Fwd) > std::cos(AetherSpace::DegToRad(Cfg.MaxAimDeg)) - 1e-9);
	CHECK(Dot(A, In.AimDir) > 0.97);
	CHECK(Dot(A, S.GetPilot().Right) > 0.05 && Dot(A, S.GetPilot().Up) > 0.01); // toward the right and up, as the cursor is
	// Far off to the side: stops at the limit.
	Input Wide = In;
	Wide.AimDir = S.GetPilot().Right;
	S.Tick(0.016, Wide);
	CHECK_NEAR(Dot(S.AimDirection(), S.GetPilot().Fwd), std::cos(AetherSpace::DegToRad(Cfg.MaxAimDeg)), 1e-6);
	// Fire makes shots that leave along the aim, from the ship's barrels.
	Input Fire = In;
	Fire.bFire = true;
	S.Tick(0.016, Fire);
	std::vector<Event> Ev = S.TakeEvents();
	int Fired = 0;
	for (const Event& E : Ev)
	{
		if (E.Kind == EventKind::Fired)
		{
			++Fired;
			CHECK(Dot(E.Dir, S.AimDirection()) > 0.99);
			CHECK(Length(E.At - S.GetPilot().Pos) < Cfg.Gun.BarrelOffset * 3.0);
		}
	}
	CHECK(Fired == 1);
	CHECK(S.GetField().Shots.size() == 1U);

	// With a rock under the cursor the guns converge on it: the shots hit it.
	Setup One = Standard();
	One.Rocks.MaxRocks = 0;
	Session T;
	T.Begin(One);
	Rock R;
	R.Id = 900U;
	R.Radius = 140.0;
	R.Pos = T.GetPilot().Pos + T.GetPilot().Fwd * 7000.0 + T.GetPilot().Right * 900.0;
	R.MaxHealth = HealthOf(R.Radius);
	R.Health = R.MaxHealth;
	T.MutableField().AddRocks({R});
	Input Aim;
	Aim.bHasAim = true;
	Aim.bFire = true;
	Aim.Throttle = 0.0;
	int Hits = 0;
	for (int I = 0; I < 90 && Hits == 0; ++I)
	{
		Aim.AimDir = Normalized(T.GetField().Rocks.empty() ? T.GetPilot().Fwd : T.GetField().Rocks[0].Pos - T.Camera().Pos);
		T.Tick(1.0 / 60.0, Aim);
		for (const Event& E : T.TakeEvents())
		{
			Hits += E.Kind == EventKind::Hit ? 1 : 0;
		}
	}
	CHECK(Hits >= 1);
	// The distance along a ray to a rock is found; nothing on the ray gives the long default.
	CHECK_NEAR(T.CursorDistance(Vec3{}, Vec3{0, 1, 0}), 30000.0, 1e-9);
	Session U;
	U.Begin(One);
	U.MutableField().AddRocks({R});
	const Vec3 Origin = R.Pos - Vec3{5000.0, 0.0, 0.0};
	CHECK_NEAR(U.CursorDistance(Origin, Vec3{1, 0, 0}), 5000.0 - 140.0 * 0.92 - 30.0, 1.0);
}

static void TestAutoAimAndThrottle()
{
	// With no cursor and a rock dead ahead the sights lead it and the shots find it.
	Setup Cfg = Standard();
	Cfg.Rocks.MaxRocks = 0;
	Session S;
	S.Begin(Cfg);
	Rock R;
	R.Id = 901U;
	R.Radius = 160.0;
	R.Pos = S.GetPilot().Pos + S.GetPilot().Fwd * 9000.0 + S.GetPilot().Up * 600.0;
	R.Vel = Vec3{0.0, 0.0, -150.0};
	R.MaxHealth = HealthOf(R.Radius);
	R.Health = R.MaxHealth;
	S.MutableField().AddRocks({R});
	Input In;
	In.bFire = true;
	In.Throttle = 0.2;
	int Hits = 0;
	for (int I = 0; I < 120 && Hits == 0; ++I)
	{
		S.Tick(1.0 / 60.0, In);
		CHECK(S.Target() == 0 || S.GetField().Rocks.empty());
		for (const Event& E : S.TakeEvents())
		{
			Hits += E.Kind == EventKind::Hit ? 1 : 0;
		}
	}
	CHECK(Hits >= 1);
	// Auto-aim off: the guns stay on the nose without a cursor.
	Setup Off = Cfg;
	Off.bAutoAim = false;
	Session T;
	T.Begin(Off);
	T.MutableField().AddRocks({R});
	T.Tick(0.016, In);
	CHECK(Dot(T.AimDirection(), T.GetPilot().Fwd) > 0.9999);
	// Throttle 0 holds it; full throttle goes. Hitches (huge frame times) are cut short.
	Session U;
	U.Begin(Cfg);
	Input Still;
	Still.Throttle = 0.0;
	for (int I = 0; I < 120; ++I)
	{
		U.Tick(1.0 / 60.0, Still);
	}
	CHECK(U.GetPilot().S < 1.0);
	const double Before = U.GetPilot().S;
	U.Tick(50.0, Input{}); // clamped to a tenth of a second
	CHECK(U.GetPilot().S - Before < Cfg.Flight.Cruise * 0.1 + 1.0);
	CHECK(U.Elapsed() < 2.2);
}

static void TestCamera()
{
	Session S;
	Setup Cfg = Standard();
	Cfg.Rocks.MaxRocks = 0;
	S.Begin(Cfg);
	Input In;
	In.Right = 1.0;
	double MinBehind = 1e9;
	double MaxBehind = 0.0;
	for (int I = 0; I < 240; ++I)
	{
		S.Tick(1.0 / 60.0, In);
		const double Behind = Dot(S.GetPilot().Pos - S.Camera().Pos, S.GetPilot().Fwd);
		MinBehind = std::min(MinBehind, Behind);
		MaxBehind = std::max(MaxBehind, Behind);
		CHECK(Length(S.Camera().Pos - S.GetPilot().Pos) < Cfg.ShipRadius * 6.0);
		CHECK(S.Camera().FovDeg >= 74.0 && S.Camera().FovDeg <= 84.0 + 1e-9);
		CHECK_NEAR(Length(S.Camera().Up), 1.0, 1e-9);
	}
	// Always behind the ship (positive), never in it.
	CHECK(MinBehind > Cfg.ShipRadius);
	// It rolls only part way with the ship.
	CHECK(std::fabs(S.GetPilot().Roll) > 0.001);
	CHECK(S.Camera().Up.Z > 0.5);
}

int main()
{
	std::printf("voyage\n");
	TestBegin();
	TestFlightAlone();
	TestAim();
	TestAutoAimAndThrottle();
	TestCamera();
	TestFlightFighting();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
