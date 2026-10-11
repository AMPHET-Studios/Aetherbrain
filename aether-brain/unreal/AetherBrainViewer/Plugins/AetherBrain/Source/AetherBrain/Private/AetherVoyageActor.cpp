#include "AetherVoyageActor.h"

#include "AetherBrainActor.h"
#include "AetherSpaceActor.h"
#include "Async/Async.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HAL/PlatformMisc.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Interfaces/IHttpResponse.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Modules/ModuleManager.h"
#include "ProceduralMeshComponent.h"
#include "TextureResource.h"
#include "UObject/ConstructorHelpers.h"

THIRD_PARTY_INCLUDES_START
#include "AetherRockMath.h"
#include "AetherShipMath.h"
#include "AetherSkyMath.h"
#include "AetherVoyageState.h"
THIRD_PARTY_INCLUDES_END

namespace Sp = AetherSpace;
namespace Sk = AetherSky;
namespace Sh = AetherShip;
namespace Rk = AetherRock;
namespace Ms = AetherMesh;
namespace Cb = AetherCombat;
namespace Vy = AetherVoyage;

/** A mesh section as the arrays Unreal's procedural mesh takes. */
struct FAetherVoyageMesh
{
	TArray<FVector> Pos;
	TArray<FVector> Nrm;
	TArray<FVector2D> Uv;
	TArray<FLinearColor> Col;
	TArray<FProcMeshTangent> Tan;
	TArray<int32> Idx;
};

namespace
{
	const TCHAR* const VoyNodeMaterialPath = TEXT("/Game/AetherBrain/M_AetherNode.M_AetherNode");
	const TCHAR* const VoyLitMaterialPath = TEXT("/Game/AetherBrain/M_AetherRock.M_AetherRock");
	const TCHAR* const VoySkyMaterialPath = TEXT("/Game/AetherBrain/M_AetherSky.M_AetherSky");
	const TCHAR* const VoySunMaterialPath = TEXT("/Game/AetherBrain/M_AetherSun.M_AetherSun");
	const TCHAR* const VoyCoronaMaterialPath = TEXT("/Game/AetherBrain/M_AetherCorona.M_AetherCorona");
	const TCHAR* const VoyHullMaterialPath = TEXT("/Game/AetherBrain/M_AetherHull.M_AetherHull");
	const TCHAR* const VoyGlassMaterialPath = TEXT("/Game/AetherBrain/M_AetherGlass.M_AetherGlass");
	const TCHAR* const VoyLightMaterialPath = TEXT("/Game/AetherBrain/M_AetherLight.M_AetherLight");
	const TCHAR* const VoyRockPbrMaterialPath = TEXT("/Game/AetherBrain/M_AetherRockPBR.M_AetherRockPBR");
	const TCHAR* const VoyCardMaterialPath = TEXT("/Game/AetherBrain/M_AetherCard.M_AetherCard");

	/** Engine spheres, cylinders, cubes are 100 cm across (a sphere's radius is 50). */
	constexpr double VoyEngineUnit = 100.0;
	/** The brightest light a ship has (the nozzle plasma): ships' light colours are divided by this to fit a vertex colour, the material multiplies it back. */
	constexpr double VoyLightMax = 9.0;
	constexpr int32 VoyBoltCapacity = 128;
	constexpr int32 VoyFragmentCapacity = 640;
	constexpr int32 VoyBlastCapacity = 80;
	constexpr double VoyBlastSeconds = 1.4;
	constexpr int32 VoyRockVisualsPerFrame = 10;
	constexpr double VoyRockVisualRange = 52000.0;
	constexpr int32 VoyMaxCardRequestsAtOnce = 3;
	constexpr double VoyCardRetrySeconds = 20.0;

	FVector VoyToFVector(const Sp::Vec3& V) { return FVector(V.X, V.Y, V.Z); }
	Sp::Vec3 VoyFromFVector(const FVector& V) { return Sp::Vec3{V.X, V.Y, V.Z}; }
	FQuat VoyToFQuat(const Sp::Quat& Q) { return FQuat(Q.X, Q.Y, Q.Z, Q.W); }

	UMaterialInterface* VoyLoadQuiet(const TCHAR* Path)
	{
		return LoadObject<UMaterialInterface>(nullptr, Path, nullptr, LOAD_Quiet | LOAD_NoWarn);
	}

	/** The orientation whose X is `Fwd`, Y is `Right` and Z is `Up` (a right-handed basis of unit vectors). */
	FQuat VoyBasisQuat(const Sp::Vec3& Fwd, const Sp::Vec3& Right, const Sp::Vec3& Up)
	{
		return VoyToFQuat(Sp::FromBasis(Fwd, Right, Up));
	}

	/** Four floats per instance, read by the instanced materials: colour and one more (glow, or how metallic). */
	void VoySetLook(UInstancedStaticMeshComponent* Ism, int32 Index, double R, double G, double B, double Extra)
	{
		Ism->SetCustomDataValue(Index, 0, static_cast<float>(R), false);
		Ism->SetCustomDataValue(Index, 1, static_cast<float>(G), false);
		Ism->SetCustomDataValue(Index, 2, static_cast<float>(B), false);
		Ism->SetCustomDataValue(Index, 3, static_cast<float>(Extra), false);
	}

	UInstancedStaticMeshComponent* VoyNewIsm(AActor* Owner, USceneComponent* Parent, UStaticMesh* Mesh, UMaterialInterface* Material)
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

	UStaticMeshComponent* VoyNewMeshComponent(AActor* Owner, USceneComponent* Parent, UStaticMesh* Mesh, UMaterialInterface* Material)
	{
		UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(Owner);
		C->SetupAttachment(Parent);
		C->SetMobility(EComponentMobility::Movable);
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetCastShadow(false);
		C->SetGenerateOverlapEvents(false);
		C->SetStaticMesh(Mesh);
		if (Material)
		{
			C->SetMaterial(0, Material);
		}
		C->RegisterComponent();
		return C;
	}

	UProceduralMeshComponent* VoyNewProcMesh(AActor* Owner, USceneComponent* Parent)
	{
		UProceduralMeshComponent* C = NewObject<UProceduralMeshComponent>(Owner);
		C->SetupAttachment(Parent);
		C->SetMobility(EComponentMobility::Movable);
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetCastShadow(true);
		C->SetGenerateOverlapEvents(false);
		C->RegisterComponent();
		return C;
	}

	/**
	 * A texture made from generated pixels (B, G, R, A), never streamed, with its whole chain of smaller pictures (a box filter) so
	 * that thin scratches and tiny stars do not shimmer when far away. `bSrgb` for colour, false for normals and the packed map.
	 */
	UTexture2D* VoyMakeTexture(const Sp::Image& Img, bool bSrgb, bool bWrap)
	{
		UTexture2D* Tex = UTexture2D::CreateTransient(Img.Width, Img.Height, PF_B8G8R8A8);
		if (!Tex || !Tex->GetPlatformData() || Tex->GetPlatformData()->Mips.Num() == 0)
		{
			return nullptr;
		}
		Tex->SRGB = bSrgb;
		Tex->Filter = TF_Trilinear;
		Tex->AddressX = bWrap ? TA_Wrap : TA_Clamp;
		Tex->AddressY = bWrap ? TA_Wrap : TA_Clamp;
		Tex->NeverStream = true;
		{
			FTexture2DMipMap& Mip = Tex->GetPlatformData()->Mips[0];
			void* Data = Mip.BulkData.Lock(LOCK_READ_WRITE);
			FMemory::Memcpy(Data, Img.Bgra.data(), Img.Bgra.size());
			Mip.BulkData.Unlock();
		}
		// The smaller pictures: each pixel the mean of four.
		std::vector<uint8_t> From;
		std::vector<uint8_t> To;
		const uint8_t* Src = Img.Bgra.data();
		int32 W = Img.Width;
		int32 H = Img.Height;
		while (W > 1 || H > 1)
		{
			const int32 NW = FMath::Max(1, W / 2);
			const int32 NH = FMath::Max(1, H / 2);
			To.assign(static_cast<size_t>(NW) * static_cast<size_t>(NH) * 4U, 0);
			for (int32 Y = 0; Y < NH; ++Y)
			{
				const int32 Y0 = FMath::Min(H - 1, Y * 2);
				const int32 Y1 = FMath::Min(H - 1, Y * 2 + 1);
				for (int32 X = 0; X < NW; ++X)
				{
					const int32 X0 = FMath::Min(W - 1, X * 2);
					const int32 X1 = FMath::Min(W - 1, X * 2 + 1);
					for (int32 C = 0; C < 4; ++C)
					{
						const uint32 Sum = static_cast<uint32>(Src[(static_cast<size_t>(Y0) * static_cast<size_t>(W) + static_cast<size_t>(X0)) * 4U + static_cast<size_t>(C)]) +
							Src[(static_cast<size_t>(Y0) * static_cast<size_t>(W) + static_cast<size_t>(X1)) * 4U + static_cast<size_t>(C)] +
							Src[(static_cast<size_t>(Y1) * static_cast<size_t>(W) + static_cast<size_t>(X0)) * 4U + static_cast<size_t>(C)] +
							Src[(static_cast<size_t>(Y1) * static_cast<size_t>(W) + static_cast<size_t>(X1)) * 4U + static_cast<size_t>(C)];
						To[(static_cast<size_t>(Y) * static_cast<size_t>(NW) + static_cast<size_t>(X)) * 4U + static_cast<size_t>(C)] = static_cast<uint8_t>((Sum + 2U) / 4U);
					}
				}
			}
			FTexture2DMipMap* Mip = new FTexture2DMipMap();
			Mip->SizeX = NW;
			Mip->SizeY = NH;
			Mip->SizeZ = 1;
			Tex->GetPlatformData()->Mips.Add(Mip);
			void* Data = Mip->BulkData.Lock(LOCK_READ_WRITE);
			Data = Mip->BulkData.Realloc(static_cast<int64>(To.size()));
			FMemory::Memcpy(Data, To.data(), To.size());
			Mip->BulkData.Unlock();
			From.swap(To);
			Src = From.data();
			W = NW;
			H = NH;
		}
		Tex->UpdateResource();
		return Tex;
	}

	/** `Scale` turns the mesh's own units into centimetres; `LightDiv` > 0 turns an HDR light colour into a vertex colour (see VoyLightMax). */
	void VoyToArrays(const Ms::Section& S, double Scale, double LightDiv, FAetherVoyageMesh& Out)
	{
		const int32 N = static_cast<int32>(S.Pos.size());
		Out.Pos.Reserve(N);
		Out.Nrm.Reserve(N);
		Out.Uv.Reserve(N);
		Out.Col.Reserve(N);
		Out.Tan.Reserve(N);
		for (int32 I = 0; I < N; ++I)
		{
			const size_t K = static_cast<size_t>(I);
			Out.Pos.Add(FVector(S.Pos[K].X * Scale, S.Pos[K].Y * Scale, S.Pos[K].Z * Scale));
			Out.Nrm.Add(FVector(S.Nrm[K].X, S.Nrm[K].Y, S.Nrm[K].Z));
			Out.Uv.Add(FVector2D(S.Uv[K].U, S.Uv[K].V));
			const double Div = LightDiv > 0.0 ? LightDiv : 1.0;
			const auto Q = [Div](double C) { return static_cast<float>(FMath::Clamp(C / Div, 0.0, 1.0)); };
			Out.Col.Add(FLinearColor(Q(S.Col[K].R), Q(S.Col[K].G), Q(S.Col[K].B), 1.f));
			Out.Tan.Add(FProcMeshTangent(FVector(S.Tan[K].X, S.Tan[K].Y, S.Tan[K].Z), false));
		}
		Out.Idx.Reserve(static_cast<int32>(S.Idx.size()));
		for (const uint32_t I : S.Idx)
		{
			Out.Idx.Add(static_cast<int32>(I));
		}
	}

	/** Which of the three kinds of sun picture a node's colour calls for: 0 red dwarf, 1 yellow, 2 blue-white. */
	int32 VoySunClassOf(const FLinearColor& C)
	{
		if (C.B > C.R * 1.08f)
		{
			return 2;
		}
		if (C.G < C.R * 0.72f)
		{
			return 0;
		}
		return 1;
	}

	double VoySunKelvin(int32 Class)
	{
		return Class == 0 ? 3400.0 : (Class == 2 ? 10500.0 : 5800.0);
	}

	bool VoyIsFolder(EAetherKind K) { return K == EAetherKind::Sun || K == EAetherKind::Star || K == EAetherKind::Planet; }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* What the actor remembers                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What a background job made: one of these pointers is set. */
struct FBakeResult
{
	TSharedPtr<Sp::Image> Image;
	TSharedPtr<Sh::HullMaps> Hull;
	TSharedPtr<Rk::RockMaps> Rock;
};

struct FAetherVoyageState
{
	/* ---- background jobs, one at a time, in this order: sky, suns, hulls, rocks ---- */
	enum class EJob : uint8 { None, Sky, Sun, Hull, Rock };
	EJob Running = EJob::None;
	int32 RunningIndex = 0;
	TFuture<TSharedPtr<FBakeResult>> Job;
	bool bSkyMade = false;
	bool bSunWanted[3] = {false, false, false};
	bool bSunMade[3] = {false, false, false};
	bool bHullMade[3] = {false, false, false};
	bool bRockMade[Rk::kRockKinds] = {false, false, false, false};
	FString Making;

	/* ---- what the pictures became ---- */
	UStaticMeshComponent* SkyBall = nullptr;
	UMaterialInstanceDynamic* SunMid[3] = {nullptr, nullptr, nullptr};
	UTexture2D* SunTex[3] = {nullptr, nullptr, nullptr};
	UMaterialInstanceDynamic* HullMid[3] = {nullptr, nullptr, nullptr};
	UMaterialInstanceDynamic* GlassMid = nullptr;
	UMaterialInstanceDynamic* LightMid = nullptr;
	UMaterialInstanceDynamic* RockMid[Rk::kRockKinds] = {nullptr, nullptr, nullptr, nullptr};
	UMaterialInterface* Glow = nullptr;
	UMaterialInterface* Lit = nullptr;

	/* ---- suns ---- */
	struct FSun
	{
		int32 Node = INDEX_NONE;
		int32 Class = 1;
		UStaticMeshComponent* Ball = nullptr;
		UStaticMeshComponent* Corona = nullptr;
		UMaterialInstanceDynamic* CoronaMid = nullptr;
	};
	TArray<FSun> Suns;
	UTexture2D* CoronaTex[3] = {nullptr, nullptr, nullptr};

	/* ---- ships ---- */
	struct FShipVisual
	{
		int32 Class = 0;
		UProceduralMeshComponent* Comp = nullptr;
		bool bBuilt = false;
	};
	FShipVisual Player;
	struct FTraffic
	{
		FShipVisual Visual;
		Cb::Route Route;
		double Speed = 600.0;
		double Phase = 0.0;
		bool bReady = false;
	};
	TArray<FTraffic> Traffic;
	bool bTrafficPlaced = false;

	/* ---- the voyage ---- */
	Vy::Session Voyage;
	int32 VoyageNode = INDEX_NONE;
	FString VoyageTitle;
	double CardWidthUsed = 900.0;

	/** The built rock meshes: key = shape * 8 + detail. */
	TMap<int32, TSharedPtr<FAetherVoyageMesh>> RockMeshes;
	struct FRockVisual
	{
		UProceduralMeshComponent* Comp = nullptr;
		int32 Kind = 0;
		bool bLive = false;
	};
	TMap<int32, FRockVisual> RockVisuals; // by rock id
	TArray<UProceduralMeshComponent*> FreeRocks;

	/** Bolts, rubble and fire. */
	UInstancedStaticMeshComponent* Bolts = nullptr;
	UInstancedStaticMeshComponent* Rubble = nullptr;
	UInstancedStaticMeshComponent* Fire = nullptr;
	struct FBlast
	{
		Sp::Vec3 At;
		double Size = 100.0;
		double Start = 0.0;
		bool bShield = false;
	};
	TArray<FBlast> Blasts;
	struct FDebris
	{
		Cb::Fragment F;
		double Start = 0.0;
		int32 Kind = 0;
		uint32 Seed = 0;
	};
	TArray<FDebris> Debris;
	struct FMuzzleFlash
	{
		Sp::Vec3 At;
		double Start = 0.0;
	};
	TArray<FMuzzleFlash> Muzzles;
	uint32 BlastSerial = 1U;

	/* ---- folder cards ---- */
	struct FCard
	{
		FString Id;
		int32 Node = INDEX_NONE;
		UProceduralMeshComponent* Comp = nullptr;
		UMaterialInstanceDynamic* Mid = nullptr;
		UTexture2D* Tex = nullptr;
		int32 PicW = 0;
		int32 PicH = 0;
		bool bRequested = false;
		bool bFailed = false;
		double RetryAt = 0.0;
		double LastUsed = 0.0;
		bool bShown = false;
		/** Where it is drawn now, for picking. */
		Sp::Vec3 Center;
		Sp::Vec3 Right;
		Sp::Vec3 Up;
		double HalfW = 0.0;
		double HalfH = 0.0;
	};
	TArray<FCard> Cards;
	struct FPendingCard
	{
		TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> Request;
		FString Id;
	};
	TArray<FPendingCard> Pending;
	double NextCardUpdate = 0.0;
	int32 CardsShown = 0;
	int32 CardsPictured = 0;

	FCard* FindCard(const FString& Id)
	{
		for (FCard& C : Cards)
		{
			if (C.Id == Id)
			{
				return &C;
			}
		}
		return nullptr;
	}

	bool bRockVisualsDirty = false;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Set-up                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

AAetherVoyageActor::AAetherVoyageActor()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bStartWithTickEnabled = true;
	// After the controller has moved the camera this frame, so the sky and the cards never lag a frame behind it.
	PrimaryActorTick.TickGroup = TG_PostUpdateWork;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Root->SetMobility(EComponentMobility::Movable);
	SetRootComponent(Root);

	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereFinder(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderFinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeFinder(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> PlaneFinder(TEXT("/Engine/BasicShapes/Plane.Plane"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> FallbackFinder(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	SphereMesh = SphereFinder.Object;
	CylinderMesh = CylinderFinder.Object;
	CubeMesh = CubeFinder.Object;
	PlaneMesh = PlaneFinder.Object;
	FallbackMaterial = FallbackFinder.Object;

	SkyMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoySkyMaterialPath));
	SunMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoySunMaterialPath));
	CoronaMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoyCoronaMaterialPath));
	HullMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoyHullMaterialPath));
	GlassMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoyGlassMaterialPath));
	LightMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoyLightMaterialPath));
	RockPbrMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoyRockPbrMaterialPath));
	CardMaterial = TSoftObjectPtr<UMaterialInterface>(FSoftObjectPath(VoyCardMaterialPath));
}

void AAetherVoyageActor::BeginPlay()
{
	Super::BeginPlay();
	State = MakeShared<FAetherVoyageState>();
	FAetherVoyageState& S = *State;

	S.Glow = VoyLoadQuiet(VoyNodeMaterialPath);
	if (!S.Glow)
	{
		S.Glow = FallbackMaterial;
	}
	S.Lit = VoyLoadQuiet(VoyLitMaterialPath);
	if (!S.Lit)
	{
		S.Lit = S.Glow;
	}
	// The materials the editor script makes: a missing one switches its part off, and the HUD says so.
	const bool bHave = SkyMaterial.LoadSynchronous() && SunMaterial.LoadSynchronous() && CoronaMaterial.LoadSynchronous() && HullMaterial.LoadSynchronous() &&
		GlassMaterial.LoadSynchronous() && LightMaterial.LoadSynchronous() && RockPbrMaterial.LoadSynchronous() && CardMaterial.LoadSynchronous();
	bMaterialsMissing = !bHave;
	if (bMaterialsMissing)
	{
		UE_LOG(LogTemp, Warning, TEXT("Aether Voyage: some of /Game/AetherBrain/M_AetherSky, _Sun, _Corona, _Hull, _Glass, _Light, _RockPBR, _Card are missing (open the project in the editor once: Content/Python/init_unreal.py makes them). The parts that need them are not drawn."));
	}
	BuildEffects();
	BuildShipVisuals();
	FindBrainAndSpace();
}

void AAetherVoyageActor::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	// A background job still running holds nothing of the world; its result is dropped.
	if (State)
	{
		State->Voyage.End();
	}
	Super::EndPlay(EndPlayReason);
}

void AAetherVoyageActor::FindBrainAndSpace()
{
	if (!GetWorld())
	{
		return;
	}
	if (!Brain.IsValid())
	{
		for (TActorIterator<AAetherBrainActor> It(GetWorld()); It; ++It)
		{
			Brain = *It;
			break;
		}
	}
	if (!Space.IsValid())
	{
		for (TActorIterator<AAetherSpaceActor> It(GetWorld()); It; ++It)
		{
			Space = *It;
			break;
		}
	}
}

void AAetherVoyageActor::BuildEffects()
{
	FAetherVoyageState& S = *State;
	const FTransform Hidden(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector);
	const auto Fill = [&](UInstancedStaticMeshComponent* Ism, int32 Count) {
		for (int32 I = 0; I < Count; ++I)
		{
			Ism->AddInstance(Hidden);
		}
		Ism->MarkRenderStateDirty();
	};
	if (CylinderMesh && S.Glow)
	{
		S.Bolts = VoyNewIsm(this, Root, CylinderMesh, S.Glow);
		Held.Add(S.Bolts);
		Fill(S.Bolts, VoyBoltCapacity);
	}
	if (CubeMesh && S.Lit)
	{
		S.Rubble = VoyNewIsm(this, Root, CubeMesh, S.Lit);
		S.Rubble->SetCastShadow(false);
		Held.Add(S.Rubble);
		Fill(S.Rubble, VoyFragmentCapacity);
	}
	if (SphereMesh && S.Glow)
	{
		S.Fire = VoyNewIsm(this, Root, SphereMesh, S.Glow);
		Held.Add(S.Fire);
		// Two balls to a blast (the fire, the flash), and a few for muzzle flashes.
		Fill(S.Fire, VoyBlastCapacity * 2 + 16);
	}
}

void AAetherVoyageActor::BuildShipVisuals()
{
	// The ships are made when their metal is: see PollBakes. Here only the player's component (hidden until then).
	FAetherVoyageState& S = *State;
	S.Player.Class = static_cast<int32>(Sh::ShipClass::Interceptor);
	S.Player.Comp = VoyNewProcMesh(this, Root);
	S.Player.Comp->SetVisibility(false);
	Held.Add(S.Player.Comp);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Background jobs: the pictures                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

void AAetherVoyageActor::PollBakes()
{
	FAetherVoyageState& S = *State;
	const unsigned Threads = static_cast<unsigned>(FMath::Clamp(FPlatformMisc::NumberOfCores() - 2, 1, 8));

	if (S.Running != FAetherVoyageState::EJob::None)
	{
		if (!S.Job.IsReady())
		{
			return;
		}
		const TSharedPtr<FBakeResult> R = S.Job.Get();
		S.Job = TFuture<TSharedPtr<FBakeResult>>();
		const FAetherVoyageState::EJob Done = S.Running;
		const int32 Index = S.RunningIndex;
		S.Running = FAetherVoyageState::EJob::None;
		S.Making.Reset();
		if (!R.IsValid())
		{
			return;
		}
		// The game thread turns pixels into textures and materials (one job's worth per frame).
		if (Done == FAetherVoyageState::EJob::Sky && R->Image.IsValid())
		{
			S.bSkyMade = true;
			UMaterialInterface* Parent = SkyMaterial.LoadSynchronous();
			UTexture2D* Tex = VoyMakeTexture(*R->Image, true, false);
			if (Parent && Tex && SphereMesh)
			{
				Held.Add(Tex);
				UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Parent, this);
				Mid->SetTextureParameterValue(TEXT("Sky"), Tex);
				Mid->SetScalarParameterValue(TEXT("Glow"), SkyGlow);
				Held.Add(Mid);
				S.SkyBall = VoyNewMeshComponent(this, Root, SphereMesh, Mid);
				Held.Add(S.SkyBall);
				bSkyReady = true;
			}
		}
		else if (Done == FAetherVoyageState::EJob::Sun && R->Image.IsValid())
		{
			S.bSunMade[Index] = true;
			UMaterialInterface* Parent = SunMaterial.LoadSynchronous();
			UTexture2D* Tex = VoyMakeTexture(*R->Image, true, false);
			if (Parent && Tex)
			{
				Held.Add(Tex);
				S.SunTex[Index] = Tex;
				UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Parent, this);
				Mid->SetTextureParameterValue(TEXT("Sun"), Tex);
				Mid->SetScalarParameterValue(TEXT("Gain"), SunGlow);
				Held.Add(Mid);
				S.SunMid[Index] = Mid;
			}
			// The corona is a small picture, made here (it takes a moment, not a thread).
			UMaterialInterface* CParent = CoronaMaterial.LoadSynchronous();
			if (CParent)
			{
				const Sp::Image Corona = Sk::MakeCorona(512, static_cast<uint32>(Seed) + 31U + static_cast<uint32>(Index), VoySunKelvin(Index));
				UTexture2D* CTex = VoyMakeTexture(Corona, true, false);
				if (CTex)
				{
					Held.Add(CTex);
					S.CoronaTex[Index] = CTex;
				}
			}
		}
		else if (Done == FAetherVoyageState::EJob::Hull && R->Hull.IsValid())
		{
			S.bHullMade[Index] = true;
			UMaterialInterface* Parent = HullMaterial.LoadSynchronous();
			UTexture2D* Base = VoyMakeTexture(R->Hull->BaseColor, true, true);
			UTexture2D* Nrm = VoyMakeTexture(R->Hull->Normal, false, true);
			UTexture2D* Orm = VoyMakeTexture(R->Hull->Orm, false, true);
			if (Parent && Base && Nrm && Orm)
			{
				Held.Add(Base);
				Held.Add(Nrm);
				Held.Add(Orm);
				UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Parent, this);
				Mid->SetTextureParameterValue(TEXT("BaseColor"), Base);
				Mid->SetTextureParameterValue(TEXT("Normal"), Nrm);
				Mid->SetTextureParameterValue(TEXT("ORM"), Orm);
				Held.Add(Mid);
				S.HullMid[Index] = Mid;
			}
			if (!S.GlassMid && GlassMaterial.LoadSynchronous())
			{
				S.GlassMid = UMaterialInstanceDynamic::Create(GlassMaterial.LoadSynchronous(), this);
				Held.Add(S.GlassMid);
			}
			if (!S.LightMid && LightMaterial.LoadSynchronous())
			{
				S.LightMid = UMaterialInstanceDynamic::Create(LightMaterial.LoadSynchronous(), this);
				S.LightMid->SetScalarParameterValue(TEXT("Intensity"), static_cast<float>(VoyLightMax));
				Held.Add(S.LightMid);
			}
		}
		else if (Done == FAetherVoyageState::EJob::Rock && R->Rock.IsValid())
		{
			S.bRockMade[Index] = true;
			UMaterialInterface* Parent = RockPbrMaterial.LoadSynchronous();
			UTexture2D* Base = VoyMakeTexture(R->Rock->BaseColor, true, true);
			UTexture2D* Nrm = VoyMakeTexture(R->Rock->Normal, false, true);
			UTexture2D* Orm = VoyMakeTexture(R->Rock->Orm, false, true);
			if (Parent && Base && Nrm && Orm)
			{
				Held.Add(Base);
				Held.Add(Nrm);
				Held.Add(Orm);
				UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(Parent, this);
				Mid->SetTextureParameterValue(TEXT("BaseColor"), Base);
				Mid->SetTextureParameterValue(TEXT("Normal"), Nrm);
				Mid->SetTextureParameterValue(TEXT("ORM"), Orm);
				Held.Add(Mid);
				S.RockMid[Index] = Mid;
			}
		}
		return;
	}

	// Next job: the sky first (it is the biggest change you see), then the suns the brain has, the player's metal, the rock, the rest.
	if (bMaterialsMissing)
	{
		return;
	}
	const int32 Seed32 = Seed;
	if (bPhotoSky && !S.bSkyMade)
	{
		S.Running = FAetherVoyageState::EJob::Sky;
		S.Making = FString::Printf(TEXT("Making the %dK sky..."), SkyWidth / 1024);
		const int32 W = FMath::Clamp(SkyWidth, 512, 16384);
		S.Job = Async(EAsyncExecution::ThreadPool, [Seed32, W, Threads]() {
			Sk::SkyParams P;
			P.Width = W;
			P.Height = W / 2;
			P.Seed = static_cast<uint32_t>(Seed32);
			P.Threads = Threads;
			TSharedPtr<FBakeResult> Out = MakeShared<FBakeResult>();
			Out->Image = MakeShared<Sp::Image>(Sk::MakeSkyMap(P));
			return Out;
		});
		return;
	}
	for (int32 K = 0; K < 3; ++K)
	{
		if (S.bSunWanted[K] && !S.bSunMade[K])
		{
			S.Running = FAetherVoyageState::EJob::Sun;
			S.RunningIndex = K;
			S.Making = FString::Printf(TEXT("Making a %dK sun..."), SunWidth / 1024);
			const int32 W = FMath::Clamp(SunWidth, 512, 16384);
			S.Job = Async(EAsyncExecution::ThreadPool, [Seed32, W, K, Threads]() {
				Sk::SunParams P;
				P.Width = W;
				P.Height = W / 2;
				P.Seed = static_cast<uint32_t>(Seed32) + 77U * static_cast<uint32_t>(K + 1);
				P.Kelvin = VoySunKelvin(K);
				P.Threads = Threads;
				TSharedPtr<FBakeResult> Out = MakeShared<FBakeResult>();
				Out->Image = MakeShared<Sp::Image>(Sk::MakeSunMap(P));
				return Out;
			});
			return;
		}
	}
	const int32 Map = FMath::Clamp(MapSize, 256, 8192);
	static const int32 HullOrder[3] = {0, 1, 2};
	for (const int32 K : HullOrder)
	{
		if (!S.bHullMade[K])
		{
			S.Running = FAetherVoyageState::EJob::Hull;
			S.RunningIndex = K;
			S.Making = TEXT("Painting the ships...");
			S.Job = Async(EAsyncExecution::ThreadPool, [Seed32, Map, K, Threads]() {
				TSharedPtr<FBakeResult> Out = MakeShared<FBakeResult>();
				Out->Hull = MakeShared<Sh::HullMaps>(Sh::MakeHullMaps(Map, static_cast<uint32_t>(Seed32) + 5U * static_cast<uint32_t>(K + 1), Sh::LiveryOf(K), Threads));
				return Out;
			});
			return;
		}
		if (K == 0)
		{
			// The rocks right after the player's own metal: they are what a voyage needs next.
			for (int32 R = 0; R < Rk::kRockKinds; ++R)
			{
				if (!S.bRockMade[R])
				{
					S.Running = FAetherVoyageState::EJob::Rock;
					S.RunningIndex = R;
					S.Making = TEXT("Shaping the asteroids...");
					S.Job = Async(EAsyncExecution::ThreadPool, [Seed32, Map, R, Threads]() {
						TSharedPtr<FBakeResult> Out = MakeShared<FBakeResult>();
						Out->Rock = MakeShared<Rk::RockMaps>(Rk::MakeRockMaps(Map, static_cast<uint32_t>(Seed32) + 400U + static_cast<uint32_t>(R), static_cast<Rk::RockKind>(R), Threads));
						return Out;
					});
					return;
				}
			}
		}
	}
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Each frame                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

void AAetherVoyageActor::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!State)
	{
		return;
	}
	Clock += static_cast<double>(DeltaSeconds);
	FindBrainAndSpace();
	PollBakes();
	// The flat backdrop steps aside once the photographic sky is up, whichever of the two actors found the other first.
	if (bSkyReady && !bBackdropHandled)
	{
		if (AAetherSpaceActor* Sky = Space.Get())
		{
			Sky->SetBackdropVisible(false);
			bBackdropHandled = true;
		}
	}

	FVector Camera = FVector::ZeroVector;
	if (GetWorld() && GetWorld()->GetFirstPlayerController() && GetWorld()->GetFirstPlayerController()->PlayerCameraManager)
	{
		Camera = GetWorld()->GetFirstPlayerController()->PlayerCameraManager->GetCameraLocation();
	}
	UpdateSky(Camera);
	UpdateSuns(Camera);
	UpdateTraffic(Clock);
	UpdateVoyageVisuals(Clock);
	UpdateCards(Camera, Clock);
}

void AAetherVoyageActor::UpdateSky(const FVector& Camera)
{
	FAetherVoyageState& S = *State;
	if (!S.SkyBall)
	{
		return;
	}
	// A very big ball round the camera: no parallax, like a painted sky. Seen from inside, so it is scaled by a negative X to turn it
	// inside out (the material is two-sided anyway).
	const double Radius = 4.0e6;
	S.SkyBall->SetWorldLocationAndRotation(Camera, FQuat::Identity);
	S.SkyBall->SetWorldScale3D(FVector(Radius * 2.0 / VoyEngineUnit));
}

void AAetherVoyageActor::UpdateSuns(const FVector& Camera)
{
	FAetherVoyageState& S = *State;
	AAetherBrainActor* B = Brain.Get();
	if (!B || bMaterialsMissing || !SphereMesh || !PlaneMesh)
	{
		return;
	}
	// Find the drives (suns) once the scene is in; a picture is made for each colour class the brain has.
	if (S.Suns.Num() == 0 && B->NumNodes() > 0 && B->HasPositions())
	{
		for (int32 I = 0; I < B->NumNodes(); ++I)
		{
			const FAetherNode* N = B->GetNode(I);
			if (N && N->Kind == EAetherKind::Sun)
			{
				FAetherVoyageState::FSun Sun;
				Sun.Node = I;
				Sun.Class = VoySunClassOf(N->Color);
				S.bSunWanted[Sun.Class] = true;
				S.Suns.Add(Sun);
				if (S.Suns.Num() >= 12)
				{
					break;
				}
			}
		}
	}
	for (FAetherVoyageState::FSun& Sun : S.Suns)
	{
		if (!S.SunMid[Sun.Class])
		{
			continue;
		}
		if (!Sun.Ball)
		{
			Sun.Ball = VoyNewMeshComponent(this, Root, SphereMesh, S.SunMid[Sun.Class]);
			Held.Add(Sun.Ball);
			if (UMaterialInterface* CParent = CoronaMaterial.LoadSynchronous())
			{
				if (S.CoronaTex[Sun.Class])
				{
					Sun.CoronaMid = UMaterialInstanceDynamic::Create(CParent, this);
					Sun.CoronaMid->SetTextureParameterValue(TEXT("Tex"), S.CoronaTex[Sun.Class]);
					Sun.CoronaMid->SetScalarParameterValue(TEXT("Glow"), SunGlow * 0.4f);
					Held.Add(Sun.CoronaMid);
					Sun.Corona = VoyNewMeshComponent(this, Root, PlaneMesh, Sun.CoronaMid);
					Held.Add(Sun.Corona);
				}
			}
		}
		const FVector Where = B->NodeLocation(Sun.Node);
		// A little bigger than the brain's own sphere, which it covers (and growing with it when it is hovered or picked).
		const double Radius = static_cast<double>(B->NodeRadius(Sun.Node)) * 1.04;
		Sun.Ball->SetWorldLocationAndRotation(Where, FQuat::Identity);
		Sun.Ball->SetWorldScale3D(FVector(Radius * 2.0 / VoyEngineUnit));
		if (Sun.Corona)
		{
			// The picture's own disc is 0.16 of its half-width, so the plane is 1 / 0.16 as wide as the sun, turned to face the camera.
			const Sp::Vec3 ToCam = Sp::Normalized(VoyFromFVector(Camera - Where), Sp::Vec3{0.0, 0.0, 1.0});
			const Sp::Vec3 Right = Sp::Normalized(Sp::Cross(Sp::kUp, ToCam), Sp::Vec3{0.0, 1.0, 0.0});
			// A plane's normal is its Z: Z toward the camera, X to the right, Y = Z x X completes the right-handed basis.
			Sun.Corona->SetWorldLocationAndRotation(Where, VoyBasisQuat(Right, Sp::Cross(ToCam, Right), ToCam));
			Sun.Corona->SetWorldScale3D(FVector(Radius * 2.0 / 0.16 / VoyEngineUnit));
		}
	}
}

void AAetherVoyageActor::UpdateTraffic(double Time)
{
	FAetherVoyageState& S = *State;
	AAetherBrainActor* B = Brain.Get();
	if (!B || TrafficShips <= 0 || bMaterialsMissing)
	{
		return;
	}
	if (!S.bTrafficPlaced)
	{
		FVector Center;
		float Radius = 0.f;
		if (!B->GetBounds(Center, Radius))
		{
			return;
		}
		S.bTrafficPlaced = true;
		Sp::Rng R(static_cast<uint32_t>(Seed) * 9176U + 5U);
		// One freighter, one cruiser, the rest interceptors.
		for (int32 I = 0; I < TrafficShips; ++I)
		{
			FAetherVoyageState::FTraffic T;
			T.Visual.Class = I == 0 ? static_cast<int32>(Sh::ShipClass::Hauler) : (I == 1 ? static_cast<int32>(Sh::ShipClass::Cruiser) : static_cast<int32>(Sh::ShipClass::Interceptor));
			const double Reach = static_cast<double>(Radius) * R.Range(1.5, 2.6) + 4000.0;
			const double A = R.Range(0.0, 2.0 * Sp::kPi);
			const double A2 = A + Sp::kPi + R.Range(-0.8, 0.8);
			const Sp::Vec3 C = VoyFromFVector(Center);
			const Sp::Vec3 From = C + Sp::Vec3{std::cos(A) * Reach, std::sin(A) * Reach, R.Range(-0.4, 0.4) * Reach * 0.5};
			const Sp::Vec3 To = C + Sp::Vec3{std::cos(A2) * Reach, std::sin(A2) * Reach, R.Range(-0.4, 0.4) * Reach * 0.5};
			T.Route = Cb::BuildRoute(From, To, static_cast<uint32_t>(Seed) + static_cast<uint32_t>(I) * 13U, 0.2, 400.0);
			// Big ships move slowly: a freighter takes minutes to cross.
			const double Scale = T.Visual.Class == 1 ? 0.4 : (T.Visual.Class == 2 ? 0.3 : 1.2);
			T.Speed = static_cast<double>(CruiseSpeed) * 0.35 * Scale * R.Range(0.8, 1.2);
			T.Phase = R.Range(0.0, T.Route.Length());
			S.Traffic.Add(T);
		}
	}
	for (int32 I = 0; I < S.Traffic.Num(); ++I)
	{
		FAetherVoyageState::FTraffic& T = S.Traffic[I];
		const int32 Livery = T.Visual.Class == 1 ? 1 : (T.Visual.Class == 2 ? 2 : 0);
		if (!T.Visual.bBuilt)
		{
			if (!S.HullMid[Livery] || !S.GlassMid || !S.LightMid)
			{
				continue;
			}
			// Build the ship (a few thousand triangles: a moment) when its metal is ready, one per frame.
			const Sh::ShipClass Cls = static_cast<Sh::ShipClass>(T.Visual.Class);
			const Ms::Mesh Mesh = Sh::MakeShip(Cls, static_cast<uint32_t>(Seed) + 100U + static_cast<uint32_t>(I));
			const double Cm = static_cast<double>(ShipLengthCm) / Sh::ShipLength(Sh::ShipClass::Interceptor) * 1.0;
			T.Visual.Comp = VoyNewProcMesh(this, Root);
			Held.Add(T.Visual.Comp);
			UMaterialInterface* Mats[3] = {S.HullMid[Livery], S.GlassMid, S.LightMid};
			for (int32 Z = 0; Z < Ms::kZones; ++Z)
			{
				FAetherVoyageMesh Arr;
				VoyToArrays(Mesh.Z[static_cast<size_t>(Z)], Cm, Z == 2 ? VoyLightMax : 0.0, Arr);
				if (Arr.Idx.Num() > 0)
				{
					T.Visual.Comp->CreateMeshSection_LinearColor(Z, Arr.Pos, Arr.Idx, Arr.Nrm, Arr.Uv, Arr.Col, Arr.Tan, false);
					T.Visual.Comp->SetMaterial(Z, Mats[Z]);
				}
			}
			T.Visual.bBuilt = true;
			return;
		}
		const double Along = std::fmod(T.Phase + T.Speed * Time, std::max(1.0, T.Route.Length()));
		const Sp::Vec3 Pos = T.Route.PointAt(Along);
		const Sp::Vec3 Fwd = T.Route.TangentAt(Along);
		const Sp::Vec3 Right = Sp::Normalized(Sp::Cross(Sp::kUp, Fwd), Sp::Vec3{0.0, 1.0, 0.0});
		const Sp::Vec3 Up = Sp::Cross(Fwd, Right);
		T.Visual.Comp->SetWorldLocationAndRotation(VoyToFVector(Pos), VoyBasisQuat(Fwd, Right, Up));
		T.Visual.Comp->SetWorldScale3D(FVector(1.0, 1.0, 1.0));
	}
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The voyage                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

bool AAetherVoyageActor::IsVoyaging() const { return State && State->Voyage.Active(); }
bool AAetherVoyageActor::HasArrived() const { return State && State->Voyage.Arrived(); }
int32 AAetherVoyageActor::GetVoyageNode() const { return State && State->Voyage.Active() ? State->VoyageNode : INDEX_NONE; }

bool AAetherVoyageActor::BeginVoyage(const FVector& From, int32 NodeIndex)
{
	AAetherBrainActor* B = Brain.Get();
	if (!State || !B)
	{
		return false;
	}
	FAetherVoyageState& S = *State;
	// A note flies to its folder, a folder to itself.
	int32 Node = NodeIndex;
	for (int32 Guard = 0; Guard < 64; ++Guard)
	{
		const FAetherNode* N = B->GetNode(Node);
		if (!N)
		{
			return false;
		}
		if (VoyIsFolder(N->Kind))
		{
			break;
		}
		if (N->Parent == INDEX_NONE)
		{
			return false;
		}
		Node = N->Parent;
	}
	const FAetherNode* Target = B->GetNode(Node);
	if (!Target || !VoyIsFolder(Target->Kind))
	{
		return false;
	}
	const FVector To = B->NodeTarget(Node);
	if (FVector::Dist(From, To) < 1800.0)
	{
		return false; // already there
	}
	if (!S.Player.Comp)
	{
		return false;
	}
	Vy::Setup Cfg;
	Cfg.From = VoyFromFVector(From);
	Cfg.To = VoyFromFVector(To);
	Cfg.Seed = static_cast<uint32_t>(Seed) + static_cast<uint32_t>(Node) * 31U + static_cast<uint32_t>(Clock * 7.0);
	Cfg.CardWidth = std::max(static_cast<double>(CardWidthCm), static_cast<double>(B->NodeRadius(Node)) * 14.0);
	Cfg.ShipRadius = static_cast<double>(ShipLengthCm) * 0.5;
	Cfg.Flight.Cruise = static_cast<double>(CruiseSpeed);
	Cfg.Flight.Accel = Cfg.Flight.Cruise * 0.28;
	Cfg.Flight.Brake = Cfg.Flight.Cruise * 0.53;
	Cfg.Flight.MaxOffset = Cfg.ShipRadius * 3.4;
	Cfg.Flight.Steer = Cfg.Flight.Cruise * 0.34;
	const double Density = std::max(0.0, static_cast<double>(AsteroidDensity));
	Cfg.Rocks.MaxRocks = static_cast<int32>(std::lround(140.0 * Density));
	Cfg.Rocks.Spacing = 2800.0 / std::max(0.2, Density);
	Cfg.Rocks.MinRadius = static_cast<double>(ShipLengthCm) * 0.12;
	Cfg.Rocks.MaxRadius = static_cast<double>(ShipLengthCm) * 1.0;
	Cfg.Rocks.GroupRadius = static_cast<double>(ShipLengthCm) * 2.9;
	Cfg.Rocks.ClearStart = static_cast<double>(ShipLengthCm) * 3.0;
	Cfg.Rocks.ClearEnd = Cfg.CardWidth * 1.8;
	S.Voyage.Begin(Cfg);
	S.VoyageNode = Node;
	S.VoyageTitle = Target->Title;
	S.CardWidthUsed = Cfg.CardWidth;
	S.Blasts.Reset();
	S.Debris.Reset();
	S.Muzzles.Reset();

	// The ship: built the first time (its metal must be ready; if not, it flies as a dark shape until the next voyage).
	if (!S.Player.bBuilt)
	{
		const Ms::Mesh Mesh = Sh::MakeShip(Sh::ShipClass::Interceptor, static_cast<uint32_t>(Seed) + 7U);
		const double Cm = static_cast<double>(ShipLengthCm) / Sh::ShipLength(Sh::ShipClass::Interceptor);
		UMaterialInterface* Hull = S.HullMid[0] ? static_cast<UMaterialInterface*>(S.HullMid[0]) : (S.Lit ? S.Lit : S.Glow);
		UMaterialInterface* Glass = S.GlassMid ? static_cast<UMaterialInterface*>(S.GlassMid) : Hull;
		UMaterialInterface* Light = S.LightMid ? static_cast<UMaterialInterface*>(S.LightMid) : Hull;
		UMaterialInterface* Mats[3] = {Hull, Glass, Light};
		for (int32 Z = 0; Z < Ms::kZones; ++Z)
		{
			FAetherVoyageMesh Arr;
			VoyToArrays(Mesh.Z[static_cast<size_t>(Z)], Cm, Z == 2 ? VoyLightMax : 0.0, Arr);
			if (Arr.Idx.Num() > 0)
			{
				S.Player.Comp->CreateMeshSection_LinearColor(Z, Arr.Pos, Arr.Idx, Arr.Nrm, Arr.Uv, Arr.Col, Arr.Tan, false);
				S.Player.Comp->SetMaterial(Z, Mats[Z]);
			}
		}
		S.Player.bBuilt = true;
	}
	S.Player.Comp->SetVisibility(true);
	return true;
}

void AAetherVoyageActor::EndVoyage()
{
	if (!State)
	{
		return;
	}
	FAetherVoyageState& S = *State;
	S.Voyage.End();
	S.VoyageNode = INDEX_NONE;
	if (S.Player.Comp)
	{
		S.Player.Comp->SetVisibility(false);
	}
	for (TPair<int32, FAetherVoyageState::FRockVisual>& Pair : S.RockVisuals)
	{
		if (Pair.Value.Comp)
		{
			Pair.Value.Comp->SetVisibility(false);
			S.FreeRocks.Add(Pair.Value.Comp);
		}
	}
	S.RockVisuals.Empty();
	S.Blasts.Reset();
	S.Debris.Reset();
	S.Muzzles.Reset();
}

void AAetherVoyageActor::StepVoyage(float DeltaSeconds, const FAetherVoyageInput& Input)
{
	if (!State || !State->Voyage.Active())
	{
		return;
	}
	FAetherVoyageState& S = *State;
	Vy::Input In;
	In.Right = static_cast<double>(Input.Right);
	In.Up = static_cast<double>(Input.Up);
	In.Throttle = static_cast<double>(Input.Throttle);
	In.bFire = Input.bFire;
	In.bHasAim = Input.bHasAim;
	In.AimDir = Sp::Normalized(VoyFromFVector(Input.AimDirection), Sp::Vec3{1.0, 0.0, 0.0});
	S.Voyage.Tick(static_cast<double>(DeltaSeconds), In);
	// What happened: the visuals of it start now.
	for (const Cb::Event& E : S.Voyage.TakeEvents())
	{
		switch (E.Kind)
		{
		case Cb::EventKind::Fired:
			S.Muzzles.Add({E.At, Clock});
			break;
		case Cb::EventKind::Hit:
			S.Blasts.Add({E.At, std::max(E.Size * 3.0, 40.0), Clock, false});
			break;
		case Cb::EventKind::Break:
		case Cb::EventKind::Vaporize:
		{
			S.Blasts.Add({E.At, E.Size * 1.6, Clock, false});
			const int32 Count = static_cast<int32>(FMath::Clamp(E.Size / 9.0, 6.0, 48.0));
			for (const Cb::Fragment& F : Cb::MakeDebris(E, S.BlastSerial++, Count))
			{
				S.Debris.Add({F, Clock, E.RockKind, S.BlastSerial});
			}
			break;
		}
		case Cb::EventKind::ShipHit:
			S.Blasts.Add({E.At, E.Size * 1.1, Clock, true});
			break;
		}
	}
	// Bounded: the oldest go first.
	while (S.Blasts.Num() > VoyBlastCapacity)
	{
		S.Blasts.RemoveAt(0);
	}
	while (S.Debris.Num() > VoyFragmentCapacity)
	{
		S.Debris.RemoveAt(0);
	}
}

bool AAetherVoyageActor::GetCamera(FVector& OutLocation, FRotator& OutRotation, float& OutFovDegrees) const
{
	if (!State || !State->Voyage.Active())
	{
		return false;
	}
	const Vy::ChaseCamera& C = State->Voyage.Camera();
	OutLocation = VoyToFVector(C.Pos);
	OutRotation = FRotationMatrix::MakeFromXZ(VoyToFVector(C.Fwd), VoyToFVector(C.Up)).Rotator();
	OutFovDegrees = static_cast<float>(C.FovDeg);
	return true;
}

float AAetherVoyageActor::GetDistanceToGoMeters() const { return State && State->Voyage.Active() ? static_cast<float>(State->Voyage.DistanceToGo() / 100.0) : 0.f; }
float AAetherVoyageActor::GetProgress() const { return State && State->Voyage.Active() ? static_cast<float>(State->Voyage.Progress()) : 0.f; }
float AAetherVoyageActor::GetShieldFraction() const { return State && State->Voyage.Active() ? static_cast<float>(State->Voyage.Ship().Shield / std::max(1.0, State->Voyage.Ship().MaxShield)) : 0.f; }
float AAetherVoyageActor::GetHullFraction() const { return State && State->Voyage.Active() ? static_cast<float>(State->Voyage.Ship().Hull / 100.0) : 0.f; }
int32 AAetherVoyageActor::GetRocksBroken() const { return State ? State->Voyage.GetField().RocksDestroyed : 0; }
int32 AAetherVoyageActor::GetScore() const { return State ? State->Voyage.GetField().Score : 0; }

bool AAetherVoyageActor::GetAimPoint(FVector& OutPoint) const
{
	if (!State || !State->Voyage.Active())
	{
		return false;
	}
	OutPoint = VoyToFVector(State->Voyage.GetPilot().Pos + State->Voyage.AimDirection() * 12000.0);
	return true;
}

bool AAetherVoyageActor::GetTargetRock(FVector& OutLocation, float& OutRadiusCm) const
{
	if (!State || !State->Voyage.Active())
	{
		return false;
	}
	const int32 T = State->Voyage.Target();
	const std::vector<Cb::Rock>& Rocks = State->Voyage.GetField().Rocks;
	if (T < 0 || static_cast<size_t>(T) >= Rocks.size())
	{
		return false;
	}
	OutLocation = VoyToFVector(Rocks[static_cast<size_t>(T)].Pos);
	OutRadiusCm = static_cast<float>(Rocks[static_cast<size_t>(T)].Radius);
	return true;
}

FString AAetherVoyageActor::GetStatus() const
{
	if (!State)
	{
		return FString();
	}
	if (bMaterialsMissing)
	{
		return TEXT("Voyage materials missing: open the project in the Unreal Editor once (Python plugin on) to make them.");
	}
	return State->Making;
}

int32 AAetherVoyageActor::NumCardsShown() const { return State ? State->CardsShown : 0; }
int32 AAetherVoyageActor::NumCardsWithPictures() const { return State ? State->CardsPictured : 0; }

void AAetherVoyageActor::UpdateVoyageVisuals(double Time)
{
	FAetherVoyageState& S = *State;
	const bool bVoyaging = S.Voyage.Active();
	const FTransform Hidden(FQuat::Identity, FVector::ZeroVector, FVector::ZeroVector);
	if (!bVoyaging)
	{
		return;
	}
	const Cb::Field& Field = S.Voyage.GetField();
	const Cb::Pilot& Pl = S.Voyage.GetPilot();

	// The ship.
	if (S.Player.Comp)
	{
		// Roll about the nose.
		const Sp::Quat Roll = Sp::FromAxisAngle(Pl.Fwd, Pl.Roll);
		const Sp::Vec3 Right = Sp::Rotate(Roll, Pl.Right);
		const Sp::Vec3 Up = Sp::Rotate(Roll, Pl.Up);
		S.Player.Comp->SetWorldLocationAndRotation(VoyToFVector(Pl.Pos), VoyBasisQuat(Pl.Fwd, Right, Up));
		S.Player.Comp->SetWorldScale3D(FVector(1.0, 1.0, 1.0));
	}

	// The rocks near enough to see: a visual for each, made a few a frame, the rest wait.
	TMap<int32, bool> Present;
	int32 Made = 0;
	for (const Cb::Rock& R : Field.Rocks)
	{
		const double Dist = Sp::Length(R.Pos - Pl.Pos);
		if (Dist > VoyRockVisualRange)
		{
			continue;
		}
		const int32 Id = static_cast<int32>(R.Id);
		Present.Add(Id, true);
		FAetherVoyageState::FRockVisual* V = S.RockVisuals.Find(Id);
		if (!V)
		{
			const int32 Kind = FMath::Clamp(R.Kind, 0, Rk::kRockKinds - 1);
			if (Made >= VoyRockVisualsPerFrame || !S.RockMid[Kind])
			{
				continue;
			}
			const int32 Detail = R.Radius < 180.0 ? 3 : (R.Radius < 420.0 ? 4 : 5);
			const int32 Shape = FMath::Clamp(R.Shape, 0, 11);
			const int32 Key = Shape * 8 + Detail;
			TSharedPtr<FAetherVoyageMesh>* Cached = S.RockMeshes.Find(Key);
			if (!Cached)
			{
				Rk::RockSpec Spec;
				Spec.Seed = static_cast<uint32_t>(Seed) * 31U + static_cast<uint32_t>(Shape) * 977U + 3U;
				Spec.Detail = Detail;
				Spec.Roughness = 0.8 + 0.15 * static_cast<double>(Shape % 5);
				Spec.Elongation = 1.1 + 0.12 * static_cast<double>(Shape % 7);
				Spec.Craters = 5 + Shape % 5;
				const Ms::Section Section = Rk::MakeAsteroid(Spec);
				TSharedPtr<FAetherVoyageMesh> Arr = MakeShared<FAetherVoyageMesh>();
				VoyToArrays(Section, 1.0, 0.0, *Arr);
				Cached = &S.RockMeshes.Add(Key, Arr);
			}
			UProceduralMeshComponent* Comp = nullptr;
			if (S.FreeRocks.Num() > 0)
			{
				Comp = S.FreeRocks.Pop();
				Comp->ClearAllMeshSections();
			}
			else
			{
				Comp = VoyNewProcMesh(this, Root);
				Held.Add(Comp);
			}
			const FAetherVoyageMesh& A = **Cached;
			Comp->CreateMeshSection_LinearColor(0, A.Pos, A.Idx, A.Nrm, A.Uv, A.Col, A.Tan, false);
			Comp->SetMaterial(0, S.RockMid[Kind]);
			Comp->SetVisibility(true);
			FAetherVoyageState::FRockVisual NewVisual;
			NewVisual.Comp = Comp;
			NewVisual.Kind = Kind;
			NewVisual.bLive = true;
			V = &S.RockVisuals.Add(Id, NewVisual);
			++Made;
		}
		V->Comp->SetWorldLocationAndRotation(VoyToFVector(R.Pos), VoyToFQuat(R.Rot));
		V->Comp->SetWorldScale3D(FVector(R.Radius));
	}
	// Rocks that are gone (broken, or left behind): their components go back to the pool.
	TArray<int32> Gone;
	for (const TPair<int32, FAetherVoyageState::FRockVisual>& Pair : S.RockVisuals)
	{
		if (!Present.Find(Pair.Key))
		{
			Gone.Add(Pair.Key);
		}
	}
	for (const int32 Id : Gone)
	{
		FAetherVoyageState::FRockVisual* V = S.RockVisuals.Find(Id);
		if (V && V->Comp)
		{
			V->Comp->SetVisibility(false);
			S.FreeRocks.Add(V->Comp);
		}
		S.RockVisuals.Remove(Id);
	}

	// Bolts: a thin glowing cylinder along each shot's flight.
	if (S.Bolts)
	{
		TArray<FTransform> Xf;
		Xf.SetNum(VoyBoltCapacity);
		for (int32 I = 0; I < VoyBoltCapacity; ++I)
		{
			Xf[I] = Hidden;
		}
		int32 I = 0;
		for (const Cb::Shot& Bolt : Field.Shots)
		{
			if (I >= VoyBoltCapacity)
			{
				break;
			}
			const Sp::Vec3 Dir = Sp::Normalized(Bolt.Vel, Sp::Vec3{1.0, 0.0, 0.0});
			const double Length = 700.0;
			// The cylinder's axis is Z; its middle is half a bolt behind the head.
			Xf[I] = FTransform(VoyToFQuat(Sp::FromZTo(Dir)), VoyToFVector(Bolt.Pos - Dir * (Length * 0.5)), FVector(Bolt.Radius * 2.0 / VoyEngineUnit, Bolt.Radius * 2.0 / VoyEngineUnit, Length / VoyEngineUnit));
			VoySetLook(S.Bolts, I, 1.0, 0.72, 0.28, 14.0);
			++I;
		}
		S.Bolts->BatchUpdateInstancesTransforms(0, Xf, false, true);
	}

	// Rubble: rock thrown out of a break, drifting and tumbling, shrinking away.
	if (S.Rubble)
	{
		TArray<FTransform> Xf;
		Xf.SetNum(VoyFragmentCapacity);
		for (int32 I = 0; I < VoyFragmentCapacity; ++I)
		{
			Xf[I] = Hidden;
		}
		int32 I = 0;
		TArray<FAetherVoyageState::FDebris> Live;
		for (const FAetherVoyageState::FDebris& D : S.Debris)
		{
			const double T = Time - D.Start;
			if (T > D.F.Life)
			{
				continue;
			}
			Live.Add(D);
			if (I >= VoyFragmentCapacity)
			{
				continue;
			}
			const double Scale = Cb::FragmentScale(D.F, T) * D.F.Size * 2.0 / VoyEngineUnit;
			const Sp::Vec3 Axis = Sp::Normalized(Sp::Vec3{std::sin(static_cast<double>(D.Seed) * 1.7), std::cos(static_cast<double>(D.Seed) * 2.3), 0.6});
			Xf[I] = FTransform(VoyToFQuat(Sp::FromAxisAngle(Axis, D.F.Spin * T)), VoyToFVector(Cb::FragmentAt(D.F, T)), FVector(Scale));
			const Rk::RockKind Kind = static_cast<Rk::RockKind>(FMath::Clamp(D.Kind, 0, Rk::kRockKinds - 1));
			const Ms::Rgb Tint = Rk::RockTint(Kind);
			VoySetLook(S.Rubble, I, Tint.R * 1.6, Tint.G * 1.6, Tint.B * 1.6, Kind == Rk::RockKind::Iron ? 0.4 : 0.0);
			++I;
		}
		S.Debris = Live;
		S.Rubble->BatchUpdateInstancesTransforms(0, Xf, false, true);
	}

	// Fire: a fireball and a flash for each blast, a flash for each muzzle.
	if (S.Fire)
	{
		const int32 Total = VoyBlastCapacity * 2 + 16;
		TArray<FTransform> Xf;
		Xf.SetNum(Total);
		for (int32 I = 0; I < Total; ++I)
		{
			Xf[I] = Hidden;
		}
		int32 I = 0;
		TArray<FAetherVoyageState::FBlast> Live;
		for (const FAetherVoyageState::FBlast& B : S.Blasts)
		{
			const double T = Time - B.Start;
			const Cb::Blast Look = Cb::BlastAt(T, VoyBlastSeconds);
			if (T > VoyBlastSeconds)
			{
				continue;
			}
			Live.Add(B);
			if (I + 1 >= VoyBlastCapacity * 2)
			{
				continue;
			}
			const double Fire = B.Size * (0.35 + 0.9 * Look.Ring) * (0.2 + Look.Fire);
			Xf[I] = FTransform(FQuat::Identity, VoyToFVector(B.At), FVector(Fire * 2.0 / VoyEngineUnit));
			if (B.bShield)
			{
				VoySetLook(S.Fire, I, 0.25, 0.55, 1.0, 6.0 * Look.Fire + 10.0 * Look.Flash);
			}
			else
			{
				VoySetLook(S.Fire, I, 1.0, 0.42 + 0.3 * Look.Flash, 0.1 + 0.4 * Look.Flash, 9.0 * Look.Fire + 22.0 * Look.Flash);
			}
			++I;
			Xf[I] = FTransform(FQuat::Identity, VoyToFVector(B.At), FVector(B.Size * 0.9 * (0.4 + Look.Flash) * 2.0 / VoyEngineUnit * (Look.Flash > 0.02 ? 1.0 : 0.0)));
			VoySetLook(S.Fire, I, 1.0, 0.96, 0.85, 40.0 * Look.Flash);
			++I;
		}
		S.Blasts = Live;
		// Muzzle flashes live a twentieth of a second.
		TArray<FAetherVoyageState::FMuzzleFlash> LiveMuzzles;
		int32 M = VoyBlastCapacity * 2;
		for (const FAetherVoyageState::FMuzzleFlash& Mz : S.Muzzles)
		{
			const double T = Time - Mz.Start;
			if (T > 0.06 || M >= Total)
			{
				continue;
			}
			LiveMuzzles.Add(Mz);
			Xf[M] = FTransform(FQuat::Identity, VoyToFVector(Mz.At), FVector(34.0 * (1.0 - T / 0.06) / VoyEngineUnit * 2.0));
			VoySetLook(S.Fire, M, 1.0, 0.8, 0.45, 30.0);
			++M;
		}
		S.Muzzles = LiveMuzzles;
		S.Fire->BatchUpdateInstancesTransforms(0, Xf, false, true);
	}
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Folder cards                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

namespace
{
	/** A flat card of `HalfW` x `HalfH` facing -X (its local X points away from whoever looks at it), upright, with the picture on it. */
	void VoyMakeCardQuad(UProceduralMeshComponent* Comp, double HalfW, double HalfH)
	{
		TArray<FVector> V;
		TArray<FVector> N;
		TArray<FVector2D> Uv;
		TArray<FLinearColor> C;
		TArray<FProcMeshTangent> T;
		TArray<int32> I;
		// Bottom-left, top-left, top-right, bottom-right as the viewer (at -X, right = +Y, up = +Z) sees them: clockwise, so it faces the viewer.
		V.Add(FVector(0.0, -HalfW, -HalfH));
		V.Add(FVector(0.0, -HalfW, HalfH));
		V.Add(FVector(0.0, HalfW, HalfH));
		V.Add(FVector(0.0, HalfW, -HalfH));
		Uv.Add(FVector2D(0.0, 1.0));
		Uv.Add(FVector2D(0.0, 0.0));
		Uv.Add(FVector2D(1.0, 0.0));
		Uv.Add(FVector2D(1.0, 1.0));
		for (int32 K = 0; K < 4; ++K)
		{
			N.Add(FVector(-1.0, 0.0, 0.0));
			C.Add(FLinearColor(1.f, 1.f, 1.f, 1.f));
			T.Add(FProcMeshTangent(FVector(0.0, 1.0, 0.0), false));
		}
		I.Add(0);
		I.Add(1);
		I.Add(2);
		I.Add(0);
		I.Add(2);
		I.Add(3);
		Comp->ClearAllMeshSections();
		Comp->CreateMeshSection_LinearColor(0, V, I, N, Uv, C, T, false);
	}
}

void AAetherVoyageActor::UpdateCards(const FVector& Camera, double Time)
{
	FAetherVoyageState& S = *State;
	AAetherBrainActor* B = Brain.Get();
	if (!B || !bFolderCards || bMaterialsMissing)
	{
		return;
	}
	UMaterialInterface* Parent = CardMaterial.LoadSynchronous();
	if (!Parent)
	{
		return;
	}
	// Who gets a card: the nearest folders that have pictures, within range; worked out a few times a second.
	if (Time >= S.NextCardUpdate && B->HasPositions())
	{
		S.NextCardUpdate = Time + 0.25;
		struct FCandidate
		{
			int32 Node;
			double Dist;
		};
		TArray<FCandidate> Near;
		for (int32 I = 0; I < B->NumNodes(); ++I)
		{
			const FAetherNode* N = B->GetNode(I);
			if (!N || !VoyIsFolder(N->Kind) || N->Pictures <= 0)
			{
				continue;
			}
			const double D = static_cast<double>(FVector::Dist(Camera, B->NodeLocation(I)));
			if (D <= static_cast<double>(CardRange))
			{
				Near.Add({I, D});
			}
		}
		Near.Sort([](const FCandidate& A, const FCandidate& C) { return A.Dist < C.Dist; });
		const int32 Keep = FMath::Min(Near.Num(), FMath::Max(1, MaxCards));
		for (FAetherVoyageState::FCard& C : S.Cards)
		{
			C.bShown = false;
		}
		for (int32 K = 0; K < Keep; ++K)
		{
			const FAetherNode* N = B->GetNode(Near[K].Node);
			FAetherVoyageState::FCard* Card = S.FindCard(N->Id);
			if (!Card)
			{
				FAetherVoyageState::FCard Fresh;
				Fresh.Id = N->Id;
				S.Cards.Add(Fresh);
				Card = &S.Cards.Last();
			}
			Card->Node = Near[K].Node;
			Card->bShown = true;
			Card->LastUsed = Time;
		}
		// Cards no longer wanted let go of their pictures (video memory) and hide.
		for (FAetherVoyageState::FCard& C : S.Cards)
		{
			if (!C.bShown && C.Tex)
			{
				Held.Remove(C.Tex);
				C.Tex = nullptr;
				C.bRequested = false;
				C.bFailed = false;
				if (C.Mid)
				{
					Held.Remove(C.Mid);
					C.Mid = nullptr;
				}
			}
			if (!C.bShown && C.Comp)
			{
				C.Comp->SetVisibility(false);
			}
		}
		// Ask for pictures (a few at a time), nearest first.
		int32 InFlight = S.Pending.Num();
		for (int32 K = 0; K < Keep && InFlight < VoyMaxCardRequestsAtOnce; ++K)
		{
			const FAetherNode* N = B->GetNode(Near[K].Node);
			FAetherVoyageState::FCard* Card = S.FindCard(N->Id);
			if (!Card || Card->Tex || Card->bRequested || (Card->bFailed && Time < Card->RetryAt))
			{
				continue;
			}
			const FString Path = FString::Printf(TEXT("/v1/thumb?id=%s&size=%d"), *FGenericPlatformHttp::UrlEncode(N->Id), FMath::Clamp(CardPixels, 64, 1024));
			TSharedPtr<IHttpRequest, ESPMode::ThreadSafe> Request = B->MakeLinkRequest(Path);
			if (!Request.IsValid())
			{
				break; // no link yet
			}
			Request->OnProcessRequestComplete().BindUObject(this, &AAetherVoyageActor::OnCardPicture);
			FAetherVoyageState::FPendingCard Pend;
			Pend.Request = Request;
			Pend.Id = N->Id;
			S.Pending.Add(Pend);
			Card->bRequested = true;
			Request->ProcessRequest();
			++InFlight;
		}
	}

	// Place the cards that are shown: in front of the folder, facing the camera, upright.
	S.CardsShown = 0;
	S.CardsPictured = 0;
	for (FAetherVoyageState::FCard& C : S.Cards)
	{
		if (!C.bShown)
		{
			continue;
		}
		const FAetherNode* N = B->GetNode(C.Node);
		if (!N || N->Id != C.Id)
		{
			C.bShown = false;
			continue;
		}
		++S.CardsShown;
		if (!C.Tex)
		{
			if (C.Comp)
			{
				C.Comp->SetVisibility(false);
			}
			continue;
		}
		++S.CardsPictured;
		if (!C.Comp)
		{
			C.Comp = VoyNewProcMesh(this, Root);
			C.Comp->SetCastShadow(false);
			Held.Add(C.Comp);
		}
		if (!C.Mid)
		{
			C.Mid = UMaterialInstanceDynamic::Create(Parent, this);
			C.Mid->SetTextureParameterValue(TEXT("Tex"), C.Tex);
			Held.Add(C.Mid);
			C.Comp->SetMaterial(0, C.Mid);
		}
		const double Width = std::max(static_cast<double>(CardWidthCm), static_cast<double>(B->NodeRadius(C.Node)) * 14.0);
		const double Aspect = C.PicW > 0 && C.PicH > 0 ? static_cast<double>(C.PicH) / static_cast<double>(C.PicW) : 1.0;
		// The longer side is `Width`.
		const double HalfW = (Aspect <= 1.0 ? Width : Width / Aspect) * 0.5;
		const double HalfH = (Aspect <= 1.0 ? Width * Aspect : Width) * 0.5;
		if (!C.Comp->IsVisible() || std::fabs(C.HalfW - HalfW) > 0.5 || std::fabs(C.HalfH - HalfH) > 0.5)
		{
			VoyMakeCardQuad(C.Comp, HalfW, HalfH);
		}
		const FVector Node = B->NodeLocation(C.Node);
		const Sp::Vec3 ToCam = Sp::Normalized(VoyFromFVector(Camera - Node), Sp::Vec3{-1.0, 0.0, 0.0});
		// The card looks the way the camera does: its X away from the viewer.
		const Sp::Vec3 Fwd = ToCam * -1.0;
		const Sp::Vec3 Right = Sp::Normalized(Sp::Cross(Sp::kUp, Fwd), Sp::Vec3{0.0, 1.0, 0.0});
		const Sp::Vec3 Up = Sp::Cross(Fwd, Right);
		// In front of the folder's sphere, so it hides nothing of the card.
		const Sp::Vec3 Center = VoyFromFVector(Node) + ToCam * (static_cast<double>(B->NodeRadius(C.Node)) * 1.6 + 8.0);
		C.Comp->SetWorldLocationAndRotation(VoyToFVector(Center), VoyBasisQuat(Fwd, Right, Up));
		C.Comp->SetWorldScale3D(FVector(1.0, 1.0, 1.0));
		C.Comp->SetVisibility(true);
		C.Center = Center;
		C.Right = Right;
		C.Up = Up;
		C.HalfW = HalfW;
		C.HalfH = HalfH;
	}
}

void AAetherVoyageActor::OnCardPicture(FHttpRequestPtr Request, FHttpResponsePtr Response, bool bConnectedSuccessfully)
{
	if (!State)
	{
		return;
	}
	FAetherVoyageState& S = *State;
	FString Id;
	for (int32 I = 0; I < S.Pending.Num(); ++I)
	{
		if (S.Pending[I].Request.Get() == Request.Get())
		{
			Id = S.Pending[I].Id;
			S.Pending.RemoveAt(I);
			break;
		}
	}
	FAetherVoyageState::FCard* Card = S.FindCard(Id);
	if (!Card)
	{
		return; // the card went away while the picture was on its way
	}
	Card->bRequested = false;
	const auto Fail = [&]() {
		Card->bFailed = true;
		Card->RetryAt = Clock + VoyCardRetrySeconds;
	};
	if (!bConnectedSuccessfully || !Response.IsValid() || Response->GetResponseCode() != 200)
	{
		Fail();
		return;
	}
	const TArray<uint8>& Bytes = Response->GetContent();
	if (Bytes.Num() < 16 || Bytes.Num() > 24 * 1024 * 1024)
	{
		Fail();
		return;
	}
	IImageWrapperModule& Wrappers = FModuleManager::LoadModuleChecked<IImageWrapperModule>(FName(TEXT("ImageWrapper")));
	TSharedPtr<IImageWrapper> Png = Wrappers.CreateImageWrapper(EImageFormat::PNG);
	TArray64<uint8> Raw;
	if (!Png.IsValid() || !Png->SetCompressed(Bytes.GetData(), Bytes.Num()) || !Png->GetRaw(ERGBFormat::BGRA, 8, Raw) || Png->GetWidth() < 1 || Png->GetHeight() < 1 ||
		Png->GetWidth() > 4096 || Png->GetHeight() > 4096 || Raw.Num() < static_cast<int64>(Png->GetWidth()) * Png->GetHeight() * 4)
	{
		Fail();
		return;
	}
	Sp::Image Img(Png->GetWidth(), Png->GetHeight());
	FMemory::Memcpy(Img.Bgra.data(), Raw.GetData(), Img.Bgra.size());
	UTexture2D* Tex = VoyMakeTexture(Img, true, false);
	if (!Tex)
	{
		Fail();
		return;
	}
	Held.Add(Tex);
	Card->Tex = Tex;
	Card->PicW = Img.Width;
	Card->PicH = Img.Height;
	Card->bFailed = false;
	// A card that already had a material gets the new picture.
	if (Card->Mid)
	{
		Card->Mid->SetTextureParameterValue(TEXT("Tex"), Tex);
	}
}

int32 AAetherVoyageActor::PickCard(const FVector& Origin, const FVector& Direction) const
{
	if (!State)
	{
		return INDEX_NONE;
	}
	const Sp::Vec3 O = VoyFromFVector(Origin);
	const Sp::Vec3 D = Sp::Normalized(VoyFromFVector(Direction), Sp::Vec3{1.0, 0.0, 0.0});
	double Best = 1e300;
	int32 Node = INDEX_NONE;
	for (const FAetherVoyageState::FCard& C : State->Cards)
	{
		if (!C.bShown || !C.Tex || C.HalfW <= 0.0)
		{
			continue;
		}
		const Sp::Vec3 Normal = Sp::Cross(C.Right, C.Up) * -1.0;
		const double Denom = Sp::Dot(D, Normal);
		if (std::fabs(Denom) < 1e-6)
		{
			continue;
		}
		const double T = Sp::Dot(C.Center - O, Normal) / Denom;
		if (T <= 0.0 || T >= Best)
		{
			continue;
		}
		const Sp::Vec3 Hit = O + D * T - C.Center;
		if (std::fabs(Sp::Dot(Hit, C.Right)) <= C.HalfW && std::fabs(Sp::Dot(Hit, C.Up)) <= C.HalfH)
		{
			Best = T;
			Node = C.Node;
		}
	}
	return Node;
}
