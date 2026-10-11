// Tests for the voyage maths (AetherCombatMath.h): the route, the asteroid fields, shots and fracture, the shield, the pilot, the aim.
// Plain C++, no Unreal: run with unreal/tests/run.sh
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherCombatMath.h"

#include <cstdio>
#include <set>

using namespace AetherCombat;

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

static int Count(const std::vector<Event>& Es, EventKind K)
{
	int N = 0;
	for (const Event& E : Es)
	{
		if (E.Kind == K)
		{
			++N;
		}
	}
	return N;
}

static Rock MakeRock(uint32_t Id, const Vec3& Pos, double Radius)
{
	Rock R;
	R.Id = Id;
	R.Seed = Id * 7U;
	R.Pos = Pos;
	R.Radius = Radius;
	R.MaxHealth = HealthOf(Radius);
	R.Health = R.MaxHealth;
	return R;
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestRoute()
{
	const Vec3 A{0.0, 0.0, 0.0};
	const Vec3 B{40000.0, 9000.0, -3000.0};
	const Route R = BuildRoute(A, B, 5U);
	CHECK(R.Pts.size() > 100U);
	CHECK(R.Pts.size() == R.Cum.size());
	CHECK_NEAR(Length(R.Pts.front() - A), 0.0, 1e-9);
	CHECK_NEAR(Length(R.Pts.back() - B), 0.0, 1e-9);
	const double Chord = Length(B - A);
	CHECK(R.Length() >= Chord);
	CHECK(R.Length() < Chord * 1.35);
	for (size_t I = 1; I < R.Cum.size(); ++I)
	{
		CHECK(R.Cum[I] > R.Cum[I - 1U]);
	}
	// Points and tangents along it.
	for (double S = 0.0; S <= R.Length(); S += R.Length() / 37.0)
	{
		const Vec3 P = R.PointAt(S);
		CHECK(Finite(P));
		CHECK_NEAR(Length(R.TangentAt(S)), 1.0, 1e-9);
		// The nearest point on the route to a point on it is where it is.
		CHECK_NEAR(R.Closest(P, S, 3000.0), S, 60.0);
	}
	CHECK_NEAR(Length(R.PointAt(-5.0) - A), 0.0, 1e-9);
	CHECK_NEAR(Length(R.PointAt(1e12) - B), 0.0, 1e-9);
	// It starts and ends along the chord's direction (straight in and out, not a hook).
	CHECK(Dot(R.TangentAt(0.0), Normalized(B - A)) > 0.8);
	CHECK(Dot(R.TangentAt(R.Length()), Normalized(B - A)) > 0.8);
	// Deterministic; a different seed bends differently; no meander is a straight line.
	const Route Same = BuildRoute(A, B, 5U);
	const Route Other = BuildRoute(A, B, 6U);
	CHECK(Same.Pts.size() == R.Pts.size() && Length(Same.Pts[50] - R.Pts[50]) == 0.0);
	CHECK(Length(Other.Pts[R.Pts.size() / 2U] - R.Pts[R.Pts.size() / 2U]) > 10.0);
	const Route Straight = BuildRoute(A, B, 5U, 0.0);
	CHECK_NEAR(Straight.Length(), Chord, Chord * 1e-3);
	// A degenerate one does not crash.
	const Route None = BuildRoute(A, A, 1U);
	CHECK(None.Pts.size() == 2U && None.Length() == 0.0);
	CHECK(Finite(None.PointAt(10.0)) && Finite(None.TangentAt(10.0)));
}

static void TestField()
{
	const Route R = BuildRoute(Vec3{0, 0, 0}, Vec3{60000, 8000, 2000}, 3U);
	FieldParams P;
	const double Ship = 260.0;
	const std::vector<Rock> A = PlaceField(R, 11U, P, Ship, 100U);
	const std::vector<Rock> B = PlaceField(R, 11U, P, Ship, 100U);
	const std::vector<Rock> C = PlaceField(R, 12U, P, Ship, 100U);
	CHECK(A.size() > 20U);
	CHECK(static_cast<int>(A.size()) <= P.MaxRocks);
	CHECK(A.size() == B.size());
	for (size_t I = 0; I < A.size(); ++I)
	{
		CHECK(Length(A[I].Pos - B[I].Pos) == 0.0 && A[I].Radius == B[I].Radius && A[I].Id == B[I].Id);
	}
	CHECK(A.size() != C.size() || Length(A[0].Pos - C[0].Pos) > 1.0);
	std::set<uint32_t> Ids;
	std::set<uint32_t> Seeds;
	double MinR = 1e9;
	double MaxR = 0.0;
	for (size_t I = 0; I < A.size(); ++I)
	{
		const Rock& Rk = A[I];
		CHECK(Ids.insert(Rk.Id).second);
		Seeds.insert(Rk.Seed);
		CHECK(Rk.Id >= 100U);
		CHECK(Finite(Rk.Pos) && Finite(Rk.Vel) && Finite(Rk.Spin));
		CHECK(Rk.Radius >= P.MinRadius - 1e-9 && Rk.Radius <= P.MaxRadius + 1e-9);
		CHECK(Rk.Kind >= 0 && Rk.Kind < P.Kinds && Rk.Shape >= 0 && Rk.Shape < P.ShapeVariants);
		CHECK_NEAR(Rk.Health, HealthOf(Rk.Radius), 1e-9);
		CHECK(Length(Rk.Vel) < P.DriftSpeed * 1.5);
		MinR = std::min(MinR, Rk.Radius);
		MaxR = std::max(MaxR, Rk.Radius);
		// The start and the end of the flight are clear.
		const double Along = R.Closest(Rk.Pos, R.Length() * 0.5, R.Length());
		CHECK(Along > P.ClearStart - Rk.Radius - 1.0);
		CHECK(Along < R.Length() - P.ClearEnd + Rk.Radius + 1.0);
		// Nothing overlaps (a shot can hit one rock at a time).
		for (size_t J = I + 1U; J < A.size(); ++J)
		{
			CHECK(Length(Rk.Pos - A[J].Pos) >= (Rk.Radius + A[J].Radius) * 1.19);
		}
	}
	CHECK(Seeds.size() > A.size() * 9U / 10U);
	CHECK(MaxR > MinR * 3.0); // a few big, mostly small
	// Some of them are in the way: across many seeds, rocks stand close enough to the line to block it.
	int Blocked = 0;
	for (uint32_t Seed = 1U; Seed <= 30U; ++Seed)
	{
		const std::vector<Rock> F = PlaceField(R, Seed, P, Ship, 1U);
		for (const Rock& Rk : F)
		{
			const double S = R.Closest(Rk.Pos, R.Length() * 0.5, R.Length());
			if (Length(Rk.Pos - R.PointAt(S)) < Rk.Radius + Ship)
			{
				++Blocked;
				break;
			}
		}
	}
	CHECK(Blocked >= 20);
	// Too short a route holds no field; a zero cap holds none either.
	CHECK(PlaceField(BuildRoute(Vec3{}, Vec3{3000, 0, 0}, 1U), 1U, P, Ship, 1U).empty());
	FieldParams Zero = P;
	Zero.MaxRocks = 0;
	CHECK(PlaceField(R, 1U, Zero, Ship, 1U).empty());
	FieldParams Few = P;
	Few.MaxRocks = 10;
	CHECK(PlaceField(R, 1U, Few, Ship, 1U).size() <= 10U);
}

static void TestShots()
{
	// A rock 30 m ahead; the shot flies at 600 m/s: it arrives in 0.05 s, and not before.
	Field F(1U);
	F.AddRocks({MakeRock(1U, Vec3{3000.0, 0.0, 0.0}, 100.0)});
	ShipBody Ship;
	Ship.Pos = Vec3{-100000.0, 0.0, 0.0}; // far away: no collisions with it
	Weapon W;
	W.Spread = 0.0;
	CHECK(F.Fire(W, Vec3{0, 0, 0}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0}));
	CHECK(!F.Fire(W, Vec3{0, 0, 0}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0})); // the cannon needs its cooldown
	std::vector<Event> Ev = F.TakeEvents();
	CHECK(Count(Ev, EventKind::Fired) == 1);
	CHECK(F.Shots.size() == 1U);
	// Barrels alternate sides.
	const double Y0 = F.Shots[0].Pos.Y;
	W.Cooldown = 0.0;
	F.Fire(W, Vec3{0, 0, 0}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	CHECK(F.Shots.size() == 2U);
	CHECK(F.Shots[1].Pos.Y * Y0 < 0.0);
	F.Shots.pop_back();
	double T = 0.0;
	int Hits = 0;
	for (int I = 0; I < 40 && Hits == 0; ++I)
	{
		F.Step(0.005, Ship, &W);
		T += 0.005;
		Hits += Count(F.TakeEvents(), EventKind::Hit);
	}
	CHECK(Hits == 1);
	CHECK(T > 0.03 && T < 0.06);
	CHECK(F.Shots.empty());
	CHECK_NEAR(F.Rocks[0].Health, HealthOf(100.0) - 35.0, 1e-9);

	// No tunnelling: a very fast shot in one big step still hits a small rock.
	Field Fast(2U);
	Fast.AddRocks({MakeRock(1U, Vec3{30000.0, 0.0, 0.0}, 60.0)});
	Weapon Wf;
	Wf.Speed = 5.0e6;
	Wf.Spread = 0.0;
	Wf.Life = 2.0;
	Fast.Fire(Wf, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	Fast.Step(0.1, Ship, &Wf); // 500,000 cm in a step: the rock is 120 cm wide
	CHECK(Count(Fast.TakeEvents(), EventKind::Hit) == 1);

	// A shot that misses flies on and expires; a shot is limited in number.
	Field Miss(3U);
	Miss.AddRocks({MakeRock(1U, Vec3{3000.0, 800.0, 0.0}, 100.0)});
	Weapon Wm;
	Wm.Spread = 0.0;
	Wm.Life = 0.5;
	Miss.Fire(Wm, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	for (int I = 0; I < 120; ++I)
	{
		Miss.Step(0.005, Ship, &Wm);
	}
	CHECK(Count(Miss.TakeEvents(), EventKind::Hit) == 0);
	CHECK(Miss.Shots.empty());
	CHECK_NEAR(Miss.Rocks[0].Health, HealthOf(100.0), 1e-9);
	Field Many(4U);
	Weapon Wr;
	Many.Rules.MaxShots = 5;
	int Fired = 0;
	for (int I = 0; I < 50; ++I)
	{
		Wr.Cooldown = 0.0;
		Fired += Many.Fire(Wr, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0}) ? 1 : 0;
	}
	CHECK(Fired == 5);

	// A shot hits the nearer of two rocks on its line, and only that one.
	Field Two(5U);
	Two.AddRocks({MakeRock(1U, Vec3{9000.0, 0.0, 0.0}, 200.0), MakeRock(2U, Vec3{3000.0, 0.0, 0.0}, 200.0)});
	Weapon Wt;
	Wt.Spread = 0.0;
	Two.Fire(Wt, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	for (int I = 0; I < 60; ++I)
	{
		Two.Step(0.005, Ship, &Wt);
	}
	CHECK(Two.Rocks.size() == 2U);
	for (const Rock& Rk : Two.Rocks)
	{
		CHECK((Rk.Id == 2U) == (Rk.Health < Rk.MaxHealth));
	}
	// The shot inherits the ship's speed.
	Field Inh(6U);
	Weapon Wi;
	Wi.Spread = 0.0;
	Inh.Fire(Wi, Vec3{}, Vec3{0, 1500.0, 0}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	const Vec3 Rel = Inh.Shots[0].Vel - Vec3{0, 1500.0, 0};
	CHECK_NEAR(Length(Rel), Wi.Speed, 1e-6);
	CHECK(Dot(Normalized(Rel), Vec3{1, 0, 0}) > 0.999);
	// The two barrels' shots cross at the aim point.
	Field Cross2(7U);
	Weapon Wc;
	Wc.Spread = 0.0;
	Cross2.Fire(Wc, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0}, 8000.0);
	Wc.Cooldown = 0.0;
	Cross2.Fire(Wc, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0}, 8000.0);
	CHECK(Cross2.Shots.size() == 2U);
	const double Tm = (8000.0 - Cross2.Shots[0].Pos.X) / Cross2.Shots[0].Vel.X;
	CHECK(std::fabs(Cross2.Shots[0].Pos.Y + Cross2.Shots[0].Vel.Y * Tm) < 1.0);
	CHECK(std::fabs(Cross2.Shots[1].Pos.Y + Cross2.Shots[1].Vel.Y * ((8000.0 - Cross2.Shots[1].Pos.X) / Cross2.Shots[1].Vel.X)) < 1.0);
}

static void TestFracture()
{
	ShipBody Ship;
	Ship.Pos = Vec3{-100000.0, 0.0, 0.0};
	const Vec3 Fly{2000.0, 100.0, -50.0};
	for (const double Radius : {160.0, 300.0, 500.0})
	{
		Field F(7U, 50U);
		Rock Parent = MakeRock(1U, Vec3{4000.0, 0.0, 0.0}, Radius);
		Parent.Vel = Fly;
		Parent.Health = 1.0; // one shot kills it
		F.AddRocks({Parent});
		Weapon W;
		W.Spread = 0.0;
		F.Fire(W, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
		for (int I = 0; I < 60 && Count(F.Events, EventKind::Break) == 0; ++I)
		{
			F.Step(0.005, Ship, &W);
		}
		const std::vector<Event> Ev = F.TakeEvents();
		CHECK(Count(Ev, EventKind::Break) == 1);
		CHECK(Count(Ev, EventKind::Hit) == 1);
		Event Brk;
		for (const Event& E : Ev)
		{
			if (E.Kind == EventKind::Break)
			{
				Brk = E;
			}
		}
		CHECK(F.Rocks.size() >= 2U && F.Rocks.size() <= 4U);
		CHECK(F.RocksDestroyed == 1);
		CHECK(F.Score == static_cast<int>(std::lround(Radius / 10.0)));
		double Vol = 0.0;
		std::set<uint32_t> Ids;
		Vec3 Mean{};
		for (const Rock& Pc : F.Rocks)
		{
			CHECK(Pc.Gen == 1);
			CHECK(Pc.Radius < Radius * 0.95 && Pc.Radius > Radius * 0.25);
			CHECK_NEAR(Pc.Health, HealthOf(Pc.Radius), 1e-9);
			CHECK(Ids.insert(Pc.Id).second && Pc.Id >= 50U);
			CHECK(Finite(Pc.Pos) && Finite(Pc.Vel));
			// A piece lies inside where the parent was (a little beyond for a big one's piece).
			CHECK(Length(Pc.Pos - Brk.At) < Radius * 1.4);
			Vol += Pc.Radius * Pc.Radius * Pc.Radius;
			Mean = Mean + Pc.Vel * (1.0 / static_cast<double>(F.Rocks.size()));
			CHECK(Pc.Seed != Parent.Seed);
		}
		// What is left is a bit over half the volume of the parent (the rest is dust).
		const double Share = Vol / (Radius * Radius * Radius);
		CHECK(Share > 0.5 && Share < 0.6);
		// They fly apart, and on with the parent's drift.
		for (size_t I = 0; I < F.Rocks.size(); ++I)
		{
			for (size_t J = I + 1U; J < F.Rocks.size(); ++J)
			{
				const Vec3 Sep = F.Rocks[J].Pos - F.Rocks[I].Pos;
				const double Closing = Dot(F.Rocks[J].Vel - F.Rocks[I].Vel, Normalized(Sep));
				CHECK(Closing > 0.0);
			}
		}
		CHECK(Length(Mean - Fly) < 900.0);
		CHECK(Brk.Dir.X > 0.9); // the shot flew along +X
		// Pieces of pieces: a second break makes smaller ones, a Gen 2.
		F.Rocks[0].Health = 1.0;
		F.Rocks[0].Radius = std::max(F.Rocks[0].Radius, 150.0);
		F.Rocks[0].Pos = Vec3{4000.0, 0.0, 0.0};
		F.Rocks[0].Vel = Vec3{};
		W.Cooldown = 0.0;
		for (size_t I = 1; I < F.Rocks.size(); ++I)
		{
			F.Rocks[I].Pos = Vec3{4000.0, 90000.0, 0.0};
		}
		const size_t Before = F.Rocks.size();
		F.Fire(W, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
		for (int I = 0; I < 60; ++I)
		{
			F.Step(0.005, Ship, &W);
		}
		CHECK(F.Rocks.size() > Before - 1U);
		bool bGen2 = false;
		for (const Rock& Pc : F.Rocks)
		{
			bGen2 = bGen2 || Pc.Gen == 2;
		}
		CHECK(bGen2);
	}
	// A small rock turns to dust.
	Field D(8U);
	Rock Small = MakeRock(1U, Vec3{3000.0, 0.0, 0.0}, 80.0);
	Small.Health = 1.0;
	D.AddRocks({Small});
	Weapon W;
	W.Spread = 0.0;
	D.Fire(W, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	for (int I = 0; I < 60; ++I)
	{
		D.Step(0.005, Ship, &W);
	}
	const std::vector<Event> Ev = D.TakeEvents();
	CHECK(Count(Ev, EventKind::Vaporize) == 1 && Count(Ev, EventKind::Break) == 0);
	CHECK(D.Rocks.empty());
	// Two shots in one step at a rock with a single point of health: it breaks once.
	Field Two(9U, 10U);
	Rock R1 = MakeRock(1U, Vec3{3000.0, 0.0, 0.0}, 200.0);
	R1.Health = 1.0;
	Two.AddRocks({R1});
	Weapon W2;
	W2.Spread = 0.0;
	Two.Fire(W2, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	W2.Cooldown = 0.0;
	Two.Fire(W2, Vec3{}, Vec3{}, Vec3{1, 0, 0}, Vec3{0, 1, 0});
	Two.Step(0.06, Ship, &W2);
	CHECK(Count(Two.TakeEvents(), EventKind::Break) == 1);
	CHECK(Two.RocksDestroyed == 1);
}

static void TestShip()
{
	// A rock on the ship: shield first, then hull; the rock breaks; the shield comes back after a while.
	Field F(10U, 20U);
	ShipBody Ship;
	Ship.Pos = Vec3{};
	Ship.Radius = 260.0;
	Rock R = MakeRock(1U, Vec3{400.0, 0.0, 0.0}, 300.0);
	F.AddRocks({R});
	F.Step(0.01, Ship);
	std::vector<Event> Ev = F.TakeEvents();
	CHECK(Count(Ev, EventKind::ShipHit) == 1);
	CHECK(Count(Ev, EventKind::Break) == 1);
	CHECK(Ship.Shield < Ship.MaxShield && Ship.Shield > 0.0);
	CHECK_NEAR(Ship.Hull, 100.0, 1e-9);
	CHECK(Ship.SinceHit < 0.5);
	// Pieces born against the ship do not hit it at once.
	const double ShieldAfter = Ship.Shield;
	for (int I = 0; I < 10; ++I)
	{
		F.Step(0.01, Ship);
	}
	CHECK(Count(F.TakeEvents(), EventKind::ShipHit) == 0);
	CHECK_NEAR(Ship.Shield, ShieldAfter, 1e-9);
	// Quiet for a while: the shield regenerates, never above its maximum.
	Field Calm(11U);
	for (int I = 0; I < 4000; ++I)
	{
		Calm.Step(0.01, Ship);
	}
	CHECK_NEAR(Ship.Shield, Ship.MaxShield, 1e-9);
	// Without shield the hull takes half of the rest; a huge rock hurts more than a small one but is capped.
	ShipBody Weak;
	Weak.Shield = 0.0;
	Field G(12U, 20U);
	G.AddRocks({MakeRock(1U, Vec3{300.0, 0.0, 0.0}, 520.0)});
	G.Step(0.01, Weak);
	CHECK(Weak.Hull < 100.0 && Weak.Hull > 60.0);
	// Rocks far away and old are forgotten.
	Field H(13U);
	Rock Far = MakeRock(1U, Vec3{200000.0, 0.0, 0.0}, 100.0);
	Far.Age = 10.0;
	Rock Near = MakeRock(2U, Vec3{5000.0, 0.0, 0.0}, 100.0);
	Near.Age = 10.0;
	Rock Young = MakeRock(3U, Vec3{200000.0, 0.0, 0.0}, 100.0);
	ShipBody Origin;
	H.AddRocks({Far, Near, Young});
	H.Step(0.01, Origin);
	CHECK(H.Rocks.size() == 2U);
	// The rock count is capped.
	Field Cap(14U);
	Cap.Rules.MaxRocks = 3;
	std::vector<Rock> Lots;
	for (uint32_t I = 1U; I <= 10U; ++I)
	{
		Lots.push_back(MakeRock(I, Vec3{static_cast<double>(I) * 9000.0, 0.0, 0.0}, 100.0));
	}
	Cap.AddRocks(Lots);
	CHECK(Cap.Rocks.size() == 3U);
}

static void TestReplay()
{
	// The same seed and the same inputs give the same fight.
	auto Run = [](uint32_t Seed, double* OutScore, size_t* OutRocks, double* OutX) {
		const Route R = BuildRoute(Vec3{}, Vec3{50000, 4000, 0}, 2U);
		Field F(Seed, 1U);
		F.AddRocks(PlaceField(R, Seed, FieldParams{}, 260.0, 1U));
		ShipBody Ship;
		Pilot Pl;
		Pl.Pos = R.PointAt(0.0);
		Weapon W;
		PilotParams Pp;
		for (int I = 0; I < 1800; ++I)
		{
			const double Dt = 1.0 / 60.0;
			StepPilot(Pl, R, Dt, PilotInput{}, Pp, &F.Rocks, 260.0);
			Ship.Pos = Pl.Pos;
			Ship.Vel = Pl.Vel;
			const int Target = PickTarget(Pl.Pos, Pl.Fwd, F.Rocks, 30000.0, 12.0);
			if (Target >= 0)
			{
				Vec3 Dir;
				double Tt = 0.0;
				if (LeadDirection(Pl.Pos, Pl.Vel, F.Rocks[static_cast<size_t>(Target)].Pos, F.Rocks[static_cast<size_t>(Target)].Vel, W.Speed, Dir, Tt))
				{
					F.Fire(W, Pl.Pos, Pl.Vel, ClampAim(Pl.Fwd, Dir, 35.0), Pl.Right);
				}
			}
			F.Step(Dt, Ship, &W);
			F.TakeEvents();
		}
		*OutScore = F.Score;
		*OutRocks = F.Rocks.size();
		*OutX = Ship.Pos.X;
		return F.RocksDestroyed;
	};
	double S1 = 0.0;
	double S2 = 0.0;
	double S3 = 0.0;
	size_t N1 = 0;
	size_t N2 = 0;
	size_t N3 = 0;
	double X1 = 0.0;
	double X2 = 0.0;
	double X3 = 0.0;
	const int D1 = Run(5U, &S1, &N1, &X1);
	const int D2 = Run(5U, &S2, &N2, &X2);
	const int D3 = Run(6U, &S3, &N3, &X3);
	CHECK(D1 == D2 && S1 == S2 && N1 == N2 && X1 == X2);
	CHECK(D1 != D3 || S1 != S3 || N1 != N3);
	// An auto-fighting ship gets through and breaks a good many rocks.
	CHECK(D1 > 10);
	CHECK(X1 > 20000.0);
	std::printf("  replay: %d rocks broken, score %g, %zu left\n", D1, S1, N1);
}

static void TestPilot()
{
	const Route R = BuildRoute(Vec3{0, 0, 0}, Vec3{30000, 5000, 1000}, 4U);
	Pilot Pl;
	Pl.Pos = R.PointAt(0.0);
	PilotParams Pp;
	double MaxSpeed = 0.0;
	double LastS = 0.0;
	int Steps = 0;
	for (; Steps < 60 * 120 && !Pl.bArrived; ++Steps)
	{
		StepPilot(Pl, R, 1.0 / 60.0, PilotInput{}, Pp, nullptr, 260.0);
		MaxSpeed = std::max(MaxSpeed, Pl.Speed);
		CHECK(Pl.S >= LastS - 1e-9);
		CHECK(Pl.Speed >= 0.0 && Pl.Speed <= Pp.Cruise + 1e-6);
		CHECK(Finite(Pl.Pos) && Finite(Pl.Fwd));
		LastS = Pl.S;
	}
	CHECK(Pl.bArrived);
	CHECK(Steps < 60 * 100);
	CHECK(MaxSpeed > Pp.Cruise * 0.99);
	// It stops short of the end by the stand-off, without overshooting it.
	CHECK_NEAR(Pl.S, R.Length() - Pp.StandOff, 3.0);
	CHECK_NEAR(Length(Pl.Pos - R.PointAt(R.Length() - Pp.StandOff)), 0.0, 3.0);
	CHECK(Length(Pl.Pos - R.PointAt(R.Length())) > Pp.StandOff * 0.7);
	// It faced the way it flew.
	Pilot Pm;
	Pm.Pos = R.PointAt(0.0);
	for (int I = 0; I < 600; ++I)
	{
		StepPilot(Pm, R, 1.0 / 60.0, PilotInput{}, Pp, nullptr, 260.0);
	}
	CHECK_NEAR(Length(Pm.Fwd), 1.0, 1e-9);
	CHECK(Dot(Pm.Fwd, R.TangentAt(Pm.S)) > 0.98);
	CHECK(std::fabs(Pm.Roll) < 0.05);
	// Steering: it moves sideways while held, no farther than the limit, and comes back to the line when released.
	Pilot Ps;
	Ps.Pos = R.PointAt(0.0);
	for (int I = 0; I < 240; ++I)
	{
		StepPilot(Ps, R, 1.0 / 60.0, PilotInput{1.0, 0.0, 1.0}, Pp, nullptr, 260.0);
		CHECK(std::sqrt(Ps.OffR * Ps.OffR + Ps.OffU * Ps.OffU) <= Pp.MaxOffset + 1e-6);
	}
	CHECK(Ps.OffR > Pp.MaxOffset * 0.95);
	CHECK(std::fabs(Ps.Roll) > 0.001);
	for (int I = 0; I < 600; ++I)
	{
		StepPilot(Ps, R, 1.0 / 60.0, PilotInput{}, Pp, nullptr, 260.0);
	}
	CHECK(std::fabs(Ps.OffR) < 5.0);
	// Throttle 0 holds it still.
	Pilot Pt;
	Pt.Pos = R.PointAt(0.0);
	for (int I = 0; I < 300; ++I)
	{
		StepPilot(Pt, R, 1.0 / 60.0, PilotInput{0.0, 0.0, 0.0}, Pp, nullptr, 260.0);
	}
	CHECK_NEAR(Pt.S, 0.0, 1e-9);
	// Assist: a rock in the way makes the ship slip aside; without assist it flies straight at it.
	std::vector<Rock> Rocks = {MakeRock(1U, R.PointAt(9000.0), 300.0)};
	auto Closest = [&](bool bAssist) {
		Pilot Pa;
		Pa.Pos = R.PointAt(0.0);
		PilotParams P2 = Pp;
		P2.bAssist = bAssist;
		double Best = 1e300;
		for (int I = 0; I < 60 * 12; ++I)
		{
			StepPilot(Pa, R, 1.0 / 60.0, PilotInput{}, P2, &Rocks, 260.0);
			Best = std::min(Best, Length(Pa.Pos - Rocks[0].Pos));
		}
		return Best;
	};
	const double With = Closest(true);
	const double Without = Closest(false);
	CHECK(Without < 300.0);
	CHECK(With > Without + 150.0);
	CHECK(With > 300.0 + 260.0 * 0.8);
	// A zero-length route does not move it or crash.
	Pilot Pz;
	StepPilot(Pz, BuildRoute(Vec3{}, Vec3{}, 1U), 0.016, PilotInput{}, Pp, nullptr, 260.0);
	CHECK(Finite(Pz.Pos));
}

static void TestAim()
{
	// ClampAim: inside the cone it is the desired direction, outside it stops at the edge.
	const Vec3 F{1, 0, 0};
	CHECK(Length(ClampAim(F, Normalized(Vec3{1, 0.1, 0}), 20.0) - Normalized(Vec3{1, 0.1, 0})) < 1e-9);
	const Vec3 Out = ClampAim(F, Vec3{0, 1, 0}, 30.0);
	CHECK_NEAR(Length(Out), 1.0, 1e-9);
	CHECK_NEAR(Dot(Out, F), std::cos(AetherSpace::DegToRad(30.0)), 1e-9);
	CHECK(Out.Y > 0.0);
	CHECK(Finite(ClampAim(F, Vec3{-1, 0, 0}, 30.0)));
	CHECK(Finite(ClampAim(Vec3{}, Vec3{}, 30.0)));
	// LeadDirection: step a shot and a moving target and see them meet.
	Rng R(3U);
	for (int Case = 0; Case < 50; ++Case)
	{
		const Vec3 Me{R.Range(-500.0, 500.0), R.Range(-500.0, 500.0), R.Range(-500.0, 500.0)};
		const Vec3 MyV{R.Range(-3000.0, 3000.0), R.Range(-800.0, 800.0), R.Range(-800.0, 800.0)};
		const Vec3 Tp{R.Range(5000.0, 40000.0), R.Range(-9000.0, 9000.0), R.Range(-9000.0, 9000.0)};
		const Vec3 Tv{R.Range(-1200.0, 1200.0), R.Range(-1200.0, 1200.0), R.Range(-1200.0, 1200.0)};
		const double Speed = 60000.0;
		Vec3 Dir;
		double T = 0.0;
		CHECK(LeadDirection(Me, MyV, Tp, Tv, Speed, Dir, T));
		CHECK(T > 0.0 && std::isfinite(T));
		CHECK_NEAR(Length(Dir), 1.0, 1e-9);
		// The shot (inheriting my velocity) and the target are in the same place at T.
		const Vec3 ShotAt = Me + (Dir * Speed + MyV) * T;
		const Vec3 TargetAt = Tp + Tv * T;
		CHECK(Length(ShotAt - TargetAt) < 1e-3);
	}
	// A target that outruns the shot cannot be led.
	Vec3 D;
	double T = 0.0;
	CHECK(!LeadDirection(Vec3{}, Vec3{}, Vec3{1000, 0, 0}, Vec3{5000, 0, 0}, 1000.0, D, T));
	// PickTarget: the rock nearest the line of fire, within range and the cone.
	std::vector<Rock> Rocks = {MakeRock(1U, Vec3{10000, 3000, 0}, 100.0), MakeRock(2U, Vec3{12000, 200, 0}, 100.0), MakeRock(3U, Vec3{-5000, 0, 0}, 100.0), MakeRock(4U, Vec3{80000, 0, 0}, 100.0)};
	CHECK(PickTarget(Vec3{}, Vec3{1, 0, 0}, Rocks, 30000.0, 20.0) == 1);
	CHECK(PickTarget(Vec3{}, Vec3{1, 0, 0}, Rocks, 30000.0, 1.0) == 1); // within a degree
	CHECK(PickTarget(Vec3{}, Vec3{0, 1, 0}, Rocks, 30000.0, 5.0) == -1); // nothing that way
	CHECK(PickTarget(Vec3{}, Vec3{1, 0, 0}, Rocks, 5000.0, 20.0) == -1); // out of range
	CHECK(PickTarget(Vec3{}, Vec3{1, 0, 0}, {}, 30000.0, 20.0) == -1);
	// The wide rock counts although its middle (10.8 degrees off) is outside the 8 degree cone: its edge is 7.3 degrees off.
	std::vector<Rock> Wide = {MakeRock(1U, Vec3{10000, 1900, 0}, 600.0)};
	CHECK(PickTarget(Vec3{}, Vec3{1, 0, 0}, Wide, 30000.0, 8.0) == 0);
	CHECK(PickTarget(Vec3{}, Vec3{1, 0, 0}, Wide, 30000.0, 6.0) == -1);
}

static void TestDebris()
{
	Event E;
	E.At = Vec3{100.0, 0.0, 0.0};
	E.Dir = Vec3{1, 0, 0};
	E.Size = 300.0;
	E.RockId = 5U;
	const std::vector<Fragment> A = MakeDebris(E, 3U, 40);
	const std::vector<Fragment> B = MakeDebris(E, 3U, 40);
	CHECK(A.size() == 40U && B.size() == 40U);
	CHECK(Length(A[7].V0 - B[7].V0) == 0.0);
	CHECK(MakeDebris(E, 3U, 0).empty());
	CHECK(MakeDebris(E, 3U, 1000).size() == 96U);
	double Fwd = 0.0;
	for (const Fragment& F : A)
	{
		CHECK(Length(F.P0 - E.At) <= E.Size);
		CHECK(F.Size >= 3.0 && F.Size < E.Size * 0.13);
		CHECK(F.Life > 1.0 && F.Life < 3.3);
		Fwd += Dot(F.V0, E.Dir);
		// It coasts out and slows: farther each moment, never past where drag lets it get.
		double Prev = 0.0;
		for (double T = 0.0; T <= 4.0; T += 0.1)
		{
			const double D = Length(FragmentAt(F, T) - F.P0);
			CHECK(D >= Prev - 1e-9);
			Prev = D;
		}
		CHECK(Prev < Length(F.V0) / 1.3 + 1e-6);
		CHECK(FragmentScale(F, 0.0) == 1.0 && FragmentScale(F, F.Life) == 0.0 && FragmentScale(F, F.Life * 0.5) == 1.0);
	}
	CHECK(Fwd > 0.0); // thrown more along the shot than against it
	// The blast: flash first, then fire, then smoke; nothing outside its time.
	const Blast B0 = BlastAt(0.0, 1.2);
	const Blast B1 = BlastAt(0.2, 1.2);
	const Blast B2 = BlastAt(0.9, 1.2);
	CHECK(B0.Flash > 0.99 && B0.Fire < 0.01);
	CHECK(B1.Fire > B0.Fire && B1.Flash < 0.1);
	CHECK(B2.Smoke > 0.0 && B2.Fire < B1.Fire);
	CHECK(B1.Ring > B0.Ring && B2.Ring > B1.Ring && B2.Ring <= 1.0);
	const Blast Out = BlastAt(5.0, 1.2);
	CHECK(Out.Flash == 0.0 && Out.Fire == 0.0 && Out.Ring == 0.0 && Out.Smoke == 0.0);
	CHECK(BlastAt(-1.0, 1.2).Flash == 0.0);
}

int main()
{
	std::printf("combat\n");
	TestRoute();
	TestField();
	TestShots();
	TestFracture();
	TestShip();
	TestPilot();
	TestAim();
	TestDebris();
	TestReplay();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
