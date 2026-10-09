#include "AetherBrainActor.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/TextRenderComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Camera/PlayerCameraManager.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Materials/MaterialInterface.h"
#include "Math/RotationMatrix.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/ConstructorHelpers.h"

THIRD_PARTY_INCLUDES_START
#include "AetherViewMath.h"
THIRD_PARTY_INCLUDES_END

namespace
{
	/** The engine's basic sphere has a radius of 50 cm; its cylinder is 100 cm tall with a radius of 50 cm. */
	constexpr float MeshRadius = 50.f;
	constexpr float MeshHeight = 100.f;
	/** Segments per orbit ring. */
	constexpr int32 RingSegments = 48;
	/** Thread radii, in brain units. */
	constexpr float LinkRadius = 0.09f;
	constexpr float OrbitRadius = 0.06f;
	constexpr double GraphPollSeconds = 0.5;
	constexpr double PositionsPollSeconds = 0.1;
	constexpr double RetrySeconds = 2.0;

	float KindGlow(EAetherKind Kind)
	{
		switch (Kind)
		{
		case EAetherKind::Sun: return 4.0f;
		case EAetherKind::Star: return 3.2f;
		case EAetherKind::Today: return 2.6f;
		case EAetherKind::Planet: return 1.5f;
		case EAetherKind::Picture: return 1.1f;
		case EAetherKind::Ghost: return 0.55f;
		default: return 1.15f;
		}
	}

	/** 0 sun, 1 star, 2 planet and the Today hub, 3 the rest: how small a body may be drawn from afar (AetherViewMath.h). */
	int32 RankOf(EAetherKind Kind)
	{
		switch (Kind)
		{
		case EAetherKind::Sun: return 0;
		case EAetherKind::Star: return 1;
		case EAetherKind::Planet:
		case EAetherKind::Today: return 2;
		default: return 3;
		}
	}

	bool IsLabelled(EAetherKind Kind)
	{
		return Kind == EAetherKind::Sun || Kind == EAetherKind::Star || Kind == EAetherKind::Planet || Kind == EAetherKind::Today;
	}

	/** A fingerprint of the first Count rings (their parents and radii): the same rings, the same fingerprint. */
	uint32 BrainRingPrint(const TArray<FAetherRing>& Rings, int32 Count)
	{
		uint32 Hash = AetherView::kRingSeed;
		for (int32 K = 0; K < Count && K < Rings.Num(); ++K)
		{
			Hash = AetherView::FoldRing(Hash, Rings[K].Parent, static_cast<double>(Rings[K].Radius));
		}
		return Hash;
	}

	void SetLook(UInstancedStaticMeshComponent* Ism, int32 Index, const FLinearColor& Color, float Glow)
	{
		Ism->SetCustomDataValue(Index, 0, Color.R, false);
		Ism->SetCustomDataValue(Index, 1, Color.G, false);
		Ism->SetCustomDataValue(Index, 2, Color.B, false);
		Ism->SetCustomDataValue(Index, 3, Glow, false);
	}

	UInstancedStaticMeshComponent* MakeIsm(AActor* Owner, USceneComponent* Parent, const TCHAR* Name)
	{
		UInstancedStaticMeshComponent* Ism = Owner->CreateDefaultSubobject<UInstancedStaticMeshComponent>(Name);
		Ism->SetupAttachment(Parent);
		Ism->SetMobility(EComponentMobility::Movable);
		Ism->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Ism->SetCastShadow(false);
		Ism->SetGenerateOverlapEvents(false);
		return Ism;
	}
}

AAetherBrainActor::AAetherBrainActor()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bStartWithTickEnabled = true;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	SetRootComponent(Root);
	Spheres = MakeIsm(this, Root, TEXT("Spheres"));
	Links = MakeIsm(this, Root, TEXT("Links"));
	Orbits = MakeIsm(this, Root, TEXT("Orbits"));
	Starfield = MakeIsm(this, Root, TEXT("Starfield"));

	// Hard references: the engine meshes get cooked with the game.
	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereFinder(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderFinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> FallbackFinder(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	SphereMesh = SphereFinder.Object;
	CylinderMesh = CylinderFinder.Object;
	FallbackMaterial = FallbackFinder.Object;
	Spheres->SetStaticMesh(SphereMesh);
	Starfield->SetStaticMesh(SphereMesh);
	Links->SetStaticMesh(CylinderMesh);
	Orbits->SetStaticMesh(CylinderMesh);

	NodeMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(TEXT("/Game/AetherBrain/M_AetherNode.M_AetherNode")));
}

void AAetherBrainActor::BeginPlay()
{
	Super::BeginPlay();

	UMaterialInterface* Material = NodeMaterial.LoadSynchronous();
	bMaterialMissing = Material == nullptr;
	if (bMaterialMissing)
	{
		UE_LOG(LogTemp, Warning, TEXT("Aether Brain: /Game/AetherBrain/M_AetherNode is missing (open the project in the editor once: Content/Python/init_unreal.py makes it). Drawing without colours."));
		Material = FallbackMaterial;
	}
	for (UInstancedStaticMeshComponent* Ism : { Spheres.Get(), Links.Get(), Orbits.Get(), Starfield.Get() })
	{
		Ism->SetNumCustomDataFloats(4);
		if (Material)
		{
			Ism->SetMaterial(0, Material);
		}
	}

	Labels.Reset();
	for (int32 I = 0; I < MaxLabels; ++I)
	{
		UTextRenderComponent* Label = NewObject<UTextRenderComponent>(this);
		Label->SetupAttachment(Root);
		Label->RegisterComponent();
		Label->SetHorizontalAlignment(EHTA_Center);
		Label->SetVerticalAlignment(EVRTA_TextBottom);
		Label->SetCastShadow(false);
		Label->SetVisibility(false);
		Labels.Add(Label);
	}

	BuildStarfield();
	Status = TEXT("Looking for Aether Brain...");
	Connect();
}

void AAetherBrainActor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (GraphRequest.IsValid())
	{
		GraphRequest->OnProcessRequestComplete().Unbind();
		GraphRequest->CancelRequest();
	}
	if (PositionsRequest.IsValid())
	{
		PositionsRequest->OnProcessRequestComplete().Unbind();
		PositionsRequest->CancelRequest();
	}
	GraphRequest.Reset();
	PositionsRequest.Reset();
	Super::EndPlay(EndPlayReason);
}

/* ------------------------------------------------------------------ */
/* The link                                                           */
/* ------------------------------------------------------------------ */

void AAetherBrainActor::Connect()
{
	FAetherConnection C;
	bConnFromSettings = false;
	if (!Url.IsEmpty() && !Token.IsEmpty())
	{
		C.Url = Url;
		C.Token = Token;
		C.Source = TEXT("the actor's settings");
		bConnFromSettings = true;
	}
	else if (AetherScene::ReadCommandLine(C))
	{
		bConnFromSettings = true;
	}
	else if (!AetherScene::ReadConnectionFile(C))
	{
		Conn = FAetherConnection();
		bLive = false;
		Status = TEXT("Aether Brain's companion link is off. In Aether Brain press a, switch on Unreal companion, and this view connects by itself.");
		NextConnect = FPlatformTime::Seconds() + RetrySeconds;
		return;
	}
	C.Url.RemoveFromEnd(TEXT("/"));
	Conn = C;
	NextGraph = 0.0;
	NextPositions = 0.0;
	GraphTag.Reset();
	PositionsTag.Reset();
}

TSharedRef<IHttpRequest, ESPMode::ThreadSafe> AAetherBrainActor::NewRequest(const FString& Path, const FString& Verb) const
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Conn.Url + Path);
	Request->SetVerb(Verb);
	Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *Conn.Token));
	Request->SetTimeout(5.f);
	return Request;
}

void AAetherBrainActor::RequestGraph()
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = NewRequest(TEXT("/v1/graph"), TEXT("GET"));
	if (!GraphTag.IsEmpty())
	{
		Request->SetHeader(TEXT("If-None-Match"), GraphTag);
	}
	Request->OnProcessRequestComplete().BindUObject(this, &AAetherBrainActor::OnGraph);
	GraphRequest = Request;
	Request->ProcessRequest();
}

void AAetherBrainActor::RequestPositions()
{
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = NewRequest(TEXT("/v1/positions"), TEXT("GET"));
	if (!PositionsTag.IsEmpty())
	{
		Request->SetHeader(TEXT("If-None-Match"), PositionsTag);
	}
	Request->OnProcessRequestComplete().BindUObject(this, &AAetherBrainActor::OnPositions);
	PositionsRequest = Request;
	Request->ProcessRequest();
}

bool AAetherBrainActor::CheckAnswer(FHttpResponsePtr Response, bool bConnectedSuccessfully)
{
	const double Now = FPlatformTime::Seconds();
	if (!bConnectedSuccessfully || !Response.IsValid())
	{
		bLive = false;
		bStatusStale = true;
		Status = TEXT("Can't reach Aether Brain. Is it running, with its Unreal companion link on (press a)?");
		// The app may have restarted on another port or token: read companion.json again.
		if (!bConnFromSettings)
		{
			Conn = FAetherConnection();
		}
		NextConnect = Now + RetrySeconds;
		NextGraph = Now + RetrySeconds;
		NextPositions = Now + RetrySeconds;
		return false;
	}
	const int32 Code = Response->GetResponseCode();
	if (Code == 401)
	{
		bLive = false;
		bStatusStale = true;
		Status = TEXT("Aether Brain refused the token (it was renewed?). Reading companion.json again...");
		if (!bConnFromSettings)
		{
			Conn = FAetherConnection();
		}
		NextConnect = Now + RetrySeconds;
		return false;
	}
	if (Code == 503)
	{
		bLive = true;
		bStatusStale = true;
		Status = bHasGraph ? TEXT("Connected. Aether Brain is working out where everything goes...") : TEXT("Connected. Waiting for Aether Brain to show a vault...");
		NextGraph = FMath::Max(NextGraph, Now + GraphPollSeconds);
		NextPositions = FMath::Max(NextPositions, Now + PositionsPollSeconds);
		return false;
	}
	if (Code != 200 && Code != 304)
	{
		bStatusStale = true;
		Status = FString::Printf(TEXT("Aether Brain answered %d."), Code);
		NextGraph = Now + RetrySeconds;
		NextPositions = Now + RetrySeconds;
		return false;
	}
	bLive = true;
	if (bStatusStale && bHasGraph)
	{
		// The wait, or the error, is over: say what is drawn again.
		RefreshStatus();
	}
	return true;
}

void AAetherBrainActor::OnGraph(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully)
{
	GraphRequest.Reset();
	NextGraph = FPlatformTime::Seconds() + GraphPollSeconds;
	if (!CheckAnswer(Response, bConnectedSuccessfully) || Response->GetResponseCode() == 304)
	{
		return;
	}
	// Looked at before it is read: a scene that is far more than a viewer takes is not made into a document in memory first.
	const FString Tag = Response->GetHeader(TEXT("ETag"));
	FAetherGraph NewGraph;
	bool bTooBig = Response->GetContent().Num() > AetherScene::MaxGraphBytes;
	if (bTooBig || !AetherScene::ParseGraph(Response->GetContentAsString(), NewGraph, &bTooBig))
	{
		Status = bTooBig
			? TEXT("This Aether Brain sends more of the brain than this viewer can draw. Update Aether Brain to the version that came with the viewer.")
			: TEXT("Aether Brain sent a scene this viewer can't read. Update the viewer and Aether Brain to the same version.");
		// The line stays until the next scene (and a good answer from the positions does not write over it).
		bStatusStale = false;
		// Not fetched and read again every half second: the next scene has another tag.
		GraphTag = Tag;
		return;
	}
	GraphTag = Tag;
	ApplyGraph(MoveTemp(NewGraph));
}

void AAetherBrainActor::OnPositions(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully)
{
	PositionsRequest.Reset();
	NextPositions = FPlatformTime::Seconds() + PositionsPollSeconds;
	if (!CheckAnswer(Response, bConnectedSuccessfully) || Response->GetResponseCode() == 304)
	{
		return;
	}
	FAetherPositions NewPositions;
	if (!AetherScene::ParsePositions(Response->GetContent(), NewPositions))
	{
		return;
	}
	PositionsTag = Response->GetHeader(TEXT("ETag"));
	ApplyPositions(MoveTemp(NewPositions));
}

/* ------------------------------------------------------------------ */
/* The scene                                                          */
/* ------------------------------------------------------------------ */

void AAetherBrainActor::ApplyGraph(FAetherGraph&& NewGraph)
{
	// Keep where every node that stays is drawn, so a new graph doesn't jump; new ones grow out of their parent.
	TMap<FString, FVector> Was;
	Was.Reserve(Graph.Nodes.Num());
	for (int32 I = 0; I < Graph.Nodes.Num() && I < Current.Num(); ++I)
	{
		Was.Add(Graph.Nodes[I].Id, Current[I]);
	}
	const FString SelectedId = Graph.Nodes.IsValidIndex(Selected) ? Graph.Nodes[Selected].Id : FString();
	// A new selection or colour mode in the desktop app sends the same nodes and links again: keep the instances.
	bool bSameShape = bHasGraph && Graph.Nodes.Num() == NewGraph.Nodes.Num() && Graph.Edges == NewGraph.Edges;
	for (int32 I = 0; bSameShape && I < Graph.Nodes.Num(); ++I)
	{
		bSameShape = Graph.Nodes[I].Id == NewGraph.Nodes[I].Id;
	}

	Graph = MoveTemp(NewGraph);
	bHasGraph = true;
	if (!bSameShape)
	{
		++ShapeSerial;
		// A flight to a node waits for the places of this node set.
		bPositionsCurrent = false;
	}
	const int32 N = Graph.Nodes.Num();
	Current.SetNum(N);
	Target.SetNum(N);
	for (int32 I = 0; I < N; ++I)
	{
		// A node that is new starts where the nearest of the folders it sits in (that was drawn before) is, and grows out of it.
		FVector Born = FVector::ZeroVector;
		int32 At = I;
		for (int32 Guard = 0; Graph.Nodes.IsValidIndex(At) && Guard < 64; ++Guard)
		{
			if (const FVector* Seen = Was.Find(Graph.Nodes[At].Id))
			{
				Born = *Seen;
				break;
			}
			At = Graph.Nodes[At].Parent;
		}
		Current[I] = Born;
		Target[I] = Born;
	}
	if (!bHasPositions)
	{
		// Until the layout says where things are they are all at one spot: nothing is shown (a clump, with no orbits, is not the brain).
		Spheres->SetVisibility(false);
		Links->SetVisibility(false);
		Orbits->SetVisibility(false);
	}
	// Positions belong to one graph: wait for this one's.
	PositionsTag.Reset();
	NextPositions = 0.0;
	// The rings name nodes by number: another node set cannot use them. The positions of this one bring its own.
	if (!bSameShape && Rings.Num() > 0)
	{
		Rings.Reset();
	}

	Selected = INDEX_NONE;
	Hovered = INDEX_NONE;
	for (int32 I = 0; !SelectedId.IsEmpty() && I < N; ++I)
	{
		if (Graph.Nodes[I].Id == SelectedId)
		{
			Selected = I;
			break;
		}
	}
	// The desktop app's selection is known by its id: the same note is another number when the scene's nodes change.
	const FString BrainId = Graph.Nodes.IsValidIndex(Graph.Selected) ? Graph.Nodes[Graph.Selected].Id : FString();
	BrainSelected = Graph.Selected;
	if (BrainId != BrainSelectedId)
	{
		BrainSelectedId = BrainId;
		if (!BrainId.IsEmpty())
		{
			Selected = Graph.Selected;
			bBrainSelectionChanged = true;
		}
	}

	RebuildInstances(bSameShape && Spheres->GetInstanceCount() == N);
	RefreshStatus();
	// Drawn the next frame, not up to a redraw gap later.
	RedrawClock = RedrawGap;
}

void AAetherBrainActor::RefreshStatus()
{
	const int32 N = Graph.Nodes.Num();
	const FString Name = Graph.Vault.IsEmpty() ? FString(TEXT("Vault")) : Graph.Vault;
	const FString Size = Graph.TotalNodes > N
		? FString::Printf(TEXT("the %d most important of %d nodes"), N, Graph.TotalNodes)
		: FString::Printf(TEXT("%d nodes"), N);
	Status = FString::Printf(TEXT("%s - %s, %d links, %d orbit rings - live from Aether Brain"), *Name, *Size, LinkCount, RingsDrawn);
	bStatusStale = false;
}

void AAetherBrainActor::ApplyPositions(FAetherPositions&& NewPositions)
{
	if (!bHasGraph || NewPositions.Version != Graph.Version || NewPositions.Points.Num() != Graph.Nodes.Num())
	{
		// Another graph's positions: the graph is behind.
		NextGraph = 0.0;
		return;
	}
	// A vault only just opened sends every node at one spot until its layout is worked out: those are not places yet. Drawing them,
	// and framing the camera on them, is the clump with no orbits.
	if (!bPositionsCurrent && AetherView::LooksUnplaced(NewPositions.Points.Num(), [&NewPositions](int I, int Axis) { return NewPositions.Points[I][Axis]; }))
	{
		PositionsTag.Reset();
		return;
	}
	for (int32 I = 0; I < Target.Num(); ++I)
	{
		Target[I] = AetherScene::ToUnreal(NewPositions.Points[I], WorldScale);
	}
	if (!bHasPositions)
	{
		Current = Target;
		bHasPositions = true;
		bFirstPositions = true;
		Spheres->SetVisibility(true);
		Links->SetVisibility(true);
		Orbits->SetVisibility(true);
		RedrawClock = RedrawGap;
	}
	bPositionsCurrent = true;
	Rings = MoveTemp(NewPositions.Rings);
	// Only the orbits are made again, and only when the rings are not the ones they were made from.
	const int32 Wanted = bShowOrbits ? FMath::Clamp(Rings.Num(), 0, FMath::Max(MaxRings, 0)) : 0;
	if (Wanted != RingsDrawn || BrainRingPrint(Rings, Wanted) != RingPrint)
	{
		RebuildOrbits();
		RefreshStatus();
		RedrawClock = RedrawGap;
	}
}

void AAetherBrainActor::BuildStarfield()
{
	Starfield->ClearInstances();
	FRandomStream Random(1337);
	const float Shell = 400000.f;
	for (int32 I = 0; I < 1800; ++I)
	{
		const FVector Where = Random.GetUnitVector() * static_cast<double>(Shell * Random.FRandRange(0.85f, 1.f));
		const double Size = Random.FRandRange(2.5f, 9.f);
		const int32 Index = Starfield->AddInstance(FTransform(FQuat::Identity, Where, FVector(Size)));
		const float Warmth = Random.FRand();
		const FLinearColor Color = FMath::Lerp(FLinearColor(0.62f, 0.72f, 1.f), FLinearColor(1.f, 0.9f, 0.78f), Warmth);
		SetLook(Starfield, Index, Color, Random.FRandRange(0.35f, 1.8f) * GlowScale);
	}
	Starfield->MarkRenderStateDirty();
}

void AAetherBrainActor::SetBuiltInStars(bool bOn)
{
	Starfield->SetVisibility(bOn);
}

float AAetherBrainActor::BaseRadius(int32 Index) const
{
	const FAetherNode* N = GetNode(Index);
	return N ? FMath::Max(N->Radius, 0.2f) * WorldScale : 0.f;
}

float AAetherBrainActor::GrowOf(int32 Index) const
{
	return Index == Selected ? 1.35f : Index == Hovered ? 1.15f : 1.f;
}

float AAetherBrainActor::NodeRadius(int32 Index) const
{
	return BaseRadius(Index) * GrowOf(Index);
}

float AAetherBrainActor::GlowOf(int32 Index) const
{
	const FAetherNode& N = Graph.Nodes[Index];
	const float Boost = Index == Selected ? 2.4f : Index == Hovered ? 1.6f : 1.f;
	return KindGlow(N.Kind) * Boost * GlowScale;
}

void AAetherBrainActor::ApplyNodeLook(int32 Index)
{
	if (Graph.Nodes.IsValidIndex(Index) && Index < Spheres->GetInstanceCount())
	{
		SetLook(Spheres, Index, Graph.Nodes[Index].Color, GlowOf(Index));
	}
}

void AAetherBrainActor::SetNodeLook(int32 Index)
{
	ApplyNodeLook(Index);
	Spheres->MarkRenderStateDirty();
}

FTransform AAetherBrainActor::Thread(const FVector& A, const FVector& B, float RadiusCm) const
{
	const FVector D = B - A;
	const double Length = D.Size();
	if (Length < 0.01)
	{
		return FTransform(FQuat::Identity, A, FVector(0.0));
	}
	const FQuat Turn = FRotationMatrix::MakeFromZ(D / Length).ToQuat();
	const double Thick = RadiusCm / MeshRadius;
	return FTransform(Turn, (A + B) * 0.5, FVector(Thick, Thick, Length / MeshHeight));
}

void AAetherBrainActor::RebuildInstances(bool bKeepInstances)
{
	const int32 N = Graph.Nodes.Num();

	if (!bKeepInstances)
	{
		Spheres->ClearInstances();
	}
	for (int32 I = 0; I < N; ++I)
	{
		if (!bKeepInstances)
		{
			Spheres->AddInstance(FTransform(FQuat::Identity, Current[I], FVector(static_cast<double>(NodeRadius(I) / MeshRadius))));
		}
		SetLook(Spheres, I, Graph.Nodes[I].Color, GlowOf(I));
	}
	Spheres->MarkRenderStateDirty();

	if (!bKeepInstances)
	{
		Links->ClearInstances();
	}
	LinkCount = bShowLinks ? FMath::Min(Graph.Edges.Num() / 2, MaxLinks) : 0;
	for (int32 E = 0; E < LinkCount; ++E)
	{
		const int32 A = Graph.Edges[E * 2];
		const int32 B = Graph.Edges[E * 2 + 1];
		if (!bKeepInstances)
		{
			Links->AddInstance(Thread(Current[A], Current[B], LinkRadius * WorldScale));
		}
		const FLinearColor Color = (Graph.Nodes[A].Color + Graph.Nodes[B].Color) * 0.5f;
		SetLook(Links, E, Color, 0.5f * GlowScale);
	}
	Links->MarkRenderStateDirty();

	if (bKeepInstances)
	{
		// Orbits and names are those of the same nodes.
		return;
	}
	RebuildOrbits();

	// Names: suns first, then stars, the Today hub, then the biggest planets.
	TArray<int32> Order;
	for (int32 I = 0; I < N; ++I)
	{
		if (IsLabelled(Graph.Nodes[I].Kind))
		{
			Order.Add(I);
		}
	}
	Order.Sort([this](int32 A, int32 B) {
		const FAetherNode& X = Graph.Nodes[A];
		const FAetherNode& Y = Graph.Nodes[B];
		const int32 RankX = X.Kind == EAetherKind::Sun ? 0 : X.Kind == EAetherKind::Star ? 1 : X.Kind == EAetherKind::Today ? 2 : 3;
		const int32 RankY = Y.Kind == EAetherKind::Sun ? 0 : Y.Kind == EAetherKind::Star ? 1 : Y.Kind == EAetherKind::Today ? 2 : 3;
		return RankX != RankY ? RankX < RankY : X.Radius > Y.Radius;
	});
	LabelNodes.Reset();
	LabelSizes.Reset();
	LabelSizes.SetNumZeroed(Labels.Num());
	for (int32 Slot = 0; Slot < Labels.Num(); ++Slot)
	{
		UTextRenderComponent* Label = Labels[Slot];
		if (!Order.IsValidIndex(Slot))
		{
			Label->SetVisibility(false);
			continue;
		}
		const int32 I = Order[Slot];
		const FAetherNode& Node = Graph.Nodes[I];
		LabelNodes.Add(I);
		const FString Text = Node.Title;
		Label->SetText(FText::FromString(Text));
		Label->SetTextRenderColor(Node.Color.ToFColor(true));
		LabelSizes[Slot] = FMath::Clamp(Node.Radius * WorldScale * 0.75f, 24.f, 260.f);
		Label->SetWorldSize(LabelSizes[Slot]);
		Label->SetVisibility(true);
	}
}

void AAetherBrainActor::RebuildOrbits()
{
	Orbits->ClearInstances();
	OrbitSegments = 0;
	// 48 pieces a ring: a brain with thousands of rings would make hundreds of thousands of them, so only the first Max Rings are drawn.
	RingsDrawn = bShowOrbits ? FMath::Clamp(Rings.Num(), 0, FMath::Max(MaxRings, 0)) : 0;
	RingPrint = BrainRingPrint(Rings, RingsDrawn);
	for (int32 K = 0; K < RingsDrawn; ++K)
	{
		const FAetherRing& Ring = Rings[K];
		const bool bUsable = Graph.Nodes.IsValidIndex(Ring.Parent);
		const FLinearColor Color = bUsable ? Graph.Nodes[Ring.Parent].Color : FLinearColor::White;
		for (int32 S = 0; S < RingSegments; ++S)
		{
			const int32 Index = Orbits->AddInstance(FTransform(FQuat::Identity, FVector::ZeroVector, FVector(0.0)));
			SetLook(Orbits, Index, Color, 0.32f * GlowScale);
			++OrbitSegments;
		}
	}
	Orbits->MarkRenderStateDirty();
}

void AAetherBrainActor::SetHovered(int32 Index)
{
	if (Index == Hovered)
	{
		return;
	}
	const int32 Was = Hovered;
	Hovered = Graph.Nodes.IsValidIndex(Index) ? Index : INDEX_NONE;
	ApplyNodeLook(Was);
	ApplyNodeLook(Hovered);
	Spheres->MarkRenderStateDirty();
}

void AAetherBrainActor::SelectNode(int32 Index, bool bOpen)
{
	if (!Graph.Nodes.IsValidIndex(Index))
	{
		return;
	}
	const int32 Was = Selected;
	Selected = Index;
	ApplyNodeLook(Was);
	ApplyNodeLook(Selected);
	Spheres->MarkRenderStateDirty();
	if (!Conn.IsValid())
	{
		return;
	}
	// The desktop app selects it too and flies there; with bOpen it opens the note.
	const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("id"), Graph.Nodes[Index].Id);
	Body->SetBoolField(TEXT("open"), bOpen);
	FString Text;
	const TSharedRef<TJsonWriter<TCHAR>> Writer = TJsonWriterFactory<TCHAR>::Create(&Text);
	FJsonSerializer::Serialize(Body, Writer);
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = NewRequest(TEXT("/v1/select"), TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetContentAsString(Text);
	Request->ProcessRequest();
	// The brain's own selection comes back with the next graph: no second flight for it.
	BrainSelected = Index;
	BrainSelectedId = Graph.Nodes[Index].Id;
}

bool AAetherBrainActor::ConsumeBrainSelection(int32& OutIndex)
{
	if (!bBrainSelectionChanged || !bFollowBrainSelection)
	{
		bBrainSelectionChanged = false;
		return false;
	}
	if (!bPositionsCurrent)
	{
		// Fly when this scene's places are in: before that the node is where it was born, not where it is.
		return false;
	}
	bBrainSelectionChanged = false;
	OutIndex = BrainSelected;
	return Graph.Nodes.IsValidIndex(OutIndex);
}

bool AAetherBrainActor::ConsumeFirstPositions()
{
	const bool bWas = bFirstPositions;
	bFirstPositions = false;
	return bWas;
}

int32 AAetherBrainActor::Pick(const FVector& Origin, const FVector& Direction) const
{
	const FVector D = Direction.GetSafeNormal();
	AetherView::PickState Best;
	for (int32 I = 0; I < Current.Num(); ++I)
	{
		const FVector ToNode = Current[I] - Origin;
		const double T = FVector::DotProduct(ToNode, D);
		if (T <= 0.0)
		{
			continue;
		}
		const double Miss = (ToNode - D * T).Size();
		// The size it is drawn at, which from afar is more than the node's own.
		const double Drawn = AetherView::ApparentRadius(static_cast<double>(NodeRadius(I)), T, AetherView::MinAngleOfRank(RankOf(Graph.Nodes[I].Kind)));
		AetherView::PickOffer(Best, I, Miss, Drawn, T);
	}
	return Best.Index;
}

bool AAetherBrainActor::GetBounds(FVector& Center, float& Radius) const
{
	if (!bHasPositions || Target.Num() == 0)
	{
		return false;
	}
	// Where the brain will be drawn, not where it is on the way there.
	FBox Box(ForceInit);
	for (const FVector& P : Target)
	{
		Box += P;
	}
	Center = Box.GetCenter();
	Radius = FMath::Max(static_cast<float>(Box.GetExtent().Size()), 200.f);
	return true;
}

int32 AAetherBrainActor::NextStar(int32 From) const
{
	const int32 N = Graph.Nodes.Num();
	for (int32 Step = 1; Step <= N; ++Step)
	{
		const int32 I = (FMath::Max(From, -1) + Step) % N;
		if (Graph.Nodes[I].Kind == EAetherKind::Star)
		{
			return I;
		}
	}
	return INDEX_NONE;
}

void AAetherBrainActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const double Now = FPlatformTime::Seconds();
	if (!Conn.IsValid())
	{
		if (Now >= NextConnect)
		{
			Connect();
		}
	}
	else
	{
		if (!GraphRequest.IsValid() && Now >= NextGraph)
		{
			RequestGraph();
		}
		if (bHasGraph && !PositionsRequest.IsValid() && Now >= NextPositions)
		{
			RequestPositions();
		}
	}
	UpdateInstances(DeltaSeconds);
	UpdateLabels();
}

void AAetherBrainActor::UpdateInstances(float DeltaSeconds)
{
	const int32 N = Current.Num();
	if (N == 0 || Spheres->GetInstanceCount() != N)
	{
		return;
	}
	// Redrawn 30 times a second at most, and less often when a redraw takes more than a fifth of the time: a big brain slows its own
	// motion down and never the editor. The nodes ease toward their places by the time that has passed since the last redraw.
	if (bMeasureNext)
	{
		// What the frame after a redraw took beyond a 60 a second frame is the engine uploading it: it counts as part of its cost.
		bMeasureNext = false;
		RedrawSpent += FMath::Max(0.0, static_cast<double>(DeltaSeconds) - 1.0 / 60.0);
		RedrawGap = AetherView::UpdateGap(RedrawSpent);
	}
	RedrawClock += static_cast<double>(DeltaSeconds);
	if (RedrawClock < RedrawGap)
	{
		return;
	}
	const float Elapsed = static_cast<float>(RedrawClock);
	RedrawClock = 0.0;
	const double Started = FPlatformTime::Seconds();

	// From the distance that shows the whole brain a moon is a fraction of a pixel and an orbit thread a hundredth of one: nothing is
	// drawn thinner than a pixel or two, however far away.
	FVector Eye = FVector::ZeroVector;
	bool bHasEye = false;
	if (const UWorld* World = GetWorld())
	{
		const APlayerController* Pc = World->GetFirstPlayerController();
		if (Pc && Pc->PlayerCameraManager)
		{
			Eye = Pc->PlayerCameraManager->GetCameraLocation();
			bHasEye = true;
		}
	}
	const auto Seen = [&Eye, bHasEye](double RadiusCm, const FVector& At, double MinAngle) -> double {
		return bHasEye ? AetherView::ApparentRadius(RadiusCm, FVector::Dist(At, Eye), MinAngle) : RadiusCm;
	};

	// Ease toward where the brain says things are (it sends 10 frames a second; orbits keep moving smoothly here).
	const float Alpha = 1.f - FMath::Exp(-Elapsed * 10.f);
	for (int32 I = 0; I < N; ++I)
	{
		Current[I] = FMath::Lerp(Current[I], Target[I], Alpha);
	}

	Scratch.Reset(N);
	for (int32 I = 0; I < N; ++I)
	{
		// The minimum is by rank, so a sun is still bigger than a moon from far away; hover and selection grow what is drawn.
		const double Radius = Seen(static_cast<double>(BaseRadius(I)), Current[I], AetherView::MinAngleOfRank(RankOf(Graph.Nodes[I].Kind))) * static_cast<double>(GrowOf(I));
		Scratch.Add(FTransform(FQuat::Identity, Current[I], FVector(Radius / static_cast<double>(MeshRadius))));
	}
	Spheres->BatchUpdateInstancesTransforms(0, Scratch, false, true, true);

	if (LinkCount > 0 && Links->GetInstanceCount() == LinkCount)
	{
		Scratch.Reset(LinkCount);
		for (int32 E = 0; E < LinkCount; ++E)
		{
			const FVector& A = Current[Graph.Edges[E * 2]];
			const FVector& B = Current[Graph.Edges[E * 2 + 1]];
			const double Thick = Seen(static_cast<double>(LinkRadius * WorldScale), (A + B) * 0.5, AetherView::kMinThreadAngle);
			Scratch.Add(Thread(A, B, static_cast<float>(Thick)));
		}
		Links->BatchUpdateInstancesTransforms(0, Scratch, false, true, true);
	}

	if (OrbitSegments > 0 && Orbits->GetInstanceCount() == OrbitSegments)
	{
		Scratch.Reset(OrbitSegments);
		for (int32 K = 0; K < RingsDrawn && K < Rings.Num(); ++K)
		{
			const FAetherRing& Ring = Rings[K];
			const bool bUsable = Current.IsValidIndex(Ring.Parent);
			const FVector Centre = bUsable ? ToBrain(Current[Ring.Parent]) : FVector::ZeroVector;
			FVector Prev = AetherScene::ToUnreal(AetherScene::RingPoint(Ring, Centre, 0.f), WorldScale);
			for (int32 S = 1; S <= RingSegments; ++S)
			{
				const float T = 2.f * UE_PI * S / RingSegments;
				const FVector Next = AetherScene::ToUnreal(AetherScene::RingPoint(Ring, Centre, T), WorldScale);
				if (bUsable)
				{
					const double Thick = Seen(static_cast<double>(OrbitRadius * WorldScale), Prev, AetherView::kMinThreadAngle);
					Scratch.Add(Thread(Prev, Next, static_cast<float>(Thick)));
				}
				else
				{
					Scratch.Add(FTransform(FQuat::Identity, FVector::ZeroVector, FVector(0.0)));
				}
				Prev = Next;
			}
		}
		Orbits->BatchUpdateInstancesTransforms(0, Scratch, false, true, true);
	}

	RedrawSpent = FPlatformTime::Seconds() - Started;
	RedrawGap = AetherView::UpdateGap(RedrawSpent);
	bMeasureNext = true;
}

void AAetherBrainActor::UpdateLabels()
{
	const UWorld* World = GetWorld();
	const APlayerController* Pc = World ? World->GetFirstPlayerController() : nullptr;
	if (!Pc || !Pc->PlayerCameraManager)
	{
		return;
	}
	const FVector Eye = Pc->PlayerCameraManager->GetCameraLocation();
	for (int32 Slot = 0; Slot < LabelNodes.Num() && Slot < Labels.Num(); ++Slot)
	{
		const int32 I = LabelNodes[Slot];
		if (!Current.IsValidIndex(I))
		{
			continue;
		}
		UTextRenderComponent* Label = Labels[Slot];
		// From the distance that shows the whole brain a name is no bigger than a pixel or two: it is made bigger with the distance,
		// in steps (a name is made again each time it is resized), and lifted over the body as it is drawn.
		const double Distance = FVector::Dist(Current[I], Eye);
		const FAetherNode& Node = Graph.Nodes[I];
		if (LabelSizes.IsValidIndex(Slot) && LabelSizes[Slot] > 0.f)
		{
			const float Base = FMath::Clamp(Node.Radius * WorldScale * 0.75f, 24.f, 260.f);
			const float Want = static_cast<float>(AetherView::ApparentRadius(static_cast<double>(Base), Distance, AetherView::kMinLabelAngle));
			if (Want > LabelSizes[Slot] * 1.25f || Want < LabelSizes[Slot] * 0.8f)
			{
				LabelSizes[Slot] = Want;
				Label->SetWorldSize(Want);
			}
		}
		const double Body = AetherView::ApparentRadius(static_cast<double>(NodeRadius(I)), Distance, AetherView::MinAngleOfRank(RankOf(Node.Kind)));
		const FVector Where = Current[I] + FVector(0.0, 0.0, Body * 1.25 + 8.0);
		// Text faces +X: turn it to the camera.
		Label->SetWorldLocationAndRotation(Where, (Eye - Where).Rotation());
	}
}
