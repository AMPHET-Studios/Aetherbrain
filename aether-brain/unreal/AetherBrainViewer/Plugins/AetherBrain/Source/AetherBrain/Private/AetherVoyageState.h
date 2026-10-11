// One voyage to a folder, as pure maths with no Unreal types: the route and the asteroid field made for it, the ship
// that flies it (autopilot plus the player's steering), the cannon (aimed where the player's cursor points), the chase
// camera, and the counts the HUD shows. The actor (AetherVoyageActor) feeds it the input and draws what it says.
// tests/voyage_core_test.cpp flies whole voyages with it.
#pragma once

#include "AetherCombatMath.h"

namespace AetherVoyage
{
using namespace AetherCombat;

struct Setup
{
	/** Where the ship starts (the camera when the voyage was called), and the folder it flies to (cm). */
	Vec3 From;
	Vec3 To;
	/** The folder's picture card is this wide; the ship stops short of it so it fills the view. */
	double CardWidth = 900.0;
	uint32_t Seed = 1U;
	double ShipRadius = 260.0;
	PilotParams Flight;
	FieldParams Rocks;
	Weapon Gun;
	/** How far the guns swing off the nose (degrees). */
	double MaxAimDeg = 38.0;
	/** Rocks the sights can pick out as a target (cm). */
	double TargetRange = 40000.0;
	/** The gunsight also leads a target when the cursor is not on anything (assist). */
	bool bAutoAim = true;
};

struct Input
{
	/** Steer sideways and up, each in [-1, 1]. */
	double Right = 0.0;
	double Up = 0.0;
	/** 0..1 of cruise speed. */
	double Throttle = 1.0;
	bool bFire = false;
	/** The cursor's ray: from the camera, along `AimDir` (a unit vector). */
	bool bHasAim = false;
	Vec3 AimDir{1.0, 0.0, 0.0};
};

/** Where the chase camera is and where it looks. */
struct ChaseCamera
{
	Vec3 Pos;
	Vec3 Fwd{1.0, 0.0, 0.0};
	Vec3 Up{0.0, 0.0, 1.0};
	double FovDeg = 78.0;
};

class Session
{
public:
	/** Starts a voyage: builds the route and the field, puts the ship on it, and the camera behind. */
	void Begin(const Setup& S)
	{
		Cfg = S;
		Cfg.Flight.StandOff = std::max(S.Flight.StandOff, S.CardWidth * 1.35);
		Rt = BuildRoute(S.From, S.To, S.Seed);
		Pl = Pilot{};
		Pl.Pos = Rt.PointAt(0.0);
		Pl.Fwd = Rt.TangentAt(0.0);
		Pl.Right = Normalized(Cross(AetherSpace::kUp, Pl.Fwd), Vec3{0.0, 1.0, 0.0});
		Pl.Up = Cross(Pl.Fwd, Pl.Right);
		Body = ShipBody{};
		Body.Pos = Pl.Pos;
		Body.Radius = S.ShipRadius;
		Gun = S.Gun;
		Fld = Field(S.Seed, 1U);
		Fld.AddRocks(PlaceField(Rt, S.Seed, S.Rocks, S.ShipRadius, 1U));
		Aim = Pl.Fwd;
		TargetIndex = -1;
		Time = 0.0;
		bActive = true;
		bCameraSet = false;
		Cam = ChaseCamera{};
		UpdateCamera(0.0, true);
	}

	/** The voyage is over (left, or landed): everything is let go. */
	void End()
	{
		bActive = false;
		Fld = Field();
		Rt = Route{};
	}

	bool Active() const { return bActive; }
	bool Arrived() const { return bActive && Pl.bArrived; }
	double Elapsed() const { return Time; }

	void Tick(double Dt, const Input& In)
	{
		if (!bActive || Dt <= 0.0)
		{
			return;
		}
		Dt = std::min(Dt, 0.1); // a hitch must not fling the ship through the field
		Time += Dt;
		PilotInput Pi;
		Pi.Right = In.Right;
		Pi.Up = In.Up;
		Pi.Throttle = In.Throttle;
		StepPilot(Pl, Rt, Dt, Pi, Cfg.Flight, &Fld.Rocks, Cfg.ShipRadius);
		Body.Pos = Pl.Pos;
		Body.Vel = Pl.Vel;
		// Where the guns point: at what the cursor is on (or, with nothing there, a point far ahead along its ray), no farther
		// round than they swing; with no cursor, at the target the gunsight picked.
		TargetIndex = PickTarget(Pl.Pos, Pl.Fwd, Fld.Rocks, Cfg.TargetRange, 14.0);
		Vec3 Want = Pl.Fwd;
		double Converge = Cfg.Gun.Converge;
		if (In.bHasAim)
		{
			const Vec3 CamPos = Cam.Pos;
			const double Dist = CursorDistance(CamPos, In.AimDir);
			const Vec3 Point = CamPos + In.AimDir * Dist;
			Want = Normalized(Point - Pl.Pos, Pl.Fwd);
			Converge = Length(Point - Pl.Pos);
		}
		else if (Cfg.bAutoAim && TargetIndex >= 0)
		{
			const Rock& T = Fld.Rocks[static_cast<size_t>(TargetIndex)];
			Vec3 Dir;
			double Tt = 0.0;
			if (LeadDirection(Pl.Pos, Pl.Vel, T.Pos, T.Vel, Gun.Speed, Dir, Tt))
			{
				Want = Dir;
				Converge = Length(T.Pos - Pl.Pos);
			}
		}
		Aim = ClampAim(Pl.Fwd, Want, Cfg.MaxAimDeg);
		if (In.bFire)
		{
			Fld.Fire(Gun, Pl.Pos, Pl.Vel, Aim, Pl.Right, std::max(1500.0, Converge));
		}
		Fld.Step(Dt, Body, &Gun);
		UpdateCamera(Dt, false);
	}

	/** The cursor's ray, from `Origin` along `Dir`: how far to the first rock it is on, or a long way if none. */
	double CursorDistance(const Vec3& Origin, const Vec3& Dir) const
	{
		double Best = 30000.0;
		for (const Rock& Rk : Fld.Rocks)
		{
			const Vec3 M = Origin - Rk.Pos;
			const double B = Dot(M, Dir);
			const double R = Rk.Radius * Fld.Rules.HitScale + 30.0;
			const double C = Dot(M, M) - R * R;
			const double Disc = B * B - C;
			if (Disc < 0.0)
			{
				continue;
			}
			const double T = -B - std::sqrt(Disc);
			if (T > 200.0 && T < Best)
			{
				Best = T;
			}
		}
		return Best;
	}

	/** The chase camera now. */
	const ChaseCamera& Camera() const { return Cam; }
	const Route& GetRoute() const { return Rt; }
	const Pilot& GetPilot() const { return Pl; }
	const ShipBody& Ship() const { return Body; }
	const Field& GetField() const { return Fld; }
	Field& MutableField() { return Fld; }
	std::vector<Event> TakeEvents() { return Fld.TakeEvents(); }
	/** The unit direction the guns point. */
	const Vec3& AimDirection() const { return Aim; }
	/** Index into the field's rocks of the one the sights are on, or -1. */
	int Target() const { return TargetIndex; }
	/** Cm of the route still to fly to the stopping point. */
	double DistanceToGo() const { return std::max(0.0, Rt.Length() - Cfg.Flight.StandOff - Pl.S); }
	/** How far along the whole flight, 0..1. */
	double Progress() const
	{
		const double Goal = std::max(1.0, Rt.Length() - Cfg.Flight.StandOff);
		return Clamp01(Pl.S / Goal);
	}
	const Setup& Config() const { return Cfg; }
	const Weapon& Cannon() const { return Gun; }

private:
	Setup Cfg;
	Route Rt;
	Pilot Pl;
	ShipBody Body;
	Weapon Gun;
	Field Fld;
	Vec3 Aim{1.0, 0.0, 0.0};
	int TargetIndex = -1;
	double Time = 0.0;
	bool bActive = false;
	bool bCameraSet = false;
	ChaseCamera Cam;

	void UpdateCamera(double Dt, bool bSnap)
	{
		// Behind and above, looking a little ahead of the nose; follows with a lag so turns read.
		const double Back = Cfg.ShipRadius * 3.1;
		const double High = Cfg.ShipRadius * 0.85;
		const Vec3 Wanted = Pl.Pos - Pl.Fwd * Back + Pl.Up * High;
		const double K = bSnap || !bCameraSet ? 1.0 : 1.0 - std::exp(-7.0 * Dt);
		Cam.Pos = bCameraSet ? Cam.Pos + (Wanted - Cam.Pos) * K : Wanted;
		const Vec3 Look = Pl.Pos + Pl.Fwd * (Cfg.ShipRadius * 5.0);
		const Vec3 Fwd = Normalized(Look - Cam.Pos, Pl.Fwd);
		Cam.Fwd = Fwd;
		// Roll with the ship a little, not all the way (a chase camera that rolls fully is sick-making).
		const Vec3 Right = Normalized(Cross(AetherSpace::kUp, Fwd), Pl.Right);
		const Vec3 FlatUp = Cross(Fwd, Right);
		Cam.Up = Normalized(FlatUp + (Pl.Up - FlatUp) * 0.25, FlatUp);
		// Faster flight, wider view.
		Cam.FovDeg = 74.0 + 10.0 * Clamp01(Pl.Speed / std::max(1.0, Cfg.Flight.Cruise));
		bCameraSet = true;
	}
};
} // namespace AetherVoyage
