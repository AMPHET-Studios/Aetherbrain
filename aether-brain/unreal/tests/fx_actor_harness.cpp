// Runs the real AetherFxActor.cpp against a stand-in for Unreal (ue_stubs/): makes the pooled Niagara components, flies a camera and
// runs a fake brain for simulated seconds, selects nodes, switches layers and the whole layer off and on, and checks what every
// component was told: where it was put, which User parameters it got and with what, and that no component was played while still
// busy. It cannot say how Niagara will draw it, nor whether the engine accepts these calls.
#include "AetherFxActor.h"

#include "AetherBrainActor.h"
#include "NiagaraComponent.h"
#include "NiagaraSystem.h"
#include "AetherFxMath.h"

#include <cstdio>
#include <map>
#include <set>
#include <string>

namespace Fx = AetherFx;
namespace Sp = AetherSpace;

static int Failures = 0;
static int Checks = 0;
#define CHECK(Cond)                                                                \
	do                                                                             \
	{                                                                              \
		++Checks;                                                                  \
		if (!(Cond))                                                               \
		{                                                                          \
			++Failures;                                                            \
			std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #Cond);            \
		}                                                                          \
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

/** The actor's protected entry points, made reachable. */
struct TestFx : AAetherFxActor
{
	using AAetherFxActor::BeginPlay;
	using AAetherFxActor::Tick;
};

enum Group : int
{
	Pulses = 0,
	Corona,
	Dust,
	Meteors,
	Ripples,
	GroupCount,
};

using Names = std::set<std::string>;

/** One thing the layer played: which group, which component, when (s of the harness's clock), and everything the component held. */
struct Event
{
	int Group = 0;
	size_t Comp = 0;
	double At = 0.0;
	UNiagaraComponent::FPlay Play;
};

struct Scene
{
	UWorld World;
	APawn Pawn;
	APlayerController Pc;
	AAetherBrainActor Brain;
	TestFx Fx;
	UNiagaraSystem* Systems[GroupCount] = {};
	std::vector<UObject*> Before;
	std::vector<Event> Events;
	std::vector<UNiagaraComponent*> Comps;
	std::vector<size_t> Seen;
	double Clock = 0.0;

	/** Which of the five systems exist (a bit per group), and whether a brain is in the world. */
	explicit Scene(unsigned Have = 31U, bool bWithBrain = true)
	{
		Before = GCreated();
		Pc.Pawn = &Pawn;
		World.Player = &Pc;
		Fx.WorldPtr = &World;
		Pawn.Location = FVector(-3000.0, 0.0, 600.0);
		if (bWithBrain)
		{
			World.Actors.push_back(&Brain);
		}
		World.Actors.push_back(&Fx);
		for (int G = 0; G < GroupCount; ++G)
		{
			if ((Have >> G) & 1U)
			{
				Systems[G] = new UNiagaraSystem();
			}
		}
		Fx.PulseSystem.Loaded = Systems[Pulses];
		Fx.CoronaSystem.Loaded = Systems[Corona];
		Fx.DustSystem.Loaded = Systems[Dust];
		Fx.MeteorSystem.Loaded = Systems[Meteors];
		Fx.RippleSystem.Loaded = Systems[Ripples];
	}

	void Start()
	{
		Fx.BeginPlay();
		for (UObject* O : std::vector<UObject*>(GCreated().begin() + static_cast<long>(Before.size()), GCreated().end()))
		{
			if (UNiagaraComponent* C = dynamic_cast<UNiagaraComponent*>(O))
			{
				Comps.push_back(C);
			}
		}
		Seen.assign(Comps.size(), 0U);
	}

	int GroupOf(const UNiagaraComponent* C) const
	{
		for (int G = 0; G < GroupCount; ++G)
		{
			if (Systems[G] && C->Asset == Systems[G])
			{
				return G;
			}
		}
		return -1;
	}

	std::vector<UNiagaraComponent*> Of(int G) const
	{
		std::vector<UNiagaraComponent*> Out;
		for (UNiagaraComponent* C : Comps)
		{
			if (GroupOf(C) == G)
			{
				Out.push_back(C);
			}
		}
		return Out;
	}

	void Frame(float Dt = 1.f / 60.f)
	{
		Clock += static_cast<double>(Dt);
		Fx.Tick(Dt);
		for (size_t I = 0; I < Comps.size(); ++I)
		{
			for (; Seen[I] < Comps[I]->Plays.size(); ++Seen[I])
			{
				Event E;
				E.Group = GroupOf(Comps[I]);
				E.Comp = I;
				E.At = Clock;
				E.Play = Comps[I]->Plays[Seen[I]];
				Events.push_back(E);
			}
		}
	}

	void Run(double Seconds, float Dt = 1.f / 60.f)
	{
		const int N = static_cast<int>(Seconds / static_cast<double>(Dt));
		for (int I = 0; I < N; ++I)
		{
			Frame(Dt);
		}
	}

	std::vector<const Event*> EventsOf(int G, size_t From = 0) const
	{
		std::vector<const Event*> Out;
		for (size_t I = From; I < Events.size(); ++I)
		{
			if (Events[I].Group == G)
			{
				Out.push_back(&Events[I]);
			}
		}
		return Out;
	}

	size_t CountOf(int G) const { return EventsOf(G).size(); }
};

/** A fake brain: node 0 a sun at the middle, node 1 another sun far off, node 2 a star, the rest moons round the first, each linked to the first sun and to its neighbour. */
static void MakeBrain(AAetherBrainActor& B, int Nodes, bool bPositions, double Ring = 2500.0)
{
	B.Nodes.SetNum(Nodes);
	B.Where.SetNum(Nodes);
	B.Links.V.clear();
	for (int I = 0; I < Nodes; ++I)
	{
		FAetherNode& N = B.Nodes[I];
		N.Kind = I < 2 ? EAetherKind::Sun : (I == 2 ? EAetherKind::Star : EAetherKind::Moon);
		N.Color = FLinearColor(0.2f + 0.02f * static_cast<float>(I % 30), 0.5f, 1.f - 0.02f * static_cast<float>(I % 30));
		N.Radius = I < 2 ? 12.f : 1.5f;
		const double Angle = 2.0 * Sp::kPi * static_cast<double>(I) / static_cast<double>(Nodes);
		B.Where[I] = I == 0 ? FVector(0.0, 0.0, 0.0) : (I == 1 ? FVector(Ring * 2.4, 0.0, 300.0) : FVector(Ring * std::cos(Angle), Ring * std::sin(Angle), 80.0 * std::sin(3.0 * Angle)));
	}
	for (int I = 2; I < Nodes; ++I)
	{
		B.Links.Add(0);
		B.Links.Add(I);
		if (I + 1 < Nodes)
		{
			B.Links.Add(I);
			B.Links.Add(I + 1);
		}
	}
	if (Nodes > 1)
	{
		B.Links.Add(0);
		B.Links.Add(1);
	}
	++B.ShapeSerial;
	B.bPositions = bPositions;
}

static bool SameVec(const FVector& A, const FVector& B) { return A.X == B.X && A.Y == B.Y && A.Z == B.Z; }

static double Dist(const FVector& A, const FVector& B) { return std::sqrt((A.X - B.X) * (A.X - B.X) + (A.Y - B.Y) * (A.Y - B.Y) + (A.Z - B.Z) * (A.Z - B.Z)); }

static int NodeAt(const AAetherBrainActor& B, const FVector& P)
{
	for (int I = 0; I < B.Nodes.Num(); ++I)
	{
		if (SameVec(B.Where[I], P))
		{
			return I;
		}
	}
	return -1;
}

static bool Linked(const AAetherBrainActor& B, int A, int C)
{
	for (int I = 0; I + 1 < B.Links.Num(); I += 2)
	{
		if ((B.Links[I] == A && B.Links[I + 1] == C) || (B.Links[I] == C && B.Links[I + 1] == A))
		{
			return true;
		}
	}
	return false;
}

template <class K, class V>
static Names KeysOf(const std::map<K, V>& M)
{
	Names Out;
	for (const auto& P : M)
	{
		Out.insert(P.first);
	}
	return Out;
}

/** What a pulse must have been told: it runs a real link of the brain from one node to another, and every parameter follows from that. */
static void CheckPulse(const Scene& S, const Event& E, float Glow = 1.f)
{
	const UNiagaraComponent::FPlay& P = E.Play;
	CHECK(P.bReset);
	CHECK(P.Points.count("User.Start") == 1U && P.Points.count("User.End") == 1U);
	if (P.Points.count("User.Start") == 0U || P.Points.count("User.End") == 0U)
	{
		return;
	}
	const FVector A = P.Points.at("User.Start");
	const FVector B = P.Points.at("User.End");
	const int From = NodeAt(S.Brain, A);
	const int To = NodeAt(S.Brain, B);
	CHECK(From >= 0 && To >= 0 && From != To);
	CHECK(From >= 0 && To >= 0 && Linked(S.Brain, From, To));
	CHECK(SameVec(P.At, A));
	const double Length = Dist(A, B);
	CHECK_NEAR(P.Floats.at("User.Duration"), Fx::PulseSeconds(Length), 1e-4);
	CHECK_NEAR(P.Floats.at("User.Intensity"), 3.0 * static_cast<double>(Glow), 1e-5);
	if (From >= 0)
	{
		CHECK_NEAR(P.Floats.at("User.Size"), Fx::PulseSize(static_cast<double>(S.Brain.NodeRadius(From))), 1e-3);
		const FLinearColor Node = S.Brain.Nodes[From].Color;
		const Sp::Vec3 Tint = Fx::PulseTint(Sp::Vec3{static_cast<double>(Node.R), static_cast<double>(Node.G), static_cast<double>(Node.B)});
		const FLinearColor Got = P.Colors.at("User.Color");
		CHECK_NEAR(static_cast<double>(Got.R), Tint.X, 1e-5);
		CHECK_NEAR(static_cast<double>(Got.G), Tint.Y, 1e-5);
		CHECK_NEAR(static_cast<double>(Got.B), Tint.Z, 1e-5);
	}
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestMakesTheComponents()
{
	Scene S;
	S.Start();
	CHECK(S.Fx.NumReady() == 5);
	CHECK(AAetherFxActor::NumSystems() == 5);
	for (int G = 0; G < GroupCount; ++G)
	{
		CHECK(S.Fx.IsReady(G));
	}
	CHECK(!S.Fx.IsReady(-1) && !S.Fx.IsReady(5));
	CHECK(S.Comps.size() == static_cast<size_t>(Fx::kPulseSlots + Fx::kCoronaSlots + 1 + Fx::kMeteorSlots + Fx::kRippleSlots));
	CHECK(S.Of(Pulses).size() == static_cast<size_t>(Fx::kPulseSlots));
	CHECK(S.Of(Corona).size() == static_cast<size_t>(Fx::kCoronaSlots));
	CHECK(S.Of(Dust).size() == 1U);
	CHECK(S.Of(Meteors).size() == static_cast<size_t>(Fx::kMeteorSlots));
	CHECK(S.Of(Ripples).size() == static_cast<size_t>(Fx::kRippleSlots));
	for (const UNiagaraComponent* C : S.Comps)
	{
		CHECK(C->bRegistered);
		CHECK(!C->bAutoActivate);
		CHECK(!C->bActive);
		CHECK(C->Plays.empty());
		CHECK(C->bVisible);
		CHECK(C->Asset != nullptr);
	}
	CHECK(S.Fx.PrimaryActorTick.bCanEverTick && S.Fx.PrimaryActorTick.bStartWithTickEnabled);
	CHECK(S.Fx.PrimaryActorTick.TickGroup == TG_PostUpdateWork);
	CHECK(S.Fx.NumPlaying() == 0);
	CHECK(std::string(AAetherFxActor::SystemName(0)) == "NS_AetherPulses");
	CHECK(std::string(AAetherFxActor::SystemName(1)) == "NS_AetherCorona");
	CHECK(std::string(AAetherFxActor::SystemName(2)) == "NS_AetherDust");
	CHECK(std::string(AAetherFxActor::SystemName(3)) == "NS_AetherShootingStars");
	CHECK(std::string(AAetherFxActor::SystemName(4)) == "NS_AetherRipple");
	CHECK(std::string(AAetherFxActor::SystemName(-1)).empty() && std::string(AAetherFxActor::SystemName(5)).empty());

	// Asking before play is safe: nothing is ready, nothing happens.
	Scene Early;
	CHECK(Early.Fx.NumReady() == 0 && Early.Fx.NumPlaying() == 0 && Early.Fx.NumDropped() == 0 && !Early.Fx.IsReady(0));
	Early.Fx.Tick(0.016f);
	Early.Fx.Toggle();
	Early.Fx.Toggle();
	CHECK(Early.Comps.empty());
}

static void TestMissingSystems()
{
	// Dust and ripples are not there: those effects are skipped, nothing is made for them, and the others play.
	Scene S((1U << Pulses) | (1U << Corona) | (1U << Meteors));
	MakeBrain(S.Brain, 40, true);
	S.Start();
	CHECK(S.Fx.NumReady() == 3);
	CHECK(S.Fx.IsReady(Pulses) && S.Fx.IsReady(Corona) && S.Fx.IsReady(Meteors));
	CHECK(!S.Fx.IsReady(Dust) && !S.Fx.IsReady(Ripples));
	CHECK(S.Comps.size() == static_cast<size_t>(Fx::kPulseSlots + Fx::kCoronaSlots + Fx::kMeteorSlots));
	S.Run(20.0);
	CHECK(S.CountOf(Pulses) > 50U);
	CHECK(S.CountOf(Meteors) >= 1U);
	CHECK(S.CountOf(Dust) == 0U && S.CountOf(Ripples) == 0U);
	CHECK(S.Of(Corona)[0]->bActive);
	CHECK(S.Fx.NumPlaying() > 0);

	// None at all: the viewer is as it was, and nothing breaks.
	Scene None(0U);
	MakeBrain(None.Brain, 40, true);
	None.Start();
	None.Brain.Selected = 5;
	None.Run(10.0);
	CHECK(None.Fx.NumReady() == 0 && None.Comps.empty() && None.Events.empty() && None.Fx.NumPlaying() == 0);
	None.Fx.Toggle();
	None.Fx.Toggle();
	None.Run(1.0);
	CHECK(None.Events.empty());
}

static void TestWithoutBrainOrPositions()
{
	// No brain in the world: the dust and the shooting stars still play (they belong to the camera), the rest waits.
	Scene S(31U, false);
	S.Start();
	S.Run(60.0);
	CHECK(S.CountOf(Dust) == 1U);
	CHECK(S.Of(Dust)[0]->bActive);
	CHECK(S.CountOf(Pulses) == 0U && S.CountOf(Corona) == 0U && S.CountOf(Ripples) == 0U);
	// 0.3 a second for a minute: about 18.
	CHECK(S.CountOf(Meteors) >= 9U && S.CountOf(Meteors) <= 30U);

	// A brain with nodes but no positions yet: nothing of the brain's own, until the positions arrive.
	Scene P;
	MakeBrain(P.Brain, 40, false);
	P.Start();
	P.Run(5.0);
	CHECK(P.CountOf(Pulses) == 0U && P.CountOf(Corona) == 0U && P.CountOf(Ripples) == 0U);
	CHECK(P.CountOf(Dust) == 1U);
	P.Brain.bPositions = true;
	P.Frame();
	// The first positions: a ripple round each sun, and the suns' coronas start.
	CHECK(P.CountOf(Ripples) == 2U);
	CHECK(P.Of(Corona)[0]->bActive && P.Of(Corona)[1]->bActive && !P.Of(Corona)[2]->bActive && !P.Of(Corona)[3]->bActive);
	P.Run(5.0);
	CHECK(P.CountOf(Pulses) > 10U);
	// Once only: the ripples of the first positions do not come again.
	CHECK(P.CountOf(Ripples) == 2U);

	// No nodes at all, with positions: nothing, quietly.
	Scene E;
	MakeBrain(E.Brain, 0, true);
	E.Start();
	E.Run(3.0);
	CHECK(E.CountOf(Pulses) == 0U && E.CountOf(Corona) == 0U && E.CountOf(Ripples) == 0U);

	// No world: nothing, quietly.
	Scene W;
	W.Start();
	W.Fx.WorldPtr = nullptr;
	W.Frame();
	CHECK(W.Events.empty());
}

static void TestPulses()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Run(20.0);
	const std::vector<const Event*> Pulse = S.EventsOf(Pulses);
	// About PulseRate a second, every one on a real link, all of them told what they need, none dropped.
	const double Rate = Fx::PulseRate(76, 1.0);
	CHECK(static_cast<double>(Pulse.size()) >= Rate * 19.0 && static_cast<double>(Pulse.size()) <= Rate * 21.0 + 1.0);
	for (const Event* E : Pulse)
	{
		CheckPulse(S, *E);
	}
	CHECK(S.Fx.NumDropped() == 0);
	// Several links are used, both ways round, from several nodes.
	std::set<std::pair<int, int>> Ways;
	for (const Event* E : Pulse)
	{
		Ways.insert({NodeAt(S.Brain, E->Play.Points.at("User.Start")), NodeAt(S.Brain, E->Play.Points.at("User.End"))});
	}
	CHECK(Ways.size() > 40U);
	// A pulse is played when it is due: one at a time per frame at this rate, never a burst.
	std::map<double, int> PerFrame;
	for (const Event* E : Pulse)
	{
		++PerFrame[E->At];
	}
	for (const auto& P : PerFrame)
	{
		CHECK(P.second <= 2);
	}
	// The pool is used in turn.
	std::set<size_t> Used;
	for (const Event* E : Pulse)
	{
		Used.insert(E->Comp);
	}
	CHECK(Used.size() > 5U);

	// A short link and a long one: slow for the long one.
	CHECK(Fx::PulseSeconds(6000.0) > Fx::PulseSeconds(600.0));

	// Brightness follows Glow.
	Scene G;
	MakeBrain(G.Brain, 40, true);
	G.Fx.Glow = 2.5f;
	G.Start();
	G.Run(5.0);
	CHECK(G.CountOf(Pulses) > 5U);
	for (const Event* E : G.EventsOf(Pulses))
	{
		CheckPulse(G, *E, 2.5f);
	}
}

static void TestParameterContract()
{
	// The names and kinds of the User parameters are what docs/UNREAL-NIAGARA.md tells the systems' makers to expose.
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Brain.Selected = 6;
	S.Run(40.0);
	struct Contract
	{
		Names Points;
		Names Colors;
		Names Floats;
	};
	const Contract Want[GroupCount] = {
		{{"User.Start", "User.End"}, {"User.Color"}, {"User.Duration", "User.Size", "User.Intensity"}},
		{{}, {"User.Color"}, {"User.Radius", "User.Intensity"}},
		{{"User.Extent"}, {"User.Color"}, {"User.SpawnRate", "User.Intensity"}},
		{{"User.Start", "User.End"}, {"User.Color"}, {"User.Duration", "User.Width", "User.Intensity"}},
		{{}, {"User.Color"}, {"User.Radius", "User.Duration", "User.Intensity"}},
	};
	for (int G = 0; G < GroupCount; ++G)
	{
		const std::vector<const Event*> Es = S.EventsOf(G);
		CHECK(!Es.empty());
		for (const Event* E : Es)
		{
			CHECK(KeysOf(E->Play.Points) == Want[G].Points);
			CHECK(KeysOf(E->Play.Colors) == Want[G].Colors);
			CHECK(KeysOf(E->Play.Floats) == Want[G].Floats);
		}
	}
	// Start and End are Position parameters by default (a place), Extent a Vector (a size).
	for (const UNiagaraComponent* C : S.Comps)
	{
		const Names Expected = C->Points.count("User.Start") ? Names{"User.Start", "User.End"} : Names{};
		CHECK(C->PositionNames == Expected);
	}
}

static void TestSelection()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Run(2.0);
	CHECK(S.CountOf(Ripples) == 2U);
	const size_t PulsesBefore = S.CountOf(Pulses);
	const std::vector<UNiagaraComponent*> Coronas = S.Of(Corona);
	CHECK(!Coronas[3]->bActive);

	// Select a moon: a ripple grows out of it, and a halo starts on it.
	S.Brain.Selected = 5;
	S.Frame();
	const std::vector<const Event*> Ripple = S.EventsOf(Ripples);
	CHECK(Ripple.size() == 3U);
	if (Ripple.size() == 3U)
	{
		const Event& E = *Ripple[2];
		CHECK(SameVec(E.Play.At, S.Brain.Where[5]));
		CHECK_NEAR(E.Play.Floats.at("User.Radius"), Fx::Ripple(static_cast<double>(S.Brain.NodeRadius(5))).Radius, 1e-3);
		CHECK_NEAR(E.Play.Floats.at("User.Duration"), Fx::Ripple(static_cast<double>(S.Brain.NodeRadius(5))).Seconds, 1e-5);
		CHECK_NEAR(E.Play.Floats.at("User.Intensity"), Fx::Ripple(1.0).Intensity, 1e-5);
	}
	CHECK(Coronas[3]->bActive);
	CHECK(SameVec(Coronas[3]->WorldLocation, S.Brain.Where[5]));
	CHECK(Coronas[3]->Floats.at("User.Radius") > 0.f);
	// The same selection again is not a new one.
	S.Run(1.0);
	CHECK(S.CountOf(Ripples) == 3U);

	// Most of the pulses now run on the selection's own links (3 of 76), mostly leaving it.
	const size_t From = S.Events.size();
	S.Run(60.0);
	int Touching = 0;
	int Leaving = 0;
	int Total = 0;
	for (const Event* E : S.EventsOf(Pulses, From))
	{
		++Total;
		const int A = NodeAt(S.Brain, E->Play.Points.at("User.Start"));
		const int B = NodeAt(S.Brain, E->Play.Points.at("User.End"));
		if (A == 5 || B == 5)
		{
			++Touching;
			Leaving += A == 5 ? 1 : 0;
		}
		CheckPulse(S, *E);
	}
	CHECK(Total > 200);
	CHECK(static_cast<double>(Touching) / Total > 0.55 && static_cast<double>(Touching) / Total < 0.78);
	CHECK(static_cast<double>(Leaving) / Touching > 0.5);
	CHECK(S.CountOf(Pulses) > PulsesBefore);

	// The halo is moved to the next selection (a ripple again), and goes away with a sun selected (it has its own corona) or nothing.
	S.Brain.Selected = 9;
	S.Frame();
	CHECK(S.CountOf(Ripples) == 4U);
	CHECK(Coronas[3]->bActive && SameVec(Coronas[3]->WorldLocation, S.Brain.Where[9]));
	S.Brain.Selected = 0;
	S.Frame();
	CHECK(S.CountOf(Ripples) == 5U);
	CHECK(!Coronas[3]->bActive);
	CHECK(Coronas[0]->bActive && Coronas[1]->bActive);
	S.Brain.Selected = 7;
	S.Frame();
	CHECK(Coronas[3]->bActive);
	S.Brain.Selected = INDEX_NONE;
	S.Frame();
	CHECK(S.CountOf(Ripples) == 6U);
	CHECK(!Coronas[3]->bActive);

	// Nothing selected is not a ripple: the count stays when selection goes to nothing again.
	const size_t Before = S.CountOf(Ripples);
	S.Run(1.0);
	CHECK(S.CountOf(Ripples) == Before);
}

static void TestCoronas()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	double MinR = 1e9;
	double MaxR = -1e9;
	for (int I = 0; I < 600; ++I)
	{
		S.Frame();
		const UNiagaraComponent* Sun = S.Of(Corona)[0];
		MinR = std::min(MinR, static_cast<double>(Sun->Floats.at("User.Radius")));
		MaxR = std::max(MaxR, static_cast<double>(Sun->Floats.at("User.Radius")));
	}
	const std::vector<UNiagaraComponent*> Coronas = S.Of(Corona);
	// Each sun's corona is played once and then breathes by parameter; it sits on its sun, in the sun's colour.
	CHECK(Coronas[0]->Plays.size() == 1U && Coronas[1]->Plays.size() == 1U);
	CHECK(SameVec(Coronas[0]->WorldLocation, S.Brain.Where[0]) && SameVec(Coronas[1]->WorldLocation, S.Brain.Where[1]));
	CHECK(MaxR - MinR > 20.0);
	const double R = static_cast<double>(S.Brain.NodeRadius(0));
	CHECK(MinR >= R * (2.6 - 0.18) - 1e-2 && MaxR <= R * (2.6 + 0.18) + 1e-2);
	const FLinearColor C = Coronas[0]->Colors.at("User.Color");
	CHECK_NEAR(static_cast<double>(C.R), static_cast<double>(S.Brain.Nodes[0].Color.R), 1e-6);
	CHECK_NEAR(static_cast<double>(C.B), static_cast<double>(S.Brain.Nodes[0].Color.B), 1e-6);
	CHECK(Coronas[0]->Floats.at("User.Intensity") > 0.7f && Coronas[0]->Floats.at("User.Intensity") < 1.3f);
	// The two suns breathe out of step.
	CHECK(Coronas[0]->Floats.at("User.Radius") / static_cast<float>(R) != Coronas[1]->Floats.at("User.Radius") / static_cast<float>(S.Brain.NodeRadius(1)));

	// A sun that moves is followed.
	S.Brain.Where[0] = FVector(500.0, 400.0, -100.0);
	S.Frame();
	CHECK(SameVec(Coronas[0]->WorldLocation, S.Brain.Where[0]));
	// Only as many coronas as there are suns.
	Scene One;
	MakeBrain(One.Brain, 40, true);
	One.Brain.Nodes[1].Kind = EAetherKind::Moon;
	One.Start();
	One.Run(1.0);
	CHECK(One.Of(Corona)[0]->bActive && !One.Of(Corona)[1]->bActive && !One.Of(Corona)[2]->bActive);
	// More suns than there are slots: the first ones get them.
	Scene Many;
	MakeBrain(Many.Brain, 40, true);
	for (int I = 0; I < 10; ++I)
	{
		Many.Brain.Nodes[I].Kind = EAetherKind::Sun;
	}
	Many.Start();
	Many.Run(1.0);
	CHECK(Many.Of(Corona)[0]->bActive && Many.Of(Corona)[1]->bActive && Many.Of(Corona)[2]->bActive && !Many.Of(Corona)[3]->bActive);
	CHECK(SameVec(Many.Of(Corona)[2]->WorldLocation, Many.Brain.Where[2]));
}

static void TestShapeChange()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Run(5.0);
	const size_t Before = S.Events.size();
	// A new set of links (one): every pulse after it runs along the one.
	S.Brain.Links.V.clear();
	S.Brain.Links.Add(7);
	S.Brain.Links.Add(8);
	++S.Brain.ShapeSerial;
	S.Run(10.0);
	const std::vector<const Event*> After = S.EventsOf(Pulses, Before);
	CHECK(After.size() > 10U);
	for (const Event* E : After)
	{
		const int A = NodeAt(S.Brain, E->Play.Points.at("User.Start"));
		const int B = NodeAt(S.Brain, E->Play.Points.at("User.End"));
		CHECK((A == 7 && B == 8) || (A == 8 && B == 7));
	}

	// No links: no pulses (the dust and the coronas carry on).
	const size_t Mark = S.Events.size();
	S.Brain.Links.V.clear();
	++S.Brain.ShapeSerial;
	S.Run(5.0);
	CHECK(S.EventsOf(Pulses, Mark).empty());
	CHECK(S.Of(Corona)[0]->bActive);

	// A smaller brain, with a selection and links that point past the end of it: nothing breaks.
	MakeBrain(S.Brain, 6, true);
	S.Brain.Links.Add(5);
	S.Brain.Links.Add(40);
	S.Brain.Links.Add(-3);
	S.Brain.Links.Add(2);
	S.Brain.Links.Add(4);
	S.Brain.Links.Add(4);
	S.Brain.Selected = 30;
	S.Run(10.0);
	for (const Event* E : S.EventsOf(Pulses, Mark))
	{
		CheckPulse(S, *E);
	}
	// A different set of nodes with the same link count and the same serial is not noticed by serial, but a different node count is.
	MakeBrain(S.Brain, 12, true);
	const size_t Again = S.Events.size();
	S.Run(10.0);
	for (const Event* E : S.EventsOf(Pulses, Again))
	{
		CheckPulse(S, *E);
	}
	CHECK(S.Fx.NumDropped() == 0);
}

static void TestDegenerateLayout()
{
	// Every node at the same spot (a layout that has not spread out yet): nothing to run along, so no pulses.
	Scene S;
	MakeBrain(S.Brain, 40, true);
	for (int I = 0; I < 40; ++I)
	{
		S.Brain.Where[I] = FVector(0.0, 0.0, 0.0);
	}
	S.Start();
	S.Run(10.0);
	CHECK(S.CountOf(Pulses) == 0U);
	CHECK(S.Fx.NumDropped() == 0);
	// Spread out: the pulses begin.
	MakeBrain(S.Brain, 40, true);
	S.Run(5.0);
	CHECK(S.CountOf(Pulses) > 10U);
	// Positions that are not numbers (a broken layout): skipped, nothing breaks.
	const size_t Before = S.CountOf(Pulses);
	for (int I = 0; I < 40; ++I)
	{
		S.Brain.Where[I] = FVector(std::nan(""), 0.0, 0.0);
	}
	S.Run(5.0);
	CHECK(S.CountOf(Pulses) == Before);
}

static void TestToggle()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Brain.Selected = 5;
	S.Run(5.0);
	CHECK(S.Fx.IsOn() && S.Fx.NumPlaying() > 3);
	CHECK(S.Of(Dust)[0]->bActive && S.Of(Corona)[0]->bActive && S.Of(Corona)[3]->bActive);

	S.Fx.Toggle();
	CHECK(!S.Fx.IsOn());
	CHECK(S.Fx.NumPlaying() == 0);
	for (const UNiagaraComponent* C : S.Comps)
	{
		CHECK(!C->bActive && !C->bVisible);
	}
	const size_t Off = S.Events.size();
	S.Brain.Selected = 9;
	S.Run(10.0);
	CHECK(S.Events.size() == Off);
	for (const UNiagaraComponent* C : S.Comps)
	{
		CHECK(!C->bActive);
	}

	// On again: shown, the layer picks up where it was (nothing owed for the time it was off, no burst), coronas and dust play again.
	S.Fx.Toggle();
	CHECK(S.Fx.IsOn());
	for (const UNiagaraComponent* C : S.Comps)
	{
		CHECK(C->bVisible);
	}
	S.Frame();
	CHECK(static_cast<int>(S.Events.size() - Off) <= 2 + 2 + 2);
	S.Run(5.0);
	CHECK(S.Of(Dust)[0]->bActive && S.Of(Corona)[0]->bActive && S.Of(Corona)[3]->bActive);
	// Selection changed while it was off: the halo is on the new one.
	CHECK(SameVec(S.Of(Corona)[3]->WorldLocation, S.Brain.Where[9]));
	// Ten seconds of it being on (not the ten it was off): about PulseRate a second.
	CHECK(S.CountOf(Pulses) > 40U && S.CountOf(Pulses) < 60U);

	// Starting switched off: nothing is shown or played until it is switched on.
	Scene Q;
	MakeBrain(Q.Brain, 40, true);
	Q.Fx.bOn = false;
	Q.Start();
	Q.Run(5.0);
	CHECK(Q.Events.empty());
	for (const UNiagaraComponent* C : Q.Comps)
	{
		CHECK(!C->bVisible && !C->bActive);
	}
	Q.Fx.Toggle();
	Q.Run(5.0);
	CHECK(!Q.Events.empty());
}

static void TestLayerFlags()
{
	struct Case
	{
		const char* Name;
		bool AAetherFxActor::*Flag;
		int Group;
	};
	const Case Cases[] = {
		{"pulses", &AAetherFxActor::bPulses, Pulses},
		{"coronas", &AAetherFxActor::bCoronas, Corona},
		{"dust", &AAetherFxActor::bDust, Dust},
		{"shooting stars", &AAetherFxActor::bShootingStars, Meteors},
		{"ripples", &AAetherFxActor::bRipples, Ripples},
	};
	for (const Case& C : Cases)
	{
		Scene S;
		MakeBrain(S.Brain, 40, true);
		S.Fx.*(C.Flag) = false;
		S.Start();
		S.Brain.Selected = 4;
		S.Run(30.0);
		S.Brain.Selected = 8;
		S.Run(2.0);
		CHECK(S.CountOf(C.Group) == 0U);
		for (int G = 0; G < GroupCount; ++G)
		{
			if (G != C.Group)
			{
				CHECK(S.CountOf(G) > 0U);
			}
		}
		if (C.Group == Corona)
		{
			for (const UNiagaraComponent* Comp : S.Of(Corona))
			{
				CHECK(!Comp->bActive);
			}
		}
	}

	// Switched off while playing: the continuous effects stop, and come back when switched on.
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Brain.Selected = 4;
	S.Run(2.0);
	CHECK(S.Of(Dust)[0]->bActive && S.Of(Corona)[0]->bActive && S.Of(Corona)[3]->bActive);
	S.Fx.bDust = false;
	S.Fx.bCoronas = false;
	S.Frame();
	CHECK(!S.Of(Dust)[0]->bActive);
	for (const UNiagaraComponent* C : S.Of(Corona))
	{
		CHECK(!C->bActive);
	}
	S.Fx.bDust = true;
	S.Fx.bCoronas = true;
	S.Frame();
	CHECK(S.Of(Dust)[0]->bActive && S.Of(Corona)[0]->bActive && S.Of(Corona)[3]->bActive);
}

static void TestDensity()
{
	// 0: no pulses and no shooting stars, and the dust makes none.
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Fx.Density = 0.f;
	S.Start();
	S.Run(30.0);
	CHECK(S.CountOf(Pulses) == 0U && S.CountOf(Meteors) == 0U);
	CHECK(S.Of(Dust)[0]->Floats.at("User.SpawnRate") == 0.f);
	CHECK(S.Of(Corona)[0]->bActive);

	// Twice the density, twice the dust and about twice the pulses.
	Scene A;
	MakeBrain(A.Brain, 40, true);
	A.Start();
	A.Run(40.0);
	Scene B;
	MakeBrain(B.Brain, 40, true);
	B.Fx.Density = 2.f;
	B.Start();
	B.Run(40.0);
	CHECK_NEAR(static_cast<double>(B.Of(Dust)[0]->Floats.at("User.SpawnRate")), 2.0 * static_cast<double>(A.Of(Dust)[0]->Floats.at("User.SpawnRate")), 1e-3);
	const double Ratio = static_cast<double>(B.CountOf(Pulses)) / static_cast<double>(A.CountOf(Pulses));
	CHECK(Ratio > 1.8 && Ratio < 2.2);
}

static void TestHitch()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Run(2.0);
	const size_t Mark = S.Events.size();
	// A frame that takes five seconds (the editor was paused): a few effects, never the five seconds' worth.
	S.Frame(5.f);
	CHECK(S.CountOf(Pulses) > 0U);
	size_t P = 0;
	size_t M = 0;
	for (size_t I = Mark; I < S.Events.size(); ++I)
	{
		P += S.Events[I].Group == Pulses ? 1U : 0U;
		M += S.Events[I].Group == Meteors ? 1U : 0U;
	}
	CHECK(P <= static_cast<size_t>(Fx::kMaxEventsPerFrame));
	CHECK(M <= static_cast<size_t>(Fx::kMaxEventsPerFrame));
	// Frames of any length keep it going.
	S.Frame(0.f);
	S.Frame(-1.f);
	S.Run(2.0, 0.1f);
	S.Run(2.0, 1.f / 240.f);
	CHECK(S.Fx.NumDropped() == 0);
}

static void TestPoolExhaustion()
{
	// A huge brain, a lot of density: more pulses are due than there are components. The extra ones are dropped, never queued,
	// and no component is played again while it is still busy.
	Scene S;
	MakeBrain(S.Brain, 40, true, 15000.0);
	S.Fx.Density = 3.f;
	S.Start();
	S.Run(40.0);
	CHECK(S.Fx.NumDropped() > 0);
	CHECK(S.Fx.NumPlaying() <= static_cast<int32>(S.Comps.size()));
	std::map<size_t, const Event*> Last;
	for (const Event& E : S.Events)
	{
		if (E.Group != Pulses)
		{
			continue;
		}
		const auto It = Last.find(E.Comp);
		if (It != Last.end())
		{
			CHECK(E.At - It->second->At >= static_cast<double>(It->second->Play.Floats.at("User.Duration")) + Fx::kLingerSeconds - 1e-3);
		}
		Last[E.Comp] = &E;
	}
	// At most as many pulses at once (counting the trail that lingers) as there are components.
	size_t Busiest = 0;
	for (double T = 5.0; T < 40.0; T += 0.1)
	{
		size_t Now = 0;
		std::map<size_t, const Event*> Latest;
		for (const Event& E : S.Events)
		{
			if (E.Group == Pulses && E.At <= T)
			{
				Latest[E.Comp] = &E;
			}
		}
		for (const auto& P : Latest)
		{
			Now += T < P.second->At + static_cast<double>(P.second->Play.Floats.at("User.Duration")) + Fx::kLingerSeconds ? 1U : 0U;
		}
		Busiest = std::max(Busiest, Now);
	}
	CHECK(Busiest <= static_cast<size_t>(Fx::kPulseSlots));
	// ... and when more are due than fit, they are all in use.
	CHECK(Busiest >= static_cast<size_t>(Fx::kPulseSlots) - 2U);
}

static void TestPositionParameters()
{
	// Unticked: Start and End go as Vectors, for systems made with Vector parameters. Extent is a Vector either way.
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Fx.bPositionParameters = false;
	S.Start();
	S.Run(20.0);
	size_t Points = 0;
	for (const UNiagaraComponent* C : S.Comps)
	{
		CHECK(C->PositionNames.empty());
		Points += C->Points.size();
	}
	CHECK(Points > 5U);
	// The values are the same either way.
	Scene V;
	MakeBrain(V.Brain, 40, true);
	V.Start();
	V.Run(20.0);
	size_t Positions = 0;
	for (const UNiagaraComponent* C : V.Comps)
	{
		Positions += C->PositionNames.size();
	}
	CHECK(Positions > 5U);
	CHECK(V.CountOf(Pulses) == S.CountOf(Pulses));
	for (size_t I = 0; I < V.Events.size() && I < S.Events.size(); ++I)
	{
		CHECK(KeysOf(V.Events[I].Play.Points) == KeysOf(S.Events[I].Play.Points));
		for (const auto& P : V.Events[I].Play.Points)
		{
			CHECK(SameVec(P.second, S.Events[I].Play.Points.at(P.first)));
		}
	}
}

static void TestDeterminism()
{
	Scene A;
	MakeBrain(A.Brain, 40, true);
	A.Start();
	A.Run(30.0);
	Scene B;
	MakeBrain(B.Brain, 40, true);
	B.Start();
	B.Run(30.0);
	CHECK(A.Events.size() == B.Events.size() && !A.Events.empty());
	for (size_t I = 0; I < A.Events.size() && I < B.Events.size(); ++I)
	{
		CHECK(A.Events[I].Group == B.Events[I].Group && A.Events[I].Comp == B.Events[I].Comp && A.Events[I].At == B.Events[I].At);
		CHECK(A.Events[I].Play.Floats == B.Events[I].Play.Floats);
	}
	// Another seed, another sequence.
	Scene C;
	MakeBrain(C.Brain, 40, true);
	C.Fx.Seed = 99;
	C.Start();
	C.Run(30.0);
	int Same = 0;
	const std::vector<const Event*> PA = A.EventsOf(Pulses);
	const std::vector<const Event*> PC = C.EventsOf(Pulses);
	for (size_t I = 0; I < PA.size() && I < PC.size(); ++I)
	{
		Same += SameVec(PA[I]->Play.Points.at("User.Start"), PC[I]->Play.Points.at("User.Start")) ? 1 : 0;
	}
	CHECK(Same < static_cast<int>(PA.size()) / 2);
	// Another frame rate, about the same number of pulses: they follow time, not frames.
	Scene F30;
	MakeBrain(F30.Brain, 40, true);
	F30.Start();
	F30.Run(30.0, 1.f / 30.f);
	Scene F120;
	MakeBrain(F120.Brain, 40, true);
	F120.Start();
	F120.Run(30.0, 1.f / 120.f);
	const double N30 = static_cast<double>(F30.CountOf(Pulses));
	const double N120 = static_cast<double>(F120.CountOf(Pulses));
	CHECK(N30 > 100.0 && std::fabs(N30 - N120) / N120 < 0.08);
}

static void TestDustFollowsTheCamera()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Start();
	S.Frame();
	const UNiagaraComponent* Dust = S.Of(::Dust)[0];
	CHECK(Dust->bActive && Dust->Plays.size() == 1U);
	// First: right where the camera is. The box is sized by how far out the scene is laid out.
	CHECK(Dist(Dust->WorldLocation, S.Pawn.Location) < 1e-6);
	const Fx::DustLook Look = Fx::Dust(Sp::FieldRadius(static_cast<double>(S.Brain.BoundsRadius)), 1.0);
	CHECK_NEAR(static_cast<double>(Dust->Points.at("User.Extent").X), Look.HalfExtent.X, 1e-3);
	CHECK_NEAR(static_cast<double>(Dust->Points.at("User.Extent").Z), Look.HalfExtent.Z, 1e-3);
	CHECK_NEAR(static_cast<double>(Dust->Floats.at("User.SpawnRate")), Look.SpawnRate, 1e-3);

	// Fly along: the box trails a little and keeps up; it is played once, not again for every move.
	for (int I = 0; I < 600; ++I)
	{
		const double T = static_cast<double>(I) / 60.0;
		S.Pawn.Location = FVector(-3000.0 + 500.0 * T, 800.0 * std::sin(0.3 * T), 600.0);
		S.Frame();
	}
	CHECK(Dust->Plays.size() == 1U);
	CHECK(Dist(Dust->WorldLocation, S.Pawn.Location) < 400.0);
	CHECK(Dist(Dust->WorldLocation, S.Pawn.Location) > 20.0);

	// A bigger brain, a wider box (to its limit).
	S.Brain.BoundsRadius = 20000.f;
	S.Frame();
	CHECK_NEAR(static_cast<double>(Dust->Points.at("User.Extent").X), 6000.0, 1e-3);
	// With no pawn the camera manager's view is used.
	Scene Cm;
	MakeBrain(Cm.Brain, 40, true);
	Cm.Pc.Pawn = nullptr;
	Cm.Pc.PlayerCameraManager = new APlayerCameraManager();
	Cm.Start();
	Cm.Run(1.0);
	CHECK(Cm.Of(::Dust)[0]->bActive);
	CHECK(Dist(Cm.Of(::Dust)[0]->WorldLocation, FVector()) < 1e-6);
	// Nobody playing: the dust is at the origin and nothing breaks.
	Scene Nobody;
	MakeBrain(Nobody.Brain, 40, true);
	Nobody.World.Player = nullptr;
	Nobody.Start();
	Nobody.Run(2.0);
	CHECK(Nobody.Of(::Dust)[0]->bActive);
}

static void TestShootingStars()
{
	Scene S;
	MakeBrain(S.Brain, 40, true);
	S.Pawn.ForwardDir = FVector(0.0, 1.0, 0.0);
	S.Start();
	S.Run(120.0);
	const std::vector<const Event*> Stars = S.EventsOf(Meteors);
	CHECK(Stars.size() >= 20U && Stars.size() <= 55U);
	for (const Event* E : Stars)
	{
		const FVector From = E->Play.Points.at("User.Start");
		const FVector To = E->Play.Points.at("User.End");
		CHECK(SameVec(E->Play.At, From));
		const double D = Dist(From, S.Pawn.Location);
		CHECK(D >= 2500.0 - 1e-3 && D <= 5500.0 + 1e-3);
		// In front of the camera, within 75 degrees of where it looks.
		const double Cos = (From.Y - S.Pawn.Location.Y) / D;
		CHECK(Cos >= std::cos(Sp::DegToRad(75.0)) - 1e-6);
		CHECK(Dist(From, To) > 2000.0);
		CHECK(E->Play.Floats.at("User.Duration") >= 0.89f && E->Play.Floats.at("User.Duration") <= 1.71f);
		CHECK(E->Play.Floats.at("User.Width") > 5.f);
		CHECK_NEAR(static_cast<double>(E->Play.Floats.at("User.Intensity")), 3.0, 1e-5);
	}
	CHECK(S.Fx.NumDropped() == 0);
	// Never more than the pool at once (they last about a second and come every three).
	std::set<size_t> Used;
	for (const Event* E : Stars)
	{
		Used.insert(E->Comp);
	}
	CHECK(Used.size() >= 2U);
}

int main()
{
	TestMakesTheComponents();
	TestMissingSystems();
	TestWithoutBrainOrPositions();
	TestPulses();
	TestParameterContract();
	TestSelection();
	TestCoronas();
	TestShapeChange();
	TestDegenerateLayout();
	TestToggle();
	TestLayerFlags();
	TestDensity();
	TestHitch();
	TestPoolExhaustion();
	TestPositionParameters();
	TestDeterminism();
	TestDustFollowsTheCamera();
	TestShootingStars();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
