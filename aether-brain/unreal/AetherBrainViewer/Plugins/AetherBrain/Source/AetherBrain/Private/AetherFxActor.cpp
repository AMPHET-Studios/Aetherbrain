#include "AetherFxActor.h"

#include "AetherBrainActor.h"
#include "Camera/PlayerCameraManager.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "NiagaraComponent.h"
#include "NiagaraSystem.h"

THIRD_PARTY_INCLUDES_START
#include "AetherFxMath.h"
THIRD_PARTY_INCLUDES_END

namespace Fx = AetherFx;
namespace Sp = AetherSpace;

namespace
{
	/** The five systems, in the order the HUD and the player controller number them. */
	enum EFxSystem : int32
	{
		FxPulses = 0,
		FxCorona,
		FxDust,
		FxMeteors,
		FxRipples,
		FxCount,
	};

	const TCHAR* const FxSystemNames[FxCount] = {
		TEXT("NS_AetherPulses"), TEXT("NS_AetherCorona"), TEXT("NS_AetherDust"), TEXT("NS_AetherShootingStars"), TEXT("NS_AetherRipple"),
	};
	const TCHAR* const FxSystemPaths[FxCount] = {
		TEXT("/Game/AetherFX/NS_AetherPulses.NS_AetherPulses"),
		TEXT("/Game/AetherFX/NS_AetherCorona.NS_AetherCorona"),
		TEXT("/Game/AetherFX/NS_AetherDust.NS_AetherDust"),
		TEXT("/Game/AetherFX/NS_AetherShootingStars.NS_AetherShootingStars"),
		TEXT("/Game/AetherFX/NS_AetherRipple.NS_AetherRipple"),
	};

	int32 FxSlotsOf(int32 System)
	{
		switch (System)
		{
		case FxPulses: return Fx::kPulseSlots;
		case FxCorona: return Fx::kCoronaSlots;
		case FxDust: return 1;
		case FxMeteors: return Fx::kMeteorSlots;
		default: return Fx::kRippleSlots;
		}
	}

	FVector FxToFVector(const Sp::Vec3& V) { return FVector(V.X, V.Y, V.Z); }
	Sp::Vec3 FxFromFVector(const FVector& V) { return Sp::Vec3{V.X, V.Y, V.Z}; }
	Sp::Vec3 FxColorOf(const FLinearColor& C) { return Sp::Vec3{static_cast<double>(C.R), static_cast<double>(C.G), static_cast<double>(C.B)}; }

	/** The User parameters the systems read (the names are the contract with the Niagara assets: docs/UNREAL-NIAGARA.md). */
	struct FFxParams
	{
		const FName Start{TEXT("User.Start")};
		const FName End{TEXT("User.End")};
		const FName Extent{TEXT("User.Extent")};
		const FName Color{TEXT("User.Color")};
		const FName Duration{TEXT("User.Duration")};
		const FName Size{TEXT("User.Size")};
		const FName Width{TEXT("User.Width")};
		const FName Radius{TEXT("User.Radius")};
		const FName SpawnRate{TEXT("User.SpawnRate")};
		const FName Intensity{TEXT("User.Intensity")};
	};
	const FFxParams& FxParams()
	{
		static const FFxParams P{};
		return P;
	}

	void FxSetFloat(UNiagaraComponent* C, const FName& Name, double V) { C->SetVariableFloat(Name, static_cast<float>(V)); }

	void FxSetColor(UNiagaraComponent* C, const FName& Name, double R, double G, double B)
	{
		C->SetVariableLinearColor(Name, FLinearColor(static_cast<float>(R), static_cast<float>(G), static_cast<float>(B), 1.f));
	}

	void FxSetPoint(UNiagaraComponent* C, const FName& Name, const FVector& V, bool bPosition)
	{
		if (bPosition)
		{
			C->SetVariablePosition(Name, V);
		}
		else
		{
			C->SetVariableVec3(Name, V);
		}
	}

	/** A component that plays one system, made but not started: it plays when Activate is called, and once an effect has ended it can be played again. */
	UNiagaraComponent* NewFx(AActor* Owner, USceneComponent* Parent, UNiagaraSystem* System)
	{
		UNiagaraComponent* C = NewObject<UNiagaraComponent>(Owner);
		C->SetupAttachment(Parent);
		C->SetMobility(EComponentMobility::Movable);
		C->SetAutoActivate(false);
		C->SetCastShadow(false);
		C->SetAsset(System);
		C->RegisterComponent();
		return C;
	}
}

/** Everything the layer remembers between frames. Only the actor's .cpp knows its shape. */
struct FAetherFxState
{
	/** The components that play one system, and who of them is busy. */
	struct FGroup
	{
		UNiagaraSystem* System = nullptr;
		TArray<UNiagaraComponent*> Comps;
		/** For the effects that start and end (pulses, shooting stars, ripples): which component is busy until when. */
		Fx::SlotPool Pool;
		/** For the effects that keep playing (corona, dust): which component is playing now. */
		std::vector<char> Playing;
		/** For pulses: the two nodes each busy slot runs between (the nodes keep moving, so the pulse follows them). */
		std::vector<int32> From;
		std::vector<int32> To;
	};

	FGroup Groups[FxCount];
	Fx::LinkIndex Links;
	uint32 LinksFor = 0;
	/** How many links the brain draws, as the index was built (it follows what is drawn: Max Links, Show Links). */
	int32 DrawnFor = 0;
	bool bLinks = false;
	/** The first few suns (node numbers). */
	std::vector<int32> Suns;
	int32 LastSelected = INDEX_NONE;
	bool bHadPositions = false;
	/** Seconds the effects have been on: every pulse and star is a function of it. */
	double Time = 0.0;
	double Prev = 0.0;
	Sp::Vec3 DustAt{};
	bool bDustAt = false;
	int32 Dropped = 0;
};

AAetherFxActor::AAetherFxActor()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bStartWithTickEnabled = true;
	// After the controller has moved the camera this frame, so the dust and the shooting stars never lag a frame behind it.
	PrimaryActorTick.TickGroup = TG_PostUpdateWork;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	SetRootComponent(Root);

	PulseSystem = TSoftObjectPtr<UNiagaraSystem>(FSoftObjectPath(FxSystemPaths[FxPulses]));
	CoronaSystem = TSoftObjectPtr<UNiagaraSystem>(FSoftObjectPath(FxSystemPaths[FxCorona]));
	DustSystem = TSoftObjectPtr<UNiagaraSystem>(FSoftObjectPath(FxSystemPaths[FxDust]));
	MeteorSystem = TSoftObjectPtr<UNiagaraSystem>(FSoftObjectPath(FxSystemPaths[FxMeteors]));
	RippleSystem = TSoftObjectPtr<UNiagaraSystem>(FSoftObjectPath(FxSystemPaths[FxRipples]));
}

const TSoftObjectPtr<UNiagaraSystem>& AAetherFxActor::SoftOf(int32 System) const
{
	switch (System)
	{
	case FxPulses: return PulseSystem;
	case FxCorona: return CoronaSystem;
	case FxDust: return DustSystem;
	case FxMeteors: return MeteorSystem;
	default: return RippleSystem;
	}
}

const TCHAR* AAetherFxActor::SystemName(int32 System)
{
	return System >= 0 && System < FxCount ? FxSystemNames[System] : TEXT("");
}

bool AAetherFxActor::IsReady(int32 System) const
{
	return State && System >= 0 && System < FxCount && State->Groups[System].System != nullptr;
}

int32 AAetherFxActor::NumReady() const
{
	int32 Count = 0;
	for (int32 I = 0; I < FxCount; ++I)
	{
		Count += IsReady(I) ? 1 : 0;
	}
	return Count;
}

int32 AAetherFxActor::NumPlaying() const
{
	if (!State || !bOn)
	{
		return 0;
	}
	int32 Count = 0;
	for (int32 I = 0; I < FxCount; ++I)
	{
		const FAetherFxState::FGroup& G = State->Groups[I];
		Count += G.Pool.Busy(State->Time);
		for (const char P : G.Playing)
		{
			Count += P ? 1 : 0;
		}
	}
	return Count;
}

int32 AAetherFxActor::NumDropped() const
{
	return State ? State->Dropped : 0;
}

void AAetherFxActor::BeginPlay()
{
	Super::BeginPlay();

	State = MakeShared<FAetherFxState>();
	for (int32 I = 0; I < FxCount; ++I)
	{
		FAetherFxState::FGroup& G = State->Groups[I];
		G.System = SoftOf(I).LoadSynchronous();
		if (!G.System)
		{
			UE_LOG(LogTemp, Warning, TEXT("Aether FX: %s is missing (build it in the Unreal Editor from docs/UNREAL-NIAGARA.md). That effect is not played."), FxSystemPaths[I]);
			continue;
		}
		const int32 Count = FxSlotsOf(I);
		for (int32 Slot = 0; Slot < Count; ++Slot)
		{
			UNiagaraComponent* C = NewFx(this, Root, G.System);
			C->SetVisibility(bOn);
			G.Comps.Add(C);
			Components.Add(C);
		}
		G.Pool.Resize(Count);
		G.Playing.assign(static_cast<size_t>(Count), 0);
		G.From.assign(static_cast<size_t>(Count), INDEX_NONE);
		G.To.assign(static_cast<size_t>(Count), INDEX_NONE);
	}
}

void AAetherFxActor::Toggle()
{
	bOn = !bOn;
	ApplyOn();
}

void AAetherFxActor::ApplyOn()
{
	if (!State)
	{
		return;
	}
	for (FAetherFxState::FGroup& G : State->Groups)
	{
		for (UNiagaraComponent* C : G.Comps)
		{
			C->SetVisibility(bOn);
			if (!bOn)
			{
				C->Deactivate();
			}
		}
		if (!bOn)
		{
			G.Pool.ReleaseAll();
			std::fill(G.Playing.begin(), G.Playing.end(), static_cast<char>(0));
		}
	}
	// Switched on again: no pulses owed for the time it was off, and the dust starts around where the camera is now.
	State->Prev = State->Time;
	State->bDustAt = false;
}

UNiagaraComponent* AAetherFxActor::Take(int32 System, double Now, double Seconds, const FVector& Where, int32* OutSlot)
{
	FAetherFxState::FGroup& G = State->Groups[System];
	if (!G.System || G.Comps.Num() == 0)
	{
		return nullptr;
	}
	const int32 Slot = G.Pool.Acquire(Now, Now + Seconds + Fx::kLingerSeconds);
	if (Slot < 0)
	{
		++State->Dropped;
		return nullptr;
	}
	UNiagaraComponent* C = G.Comps[Slot];
	C->SetWorldLocation(Where);
	if (OutSlot)
	{
		*OutSlot = Slot;
	}
	return C;
}

void AAetherFxActor::RefreshShape(const AAetherBrainActor& B)
{
	FAetherFxState& S = *State;
	// Pulses run only along the links the brain draws (its first Max Links, none when Show Links is off).
	const int32 Drawn = FMath::Max(B.GetDrawnLinkCount(), 0);
	if (S.bLinks && S.LinksFor == B.GetShapeSerial() && S.Links.NodeCount() == B.NumNodes() && S.DrawnFor == Drawn)
	{
		return;
	}
	if (S.bLinks)
	{
		// New nodes and links may have moved the selection to another number: not a new selection, so no ripple for it.
		S.LastSelected = B.GetSelected();
	}
	const TArray<int32>& Links = B.GetLinks();
	S.Links.Build(Links.GetData(), FMath::Min(Links.Num(), Drawn * 2), B.NumNodes());
	S.DrawnFor = Drawn;
	S.Suns.clear();
	for (int32 I = 0; I < B.NumNodes() && static_cast<int32>(S.Suns.size()) < Fx::kSunSlots; ++I)
	{
		const FAetherNode* N = B.GetNode(I);
		if (N && N->Kind == EAetherKind::Sun)
		{
			S.Suns.push_back(I);
		}
	}
	S.LinksFor = B.GetShapeSerial();
	S.bLinks = true;
}

void AAetherFxActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	UWorld* World = GetWorld();
	if (!State || !World || !bOn)
	{
		return;
	}
	FAetherFxState& S = *State;
	if (!Brain.IsValid())
	{
		for (TActorIterator<AAetherBrainActor> It(World); It; ++It)
		{
			Brain = *It;
			break;
		}
	}
	const double Dt = FMath::Clamp(static_cast<double>(DeltaSeconds), 0.0, 1.0);
	const double Prev = S.Prev;
	S.Time += Dt;
	const double Now = S.Time;
	S.Prev = Now;

	// Where the camera is and which way it looks: the pawn the controller has just moved.
	FVector Camera = FVector::ZeroVector;
	FVector Forward = FVector(1.0, 0.0, 0.0);
	if (const APlayerController* Pc = World->GetFirstPlayerController())
	{
		if (const APawn* Pawn = Pc->GetPawn())
		{
			Camera = Pawn->GetActorLocation();
			Forward = Pawn->GetActorForwardVector();
		}
		else if (Pc->PlayerCameraManager)
		{
			Camera = Pc->PlayerCameraManager->GetCameraLocation();
		}
	}

	const AAetherBrainActor* B = Brain.Get();
	const bool bPlaced = B && B->HasPositions() && B->NumNodes() > 0;
	double Field = Sp::kNominalField;
	if (B)
	{
		FVector Center;
		float Radius = 0.f;
		if (B->GetBounds(Center, Radius))
		{
			Field = Sp::FieldRadius(static_cast<double>(Radius));
		}
	}

	UpdateDust(Dt, Camera, Field);
	FireMeteors(Prev, Now, Camera, Forward);
	if (bPlaced)
	{
		RefreshShape(*B);
		UpdateCoronas(Now, *B);
		FireRipples(Now, *B);
		FollowPulses(Now, *B);
		FirePulses(Prev, Now, *B);
	}
}

void AAetherFxActor::UpdateDust(double Dt, const FVector& Camera, double Field)
{
	FAetherFxState& S = *State;
	FAetherFxState::FGroup& G = S.Groups[FxDust];
	if (!G.System || G.Comps.Num() == 0)
	{
		return;
	}
	UNiagaraComponent* C = G.Comps[0];
	if (!bDust)
	{
		if (G.Playing[0])
		{
			C->Deactivate();
			G.Playing[0] = 0;
		}
		return;
	}
	// The dust box follows the camera, eased (the motes already made stay where they are, so flying through it shows speed).
	const Sp::Vec3 Cam = FxFromFVector(Camera);
	S.DustAt = S.bDustAt ? Fx::Ease(S.DustAt, Cam, Dt, 2.0) : Cam;
	S.bDustAt = true;
	const Fx::DustLook Look = Fx::Dust(Field, static_cast<double>(Density));
	const FFxParams& P = FxParams();
	C->SetWorldLocation(FxToFVector(S.DustAt));
	// A size, not a place: always a Vector.
	C->SetVariableVec3(P.Extent, FxToFVector(Look.HalfExtent));
	FxSetFloat(C, P.SpawnRate, Look.SpawnRate);
	FxSetColor(C, P.Color, 0.62, 0.74, 1.0);
	FxSetFloat(C, P.Intensity, 0.6 * static_cast<double>(Glow));
	if (!G.Playing[0])
	{
		C->Activate(true);
		G.Playing[0] = 1;
	}
}

void AAetherFxActor::UpdateCoronas(double Now, const AAetherBrainActor& B)
{
	FAetherFxState& S = *State;
	FAetherFxState::FGroup& G = S.Groups[FxCorona];
	if (!G.System || G.Comps.Num() < Fx::kCoronaSlots)
	{
		return;
	}
	const FFxParams& P = FxParams();
	for (int32 Slot = 0; Slot < Fx::kCoronaSlots; ++Slot)
	{
		// The first slots are the suns; the last is a halo on the selection (a selected sun already has its corona).
		int32 Node = INDEX_NONE;
		double Scale = 1.0;
		if (bCoronas)
		{
			if (Slot < Fx::kSunSlots)
			{
				Node = Slot < static_cast<int32>(S.Suns.size()) ? S.Suns[static_cast<size_t>(Slot)] : INDEX_NONE;
			}
			else
			{
				Node = B.GetSelected();
				Scale = 0.6;
				if (std::find(S.Suns.begin(), S.Suns.end(), Node) != S.Suns.end())
				{
					Node = INDEX_NONE;
				}
			}
		}
		UNiagaraComponent* C = G.Comps[Slot];
		const FAetherNode* N = B.GetNode(Node);
		if (!N)
		{
			if (G.Playing[static_cast<size_t>(Slot)])
			{
				C->Deactivate();
				G.Playing[static_cast<size_t>(Slot)] = 0;
			}
			continue;
		}
		const Fx::CoronaLook Look = Fx::Corona(Now, static_cast<double>(B.NodeRadius(Node)) * Scale, static_cast<uint32>(Node) + (Slot >= Fx::kSunSlots ? 7000U : 0U));
		const Sp::Vec3 Color = FxColorOf(N->Color);
		C->SetWorldLocation(B.NodeLocation(Node));
		FxSetFloat(C, P.Radius, Look.Radius);
		FxSetColor(C, P.Color, Color.X, Color.Y, Color.Z);
		FxSetFloat(C, P.Intensity, Look.Intensity * static_cast<double>(Glow));
		if (!G.Playing[static_cast<size_t>(Slot)])
		{
			C->Activate(true);
			G.Playing[static_cast<size_t>(Slot)] = 1;
		}
	}
}

void AAetherFxActor::FireRipples(double Now, const AAetherBrainActor& B)
{
	FAetherFxState& S = *State;
	// A ripple where a node was just selected, and one round every sun when the brain first appears.
	const int32 Selected = B.GetSelected();
	if (Selected != S.LastSelected)
	{
		S.LastSelected = Selected;
		if (bRipples && B.GetNode(Selected))
		{
			RippleAt(Now, B, Selected);
		}
	}
	if (!S.bHadPositions)
	{
		S.bHadPositions = true;
		for (const int32 Sun : S.Suns)
		{
			if (bRipples)
			{
				RippleAt(Now, B, Sun);
			}
		}
	}
}

void AAetherFxActor::RippleAt(double Now, const AAetherBrainActor& B, int32 Node)
{
	const FAetherNode* N = B.GetNode(Node);
	if (!N)
	{
		return;
	}
	const Fx::RippleLook Look = Fx::Ripple(static_cast<double>(B.NodeRadius(Node)));
	UNiagaraComponent* C = Take(FxRipples, Now, Look.Seconds, B.NodeLocation(Node));
	if (!C)
	{
		return;
	}
	const FFxParams& P = FxParams();
	const Sp::Vec3 Color = Fx::PulseTint(FxColorOf(N->Color));
	FxSetFloat(C, P.Radius, Look.Radius);
	FxSetColor(C, P.Color, Color.X, Color.Y, Color.Z);
	FxSetFloat(C, P.Duration, Look.Seconds);
	FxSetFloat(C, P.Intensity, Look.Intensity * static_cast<double>(Glow));
	C->Activate(true);
}

void AAetherFxActor::FollowPulses(double Now, const AAetherBrainActor& B)
{
	// The nodes keep orbiting while a pulse runs between them: hand every pulse that is still playing the nodes' places now, so it
	// arrives where the node is and not where it was.
	FAetherFxState::FGroup& G = State->Groups[FxPulses];
	if (!G.System)
	{
		return;
	}
	const FFxParams& P = FxParams();
	for (int32 Slot = 0; Slot < G.Comps.Num(); ++Slot)
	{
		const int32 From = G.From[static_cast<size_t>(Slot)];
		const int32 To = G.To[static_cast<size_t>(Slot)];
		if (!G.Pool.IsBusy(Slot, Now) || !B.GetNode(From) || !B.GetNode(To))
		{
			continue;
		}
		const FVector Start = B.NodeLocation(From);
		const FVector End = B.NodeLocation(To);
		if (!std::isfinite(Sp::Length(FxFromFVector(End) - FxFromFVector(Start))))
		{
			continue;
		}
		UNiagaraComponent* C = G.Comps[Slot];
		C->SetWorldLocation(Start);
		FxSetPoint(C, P.Start, Start, bPositionParameters);
		FxSetPoint(C, P.End, End, bPositionParameters);
	}
}

void AAetherFxActor::FirePulses(double Prev, double Now, const AAetherBrainActor& B)
{
	FAetherFxState& S = *State;
	if (!bPulses || !S.Groups[FxPulses].System || S.Links.NodeCount() != B.NumNodes())
	{
		return;
	}
	const double Rate = Fx::PulseRate(S.Links.LinkCount(), static_cast<double>(Density));
	const int32 Focus = B.GetSelected();
	const FFxParams& P = FxParams();
	for (const uint32 K : Fx::DueEvents(static_cast<uint32>(Seed), Fx::kPulseSalt, Rate, Prev, Now))
	{
		const Fx::LinkPick Pick = Fx::PickLink(S.Links, static_cast<uint32>(Seed), K, Focus, static_cast<double>(SelectionShare));
		const FAetherNode* From = B.GetNode(Pick.From);
		if (Pick.Link < 0 || !From || !B.GetNode(Pick.To))
		{
			continue;
		}
		const FVector Start = B.NodeLocation(Pick.From);
		const FVector End = B.NodeLocation(Pick.To);
		const double Length = Sp::Length(FxFromFVector(End) - FxFromFVector(Start));
		// Before the nodes have moved apart (or if the layout is degenerate) there is nothing to run along.
		if (!std::isfinite(Length) || Length < 5.0)
		{
			continue;
		}
		const double Seconds = Fx::PulseSeconds(Length);
		int32 Slot = INDEX_NONE;
		UNiagaraComponent* C = Take(FxPulses, Now, Seconds, Start, &Slot);
		if (!C)
		{
			continue;
		}
		S.Groups[FxPulses].From[static_cast<size_t>(Slot)] = Pick.From;
		S.Groups[FxPulses].To[static_cast<size_t>(Slot)] = Pick.To;
		const Sp::Vec3 Color = Fx::PulseTint(FxColorOf(From->Color));
		FxSetPoint(C, P.Start, Start, bPositionParameters);
		FxSetPoint(C, P.End, End, bPositionParameters);
		FxSetColor(C, P.Color, Color.X, Color.Y, Color.Z);
		FxSetFloat(C, P.Duration, Seconds);
		FxSetFloat(C, P.Size, Fx::PulseSize(static_cast<double>(B.NodeRadius(Pick.From))));
		FxSetFloat(C, P.Intensity, 3.0 * static_cast<double>(Glow));
		C->Activate(true);
	}
}

void AAetherFxActor::FireMeteors(double Prev, double Now, const FVector& Camera, const FVector& Forward)
{
	FAetherFxState& S = *State;
	if (!bShootingStars || !S.Groups[FxMeteors].System)
	{
		return;
	}
	const FFxParams& P = FxParams();
	const double Rate = Fx::kMeteorRate * static_cast<double>(FMath::Clamp(Density, 0.f, 3.f));
	for (const uint32 K : Fx::DueEvents(static_cast<uint32>(Seed), Fx::kMeteorSalt, Rate, Prev, Now))
	{
		const Fx::MeteorShot Star = Fx::Meteor(static_cast<uint32>(Seed), K, FxFromFVector(Camera), FxFromFVector(Forward));
		UNiagaraComponent* C = Take(FxMeteors, Now, Star.Seconds, FxToFVector(Star.From));
		if (!C)
		{
			continue;
		}
		FxSetPoint(C, P.Start, FxToFVector(Star.From), bPositionParameters);
		FxSetPoint(C, P.End, FxToFVector(Star.To), bPositionParameters);
		FxSetColor(C, P.Color, Star.R, Star.G, Star.B);
		FxSetFloat(C, P.Duration, Star.Seconds);
		FxSetFloat(C, P.Width, Star.Width);
		FxSetFloat(C, P.Intensity, 3.0 * static_cast<double>(Glow));
		C->Activate(true);
	}
}
