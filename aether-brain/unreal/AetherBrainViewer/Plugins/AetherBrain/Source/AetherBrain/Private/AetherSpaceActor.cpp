#include "AetherSpaceActor.h"

#include "AetherBrainActor.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "TextureResource.h"
#include "UObject/ConstructorHelpers.h"

THIRD_PARTY_INCLUDES_START
#include "AetherSpaceMath.h"
THIRD_PARTY_INCLUDES_END

namespace Sp = AetherSpace;

namespace
{
	const TCHAR* const NodeMaterialPath = TEXT("/Game/AetherBrain/M_AetherNode.M_AetherNode");
	const TCHAR* const SpriteMaterialPath = TEXT("/Game/AetherBrain/M_AetherSprite.M_AetherSprite");
	const TCHAR* const RockMaterialPath = TEXT("/Game/AetherBrain/M_AetherRock.M_AetherRock");

	FVector ToFVector(const Sp::Vec3& V) { return FVector(V.X, V.Y, V.Z); }
	FQuat ToFQuat(const Sp::Quat& Q) { return FQuat(Q.X, Q.Y, Q.Z, Q.W); }
	Sp::Vec3 FromFVector(const FVector& V) { return Sp::Vec3{V.X, V.Y, V.Z}; }
	FTransform ToFTransform(const Sp::Xf& X) { return FTransform(ToFQuat(X.Rot), ToFVector(X.Pos), ToFVector(X.Scale)); }

	FLinearColor Lin(double R, double G, double B)
	{
		return FLinearColor(static_cast<float>(R), static_cast<float>(G), static_cast<float>(B));
	}

	UMaterialInterface* LoadQuiet(const TCHAR* Path)
	{
		return LoadObject<UMaterialInterface>(nullptr, Path, nullptr, LOAD_Quiet | LOAD_NoWarn);
	}

	/** Four floats per instance: colour (linear) and one more (glow, or how metallic). The materials read them. */
	void SetLook(UInstancedStaticMeshComponent* Ism, int32 Index, double R, double G, double B, double Extra)
	{
		Ism->SetCustomDataValue(Index, 0, static_cast<float>(R), false);
		Ism->SetCustomDataValue(Index, 1, static_cast<float>(G), false);
		Ism->SetCustomDataValue(Index, 2, static_cast<float>(B), false);
		Ism->SetCustomDataValue(Index, 3, static_cast<float>(Extra), false);
	}

	UInstancedStaticMeshComponent* NewIsm(AActor* Owner, USceneComponent* Parent, UStaticMesh* Mesh, UMaterialInterface* Material)
	{
		UInstancedStaticMeshComponent* Ism = NewObject<UInstancedStaticMeshComponent>(Owner);
		Ism->SetupAttachment(Parent);
		Ism->SetMobility(EComponentMobility::Movable);
		Ism->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Ism->SetCastShadow(false);
		Ism->SetGenerateOverlapEvents(false);
		Ism->SetStaticMesh(Mesh);
		if (Material)
		{
			Ism->SetMaterial(0, Material);
		}
		Ism->RegisterComponent();
		Ism->SetNumCustomDataFloats(4);
		return Ism;
	}

	/** A texture made from generated pixels (B, G, R, A), sRGB, never streamed. */
	UTexture2D* MakeTexture(const Sp::Image& Img)
	{
		UTexture2D* Tex = UTexture2D::CreateTransient(Img.Width, Img.Height, PF_B8G8R8A8);
		if (!Tex || !Tex->GetPlatformData() || Tex->GetPlatformData()->Mips.Num() == 0)
		{
			return nullptr;
		}
		Tex->SRGB = true;
		Tex->Filter = TF_Bilinear;
		Tex->AddressX = TA_Clamp;
		Tex->AddressY = TA_Clamp;
		Tex->NeverStream = true;
		FTexture2DMipMap& Mip = Tex->GetPlatformData()->Mips[0];
		void* Data = Mip.BulkData.Lock(LOCK_READ_WRITE);
		FMemory::Memcpy(Data, Img.Bgra.data(), Img.Bgra.size());
		Mip.BulkData.Unlock();
		Tex->UpdateResource();
		return Tex;
	}
}

/** Everything the space remembers between frames. Only the actor's .cpp knows its shape. */
struct FAetherSpaceState
{
	/** Which instance of which batch a part of the scene is. */
	struct FSlot
	{
		int32 Batch = INDEX_NONE;
		int32 Index = INDEX_NONE;
	};

	/** One instanced component and the world transforms of all its instances, rewritten each frame. */
	struct FBatch
	{
		UInstancedStaticMeshComponent* Ism = nullptr;
		TArray<FTransform> Xf;
	};

	/** A backdrop layer: its spec and its sprites' components (one per picture; empty entries for pictures not used). */
	struct FLayer
	{
		Sp::LayerSpec Spec{};
		uint32 Index = 0;
		TArray<UInstancedStaticMeshComponent*> Isms;
	};

	TArray<FLayer> Layers;
	TArray<FBatch> Batches;
	/** The batch for a (category, shape), made on first use. Categories: 0 lit (rocks, hulls), 1 glowing. Shapes: Sp::Prim. */
	int32 BatchOf[2][4] = {{INDEX_NONE, INDEX_NONE, INDEX_NONE, INDEX_NONE}, {INDEX_NONE, INDEX_NONE, INDEX_NONE, INDEX_NONE}};

	std::vector<Sp::BeltRock> Belt;
	TArray<FSlot> BeltSlots;
	std::vector<Sp::FlybyRock> Flyby;
	TArray<FSlot> FlybySlots;
	std::vector<Sp::Streak> Streaks;
	TArray<FSlot> StreakSlots;
	std::vector<Sp::ShipSpec> Fleet;
	std::vector<std::vector<Sp::Part>> FleetParts;
	TArray<TArray<FSlot>> ShipSlots;
};

AAetherSpaceActor::AAetherSpaceActor()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bStartWithTickEnabled = true;
	// After the controller has moved the camera this frame, so the backdrop never lags a frame behind it.
	PrimaryActorTick.TickGroup = TG_PostUpdateWork;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	SetRootComponent(Root);

	const auto MakeLight = [this](const TCHAR* Name, const Sp::StageLight& L) -> UDirectionalLightComponent*
	{
		UDirectionalLightComponent* Light = CreateDefaultSubobject<UDirectionalLightComponent>(Name);
		Light->SetupAttachment(Root);
		Light->SetMobility(EComponentMobility::Movable);
		Light->SetIntensity(static_cast<float>(L.Lux));
		Light->SetLightColor(Lin(L.R, L.G, L.B), false);
		Light->SetCastShadows(false);
		Light->SetRelativeRotation(FRotator(static_cast<float>(L.Pitch), static_cast<float>(L.Yaw), 0.f));
		return Light;
	};
	KeyLight = MakeLight(TEXT("KeyLight"), Sp::kKeyLight);
	FillLight = MakeLight(TEXT("FillLight"), Sp::kFillLight);

	// Hard references: the engine meshes get cooked with the game.
	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereFinder(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderFinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> ConeFinder(TEXT("/Engine/BasicShapes/Cone.Cone"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeFinder(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> PlaneFinder(TEXT("/Engine/BasicShapes/Plane.Plane"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> FallbackFinder(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	SphereMesh = SphereFinder.Object;
	CylinderMesh = CylinderFinder.Object;
	ConeMesh = ConeFinder.Object;
	CubeMesh = CubeFinder.Object;
	PlaneMesh = PlaneFinder.Object;
	FallbackMaterial = FallbackFinder.Object;

	SpriteMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(SpriteMaterialPath));
	RockMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(RockMaterialPath));
}

void AAetherSpaceActor::BeginPlay()
{
	Super::BeginPlay();

	State = MakeShared<FAetherSpaceState>();
	FieldNow = Sp::kNominalField;

	UMaterialInterface* Glow = LoadQuiet(NodeMaterialPath);
	if (!Glow)
	{
		Glow = FallbackMaterial;
	}
	UMaterialInterface* Sprites = SpriteMaterial.LoadSynchronous();
	bSpriteMaterialMissing = Sprites == nullptr;
	if (bSpriteMaterialMissing)
	{
		UE_LOG(LogTemp, Warning, TEXT("Aether Space: /Game/AetherBrain/M_AetherSprite is missing (open the project in the editor once: Content/Python/init_unreal.py makes it). No nebulae, galaxies or stars of the backdrop."));
	}
	UMaterialInterface* Lit = RockMaterial.LoadSynchronous();
	if (!Lit)
	{
		UE_LOG(LogTemp, Warning, TEXT("Aether Space: /Game/AetherBrain/M_AetherRock is missing (open the project in the editor once). Rocks and ships are drawn without shading."));
		Lit = Glow;
	}

	KeyLight->SetVisibility(bStageLights);
	FillLight->SetVisibility(bStageLights);

	BuildBackdrop(Sprites);
	BuildMovers(Glow, Lit);
	ApplyMode();
}

void AAetherSpaceActor::BuildBackdrop(UMaterialInterface* Sprites)
{
	if (!Sprites || !PlaneMesh)
	{
		return;
	}
	FAetherSpaceState& S = *State;
	const int32 Size = FMath::Clamp(TextureSize, 64, 1024);

	// One material per generated picture, shared by every layer that uses it.
	const auto MakeMaterial = [this, Sprites](const Sp::Image& Img) -> UMaterialInstanceDynamic*
	{
		UTexture2D* Tex = MakeTexture(Img);
		UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Sprites, this);
		if (Tex)
		{
			Textures.Add(Tex);
			if (Mid)
			{
				Mid->SetTextureParameterValue(TEXT("Tex"), Tex);
			}
		}
		if (Mid)
		{
			SpriteMaterials.Add(Mid);
		}
		return Mid;
	};
	UMaterialInstanceDynamic* StarMaterial = MakeMaterial(Sp::MakeStarDot(64));
	TArray<UMaterialInstanceDynamic*> NebulaMaterials;
	for (int32 V = 0; V < Sp::kNebulaVariants; ++V)
	{
		NebulaMaterials.Add(MakeMaterial(Sp::MakeNebula(Size, 100U + static_cast<uint32>(V) * 17U)));
	}
	TArray<UMaterialInstanceDynamic*> GalaxyMaterials;
	for (int32 V = 0; V < Sp::kGalaxyVariants; ++V)
	{
		GalaxyMaterials.Add(MakeMaterial(Sp::MakeGalaxy(Size, 200U + static_cast<uint32>(V) * 13U, static_cast<Sp::GalaxyKind>(V))));
	}

	const std::vector<Sp::LayerSpec> Specs = Sp::DefaultLayers();
	for (size_t Li = 0; Li < Specs.size(); ++Li)
	{
		const Sp::LayerSpec& Spec = Specs[Li];
		FAetherSpaceState::FLayer Layer;
		Layer.Spec = Spec;
		Layer.Index = static_cast<uint32>(Li);
		const int32 Count = FMath::Max(0, FMath::RoundToInt(static_cast<float>(Spec.Count) * Density));
		const std::vector<Sp::SkyItem> Items = Sp::BuildLayerItems(Spec, Count, static_cast<uint32>(Seed) + 9000U + static_cast<uint32>(Li) * 31U);
		const int32 Variants = Spec.Kind == Sp::SpriteKind::Star ? 1 : (Spec.Kind == Sp::SpriteKind::Nebula ? Sp::kNebulaVariants : Sp::kGalaxyVariants);
		Layer.Isms.SetNumZeroed(Variants);
		for (const Sp::SkyItem& It : Items)
		{
			const int32 V = FMath::Clamp(It.Variant, 0, Variants - 1);
			if (!Layer.Isms[V])
			{
				UMaterialInstanceDynamic* Material = Spec.Kind == Sp::SpriteKind::Star ? StarMaterial : (Spec.Kind == Sp::SpriteKind::Nebula ? NebulaMaterials[V] : GalaxyMaterials[V]);
				UInstancedStaticMeshComponent* Ism = NewIsm(this, Root, PlaneMesh, Material);
				Components.Add(Ism);
				Layer.Isms[V] = Ism;
			}
			UInstancedStaticMeshComponent* Ism = Layer.Isms[V];
			const int32 Index = Ism->AddInstance(ToFTransform(Sp::SpriteXf(It, Spec.Radius)));
			SetLook(Ism, Index, It.R, It.G, It.B, It.Glow * static_cast<double>(SkyGlow));
		}
		for (UInstancedStaticMeshComponent* Ism : Layer.Isms)
		{
			if (Ism)
			{
				Ism->MarkRenderStateDirty();
			}
		}
		S.Layers.Add(MoveTemp(Layer));
	}
}

void AAetherSpaceActor::BuildMovers(UMaterialInterface* Glow, UMaterialInterface* Lit)
{
	FAetherSpaceState& S = *State;
	UStaticMesh* Meshes[4] = {SphereMesh, CylinderMesh, ConeMesh, CubeMesh};

	const auto BatchFor = [this, &S, &Meshes, Glow, Lit](int32 Category, Sp::Prim Shape) -> int32
	{
		const int32 P = static_cast<int32>(Shape);
		if (S.BatchOf[Category][P] == INDEX_NONE)
		{
			FAetherSpaceState::FBatch Batch;
			Batch.Ism = NewIsm(this, Root, Meshes[P], Category == 0 ? Lit : Glow);
			Components.Add(Batch.Ism);
			S.BatchOf[Category][P] = S.Batches.Add(MoveTemp(Batch));
		}
		return S.BatchOf[Category][P];
	};

	// Every instance starts hidden (no size) and is placed by UpdateMovers each frame.
	const FTransform Hidden(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector);
	const auto NewInstance = [&S, &Hidden](int32 Batch, const FLinearColor& Color, double Extra) -> FAetherSpaceState::FSlot
	{
		FAetherSpaceState::FBatch& B = S.Batches[Batch];
		const int32 Index = B.Ism->AddInstance(Hidden);
		if (B.Xf.Num() <= Index)
		{
			B.Xf.SetNum(Index + 1);
		}
		B.Xf[Index] = Hidden;
		SetLook(B.Ism, Index, Color.R, Color.G, Color.B, Extra);
		FAetherSpaceState::FSlot Slot;
		Slot.Batch = Batch;
		Slot.Index = Index;
		return Slot;
	};

	const uint32 Base = static_cast<uint32>(Seed);

	// Rocks going round the brain, and bigger ones zooming through: three lumps each, rounded or angular.
	S.Belt = Sp::BuildBelt(FMath::Max(0, FMath::RoundToInt(static_cast<float>(AsteroidCount) * Density)), Base + 4242U);
	for (const Sp::BeltRock& Rock : S.Belt)
	{
		for (const Sp::Lump& Lump : Rock.Look.Lumps)
		{
			S.BeltSlots.Add(NewInstance(BatchFor(0, Lump.Shape), Lin(Rock.Look.R * Lump.Shade, Rock.Look.G * Lump.Shade, Rock.Look.B * Lump.Shade), Rock.Look.Metal));
		}
	}
	S.Flyby = Sp::BuildFlybyRocks(FMath::Max(0, FMath::RoundToInt(static_cast<float>(FlybyRockCount) * Density)), Base + 4243U);
	for (const Sp::FlybyRock& Rock : S.Flyby)
	{
		for (const Sp::Lump& Lump : Rock.Look.Lumps)
		{
			S.FlybySlots.Add(NewInstance(BatchFor(0, Lump.Shape), Lin(Rock.Look.R * Lump.Shade, Rock.Look.G * Lump.Shade, Rock.Look.B * Lump.Shade), Rock.Look.Metal));
		}
	}

	// Shooting stars: thin glowing cylinders.
	S.Streaks = Sp::BuildStreaks(FMath::Max(0, FMath::RoundToInt(static_cast<float>(ShootingStarCount) * Density)), Base + 4244U);
	for (const Sp::Streak& Streak : S.Streaks)
	{
		S.StreakSlots.Add(NewInstance(BatchFor(1, Sp::Prim::Cylinder), Lin(Streak.R, Streak.G, Streak.B), Streak.Glow));
	}

	// Ships: each part is one instance of a lit hull shape or a glowing one.
	S.Fleet = Sp::DefaultFleet(Base, static_cast<double>(Density));
	for (const Sp::ShipSpec& Ship : S.Fleet)
	{
		S.FleetParts.push_back(Sp::ShipParts(Ship.Design));
		TArray<FAetherSpaceState::FSlot> Slots;
		for (const Sp::Part& Part : S.FleetParts.back())
		{
			const bool bGlow = Sp::IsGlowTone(Part.Colour);
			const Sp::PartLook Look = Sp::LookOf(Ship, Part.Colour);
			Slots.Add(NewInstance(BatchFor(bGlow ? 1 : 0, Part.Shape), Lin(Look.R, Look.G, Look.B), Look.Extra));
		}
		S.ShipSlots.Add(MoveTemp(Slots));
	}

	for (FAetherSpaceState::FBatch& B : S.Batches)
	{
		B.Ism->MarkRenderStateDirty();
	}
}

void AAetherSpaceActor::CycleMode()
{
	Mode = Mode == EAetherSpaceMode::Full ? EAetherSpaceMode::Calm : (Mode == EAetherSpaceMode::Calm ? EAetherSpaceMode::Off : EAetherSpaceMode::Full);
	ApplyMode();
}

const TCHAR* AAetherSpaceActor::GetModeName() const
{
	switch (Mode)
	{
	case EAetherSpaceMode::Full: return TEXT("full");
	case EAetherSpaceMode::Calm: return TEXT("calm (backdrop only)");
	default: return TEXT("off");
	}
}

void AAetherSpaceActor::SetBackdropVisible(bool bVisible)
{
	bBackdropHidden = !bVisible;
	ApplyMode();
}

void AAetherSpaceActor::ApplyMode()
{
	if (!State)
	{
		return;
	}
	const bool bBackdrop = Mode != EAetherSpaceMode::Off;
	const bool bMoving = Mode == EAetherSpaceMode::Full;
	for (FAetherSpaceState::FLayer& Layer : State->Layers)
	{
		for (UInstancedStaticMeshComponent* Ism : Layer.Isms)
		{
			if (Ism)
			{
				Ism->SetVisibility(bBackdrop && !bBackdropHidden);
			}
		}
	}
	for (FAetherSpaceState::FBatch& B : State->Batches)
	{
		B.Ism->SetVisibility(bMoving);
	}
	KeyLight->SetVisibility(bMoving && bStageLights);
	FillLight->SetVisibility(bMoving && bStageLights);
	// With the space off the brain's own plain stars come back.
	if (Brain.IsValid())
	{
		Brain->SetBuiltInStars(!bBackdrop);
	}
}

void AAetherSpaceActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	UWorld* World = GetWorld();
	if (!State || !World)
	{
		return;
	}
	if (!Brain.IsValid())
	{
		for (TActorIterator<AAetherBrainActor> It(World); It; ++It)
		{
			Brain = *It;
			Brain->SetBuiltInStars(Mode == EAetherSpaceMode::Off || bSpriteMaterialMissing);
			break;
		}
	}
	SpaceTime += static_cast<double>(DeltaSeconds) * static_cast<double>(TimeScale);
	if (Mode == EAetherSpaceMode::Off)
	{
		return;
	}

	// Where the camera is: the pawn the controller has just moved.
	FVector Camera = FVector::ZeroVector;
	if (const APlayerController* Pc = World->GetFirstPlayerController())
	{
		if (const APawn* Pawn = Pc->GetPawn())
		{
			Camera = Pawn->GetActorLocation();
		}
		else if (Pc->PlayerCameraManager)
		{
			Camera = Pc->PlayerCameraManager->GetCameraLocation();
		}
	}

	// The scene is laid out around the brain and widens with it (eased, so a rescan never makes things jump).
	FVector Center = FVector::ZeroVector;
	float BrainRadius = 0.f;
	if (Brain.IsValid())
	{
		FVector C;
		float R = 0.f;
		if (Brain->GetBounds(C, R))
		{
			Center = C;
			BrainRadius = R;
		}
	}
	FieldNow += (Sp::FieldRadius(static_cast<double>(BrainRadius)) - FieldNow) * (1.0 - FMath::Exp(-static_cast<double>(DeltaSeconds) * 0.6));

	UpdateBackdrop(Camera);
	if (Mode == EAetherSpaceMode::Full)
	{
		UpdateMovers(Center);
	}
}

void AAetherSpaceActor::UpdateBackdrop(const FVector& Camera)
{
	const Sp::Vec3 Cam = FromFVector(Camera);
	for (FAetherSpaceState::FLayer& Layer : State->Layers)
	{
		// The layer lags behind the camera by a share that grows with how near it is (parallax), and turns slowly.
		const FVector Where = ToFVector(Sp::LayerOrigin(Cam, Layer.Spec.Follow, Layer.Spec.Radius));
		const FQuat Turn = ToFQuat(Sp::LayerDrift(Layer.Spec, Layer.Index, SpaceTime));
		for (UInstancedStaticMeshComponent* Ism : Layer.Isms)
		{
			if (Ism)
			{
				Ism->SetWorldLocationAndRotation(Where, Turn);
			}
		}
	}
}

void AAetherSpaceActor::UpdateMovers(const FVector& CenterPoint)
{
	FAetherSpaceState& S = *State;
	const Sp::Vec3 Center = FromFVector(CenterPoint);
	const double Field = FieldNow;
	const double Time = SpaceTime;
	const double RockScale = static_cast<double>(AsteroidScale);
	const auto Put = [&S](const FAetherSpaceState::FSlot& Slot, const Sp::Xf& X)
	{
		S.Batches[Slot.Batch].Xf[Slot.Index] = ToFTransform(X);
	};

	for (size_t I = 0; I < S.Belt.size(); ++I)
	{
		const Sp::Pose P = Sp::EvalBelt(S.Belt[I], Time, Center, Field);
		for (int32 L = 0; L < 3; ++L)
		{
			Put(S.BeltSlots[static_cast<int32>(I) * 3 + L], Sp::LumpWorld(S.Belt[I].Look, L, P, 1.0, RockScale));
		}
	}
	for (size_t I = 0; I < S.Flyby.size(); ++I)
	{
		double Fade = 0.0;
		const Sp::Pose P = Sp::EvalFlybyRock(S.Flyby[I], Time, Center, Field, Fade);
		for (int32 L = 0; L < 3; ++L)
		{
			Put(S.FlybySlots[static_cast<int32>(I) * 3 + L], Sp::LumpWorld(S.Flyby[I].Look, L, P, Fade, RockScale));
		}
	}
	for (size_t I = 0; I < S.Streaks.size(); ++I)
	{
		bool bVisible = false;
		Sp::Xf X = Sp::StreakXf(S.Streaks[I], Time, Center, Field, bVisible);
		if (!bVisible)
		{
			X.Scale = Sp::Vec3{};
		}
		Put(S.StreakSlots[static_cast<int32>(I)], X);
	}
	for (size_t I = 0; I < S.Fleet.size(); ++I)
	{
		const Sp::ShipPose Pose = Sp::EvalShip(S.Fleet[I], Time, Center, Field);
		const std::vector<Sp::Part>& Parts = S.FleetParts[I];
		for (size_t K = 0; K < Parts.size(); ++K)
		{
			Put(S.ShipSlots[static_cast<int32>(I)][static_cast<int32>(K)], Sp::PartWorld(Parts[K], Pose, S.Fleet[I].UnitCm));
		}
	}

	// World-space transforms, written in one go per component.
	for (FAetherSpaceState::FBatch& B : S.Batches)
	{
		if (B.Ism && B.Xf.Num() > 0)
		{
			B.Ism->BatchUpdateInstancesTransforms(0, B.Xf, true, true, true);
		}
	}
}
