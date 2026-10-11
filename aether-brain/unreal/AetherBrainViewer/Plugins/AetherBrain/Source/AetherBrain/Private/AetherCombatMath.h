// The voyage to a folder, as pure maths with no Unreal types: the route (a smooth curve from where the ship is to the
// folder), asteroid fields placed along it, the ship's cannon and its shots (swept, so a fast shot cannot tunnel through a
// small rock), rocks that break into smaller rocks and dust, a shield that takes the knocks, an autopilot that flies the
// route and steers round what is in the way, and the aiming helpers (lead, nearest target in the cone).
//
// Units are centimetres and seconds, as in the viewer. Everything random comes from a seed, so a run can be replayed:
// tests/combat_core_test.cpp does that. The actor (AetherVoyageActor) only draws what this says and feeds it the player's input.
#pragma once

#include "AetherSpaceMath.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace AetherCombat
{
using AetherSpace::Clamp;
using AetherSpace::Clamp01;
using AetherSpace::Cross;
using AetherSpace::Dot;
using AetherSpace::FromAxisAngle;
using AetherSpace::HashU;
using AetherSpace::kPi;
using AetherSpace::Length;
using AetherSpace::Lerp;
using AetherSpace::Normalized;
using AetherSpace::Quat;
using AetherSpace::Rng;
using AetherSpace::Rotate;
using AetherSpace::Smoothstep;
using AetherSpace::Vec3;

/* ------------------------------------------------------------------------------------------------------------------ */
/* The route                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A curve sampled as a polyline: points, and the distance along it to each. */
struct Route
{
	std::vector<Vec3> Pts;
	std::vector<double> Cum;

	double Length() const { return Cum.empty() ? 0.0 : Cum.back(); }

	/** The point at distance S along the route (clamped to its ends). */
	Vec3 PointAt(double S) const
	{
		if (Pts.empty())
		{
			return Vec3{};
		}
		if (S <= 0.0 || Pts.size() == 1U)
		{
			return Pts.front();
		}
		if (S >= Cum.back())
		{
			return Pts.back();
		}
		const size_t I = Index(S);
		const double Span = Cum[I + 1U] - Cum[I];
		const double T = Span > 1e-12 ? (S - Cum[I]) / Span : 0.0;
		return Pts[I] + (Pts[I + 1U] - Pts[I]) * T;
	}

	/** The unit direction of travel at distance S. */
	Vec3 TangentAt(double S) const
	{
		if (Pts.size() < 2U)
		{
			return Vec3{1.0, 0.0, 0.0};
		}
		const double H = std::max(20.0, Length() * 0.002);
		const Vec3 D = PointAt(S + H) - PointAt(S - H);
		return Normalized(D, Vec3{1.0, 0.0, 0.0});
	}

	/** The distance along the route of the point nearest P, searched from `Hint` (a distance) forward and back by `Window`. */
	double Closest(const Vec3& P, double Hint, double Window) const
	{
		if (Pts.size() < 2U)
		{
			return 0.0;
		}
		const double Lo = Clamp(Hint - Window, 0.0, Length());
		const double Hi = Clamp(Hint + Window, 0.0, Length());
		double Best = Lo;
		double BestD = 1e300;
		for (size_t I = Index(Lo); I + 1U < Pts.size() && Cum[I] <= Hi; ++I)
		{
			const Vec3 A = Pts[I];
			const Vec3 B = Pts[I + 1U];
			const Vec3 AB = B - A;
			const double L2 = Dot(AB, AB);
			const double T = L2 > 1e-12 ? Clamp01(Dot(P - A, AB) / L2) : 0.0;
			const Vec3 Q = A + AB * T;
			const double D = AetherSpace::Length(P - Q);
			if (D < BestD)
			{
				BestD = D;
				Best = Cum[I] + (Cum[I + 1U] - Cum[I]) * T;
			}
		}
		return Clamp(Best, Lo, Hi);
	}

private:
	size_t Index(double S) const
	{
		size_t Lo = 0;
		size_t Hi = Cum.size() - 1U;
		while (Hi - Lo > 1U)
		{
			const size_t Mid = (Lo + Hi) / 2U;
			(Cum[Mid] <= S ? Lo : Hi) = Mid;
		}
		return Lo;
	}
};

/**
 * A smooth route from `From` to `To`: a Catmull-Rom curve through two points a third and two thirds of the way, pushed
 * sideways and up by up to `Meander` of the distance, so the flight bends instead of running down a ruler. `Step` is the
 * spacing of the samples (cm).
 */
inline Route BuildRoute(const Vec3& From, const Vec3& To, uint32_t Seed, double Meander = 0.12, double Step = 100.0)
{
	Route R;
	const Vec3 Chord = To - From;
	const double L = Length(Chord);
	if (L < 1e-6)
	{
		R.Pts = {From, To};
		R.Cum = {0.0, 0.0};
		return R;
	}
	const Vec3 Dir = Chord * (1.0 / L);
	Vec3 Side = Cross(Dir, AetherSpace::kUp);
	if (Length(Side) < 1e-6)
	{
		Side = Vec3{0.0, 1.0, 0.0};
	}
	Side = Normalized(Side);
	const Vec3 Up = Normalized(Cross(Side, Dir));
	Rng Rg(Seed * 2246822519U + 3U);
	const double M = Clamp(Meander, 0.0, 0.4);
	const Vec3 C1 = From + Chord * (1.0 / 3.0) + Side * (L * M * Rg.Range(-1.0, 1.0)) + Up * (L * M * 0.5 * Rg.Range(-1.0, 1.0));
	const Vec3 C2 = From + Chord * (2.0 / 3.0) + Side * (L * M * Rg.Range(-1.0, 1.0)) + Up * (L * M * 0.5 * Rg.Range(-1.0, 1.0));
	// Phantom end points that keep the ends straight along the chord.
	const Vec3 P0 = From - Dir * (L * 0.2);
	const Vec3 P3 = To + Dir * (L * 0.2);
	const Vec3 K[6] = {P0, From, C1, C2, To, P3};
	const int N = static_cast<int>(Clamp(std::ceil(L * 1.15 / std::max(10.0, Step)), 16.0, 4000.0));
	R.Pts.reserve(static_cast<size_t>(N) + 1U);
	for (int I = 0; I <= N; ++I)
	{
		const double U = static_cast<double>(I) / static_cast<double>(N) * 3.0;
		const int Seg = std::min(2, static_cast<int>(std::floor(U)));
		const double T = U - Seg;
		const Vec3& A = K[Seg];
		const Vec3& B = K[Seg + 1];
		const Vec3& C = K[Seg + 2];
		const Vec3& D = K[Seg + 3];
		const double T2 = T * T;
		const double T3 = T2 * T;
		R.Pts.push_back((B * 2.0 + (C - A) * T + (A * 2.0 - B * 5.0 + C * 4.0 - D) * T2 + (B * 3.0 - A - C * 3.0 + D) * T3) * 0.5);
	}
	R.Pts.front() = From;
	R.Pts.back() = To;
	R.Cum.assign(R.Pts.size(), 0.0);
	for (size_t I = 1; I < R.Pts.size(); ++I)
	{
		R.Cum[I] = R.Cum[I - 1U] + Length(R.Pts[I] - R.Pts[I - 1U]);
	}
	return R;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Rocks                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

struct Rock
{
	uint32_t Id = 0U;
	/** Seeds the rock's shape (the viewer keeps a few built meshes and picks by Shape). */
	uint32_t Seed = 0U;
	int Kind = 0;
	int Shape = 0;
	/** 0 = a rock of the field, 1 = a piece of one, 2 = a piece of a piece ... */
	int Gen = 0;
	Vec3 Pos;
	Vec3 Vel;
	Quat Rot;
	/** Axis times rate (rad/s). */
	Vec3 Spin;
	double Radius = 100.0;
	double Health = 1.0;
	double MaxHealth = 1.0;
	double Age = 0.0;
};

/** How tough a rock of this radius is: a small one takes a shot or two, a boulder a good burst. */
inline double HealthOf(double Radius) { return 20.0 + 0.30 * Radius; }

struct FieldParams
{
	double MinRadius = 60.0;
	double MaxRadius = 520.0;
	int MaxRocks = 140;
	/** The route length between two groups of rocks on average. */
	double Spacing = 2800.0;
	double GroupRadius = 1500.0;
	int GroupMin = 3;
	int GroupMax = 9;
	/** Nothing is placed in this much of the route at the start, and in this much (plus the folder's size) at its end. */
	double ClearStart = 1500.0;
	double ClearEnd = 2800.0;
	/** Typical drift speed of a rock (cm/s). */
	double DriftSpeed = 45.0;
	int ShapeVariants = 12;
	int Kinds = 4;
};

/**
 * Asteroid groups along the route: each group a loose cluster a little off the line (about half of them close enough to
 * block it, so there is always something to shoot), some with a boulder in the middle, none at the start or round the
 * folder, none overlapping. `ShipRadius` keeps the very start clear. Ids count up from `FirstId`.
 */
inline std::vector<Rock> PlaceField(const Route& Rt, uint32_t Seed, const FieldParams& P, double ShipRadius, uint32_t FirstId)
{
	std::vector<Rock> Out;
	const double L = Rt.Length();
	const double From = P.ClearStart + ShipRadius;
	const double To = L - P.ClearEnd;
	if (To - From < P.Spacing * 0.5 || P.MaxRocks <= 0)
	{
		return Out;
	}
	Rng R(Seed * 3266489917U + 41U);
	const int Groups = std::max(1, static_cast<int>(std::lround((To - From) / P.Spacing)));
	uint32_t Id = FirstId;
	for (int G = 0; G < Groups && static_cast<int>(Out.size()) < P.MaxRocks; ++G)
	{
		const double S = From + (To - From) * (static_cast<double>(G) + R.Range(0.2, 0.8)) / static_cast<double>(Groups);
		const Vec3 Centre0 = Rt.PointAt(S);
		const Vec3 Tan = Rt.TangentAt(S);
		Vec3 Side = Cross(Tan, AetherSpace::kUp);
		if (Length(Side) < 1e-6)
		{
			Side = Vec3{0.0, 1.0, 0.0};
		}
		Side = Normalized(Side);
		const Vec3 Up = Normalized(Cross(Side, Tan));
		const double Ang = R.Range(0.0, 2.0 * kPi);
		const Vec3 Centre = Centre0 + (Side * std::cos(Ang) + Up * std::sin(Ang)) * (R.Range(0.0, 0.7) * P.GroupRadius);
		const int Count = P.GroupMin + static_cast<int>(R.Next() * static_cast<double>(std::max(0, P.GroupMax - P.GroupMin + 1)));
		const bool bBoulder = (G % 3) == 1;
		for (int K = 0; K < Count && static_cast<int>(Out.size()) < P.MaxRocks; ++K)
		{
			Rock Rk;
			Rk.Id = Id;
			Rk.Seed = static_cast<uint32_t>(HashU(Seed, Id, 11U));
			Rk.Kind = static_cast<int>(R.NextU() % static_cast<uint32_t>(std::max(1, P.Kinds)));
			Rk.Shape = static_cast<int>(R.NextU() % static_cast<uint32_t>(std::max(1, P.ShapeVariants)));
			// Mostly small, a few big: log-normal around a third of the largest.
			const double Mid = P.MaxRadius * 0.28;
			Rk.Radius = Clamp(Mid * std::exp(0.65 * R.Gauss()), P.MinRadius, P.MaxRadius);
			if (bBoulder && K == 0)
			{
				Rk.Radius = P.MaxRadius * R.Range(0.85, 1.0);
			}
			bool bPlaced = false;
			for (int Try = 0; Try < 24 && !bPlaced; ++Try)
			{
				const Vec3 Off = Vec3{R.Gauss(), R.Gauss(), R.Gauss()} * (P.GroupRadius / 2.4);
				const double Reach = Length(Off);
				Vec3 Pos = Centre + (Reach > P.GroupRadius ? Off * (P.GroupRadius / Reach) : Off);
				if (bBoulder && K == 0)
				{
					Pos = Centre;
				}
				bool bClear = true;
				for (const Rock& O : Out)
				{
					if (Length(O.Pos - Pos) < (O.Radius + Rk.Radius) * 1.2)
					{
						bClear = false;
						break;
					}
				}
				// Not in the cleared stretches at either end.
				const double Along = Rt.Closest(Pos, S, P.GroupRadius * 2.0);
				if (Along < From - Rk.Radius || Along > To + Rk.Radius)
				{
					bClear = false;
				}
				if (bClear)
				{
					Rk.Pos = Pos;
					bPlaced = true;
				}
			}
			if (!bPlaced)
			{
				continue;
			}
			const Vec3 DriftDir = R.Unit();
			Rk.Vel = DriftDir * (P.DriftSpeed * R.Range(0.2, 1.4));
			Rk.Spin = R.Unit() * R.Range(0.02, 0.25);
			Rk.Rot = FromAxisAngle(R.Unit(), R.Range(0.0, 2.0 * kPi));
			Rk.MaxHealth = HealthOf(Rk.Radius);
			Rk.Health = Rk.MaxHealth;
			Out.push_back(Rk);
			++Id;
		}
	}
	return Out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shots, the cannon, events                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

struct Shot
{
	uint32_t Id = 0U;
	Vec3 Pos;
	Vec3 Vel;
	double Age = 0.0;
	double Life = 1.6;
	double Damage = 35.0;
	/** Half the width of the bolt: it hits what passes within this of its path. */
	double Radius = 14.0;
};

struct Weapon
{
	/** Shots per second (the two barrels alternate). */
	double Rate = 7.0;
	/** cm/s relative to the ship. */
	double Speed = 62000.0;
	double Damage = 35.0;
	double Life = 1.6;
	/** Half the width between the barrels, cm. */
	double BarrelOffset = 90.0;
	/** Random angle of a shot off the aim, radians. */
	double Spread = 0.0025;
	/** The two barrels aim at the same point this far ahead (cm), so their shots cross on what the pilot is looking at. */
	double Converge = 20000.0;
	double Cooldown = 0.0;
	int NextBarrel = 0;
};

enum class EventKind : uint8_t
{
	/** A shot left a barrel (At = the muzzle, Dir = the way it flies). */
	Fired,
	/** A shot hit a rock that stood (At = the point, Dir = out of the surface, Size = the bolt). */
	Hit,
	/** A rock broke into pieces (At = its middle, Size = its radius, Dir = the way the shot was flying). */
	Break,
	/** A small rock was blown to dust. */
	Vaporize,
	/** A rock struck the ship (At = the point, Size = the rock's radius). */
	ShipHit,
};

struct Event
{
	EventKind Kind = EventKind::Hit;
	Vec3 At;
	Vec3 Dir;
	double Size = 0.0;
	uint32_t RockId = 0U;
	int RockKind = 0;
};

/** The ship as the field sees it. */
struct ShipBody
{
	Vec3 Pos;
	Vec3 Vel;
	double Radius = 260.0;
	double Shield = 100.0;
	double MaxShield = 100.0;
	double Hull = 100.0;
	/** The shield comes back this fast (per second) after `ShieldDelay` seconds without a hit. */
	double ShieldRegen = 14.0;
	double ShieldDelay = 3.0;
	double SinceHit = 99.0;
};

struct FieldRules
{
	/** A rock this big or bigger breaks into pieces; smaller ones turn to dust. */
	double SplitRadius = 110.0;
	/** Share of the volume that is left as pieces. */
	double Retained = 0.55;
	/** Pieces cannot hurt the ship for this long after they form (they are born next to it). */
	double Grace = 0.6;
	/** Rocks farther than this from the ship, and older than a few seconds, are forgotten. */
	double CullDistance = 60000.0;
	double HitScale = 0.92;
	int MaxShots = 96;
	int MaxRocks = 220;
};

class Field
{
public:
	std::vector<Rock> Rocks;
	std::vector<Shot> Shots;
	/** What happened since the last TakeEvents (Fire and Step add to it). */
	std::vector<Event> Events;
	FieldRules Rules;
	int Score = 0;
	int RocksDestroyed = 0;

	explicit Field(uint32_t Seed = 1U, uint32_t FirstId = 1U) : R(Seed * 668265263U + 5U), NextId(FirstId) {}

	uint32_t NewId() { return NextId++; }

	/** The events so far, handed over and cleared. */
	std::vector<Event> TakeEvents()
	{
		std::vector<Event> Out;
		Out.swap(Events);
		return Out;
	}

	void AddRocks(const std::vector<Rock>& More)
	{
		for (const Rock& Rk : More)
		{
			if (static_cast<int>(Rocks.size()) >= Rules.MaxRocks)
			{
				break;
			}
			Rocks.push_back(Rk);
			NextId = std::max(NextId, Rk.Id + 1U);
		}
	}

	/**
	 * Fires if the weapon is ready: true when a shot left. `Dir` is a unit vector; the shot inherits the ship's velocity. The
	 * barrels sit `BarrelOffset` to each side and aim at the point `Converge` ahead along `Dir` (the weapon's own distance
	 * when `Converge` is negative), so a shot is not a barrel's width off a small rock in the middle of the sights.
	 */
	bool Fire(Weapon& W, const Vec3& ShipPos, const Vec3& ShipVel, const Vec3& Dir, const Vec3& Right, double Converge = -1.0)
	{
		if (W.Cooldown > 0.0 || static_cast<int>(Shots.size()) >= Rules.MaxShots)
		{
			return false;
		}
		W.Cooldown += 1.0 / std::max(0.5, W.Rate);
		const double Side = (W.NextBarrel++ % 2 == 0) ? -1.0 : 1.0;
		const Vec3 Muzzle = ShipPos + Right * (Side * W.BarrelOffset) + Dir * (W.BarrelOffset * 1.5);
		const Vec3 Point = ShipPos + Dir * std::max(500.0, Converge >= 0.0 ? Converge : W.Converge);
		Vec3 D = Normalized(Point - Muzzle, Dir);
		D = Normalized(D + Vec3{R.Gauss(), R.Gauss(), R.Gauss()} * W.Spread, D);
		Shot S;
		S.Id = NewId();
		S.Pos = Muzzle;
		S.Vel = D * W.Speed + ShipVel;
		S.Life = W.Life;
		S.Damage = W.Damage;
		Shots.push_back(S);
		Events.push_back(Event{EventKind::Fired, Muzzle, D, 0.0, 0U, 0});
		return true;
	}

	/** Moves everything by Dt seconds, resolves hits, breaks rocks, damages the ship, forgets what is far behind. */
	void Step(double Dt, ShipBody& Ship, Weapon* W = nullptr)
	{
		if (W != nullptr)
		{
			W->Cooldown = std::max(0.0, W->Cooldown - Dt);
		}
		if (Dt <= 0.0)
		{
			return;
		}
		for (Rock& Rk : Rocks)
		{
			Rk.Pos = Rk.Pos + Rk.Vel * Dt;
			const double Rate = Length(Rk.Spin);
			if (Rate > 1e-9)
			{
				Rk.Rot = Normalize(FromAxisAngle(Rk.Spin * (1.0 / Rate), Rate * Dt) * Rk.Rot);
			}
			Rk.Age += Dt;
		}
		std::vector<bool> Dead(Rocks.size(), false);
		std::vector<Vec3> KillDir(Rocks.size());
		// Shots: each one moves along a segment; the first rock its bolt touches takes the damage.
		for (size_t I = 0; I < Shots.size();)
		{
			Shot& S = Shots[I];
			const Vec3 P0 = S.Pos;
			const Vec3 Move = S.Vel * Dt;
			double BestT = 2.0;
			size_t BestRock = Rocks.size();
			for (size_t J = 0; J < Rocks.size(); ++J)
			{
				if (Dead[J])
				{
					continue;
				}
				// The rock moved this step too: test against where it is now, the shot's path relative to it is what counts.
				const double T = SweepHit(P0, Move, Rocks[J].Pos, Rocks[J].Radius * Rules.HitScale + S.Radius);
				if (T >= 0.0 && T < BestT)
				{
					BestT = T;
					BestRock = J;
				}
			}
			if (BestRock < Rocks.size())
			{
				Rock& Rk = Rocks[BestRock];
				const Vec3 At = P0 + Move * BestT;
				const Vec3 Out = Normalized(At - Rk.Pos, Vec3{0.0, 0.0, 1.0});
				Rk.Health -= S.Damage;
				Rk.Vel = Rk.Vel + Normalized(S.Vel) * (S.Damage * 0.6 * (100.0 / std::max(60.0, Rk.Radius)));
				Events.push_back(Event{EventKind::Hit, At, Out, S.Radius, Rk.Id, Rk.Kind});
				if (Rk.Health <= 0.0)
				{
					Dead[BestRock] = true;
					KillDir[BestRock] = Normalized(S.Vel);
				}
				Shots[I] = Shots.back();
				Shots.pop_back();
				continue;
			}
			S.Pos = P0 + Move;
			S.Age += Dt;
			if (S.Age >= S.Life)
			{
				Shots[I] = Shots.back();
				Shots.pop_back();
				continue;
			}
			++I;
		}
		// Rocks and the ship.
		Ship.SinceHit += Dt;
		for (size_t J = 0; J < Rocks.size(); ++J)
		{
			if (Dead[J])
			{
				continue;
			}
			const Rock& Rk = Rocks[J];
			if (Rk.Gen > 0 && Rk.Age < Rules.Grace)
			{
				continue;
			}
			const Vec3 Gap = Rk.Pos - Ship.Pos;
			const double Dist = Length(Gap);
			if (Dist < Rk.Radius * Rules.HitScale + Ship.Radius)
			{
				const Vec3 Out = Normalized(Gap * -1.0, Vec3{-1.0, 0.0, 0.0});
				const double Rel = Length(Rk.Vel - Ship.Vel);
				const double Dmg = Clamp(Rk.Radius * 0.14 * (1.0 + Rel / 2500.0), 4.0, 60.0);
				const double Soak = std::min(Ship.Shield, Dmg);
				Ship.Shield -= Soak;
				Ship.Hull = std::max(0.0, Ship.Hull - (Dmg - Soak) * 0.5);
				Ship.SinceHit = 0.0;
				Events.push_back(Event{EventKind::ShipHit, Ship.Pos + Normalized(Gap) * Ship.Radius, Out, Rk.Radius, Rk.Id, Rk.Kind});
				Dead[J] = true;
				KillDir[J] = Normalized(Rk.Pos - Ship.Pos);
			}
		}
		if (Ship.SinceHit > Ship.ShieldDelay)
		{
			Ship.Shield = std::min(Ship.MaxShield, Ship.Shield + Ship.ShieldRegen * Dt);
		}
		// Break what died.
		std::vector<Rock> Born;
		std::vector<Rock> Alive;
		Alive.reserve(Rocks.size());
		for (size_t J = 0; J < Rocks.size(); ++J)
		{
			if (Dead[J])
			{
				Destroy(Rocks[J], KillDir[J], Born);
			}
			else
			{
				Alive.push_back(Rocks[J]);
			}
		}
		Rocks = std::move(Alive);
		for (const Rock& Pc : Born)
		{
			if (static_cast<int>(Rocks.size()) < Rules.MaxRocks)
			{
				Rocks.push_back(Pc);
			}
		}
		// Forget what is far away and has been around.
		Rocks.erase(std::remove_if(Rocks.begin(), Rocks.end(), [&](const Rock& Rk) { return Rk.Age > 4.0 && Length(Rk.Pos - Ship.Pos) > Rules.CullDistance; }), Rocks.end());
	}

	/** The earliest fraction (0..1) of the move from P0 along `Move` at which a ball of radius Rad at C is touched, or -1. */
	static double SweepHit(const Vec3& P0, const Vec3& Move, const Vec3& C, double Rad)
	{
		const Vec3 M = P0 - C;
		const double A = Dot(Move, Move);
		const double B = Dot(M, Move);
		const double Cc = Dot(M, M) - Rad * Rad;
		if (Cc <= 0.0)
		{
			return 0.0; // starts inside
		}
		if (A < 1e-12)
		{
			return -1.0;
		}
		const double Disc = B * B - A * Cc;
		if (Disc < 0.0)
		{
			return -1.0;
		}
		const double T = (-B - std::sqrt(Disc)) / A;
		return (T >= 0.0 && T <= 1.0) ? T : -1.0;
	}

private:
	Rng R;
	uint32_t NextId;

	static Quat Normalize(const Quat& Q)
	{
		const double L = std::sqrt(Q.X * Q.X + Q.Y * Q.Y + Q.Z * Q.Z + Q.W * Q.W);
		return L > 1e-12 ? Quat{Q.X / L, Q.Y / L, Q.Z / L, Q.W / L} : Quat{};
	}

	/** A rock is gone: pieces if it was big, dust if it was small. */
	void Destroy(const Rock& Rk, const Vec3& Dir, std::vector<Rock>& Born)
	{
		++RocksDestroyed;
		Score += static_cast<int>(std::lround(Rk.Radius / 10.0));
		if (Rk.Radius < Rules.SplitRadius)
		{
			Events.push_back(Event{EventKind::Vaporize, Rk.Pos, Dir, Rk.Radius, Rk.Id, Rk.Kind});
			return;
		}
		Events.push_back(Event{EventKind::Break, Rk.Pos, Dir, Rk.Radius, Rk.Id, Rk.Kind});
		const int Count = Rk.Radius > 340.0 ? 3 + static_cast<int>(R.Next() * 2.0) : 2 + static_cast<int>(R.Next() * 2.0);
		std::vector<double> W;
		double Sum3 = 0.0;
		for (int I = 0; I < Count; ++I)
		{
			W.push_back(R.Range(0.6, 1.0));
			Sum3 += W.back() * W.back() * W.back();
		}
		const double Scale = std::cbrt(Rules.Retained / Sum3);
		// Directions spread over the sphere.
		std::vector<Vec3> Dirs;
		for (int I = 0; I < Count; ++I)
		{
			Vec3 D = R.Unit();
			// Push apart from the ones already chosen.
			for (int Pass = 0; Pass < 8; ++Pass)
			{
				Vec3 Away{};
				for (const Vec3& O : Dirs)
				{
					Away = Away + (D - O) * (1.0 / std::max(0.05, Dot(D - O, D - O)));
				}
				D = Normalized(D + Away * 0.12, D);
			}
			Dirs.push_back(D);
		}
		for (int I = 0; I < Count; ++I)
		{
			Rock Pc;
			Pc.Id = NewId();
			Pc.Gen = Rk.Gen + 1;
			Pc.Kind = Rk.Kind;
			Pc.Seed = HashU(Rk.Seed, static_cast<uint32_t>(I), static_cast<uint32_t>(Pc.Gen));
			Pc.Shape = (Rk.Shape * 5 + I + 1 + Pc.Gen) % 12;
			Pc.Radius = Rk.Radius * W[static_cast<size_t>(I)] * Scale;
			const Vec3 D = Dirs[static_cast<size_t>(I)];
			// Born touching, not overlapping: from the parent's middle outward by what is left of the parent's reach.
			Pc.Pos = Rk.Pos + D * std::max(0.0, Rk.Radius * 0.55 - Pc.Radius * 0.15) * 0.6 + D * (Pc.Radius * 0.6);
			const double Out = R.Range(0.8, 1.25) * (170.0 + 0.30 * Rk.Radius);
			const double Kick = std::min(420.0, 22000.0 / std::max(60.0, Rk.Radius));
			Pc.Vel = Rk.Vel + D * Out + Dir * Kick + R.Unit() * (0.15 * Out);
			Pc.Spin = R.Unit() * R.Range(0.1, 0.7);
			Pc.Rot = FromAxisAngle(R.Unit(), R.Range(0.0, 2.0 * kPi));
			Pc.MaxHealth = HealthOf(Pc.Radius);
			Pc.Health = Pc.MaxHealth;
			Born.push_back(Pc);
		}
	}
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Dust and fire                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One piece of rubble thrown out by a break: where it starts, how fast it goes, how big it is, how long it lives. */
struct Fragment
{
	Vec3 P0;
	Vec3 V0;
	double Size = 10.0;
	/** Tumble rate, rad/s. */
	double Spin = 1.0;
	double Life = 2.0;
};

/** The rubble of a break (`Count` pieces), thrown out of a ball of radius `Size`, biased the way the shot was flying. */
inline std::vector<Fragment> MakeDebris(const Event& E, uint32_t Seed, int Count)
{
	std::vector<Fragment> Out;
	Rng R(Seed * 2654435761U + static_cast<uint32_t>(E.RockId) * 40503U + 9U);
	const int N = static_cast<int>(Clamp(static_cast<double>(Count), 0.0, 96.0));
	for (int I = 0; I < N; ++I)
	{
		const Vec3 D = R.Unit();
		Fragment F;
		F.P0 = E.At + D * (E.Size * R.Range(0.1, 0.8));
		const double Speed = (200.0 + 0.55 * E.Size) * R.Range(0.3, 1.5);
		F.V0 = D * Speed + E.Dir * (0.4 * Speed);
		F.Size = std::max(3.0, E.Size * R.Range(0.02, 0.12));
		F.Spin = R.Range(-6.0, 6.0);
		F.Life = R.Range(1.2, 3.2);
		Out.push_back(F);
	}
	return Out;
}

/** Where a fragment is T seconds after the break: it coasts and slows (drag), so it never leaves far. */
inline Vec3 FragmentAt(const Fragment& F, double T)
{
	const double K = 1.3;
	return F.P0 + F.V0 * ((1.0 - std::exp(-K * T)) / K);
}

/** How a fragment looks T seconds in: 1 at the start, shrinking to 0 at the end of its life. */
inline double FragmentScale(const Fragment& F, double T) { return 1.0 - Smoothstep(0.55, 1.0, T / std::max(0.01, F.Life)); }

/** The look of a blast `T` seconds after it began (of `Duration`): the flash, the fireball, the shock ring (radius in units of the rock's), the smoke. */
struct Blast
{
	double Flash = 0.0;
	double Fire = 0.0;
	double Ring = 0.0;
	double Smoke = 0.0;
};

inline Blast BlastAt(double T, double Duration)
{
	Blast B;
	if (T < 0.0 || T > Duration)
	{
		return B;
	}
	const double U = T / std::max(0.05, Duration);
	B.Flash = std::exp(-T / 0.05);
	B.Fire = Smoothstep(0.0, 0.08, U) * (1.0 - Smoothstep(0.1, 0.7, U));
	B.Ring = 1.0 - std::exp(-5.0 * U);
	B.Smoke = Smoothstep(0.05, 0.3, U) * (1.0 - Smoothstep(0.5, 1.0, U));
	return B;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The pilot                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

struct PilotInput
{
	/** Steer sideways and up, each in [-1, 1]. */
	double Right = 0.0;
	double Up = 0.0;
	/** 0..1 of cruise speed. */
	double Throttle = 1.0;
};

struct Pilot
{
	/** Distance flown along the route. */
	double S = 0.0;
	double Speed = 0.0;
	/** Where the ship is off the route's line: sideways and up in the route's frame, and how fast that changes. */
	double OffR = 0.0;
	double OffU = 0.0;
	double VelR = 0.0;
	double VelU = 0.0;
	Vec3 Pos;
	Vec3 Fwd{1.0, 0.0, 0.0};
	Vec3 Right{0.0, 1.0, 0.0};
	Vec3 Up{0.0, 0.0, 1.0};
	Vec3 Vel;
	/** Roll, radians, from the sideways acceleration. */
	double Roll = 0.0;
	bool bArrived = false;
};

struct PilotParams
{
	double Cruise = 3200.0;
	double Accel = 900.0;
	double Brake = 1700.0;
	/** The farthest the ship may stray from the route's line. */
	double MaxOffset = 900.0;
	/** How fast the player's steering moves it sideways (cm/s at full stick). */
	double Steer = 1100.0;
	/** The route's end is not reached: the ship stops this far before it. */
	double StandOff = 900.0;
	/** Steer round rocks in the way when the player is not steering. */
	bool bAssist = true;
};

/**
 * Flies the route: speeds up to cruise, slows to stop `StandOff` short of the end, drifts sideways as the player steers
 * (pulling back to the line when they let go), and, with assist on, slips round a rock that is in the way.
 */
inline void StepPilot(Pilot& Pl, const Route& Rt, double Dt, const PilotInput& In, const PilotParams& Pp, const std::vector<Rock>* Rocks, double ShipRadius)
{
	if (Dt <= 0.0 || Rt.Pts.size() < 2U)
	{
		return;
	}
	const double L = Rt.Length();
	const double Goal = std::max(0.0, L - Pp.StandOff);
	const double Remaining = Goal - Pl.S;
	const double Target = Pp.Cruise * Clamp01(In.Throttle);
	// Slow in time to stop at the goal: v^2 / (2 b) is the distance the brakes need.
	const double StopDist = Pl.Speed * Pl.Speed / (2.0 * Pp.Brake);
	if (Remaining <= StopDist + 1.0)
	{
		Pl.Speed = std::max(0.0, Pl.Speed - Pp.Brake * Dt);
		// Close enough: settle onto the goal.
		if (Remaining < 2.0 || Pl.Speed < 1.0)
		{
			Pl.Speed = std::min(Pl.Speed, std::max(0.0, Remaining * 3.0));
		}
	}
	else if (Pl.Speed < Target)
	{
		Pl.Speed = std::min(Target, Pl.Speed + Pp.Accel * Dt);
	}
	else
	{
		Pl.Speed = std::max(Target, Pl.Speed - Pp.Brake * Dt);
	}
	Pl.S = std::min(Goal, Pl.S + Pl.Speed * Dt);
	Pl.bArrived = (Goal - Pl.S) < 2.0 && Pl.Speed < 2.0;

	const Vec3 Tan = Rt.TangentAt(Pl.S);
	Vec3 Side = Cross(Tan, AetherSpace::kUp);
	if (Length(Side) < 1e-6)
	{
		Side = Vec3{0.0, 1.0, 0.0};
	}
	const Vec3 Right = Normalized(Side);
	const Vec3 Up = Normalized(Cross(Right, Tan));
	// Steering: the stick sets a sideways speed; with nothing held the ship eases back to the line.
	double WantR = In.Right * Pp.Steer;
	double WantU = In.Up * Pp.Steer;
	const bool bHeld = std::fabs(In.Right) > 0.05 || std::fabs(In.Up) > 0.05;
	if (!bHeld)
	{
		bool bThreat = false;
		double PushR = 0.0;
		double PushU = 0.0;
		if (Pp.bAssist && Rocks != nullptr)
		{
			// Rocks ahead whose path crosses the ship's: slip away from them, harder the nearer they are.
			const double Look = std::max(3500.0, Pl.Speed * 3.0 + 1500.0);
			for (const Rock& Rk : *Rocks)
			{
				const Vec3 Rel = Rk.Pos - Pl.Pos;
				const double Ahead = Dot(Rel, Tan);
				if (Ahead < -Rk.Radius || Ahead > Look)
				{
					continue;
				}
				const double Ry = Dot(Rel, Right);
				const double Rz = Dot(Rel, Up);
				const double Lat = std::sqrt(Ry * Ry + Rz * Rz);
				const double Need = Rk.Radius * 0.92 + ShipRadius * 1.3 + 140.0;
				if (Lat < Need * 1.3)
				{
					bThreat = true;
					const double Near = 1.0 - Clamp01(Ahead / Look);
					const double Push = std::sqrt(Near) * (1.0 - Clamp01(Lat / (Need * 1.3)) * 0.5);
					const double Dy = Lat > 1.0 ? -Ry / Lat : 1.0;
					const double Dz = Lat > 1.0 ? -Rz / Lat : 0.0;
					PushR += Dy * Pp.Steer * 1.3 * Push;
					PushU += Dz * Pp.Steer * 1.3 * Push;
				}
			}
		}
		// Back to the line when nothing is in the way; hold the offset while something is.
		const double Back = bThreat ? 0.0 : 0.8;
		WantR = -Pl.OffR * Back + PushR;
		WantU = -Pl.OffU * Back + PushU;
	}
	// Ease toward the wanted sideways speed.
	const double Ease = 1.0 - std::exp(-5.0 * Dt);
	const double PrevVelR = Pl.VelR;
	Pl.VelR += (WantR - Pl.VelR) * Ease;
	Pl.VelU += (WantU - Pl.VelU) * Ease;
	Pl.OffR += Pl.VelR * Dt;
	Pl.OffU += Pl.VelU * Dt;
	// Not past the limit: a disc, so diagonals are no farther than the sides.
	const double Off = std::sqrt(Pl.OffR * Pl.OffR + Pl.OffU * Pl.OffU);
	if (Off > Pp.MaxOffset)
	{
		const double K = Pp.MaxOffset / Off;
		Pl.OffR *= K;
		Pl.OffU *= K;
		// Stop pushing outward.
		if (Pl.OffR * Pl.VelR > 0.0)
		{
			Pl.VelR *= 0.5;
		}
		if (Pl.OffU * Pl.VelU > 0.0)
		{
			Pl.VelU *= 0.5;
		}
	}
	const Vec3 PrevPos = Pl.Pos;
	Pl.Pos = Rt.PointAt(Pl.S) + Right * Pl.OffR + Up * Pl.OffU;
	Pl.Vel = (Pl.Pos - PrevPos) * (1.0 / Dt);
	// Nose along the way it is going (the route's direction plus the sideways drift), roll into the turn.
	const Vec3 Heading = Tan * std::max(Pl.Speed, 200.0) + Right * Pl.VelR + Up * Pl.VelU;
	const Vec3 NewFwd = Normalized(Heading, Tan);
	// A little smoothing so it never snaps.
	Pl.Fwd = Normalized(Pl.Fwd * (1.0 - Ease) + NewFwd * Ease, NewFwd);
	Pl.Right = Normalized(Cross(AetherSpace::kUp, Pl.Fwd), Right);
	Pl.Up = Cross(Pl.Fwd, Pl.Right);
	const double Accel = (Pl.VelR - PrevVelR) / Dt;
	const double WantRoll = Clamp(-Accel * 0.0006 - Pl.VelR * 0.00045, -0.7, 0.7);
	Pl.Roll += (WantRoll - Pl.Roll) * Ease;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Aiming                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `Desired`, turned toward `Forward` if it is more than MaxDeg away from it (the guns only swing so far). */
inline Vec3 ClampAim(const Vec3& Forward, const Vec3& Desired, double MaxDeg)
{
	const Vec3 F = Normalized(Forward, Vec3{1.0, 0.0, 0.0});
	const Vec3 D = Normalized(Desired, F);
	const double Cos = Clamp(Dot(F, D), -1.0, 1.0);
	const double Ang = std::acos(Cos);
	const double Max = AetherSpace::DegToRad(MaxDeg);
	if (Ang <= Max)
	{
		return D;
	}
	// Spherical step from F toward D by Max.
	const Vec3 Perp = Normalized(D - F * Cos, F);
	return Normalized(F * std::cos(Max) + Perp * std::sin(Max), F);
}

/**
 * The direction to fire so that a shot of speed `ShotSpeed` (relative to the shooter, which moves at `ShooterVel`)
 * meets a target moving at `TargetVel`. False if it cannot (the target outruns the shot).
 */
inline bool LeadDirection(const Vec3& ShooterPos, const Vec3& ShooterVel, const Vec3& TargetPos, const Vec3& TargetVel, double ShotSpeed, Vec3& OutDir, double& OutTime)
{
	const Vec3 P = TargetPos - ShooterPos;
	const Vec3 V = TargetVel - ShooterVel;
	// |P + V t| = S t  ->  (V.V - S^2) t^2 + 2 P.V t + P.P = 0
	const double A = Dot(V, V) - ShotSpeed * ShotSpeed;
	const double B = 2.0 * Dot(P, V);
	const double C = Dot(P, P);
	double T = -1.0;
	if (std::fabs(A) < 1e-9)
	{
		if (std::fabs(B) > 1e-12)
		{
			T = -C / B;
		}
	}
	else
	{
		const double Disc = B * B - 4.0 * A * C;
		if (Disc >= 0.0)
		{
			const double Sq = std::sqrt(Disc);
			const double T1 = (-B - Sq) / (2.0 * A);
			const double T2 = (-B + Sq) / (2.0 * A);
			T = std::min(T1 > 1e-9 ? T1 : 1e30, T2 > 1e-9 ? T2 : 1e30);
			if (T > 1e29)
			{
				T = -1.0;
			}
		}
	}
	if (T <= 0.0)
	{
		return false;
	}
	OutTime = T;
	OutDir = Normalized(P + V * T, Normalized(P));
	return true;
}

/** The rock nearest the line of fire within a cone, within range (the one the bracket sits on), or -1. */
inline int PickTarget(const Vec3& From, const Vec3& Aim, const std::vector<Rock>& Rocks, double MaxRange, double ConeDeg)
{
	const Vec3 A = Normalized(Aim, Vec3{1.0, 0.0, 0.0});
	const double CosCone = std::cos(AetherSpace::DegToRad(ConeDeg));
	int Best = -1;
	double BestScore = 1e300;
	for (size_t I = 0; I < Rocks.size(); ++I)
	{
		const Vec3 Rel = Rocks[I].Pos - From;
		const double D = Length(Rel);
		if (D < 1.0 || D > MaxRange)
		{
			continue;
		}
		const double Cos = Dot(Rel * (1.0 / D), A);
		// The angular size counts: a big rock close to the line is within the cone even if its middle is not.
		const double Slack = std::asin(Clamp01(Rocks[I].Radius / D));
		if (std::acos(Clamp(Cos, -1.0, 1.0)) - Slack > std::acos(CosCone))
		{
			continue;
		}
		// Nearer to the line first, then nearer to us.
		const double Score = std::acos(Clamp(Cos, -1.0, 1.0)) * 4000.0 + D * 0.15;
		if (Score < BestScore)
		{
			BestScore = Score;
			Best = static_cast<int>(I);
		}
	}
	return Best;
}
} // namespace AetherCombat
