// The maths behind the viewer's Niagara layer (AetherFxActor): which link a pulse of light runs along and when, where a
// shooting star crosses the sky, how a corona breathes, how big a ripple grows, how far the dust reaches, and the pool that
// hands out the few Niagara components that play them.
//
// Plain C++ with no Unreal types, so it is compiled and tested on an ordinary computer (unreal/tests/fx_core_test.cpp); the
// actor only turns its answers into Niagara user parameters. Like the space world's maths, everything that happens is a pure
// function of time and a seed: the K-th pulse is the same pulse whenever it is asked for, nothing needs saving, and a long
// frame never makes a burst (events that are too late are dropped, never queued).
//
// Axes are Unreal's: X forward, Y right, Z up. Lengths are cm.
#pragma once

#include "AetherSpaceMath.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

namespace AetherFx
{
namespace Sp = AetherSpace;
using Sp::Vec3;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Budgets: nothing the layer plays is unbounded                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Niagara components that play pulses at once. A pulse that finds none free is dropped, never queued. */
constexpr int kPulseSlots = 40;
constexpr int kMeteorSlots = 6;
constexpr int kRippleSlots = 4;
/** Suns that get a corona, plus one halo that follows the selection. */
constexpr int kSunSlots = 3;
constexpr int kCoronaSlots = kSunSlots + 1;
/** Links that are looked at when picking where a pulse runs (the rest of a huge brain never get one). */
constexpr int kMaxIndexedLinks = 200000;
/** Events a stream may deliver in one frame, and how late (s) one may start before it is dropped instead. */
constexpr int kMaxEventsPerFrame = 6;
constexpr double kMaxLateSeconds = 0.25;
constexpr double kMaxEventRate = 120.0;
/** A finished system lingers this long (s) after its nominal end (trails fade) before its slot is handed out again. */
constexpr double kLingerSeconds = 0.8;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Which links: the brain's links, indexed once per change                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The brain's links by node: every node's links in one flat list (so a selection finds its own at once). Built once per change. */
class LinkIndex
{
public:
	/**
	 * Pairs of node numbers, flat (a0, b0, a1, b1 ...); Count is the number of ints. Links that leave the graph or join a node to
	 * itself are skipped, and only the first kMaxIndexedLinks are kept.
	 */
	void Build(const int* Pairs, int Count, int NodeCount)
	{
		Nodes_ = std::max(NodeCount, 0);
		Ends_.clear();
		Items_.clear();
		Offset_.assign(static_cast<size_t>(Nodes_) + 1U, 0);
		const int Wanted = std::min(std::max(Count, 0) / 2, kMaxIndexedLinks);
		for (int I = 0; Pairs && I < Wanted; ++I)
		{
			const int A = Pairs[2 * I];
			const int B = Pairs[2 * I + 1];
			if (A < 0 || B < 0 || A >= Nodes_ || B >= Nodes_ || A == B)
			{
				continue;
			}
			Ends_.push_back(A);
			Ends_.push_back(B);
			++Offset_[static_cast<size_t>(A) + 1U];
			++Offset_[static_cast<size_t>(B) + 1U];
		}
		for (size_t N = 0; N < static_cast<size_t>(Nodes_); ++N)
		{
			Offset_[N + 1U] += Offset_[N];
		}
		Items_.assign(Ends_.size(), 0);
		std::vector<int> Cursor(Offset_.begin(), Offset_.end() - 1);
		for (int L = 0; L < LinkCount(); ++L)
		{
			for (int End = 0; End < 2; ++End)
			{
				const size_t Node = static_cast<size_t>(Ends_[static_cast<size_t>(2 * L + End)]);
				Items_[static_cast<size_t>(Cursor[Node]++)] = L;
			}
		}
	}

	int NodeCount() const { return Nodes_; }
	int LinkCount() const { return static_cast<int>(Ends_.size() / 2U); }

	/** The two nodes a link joins. */
	void Ends(int Link, int& A, int& B) const
	{
		A = Ends_[static_cast<size_t>(2 * Link)];
		B = Ends_[static_cast<size_t>(2 * Link + 1)];
	}
	/** How many links a node has (0 for a number that is not a node). */
	int Degree(int Node) const
	{
		if (Node < 0 || Node >= Nodes_)
		{
			return 0;
		}
		return Offset_[static_cast<size_t>(Node) + 1U] - Offset_[static_cast<size_t>(Node)];
	}
	/** The N-th link of a node (N below Degree). */
	int IncidentLink(int Node, int N) const { return Items_[static_cast<size_t>(Offset_[static_cast<size_t>(Node)] + N)]; }

private:
	int Nodes_ = 0;
	std::vector<int> Ends_;
	/** Per node, where its links start in Items_ (Nodes_ + 1 entries). */
	std::vector<int> Offset_;
	std::vector<int> Items_;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* A stream of events: one in each slot of 1/Rate seconds, at a hashed spot in it                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The time (s) of the K-th event of a stream. Different Salts are different streams. */
inline double EventTime(uint32_t Seed, uint32_t Salt, double Rate, uint32_t K)
{
	return (static_cast<double>(K) + Sp::Hash01(Seed, K, Salt)) / Rate;
}

/**
 * The numbers of the events with Prev <= time < Now, oldest first. Events more than MaxLate before Now are dropped (a long frame
 * never makes a burst), and at most MaxCount are kept (the newest). Each event is in exactly one window of a run of windows
 * that follow each other, so each is delivered once.
 */
inline std::vector<uint32_t> DueEvents(uint32_t Seed, uint32_t Salt, double Rate, double Prev, double Now, double MaxLate = kMaxLateSeconds, int MaxCount = kMaxEventsPerFrame)
{
	std::vector<uint32_t> Out;
	if (!(Rate > 1e-6) || !(Now > Prev) || MaxCount <= 0)
	{
		return Out;
	}
	Rate = std::min(Rate, kMaxEventRate);
	const double From = std::max(std::max(Prev, Now - MaxLate), 0.0);
	const double First = std::floor(From * Rate);
	const double Last = std::floor(Now * Rate);
	if (Last >= 4.0e9)
	{
		return Out;
	}
	for (double K = First; K <= Last; K += 1.0)
	{
		const uint32_t Id = static_cast<uint32_t>(K);
		const double T = EventTime(Seed, Salt, Rate, Id);
		if (T >= From && T < Now)
		{
			Out.push_back(Id);
		}
	}
	if (static_cast<int>(Out.size()) > MaxCount)
	{
		Out.erase(Out.begin(), Out.end() - MaxCount);
	}
	return Out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Pulses of light along the brain's links                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

constexpr uint32_t kPulseSalt = 0x5055U;
constexpr uint32_t kMeteorSalt = 0x4D45U;

/** Pulses a second for a brain with this many links: more links, more traffic, but never a flood (Density multiplies). */
inline double PulseRate(int Links, double Density)
{
	if (Links <= 0 || !(Density > 0.0))
	{
		return 0.0;
	}
	return Density * Sp::Clamp(2.0 + 1.5 * std::log10(1.0 + static_cast<double>(Links)), 0.0, 14.0);
}

/** How far a pulse travels in a second (cm). */
constexpr double kPulseSpeed = 1800.0;

/** How long a pulse takes to run a link of this length (s). */
inline double PulseSeconds(double LengthCm) { return Sp::Clamp(LengthCm / kPulseSpeed, 0.6, 3.5); }

/** How big a pulse's glow is when it leaves a node of this radius (cm). */
inline double PulseSize(double NodeRadiusCm) { return Sp::Clamp(NodeRadiusCm * 0.22, 10.0, 70.0); }

/** A link picked for a pulse, and the way it runs. */
struct LinkPick
{
	int Link = -1;
	int From = -1;
	int To = -1;
};

/**
 * The link for pulse number K. With a node in focus (the selection) and FocusShare of the pulses, the link is one of the focus's
 * own and the pulse mostly leaves it; otherwise any link, either way round.
 */
inline LinkPick PickLink(const LinkIndex& Links, uint32_t Seed, uint32_t K, int Focus, double FocusShare)
{
	LinkPick P;
	const int Count = Links.LinkCount();
	if (Count <= 0)
	{
		return P;
	}
	const double ChooseFocus = Sp::Hash01(Seed, K, 11U);
	const double ChooseLink = Sp::Hash01(Seed, K, 12U);
	const double ChooseWay = Sp::Hash01(Seed, K, 13U);
	const int Degree = Links.Degree(Focus);
	if (Degree > 0 && ChooseFocus < FocusShare)
	{
		P.Link = Links.IncidentLink(Focus, std::min(Degree - 1, static_cast<int>(ChooseLink * Degree)));
		int A = 0;
		int B = 0;
		Links.Ends(P.Link, A, B);
		const int Other = A == Focus ? B : A;
		const bool bOut = ChooseWay < 0.65;
		P.From = bOut ? Focus : Other;
		P.To = bOut ? Other : Focus;
		return P;
	}
	P.Link = std::min(Count - 1, static_cast<int>(ChooseLink * Count));
	int A = 0;
	int B = 0;
	Links.Ends(P.Link, A, B);
	const bool bBack = ChooseWay < 0.5;
	P.From = bBack ? B : A;
	P.To = bBack ? A : B;
	return P;
}

/** A node's colour (linear), lifted toward white so a pulse reads against it. */
inline Vec3 PulseTint(const Vec3& Node)
{
	return {Sp::Lerp(Node.X, 1.0, 0.35), Sp::Lerp(Node.Y, 1.0, 0.35), Sp::Lerp(Node.Z, 1.0, 0.35)};
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shooting stars: streaks across the part of the sky the camera is looking at                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Shooting stars a second (Density multiplies). */
constexpr double kMeteorRate = 0.3;

/** One shooting star: a head that runs from From to To in Seconds, trailing a ribbon Width wide. */
struct MeteorShot
{
	Vec3 From;
	Vec3 To;
	double Seconds = 1.0;
	double Width = 20.0;
	double R = 1.0;
	double G = 1.0;
	double B = 1.0;
};

/** A unit vector at right angles to Dir, as near to Hint as it can be (any one if they are the same line). */
inline Vec3 PerpendicularTo(const Vec3& Dir, const Vec3& Hint)
{
	Vec3 P = Hint - Dir * Sp::Dot(Hint, Dir);
	if (Sp::Length(P) < 1e-6)
	{
		P = Sp::Cross(Dir, Sp::kUp);
		if (Sp::Length(P) < 1e-6)
		{
			P = Sp::Cross(Dir, Vec3{1.0, 0.0, 0.0});
		}
	}
	return Sp::Normalized(P);
}

/** Shooting star number K, crossing a patch of sky within 75 degrees of where the camera looks (Forward). */
inline MeteorShot Meteor(uint32_t Seed, uint32_t K, const Vec3& Camera, const Vec3& Forward)
{
	Sp::Rng R(Sp::HashU(Seed, K, 77U));
	const Vec3 F = Sp::Normalized(Forward, Vec3{1.0, 0.0, 0.0});
	const Vec3 Right = PerpendicularTo(F, Sp::Cross(F, Sp::kUp));
	const Vec3 Up = Sp::Cross(Right, F);
	const double CosCone = std::cos(Sp::DegToRad(75.0));
	const double CosT = Sp::Lerp(1.0, CosCone, R.Next());
	const double SinT = std::sqrt(std::max(0.0, 1.0 - CosT * CosT));
	const double Phi = R.Range(0.0, 2.0 * Sp::kPi);
	const Vec3 Dir = Sp::Normalized(F * CosT + (Right * std::cos(Phi) + Up * std::sin(Phi)) * SinT, F);
	const double Dist = R.Range(2500.0, 5500.0);

	MeteorShot S;
	S.From = Camera + Dir * Dist;
	const Vec3 Side = PerpendicularTo(Dir, R.Unit());
	S.To = S.From + Side * R.Range(2200.0, 5200.0);
	S.Seconds = R.Range(0.9, 1.7);
	S.Width = Dist * R.Range(0.006, 0.012);
	const double Hue = R.Next();
	if (Hue < 0.6)
	{
		S.R = 0.75;
		S.G = 0.88;
		S.B = 1.0;
	}
	else if (Hue < 0.85)
	{
		S.R = 1.0;
		S.G = 0.82;
		S.B = 0.55;
	}
	else
	{
		S.R = 0.7;
		S.G = 1.0;
		S.B = 0.8;
	}
	return S;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Coronas, ripples and dust                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What a corona looks like at a moment: how far it reaches (cm) and how bright it is (1 = as designed). */
struct CoronaLook
{
	double Radius = 0.0;
	double Intensity = 1.0;
};

/** A corona breathes: slow swells and a quicker flicker, each corona out of step with the others (Phase). */
inline CoronaLook Corona(double Time, double NodeRadiusCm, uint32_t Phase)
{
	const double Offset = Sp::Hash01(Phase, 5U, 6U) * 2.0 * Sp::kPi;
	const double Swell = std::sin(2.0 * Sp::kPi * Time / 6.5 + Offset);
	const double Flicker = std::sin(2.0 * Sp::kPi * Time / 2.3 + Offset * 1.7);
	CoronaLook L;
	L.Radius = NodeRadiusCm * (2.6 + 0.18 * Swell);
	L.Intensity = 1.0 + 0.18 * Swell + 0.06 * Flicker;
	return L;
}

/** How a ripple looks when a node is selected: it grows from the node to Radius (cm) over Seconds. */
struct RippleLook
{
	double Radius = 0.0;
	double Seconds = 1.6;
	double Intensity = 1.0;
};

inline RippleLook Ripple(double NodeRadiusCm)
{
	RippleLook L;
	L.Radius = std::max(NodeRadiusCm, 10.0) * 4.0;
	L.Seconds = Sp::Clamp(1.2 + L.Radius / 4000.0, 1.2, 2.2);
	L.Intensity = 1.6;
	return L;
}

/** The box of drifting dust around the camera: half its size (cm), and how many motes a second it makes. */
struct DustLook
{
	Vec3 HalfExtent;
	double SpawnRate = 0.0;
};

/** Field is how far out the scene is laid out. Dust reaches about half of it, never less than 15 m nor more than 60 m. */
inline DustLook Dust(double Field, double Density)
{
	DustLook L;
	const double Half = Sp::Clamp(Field * 0.5, 1500.0, 6000.0);
	L.HalfExtent = {Half, Half, Half * 0.7};
	L.SpawnRate = Sp::Clamp(Density, 0.0, 3.0) * 90.0;
	return L;
}

/** From Now toward Target by Dt seconds at Rate (1 / seconds): eased, the same at any frame rate. */
inline Vec3 Ease(const Vec3& Now, const Vec3& Target, double Dt, double Rate)
{
	const double T = 1.0 - std::exp(-std::max(Dt, 0.0) * Rate);
	return Now + (Target - Now) * T;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The pool                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A fixed number of slots (one Niagara component each) handed out for as long as their effect plays. */
class SlotPool
{
public:
	explicit SlotPool(int Size = 0) { Resize(Size); }

	void Resize(int Size)
	{
		Until_.assign(static_cast<size_t>(std::max(Size, 0)), std::numeric_limits<double>::lowest());
		Next_ = 0;
	}

	int Size() const { return static_cast<int>(Until_.size()); }

	/** A slot that is not in use at Now, taken until Until; -1 when every one is busy. Slots are used in turn, so none wears first. */
	int Acquire(double Now, double Until)
	{
		const int N = Size();
		for (int I = 0; I < N; ++I)
		{
			const int S = (Next_ + I) % N;
			if (Until_[static_cast<size_t>(S)] <= Now)
			{
				Until_[static_cast<size_t>(S)] = Until;
				Next_ = (S + 1) % N;
				return S;
			}
		}
		return -1;
	}

	/** Free a slot at once (its effect was stopped). */
	void Release(int Slot)
	{
		if (Slot >= 0 && Slot < Size())
		{
			Until_[static_cast<size_t>(Slot)] = std::numeric_limits<double>::lowest();
		}
	}

	void ReleaseAll() { std::fill(Until_.begin(), Until_.end(), std::numeric_limits<double>::lowest()); }

	bool IsBusy(int Slot, double Now) const { return Slot >= 0 && Slot < Size() && Until_[static_cast<size_t>(Slot)] > Now; }

	int Busy(double Now) const
	{
		int Count = 0;
		for (const double U : Until_)
		{
			Count += U > Now ? 1 : 0;
		}
		return Count;
	}

private:
	std::vector<double> Until_;
	int Next_ = 0;
};
} // namespace AetherFx
