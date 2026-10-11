// The real AetherVoyageActor.cpp (with the real AetherBrainActor.cpp and AetherScene.cpp it works with) compiled unchanged against the
// engine stand-in (brain_stubs/FakeUE.h) and run: the background jobs that make the sky, suns, metal and rock; the textures they become;
// the suns, the traffic, the voyage (ship, rocks, bolts, rubble, fire), the folder cards and their pictures over HTTP. The stand-in is
// shaped after Unreal 5's signatures (procedural meshes check their arrays, one type for FMath::Clamp ...); it is not Unreal. It proves
// the logic and the bookkeeping, not the engine. Run with unreal/tests/run.sh.
#include "FakeUE.h"

#include <chrono>
#include <cstdio>
#include <thread>

#define private public
#define protected public
#include "AetherBrainActor.h"
#include "AetherBrainActor.cpp"
#include "AetherScene.cpp"
#include "AetherSpaceActor.h"
#include "AetherVoyageActor.h"
#include "AetherVoyageActor.cpp"
#undef private
#undef protected

// The space actor is not under test: just enough of it to be found and told to step aside.
AAetherSpaceActor::AAetherSpaceActor() {}
void AAetherSpaceActor::BeginPlay() {}
void AAetherSpaceActor::Tick(float) {}
void AAetherSpaceActor::SetBackdropVisible(bool bVisible) { bBackdropHidden = !bVisible; }

static int Failures = 0;
static int Checks = 0;
#define CHECK(Cond)                                                                    \
	do                                                                                 \
	{                                                                                  \
		++Checks;                                                                      \
		if (!(Cond))                                                                   \
		{                                                                              \
			++Failures;                                                                \
			std::printf("FAIL line %d: %s\n", __LINE__, #Cond);                        \
		}                                                                              \
	} while (0)
#define CHECK_EQ(A, B)                                                                 \
	do                                                                                 \
	{                                                                                  \
		++Checks;                                                                      \
		const auto A_ = (A);                                                           \
		const auto B_ = (B);                                                           \
		if (!(A_ == B_))                                                               \
		{                                                                              \
			++Failures;                                                                \
			std::printf("FAIL line %d: %s == %s  (%lld vs %lld)\n", __LINE__, #A, #B, static_cast<long long>(A_), static_cast<long long>(B_)); \
		}                                                                              \
	} while (0)
#define CHECK_NEAR(A, B, Eps)                                                                      \
	do                                                                                             \
	{                                                                                              \
		++Checks;                                                                                  \
		const double A_ = static_cast<double>(A);                                                  \
		const double B_ = static_cast<double>(B);                                                  \
		if (!(std::fabs(A_ - B_) <= (Eps)))                                                        \
		{                                                                                          \
			++Failures;                                                                            \
			std::printf("FAIL line %d: %s = %g, expected %g\n", __LINE__, #A, A_, B_);             \
		}                                                                                          \
	} while (0)

/** A world with a brain that has a scene: a yellow drive, a blue drive, a project, three folders with pictures, one without, a note. */
struct Rig
{
	UWorld World;
	APlayerController Pc;
	APlayerCameraManager Cam;
	AAetherBrainActor* Brain = nullptr;
	AAetherSpaceActor* Space = nullptr;
	AAetherVoyageActor* Voyage = nullptr;

	explicit Rig(bool bMaterials = true, int TrafficShips = 3)
	{
		Pc.PlayerCameraManager = &Cam;
		World.Player = &Pc;
		Brain = new AAetherBrainActor();
		Brain->WorldPtr = &World;
		Brain->BeginPlay();
		Brain->Conn.Url = FString("http://127.0.0.1:7459");
		Brain->Conn.Token = FString("tok");
		FAetherGraph G;
		G.Version = 1;
		G.Vault = FString("V");
		struct FRow
		{
			const char* Id;
			EAetherKind Kind;
			float Radius;
			float Cr;
			float Cg;
			float Cb;
			int32 Parent;
			int32 Pictures;
			const char* Cover;
		};
		const FRow Nodes[] = {
			{"folder:", EAetherKind::Sun, 8.f, 1.0f, 0.9f, 0.6f, -1, 0, ""},
			{"folder:Blue", EAetherKind::Sun, 7.f, 0.5f, 0.7f, 1.0f, -1, 0, ""},
			{"folder:Proj", EAetherKind::Star, 5.f, 1.f, 0.8f, 0.4f, 0, 2, ""},
			{"folder:Proj/Art", EAetherKind::Planet, 3.f, 0.9f, 0.5f, 0.5f, 2, 40, "image:Proj/Art/gate.png"},
			{"folder:Proj/Notes", EAetherKind::Planet, 3.f, 0.5f, 0.9f, 0.5f, 2, 0, ""},
			{"folder:Misc", EAetherKind::Planet, 3.f, 0.5f, 0.5f, 0.9f, 0, 6, ""},
			{"folder:Misc/Deep", EAetherKind::Planet, 3.f, 0.6f, 0.6f, 0.9f, 5, 9, ""},
			{"Proj/Notes/Plan", EAetherKind::Moon, 1.f, 1.f, 1.f, 1.f, 4, 0, ""},
		};
		for (const FRow& N : Nodes)
		{
			FAetherNode Node;
			Node.Id = FString(N.Id);
			Node.Title = FString(N.Id);
			Node.Kind = N.Kind;
			Node.Radius = N.Radius;
			Node.Color = FLinearColor(N.Cr, N.Cg, N.Cb, 1.f);
			Node.Parent = N.Parent;
			Node.Pictures = N.Pictures;
			Node.Cover = FString(N.Cover);
			G.Nodes.Add(Node);
		}
		Brain->ApplyGraph(MoveTemp(G));
		FAetherPositions P;
		P.Version = 1;
		const double Where[8][3] = {{0, 0, 0}, {-420, 80, 40}, {60, 40, 0}, {90, 50, 10}, {70, -40, 20}, {-80, 30, 0}, {-100, 20, 10}, {75, -45, 25}};
		for (const auto& W : Where)
		{
			P.Points.Add(FVector(W[0], W[1], W[2]));
		}
		Brain->ApplyPositions(MoveTemp(P));
		// Placed: no easing left to wait for.
		for (int32 I = 0; I < Brain->NumNodes(); ++I)
		{
			Brain->Current[I] = Brain->Target[I];
		}
		Space = new AAetherSpaceActor();
		Space->WorldPtr = &World;
		Voyage = new AAetherVoyageActor();
		Voyage->WorldPtr = &World;
		Voyage->SkyWidth = 512;
		Voyage->SunWidth = 512;
		Voyage->MapSize = 256;
		Voyage->TrafficShips = TrafficShips;
		Voyage->MaxCards = 3;
		if (bMaterials)
		{
			for (TSoftObjectPtr<UMaterialInterface>* M : {&Voyage->SkyMaterial, &Voyage->SunMaterial, &Voyage->CoronaMaterial, &Voyage->HullMaterial, &Voyage->GlassMaterial, &Voyage->LightMaterial, &Voyage->RockPbrMaterial, &Voyage->CardMaterial})
			{
				M->Loaded = new UMaterialInterface();
			}
		}
		World.Actors = {Brain, Space, Voyage};
		Voyage->BeginPlay();
	}

	void Tick(float Dt = 0.016f) { Voyage->Tick(Dt); }

	/** Tick until `Done` or a timeout (the jobs run on real threads). */
	template <class F>
	bool TickUntil(F Done, int Millis = 90000)
	{
		const auto Start = std::chrono::steady_clock::now();
		while (!Done())
		{
			Tick();
			if (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - Start).count() > Millis)
			{
				return false;
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(2));
		}
		return true;
	}

	bool AllBaked() const
	{
		const FAetherVoyageState& S = *Voyage->State;
		return S.bSkyMade && S.bSunMade[0] == S.bSunWanted[0] && S.bSunMade[1] == S.bSunWanted[1] && S.bSunMade[2] == S.bSunWanted[2] && S.bHullMade[0] && S.bHullMade[1] && S.bHullMade[2] &&
			S.bRockMade[0] && S.bRockMade[1] && S.bRockMade[2] && S.bRockMade[3] && S.Running == FAetherVoyageState::EJob::None;
	}

	int32 NodeIndex(const char* Id) const
	{
		for (int32 I = 0; I < Brain->NumNodes(); ++I)
		{
			if (Brain->GetNode(I)->Id == FString(Id))
			{
				return I;
			}
		}
		return INDEX_NONE;
	}
};

/** The stand-in PNG the stand-in decoder reads. */
static FHttpResponsePtr PngReply(int W, int H, int Code = 200)
{
	TSharedPtr<FHttpResponseFake> R = MakeShared<FHttpResponseFake>();
	R->Code = Code;
	if (Code == 200)
	{
		R->Bytes = {'F', 'P', 'N', 'G', static_cast<uint8>(W & 255), static_cast<uint8>(W >> 8), static_cast<uint8>(H & 255), static_cast<uint8>(H >> 8), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
	}
	return R;
}

/** Answers the oldest pending card request. Returns its URL. */
static std::string Answer(Rig& R, FHttpResponsePtr Reply, bool bConnected = true)
{
	FAetherVoyageState& S = *R.Voyage->State;
	if (S.Pending.Num() == 0)
	{
		return std::string();
	}
	FAetherVoyageState::FPendingCard P = S.Pending[0];
	const std::string Url = P.Request->Url.S;
	P.Request->Delegate.Fn(P.Request, Reply, bConnected);
	return Url;
}

static int ShownTriangles(const UProceduralMeshComponent* C)
{
	int N = 0;
	for (const auto& Pair : C->Sections)
	{
		N += Pair.second.Idx.Num() / 3;
	}
	return N;
}

/* ---------------------------------------------------------------------------------------------------------------- */

static void TestMissingMaterials()
{
	Rig R(false);
	CHECK(R.Voyage->bMaterialsMissing);
	CHECK(R.Voyage->GetStatus().S.find("materials missing") != std::string::npos);
	for (int I = 0; I < 30; ++I)
	{
		R.Tick();
	}
	CHECK(R.Voyage->State->Running == FAetherVoyageState::EJob::None);
	CHECK(R.Voyage->State->SkyBall == nullptr && !R.Voyage->IsSkyReady());
	CHECK(R.Voyage->State->Suns.Num() == 0);
	CHECK(!R.Space->bBackdropHidden); // the flat backdrop stays when there is no photo sky
	CHECK(!R.Voyage->IsVoyaging());
	CHECK(R.Voyage->NumCardsShown() == 0);
}

static void TestBakes()
{
	Rig R;
	CHECK(!R.Voyage->bMaterialsMissing);
	CHECK(R.Voyage->State->Bolts != nullptr && R.Voyage->State->Bolts->Instances.size() == VoyBoltCapacity);
	CHECK(R.Voyage->State->Rubble != nullptr && R.Voyage->State->Rubble->Instances.size() == VoyFragmentCapacity);
	CHECK(R.Voyage->State->Fire != nullptr && R.Voyage->State->Fire->Instances.size() == static_cast<size_t>(VoyBlastCapacity * 2 + 16));
	// The sky first.
	R.Tick();
	CHECK(R.Voyage->State->Running == FAetherVoyageState::EJob::Sky);
	CHECK(R.Voyage->GetStatus().S.find("sky") != std::string::npos);
	CHECK(R.TickUntil([&] { return R.Voyage->IsSkyReady(); }));
	FAetherVoyageState& S = *R.Voyage->State;
	CHECK(S.SkyBall != nullptr);
	CHECK(R.Space->bBackdropHidden);
	UMaterialInstanceDynamic* Sky = dynamic_cast<UMaterialInstanceDynamic*>(S.SkyBall->Material);
	CHECK(Sky != nullptr);
	UTexture2D* SkyTex = Sky ? dynamic_cast<UTexture2D*>(Sky->Textures["Sky"]) : nullptr;
	CHECK(SkyTex != nullptr);
	if (SkyTex)
	{
		CHECK_EQ(SkyTex->Width, 512);
		CHECK_EQ(SkyTex->Height, 256);
		CHECK(SkyTex->SRGB && SkyTex->Filter == TF_Trilinear && SkyTex->NeverStream);
		// 512 x 256 down to 1 x 1: ten pictures, each half the one before; the last is one pixel.
		CHECK_EQ(SkyTex->GetPlatformData()->Mips.Num(), 10);
		CHECK_EQ(SkyTex->GetPlatformData()->Mips[1].SizeX, 256);
		CHECK_EQ(SkyTex->GetPlatformData()->Mips[1].SizeY, 128);
		CHECK_EQ(SkyTex->GetPlatformData()->Mips[9].SizeX, 1);
		CHECK_EQ(SkyTex->GetPlatformData()->Mips[9].SizeY, 1);
		for (int32 M = 0; M < 10; ++M)
		{
			const FTexture2DMipMap& Mip = SkyTex->GetPlatformData()->Mips[M];
			CHECK_EQ(static_cast<int64>(Mip.BulkData.Data.size()), static_cast<int64>(Mip.SizeX) * Mip.SizeY * 4);
		}
		// It has stars in it (something bright) and is mostly dark.
		const std::vector<uint8>& D = SkyTex->GetPlatformData()->Mips[0].BulkData.Data;
		int Bright = 0;
		for (size_t I = 0; I + 3 < D.size(); I += 4)
		{
			Bright += D[I + 2] > 200 ? 1 : 0;
		}
		CHECK(Bright > 5 && Bright < static_cast<int>(D.size() / 4 / 10));
		CHECK(SkyTex->UpdateCount >= 1);
		CHECK(Sky->Scalars.count("Glow") == 1);
	}
	R.Tick();
	// The sky is a ball round the camera, scaled to be huge, and follows the camera.
	R.Cam.Location = FVector(1000.0, -2000.0, 300.0);
	R.Tick();
	CHECK_NEAR(S.SkyBall->WorldLocation.X, 1000.0, 1e-9);
	CHECK(S.SkyBall->WorldScale.X > 1e4);
	// Then the suns the brain has: a yellow one and a blue one (two classes), none for the red class.
	CHECK(R.TickUntil([&] { return R.AllBaked(); }));
	CHECK_EQ(S.Suns.Num(), 2);
	CHECK(S.bSunWanted[1] && S.bSunWanted[2] && !S.bSunWanted[0]);
	CHECK(S.bSunMade[1] && S.bSunMade[2] && !S.bSunMade[0]);
	R.Tick();
	R.Tick();
	for (FAetherVoyageState::FSun& Sun : S.Suns)
	{
		CHECK(Sun.Ball != nullptr && Sun.Corona != nullptr && Sun.CoronaMid != nullptr);
		CHECK(Sun.Class == (Sun.Node == 0 ? 1 : 2));
		const FVector Where = R.Brain->NodeLocation(Sun.Node);
		CHECK_NEAR(Sun.Ball->WorldLocation.X, Where.X, 1e-9);
		const double Radius = R.Brain->NodeRadius(Sun.Node) * 1.04;
		CHECK_NEAR(Sun.Ball->WorldScale.X, Radius * 2.0 / 100.0, 1e-6);
		UMaterialInstanceDynamic* Mid = dynamic_cast<UMaterialInstanceDynamic*>(Sun.Ball->Material);
		CHECK(Mid != nullptr && Mid->Textures.count("Sun") == 1 && Mid->Scalars["Gain"] == R.Voyage->SunGlow);
		// The corona's plane is 1 / 0.16 as wide as the sun.
		CHECK_NEAR(Sun.Corona->WorldScale.X, Radius * 2.0 / 0.16 / 100.0, 1e-6);
		CHECK(std::fabs(Sun.Corona->WorldRotation.W * Sun.Corona->WorldRotation.W + Sun.Corona->WorldRotation.X * Sun.Corona->WorldRotation.X + Sun.Corona->WorldRotation.Y * Sun.Corona->WorldRotation.Y + Sun.Corona->WorldRotation.Z * Sun.Corona->WorldRotation.Z - 1.0) < 1e-6);
	}
	// The sun maps are 512 wide here, with mips.
	CHECK(S.SunTex[1] != nullptr && S.SunTex[1]->Width == 512 && S.SunTex[1]->GetPlatformData()->Mips.Num() == 10);
	// The player's metal, the rock maps: textures with their own settings (linear for normals and the packed map; wrapped).
	CHECK(S.HullMid[0] && S.HullMid[1] && S.HullMid[2]);
	for (const char* Name : {"BaseColor", "Normal", "ORM"})
	{
		UTexture2D* T = dynamic_cast<UTexture2D*>(S.HullMid[0]->Textures[Name]);
		CHECK(T != nullptr);
		if (T)
		{
			CHECK_EQ(T->Width, 256);
			CHECK(T->AddressX == TA_Wrap);
			CHECK(T->SRGB == (std::string(Name) == "BaseColor"));
			CHECK_EQ(T->GetPlatformData()->Mips.Num(), 9);
		}
	}
	for (int K = 0; K < Rk::kRockKinds; ++K)
	{
		CHECK(S.RockMid[K] != nullptr && S.RockMid[K]->Textures.count("ORM") == 1);
	}
	CHECK(S.GlassMid != nullptr && S.LightMid != nullptr);
	CHECK_NEAR(S.LightMid->Scalars["Intensity"], 9.0, 1e-6);
	CHECK(R.Voyage->GetStatus().IsEmpty());
}

static void TestTraffic()
{
	Rig R(true, 3);
	CHECK(R.TickUntil([&] { return R.AllBaked(); }));
	for (int I = 0; I < 12; ++I)
	{
		R.Tick();
	}
	FAetherVoyageState& S = *R.Voyage->State;
	CHECK_EQ(S.Traffic.Num(), 3);
	CHECK(S.Traffic[0].Visual.Class == 1 && S.Traffic[1].Visual.Class == 2 && S.Traffic[2].Visual.Class == 0);
	FVector First[3];
	for (int I = 0; I < 3; ++I)
	{
		FAetherVoyageState::FTraffic& T = S.Traffic[I];
		CHECK(T.Visual.bBuilt && T.Visual.Comp != nullptr);
		if (!T.Visual.Comp)
		{
			continue;
		}
		CHECK_EQ(T.Visual.Comp->NumSections(), 3);
		CHECK(ShownTriangles(T.Visual.Comp) > 1000);
		// The hull wears the livery made for its class; glass and lights have their own materials.
		const int Livery = T.Visual.Class == 1 ? 1 : (T.Visual.Class == 2 ? 2 : 0);
		CHECK(T.Visual.Comp->Sections[0].Material == S.HullMid[Livery]);
		CHECK(T.Visual.Comp->Sections[1].Material == S.GlassMid);
		CHECK(T.Visual.Comp->Sections[2].Material == S.LightMid);
		// Light colours were turned into vertex colours in [0, 1].
		for (const FLinearColor& C : T.Visual.Comp->Sections[2].Col)
		{
			CHECK(C.R >= 0.f && C.R <= 1.f && C.G >= 0.f && C.G <= 1.f && C.B >= 0.f && C.B <= 1.f);
		}
		First[I] = T.Visual.Comp->WorldLocation;
		CHECK(T.Route.Length() > 1000.0);
	}
	// A freighter is far bigger than an interceptor.
	auto Span = [](const UProceduralMeshComponent* C) {
		double Lo = 1e30;
		double Hi = -1e30;
		for (const auto& Pair : C->Sections)
		{
			for (const FVector& V : Pair.second.Pos)
			{
				Lo = std::min(Lo, V.X);
				Hi = std::max(Hi, V.X);
			}
		}
		return Hi - Lo;
	};
	CHECK_NEAR(Span(S.Traffic[2].Visual.Comp), R.Voyage->ShipLengthCm, R.Voyage->ShipLengthCm * 0.1);
	CHECK(Span(S.Traffic[0].Visual.Comp) > Span(S.Traffic[2].Visual.Comp) * 5.0);
	CHECK(Span(S.Traffic[1].Visual.Comp) > Span(S.Traffic[0].Visual.Comp));
	// They move.
	for (int I = 0; I < 200; ++I)
	{
		R.Tick(0.05f);
	}
	for (int I = 0; I < 3; ++I)
	{
		const FVector Now = S.Traffic[I].Visual.Comp->WorldLocation;
		CHECK((Now - First[I]).Size() > 50.0);
	}
	// None when asked for none.
	Rig None(true, 0);
	CHECK(None.TickUntil([&] { return None.AllBaked(); }));
	for (int I = 0; I < 6; ++I)
	{
		None.Tick();
	}
	CHECK(None.Voyage->State->Traffic.Num() == 0);
}

static void TestVoyage()
{
	Rig R(true, 0);
	CHECK(R.TickUntil([&] { return R.AllBaked(); }));
	R.Tick();
	FAetherVoyageState& S = *R.Voyage->State;
	const int32 Art = R.NodeIndex("folder:Proj/Art");
	const int32 Note = R.NodeIndex("Proj/Notes/Plan");
	const int32 Deep = R.NodeIndex("folder:Misc/Deep");
	CHECK(Art != INDEX_NONE && Note != INDEX_NONE && Deep != INDEX_NONE);
	CHECK(!R.Voyage->IsVoyaging());
	// Nowhere to go: no such node, too close, no brain.
	CHECK(!R.Voyage->BeginVoyage(FVector(0, 0, 0), 99));
	CHECK(!R.Voyage->BeginVoyage(R.Brain->NodeTarget(Art), Art));
	CHECK(!R.Voyage->IsVoyaging());
	// A far start.
	const FVector Start = R.Brain->NodeTarget(Art) + FVector(-60000.0, 8000.0, 2000.0);
	R.Pc.PlayerCameraManager->Location = Start;
	CHECK(R.Voyage->BeginVoyage(Start, Note)); // a note flies to its folder (the notes folder is Proj/Notes: its parent)
	CHECK(R.Voyage->IsVoyaging());
	CHECK_EQ(R.Voyage->GetVoyageNode(), R.NodeIndex("folder:Proj/Notes"));
	R.Voyage->EndVoyage();
	CHECK(!R.Voyage->IsVoyaging() && R.Voyage->GetVoyageNode() == INDEX_NONE);
	CHECK(R.Voyage->BeginVoyage(Start, Art));
	CHECK_EQ(R.Voyage->GetVoyageNode(), Art);
	CHECK(S.VoyageTitle == FString("folder:Proj/Art"));
	// The route's far end is the folder; the stand-off follows its card.
	CHECK_NEAR((S.Voyage.Config().To.X - R.Brain->NodeTarget(Art).X), 0.0, 1e-6);
	CHECK(S.Voyage.GetField().Rocks.size() > 20U);
	// The ship is there: three sections, the player's metal on the hull, visible.
	CHECK(S.Player.bBuilt && S.Player.Comp->bVisible);
	CHECK_EQ(S.Player.Comp->NumSections(), 3);
	CHECK(S.Player.Comp->Sections[0].Material == S.HullMid[0]);
	CHECK(S.Player.Comp->Sections[2].Material == S.LightMid);
	// The camera: behind the ship.
	FVector CamPos;
	FRotator CamRot;
	float Fov = 0.f;
	CHECK(R.Voyage->GetCamera(CamPos, CamRot, Fov));
	CHECK(Fov > 60.f && Fov < 100.f);
	CHECK((CamPos - Start).Size() < R.Voyage->ShipLengthCm * 5.0);

	// Fly with the cannon held and the cursor on nothing: rocks appear (a few a frame), shots fly, things break, rubble and fire show.
	FAetherVoyageInput In;
	In.bFire = true;
	In.bHasAim = false;
	int MaxRocks = 0;
	int MaxBolts = 0;
	int MaxRubble = 0;
	int MaxFire = 0;
	bool bArrived = false;
	for (int I = 0; I < 60 * 150 && !bArrived; ++I)
	{
		R.Voyage->StepVoyage(1.f / 60.f, In);
		R.Voyage->Tick(1.f / 60.f);
		MaxRocks = std::max(MaxRocks, S.RockVisuals.Num());
		int Bolts = 0;
		for (const FTransform& T : S.Bolts->Instances)
		{
			Bolts += T.Scale3D.X > 0.0 ? 1 : 0;
		}
		MaxBolts = std::max(MaxBolts, Bolts);
		int Rubble = 0;
		for (const FTransform& T : S.Rubble->Instances)
		{
			Rubble += T.Scale3D.X > 0.0 ? 1 : 0;
		}
		MaxRubble = std::max(MaxRubble, Rubble);
		int Fire = 0;
		for (const FTransform& T : S.Fire->Instances)
		{
			Fire += T.Scale3D.X > 0.0 ? 1 : 0;
		}
		MaxFire = std::max(MaxFire, Fire);
		bArrived = R.Voyage->HasArrived();
		// Every rock visual is a mesh with a material of its kind and the right scale.
		if (I % 97 == 0)
		{
			for (const auto& Pair : S.RockVisuals)
			{
				const FAetherVoyageState::FRockVisual& V = Pair.Value;
				CHECK(V.Comp != nullptr && V.Comp->bVisible && V.Comp->NumSections() == 1);
				CHECK(V.Comp->Sections[0].Material == S.RockMid[V.Kind]);
				CHECK(V.Comp->WorldScale.X > 10.0 && V.Comp->WorldScale.X < 2000.0);
				CHECK(ShownTriangles(V.Comp) >= 1280);
			}
		}
	}
	CHECK(bArrived);
	CHECK(R.Voyage->GetRocksBroken() > 5);
	CHECK(R.Voyage->GetScore() > 30);
	CHECK(MaxRocks > 5 && MaxRocks <= 220);
	CHECK(MaxBolts > 2 && MaxBolts <= VoyBoltCapacity);
	CHECK(MaxRubble > 10 && MaxRubble <= VoyFragmentCapacity);
	CHECK(MaxFire > 1);
	CHECK(R.Voyage->GetProgress() > 0.99f && R.Voyage->GetDistanceToGoMeters() < 0.1f);
	CHECK(R.Voyage->GetShieldFraction() >= 0.f && R.Voyage->GetShieldFraction() <= 1.f && R.Voyage->GetHullFraction() > 0.f);
	FVector Aim;
	CHECK(R.Voyage->GetAimPoint(Aim));
	// Rock components made once and reused: the pool is not larger than the most rocks that were ever there at once.
	int Components = 0;
	for (const auto& Pair : S.RockVisuals)
	{
		(void)Pair;
		++Components;
	}
	CHECK(Components + S.FreeRocks.Num() <= MaxRocks + 20);
	// The mesh cache holds a handful of shapes, not one per rock.
	CHECK(S.RockMeshes.Num() >= 1 && S.RockMeshes.Num() <= 12 * 3);

	// Leaving: the ship is hidden, every rock goes back to the pool, nothing is left flying.
	const int Before = S.RockVisuals.Num() + S.FreeRocks.Num();
	R.Voyage->EndVoyage();
	CHECK(!S.Player.Comp->bVisible);
	CHECK(S.RockVisuals.Num() == 0);
	CHECK(S.FreeRocks.Num() >= Before - 5);
	for (UProceduralMeshComponent* C : S.FreeRocks)
	{
		CHECK(!C->bVisible);
	}
	// A second voyage reuses them.
	const int Created = static_cast<int>(R.Voyage->Held.Num());
	CHECK(R.Voyage->BeginVoyage(Start, Deep));
	for (int I = 0; I < 600; ++I)
	{
		R.Voyage->StepVoyage(1.f / 60.f, FAetherVoyageInput{});
		R.Voyage->Tick(1.f / 60.f);
	}
	CHECK(R.Voyage->State->RockVisuals.Num() > 0);
	CHECK(static_cast<int>(R.Voyage->Held.Num()) < Created + 30);
	R.Voyage->EndVoyage();
	// Calls with no voyage are harmless.
	R.Voyage->StepVoyage(0.016f, In);
	FVector V;
	float F = 0.f;
	FRotator Ro;
	CHECK(!R.Voyage->GetCamera(V, Ro, F) && !R.Voyage->GetAimPoint(V) && !R.Voyage->GetTargetRock(V, F));
}

static void TestCards()
{
	Rig R(true, 0);
	FAetherVoyageState& S = *R.Voyage->State;
	// The camera near the folders: cards for those with pictures (Art, Misc, Misc/Deep, Proj: four), at most MaxCards (3), nearest first.
	R.Cam.Location = FVector(100.0, 60.0, 10.0);
	for (int I = 0; I < 40; ++I)
	{
		R.Tick(0.016f);
	}
	CHECK(R.Voyage->NumCardsShown() == 3);
	CHECK(R.Voyage->NumCardsWithPictures() == 0);
	// Only three requests at a time, for the nearest folders with pictures, to /v1/thumb with the id encoded and a bearer token.
	CHECK(S.Pending.Num() == 3);
	std::vector<std::string> Urls;
	for (const auto& P : S.Pending)
	{
		Urls.push_back(P.Request->Url.S);
		CHECK(P.Request->Url.S.find("http://127.0.0.1:7459/v1/thumb?id=") == 0);
		CHECK(P.Request->Url.S.find("&size=1024") != std::string::npos);
		CHECK(P.Request->Headers["Authorization"] == "Bearer tok");
		CHECK(P.Request->bProcessed);
		CHECK(P.Request->Timeout >= 20.f);
	}
	// The nearest three folders with pictures: the project, the misc folder, the art folder (not the deep one, not the one without pictures).
	CHECK(Urls[0].find("folder%3AProj") != std::string::npos && Urls[0].find("Art") == std::string::npos);
	for (const std::string& U : Urls)
	{
		CHECK(U.find("Deep") == std::string::npos && U.find("Notes") == std::string::npos && U.find("Blue") == std::string::npos);
	}
	// Answer the first: it gets its picture, a card, the right aspect; the next request goes out.
	const std::string First = Answer(R, PngReply(640, 320));
	CHECK(First == Urls[0]);
	R.Tick();
	CHECK(R.Voyage->NumCardsWithPictures() == 1);
	FAetherVoyageState::FCard* Art = nullptr;
	for (FAetherVoyageState::FCard& C : S.Cards)
	{
		if (C.Tex)
		{
			Art = &C;
		}
	}
	CHECK(Art != nullptr && Art->Tex != nullptr && Art->PicW == 640 && Art->PicH == 320);
	if (Art && Art->Comp)
	{
		CHECK(Art->Comp->bVisible && Art->Comp->NumSections() == 1);
		CHECK(Art->Comp->Sections[0].Pos.Num() == 4 && Art->Comp->Sections[0].Idx.Num() == 6);
		// A card twice as wide as high, the longer side being the card width (bigger for a big folder).
		const double Wide = std::max(static_cast<double>(R.Voyage->CardWidthCm), R.Brain->NodeRadius(Art->Node) * 14.0);
		const double W = Art->HalfW * 2.0;
		const double H = Art->HalfH * 2.0;
		CHECK_NEAR(W, Wide, 1e-6);
		CHECK_NEAR(H, W / 2.0, 1e-6);
		// In front of the folder toward the camera.
		const FVector Node = R.Brain->NodeLocation(Art->Node);
		CHECK((Art->Comp->WorldLocation - Node).Size() > R.Brain->NodeRadius(Art->Node) * 1.5);
		UMaterialInstanceDynamic* Mid = Art->Mid;
		CHECK(Mid != nullptr && Mid->Textures["Tex"] == Art->Tex);
		// The quad's UVs run the whole picture, top left to bottom right, and its triangles are clockwise from the front (-X).
		const auto& Q = Art->Comp->Sections[0];
		CHECK(Q.Uv[1].X == 0.0 && Q.Uv[1].Y == 0.0 && Q.Uv[3].X == 1.0 && Q.Uv[3].Y == 1.0);
		const FVector A = Q.Pos[Q.Idx[0]];
		const FVector B = Q.Pos[Q.Idx[1]];
		const FVector C = Q.Pos[Q.Idx[2]];
		const FVector N((B.Y - A.Y) * (C.Z - A.Z) - (B.Z - A.Z) * (C.Y - A.Y), (B.Z - A.Z) * (C.X - A.X) - (B.X - A.X) * (C.Z - A.Z), (B.X - A.X) * (C.Y - A.Y) - (B.Y - A.Y) * (C.X - A.X));
		CHECK(N.X < 0.0); // outward = toward -X, the way the viewer sits in the card's own frame
		// Picking: a ray from the camera through the card hits it; a ray that misses does not.
		const FVector Eye = R.Cam.Location;
		const FVector Mid3 = Art->Comp->WorldLocation;
		CHECK(R.Voyage->PickCard(Eye, (Mid3 - Eye).GetSafeNormal()) == Art->Node);
		const FVector Off = Mid3 + FVector(0, 0, Art->HalfH * 1.5 + 100.0);
		CHECK(R.Voyage->PickCard(Eye, (Off - Eye).GetSafeNormal()) != Art->Node);
		CHECK(R.Voyage->PickCard(Eye, (Eye - Mid3).GetSafeNormal()) == INDEX_NONE);
	}
	CHECK(S.Pending.Num() == 3 || S.Pending.Num() == 2); // the fourth folder got its request when a slot freed
	// A failed answer: no picture, tried again later, not at once.
	const std::string Second = Answer(R, PngReply(0, 0, 404));
	CHECK(!Second.empty());
	FAetherVoyageState::FCard* Failed = nullptr;
	for (FAetherVoyageState::FCard& C : S.Cards)
	{
		if (C.bFailed)
		{
			Failed = &C;
		}
	}
	CHECK(Failed != nullptr && Failed->Tex == nullptr && !Failed->bRequested);
	const int PendingBefore = S.Pending.Num();
	for (int I = 0; I < 40; ++I)
	{
		R.Tick(0.016f);
	}
	CHECK(S.Pending.Num() <= PendingBefore); // it is not asked again within the wait
	// A lost connection, an empty body, a corrupt body: no picture, no crash. (Time passes so that a failed one is asked again.)
	const auto WaitPending = [&]() {
		for (int I = 0; I < 120 && S.Pending.Num() == 0; ++I)
		{
			R.Tick(0.5f);
		}
		return S.Pending.Num() > 0;
	};
	CHECK(WaitPending());
	CHECK(!Answer(R, PngReply(10, 10), false).empty());
	CHECK(WaitPending());
	TSharedPtr<FHttpResponseFake> Empty = MakeShared<FHttpResponseFake>();
	CHECK(!Answer(R, Empty).empty());
	CHECK(WaitPending());
	TSharedPtr<FHttpResponseFake> Corrupt = MakeShared<FHttpResponseFake>();
	Corrupt->Bytes.assign(40, 'x');
	CHECK(!Answer(R, Corrupt).empty());
	int WithPictures = R.Voyage->NumCardsWithPictures();
	CHECK(WithPictures >= 1);
	for (int I = 0; I < 6; ++I)
	{
		R.Tick(0.3f);
	}
	// A card whose node went away while its picture was on the way is ignored; an unknown request is too.
	R.Voyage->OnCardPicture(nullptr, PngReply(8, 8), true);
	// Move far away: every card is let go of (no pictures kept in video memory), nothing is drawn.
	R.Cam.Location = FVector(5.0e6, 0.0, 0.0);
	for (int I = 0; I < 40; ++I)
	{
		R.Tick(0.1f);
	}
	CHECK(R.Voyage->NumCardsShown() == 0);
	for (const FAetherVoyageState::FCard& C : S.Cards)
	{
		CHECK(C.Tex == nullptr && !C.bShown && (!C.Comp || !C.Comp->bVisible));
	}
	CHECK(R.Voyage->PickCard(FVector(0, 0, 0), FVector(1, 0, 0)) == INDEX_NONE);
	// Switched off, nothing is asked for.
	Rig Off(true, 0);
	Off.Voyage->bFolderCards = false;
	Off.Cam.Location = FVector(100.0, 60.0, 10.0);
	for (int I = 0; I < 40; ++I)
	{
		Off.Tick();
	}
	CHECK(Off.Voyage->State->Pending.Num() == 0 && Off.Voyage->NumCardsShown() == 0);
	// No link yet: no request, and no crash.
	Rig NoLink(true, 0);
	NoLink.Brain->Conn = FAetherConnection();
	NoLink.Cam.Location = FVector(100.0, 60.0, 10.0);
	for (int I = 0; I < 40; ++I)
	{
		NoLink.Tick();
	}
	CHECK(NoLink.Voyage->State->Pending.Num() == 0);
}

int main()
{
	std::printf("voyage actor\n");
	TestMissingMaterials();
	TestBakes();
	TestTraffic();
	TestVoyage();
	TestCards();
	std::printf("%d checks, %d failed\n", Checks, Failures);
	return Failures == 0 ? 0 : 1;
}
